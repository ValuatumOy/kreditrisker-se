import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createPlan, writePlan, readPlan, candidateConfig, runNext, verifyCandidate, stageCandidate, type BuildSteps, type Context } from '../scripts/lib/candidate.ts'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'se-candidate-'))
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r) + '\n').join('')
const read = (file: string) => fs.readFileSync(file, 'utf8')
const rows = ['1\ta\tAlfa AB\t1\t5564480282', '2\ta\tAlfa AB\t1\t5564480282K', '3\tb\tBeta AB\t1\t5565675906', '4\tc\tGamma AB\t1\t5591844112']
const context: Context = { revision: 'a'.repeat(40), config: candidateConfig({ SE_INDEXING: '1', SE_COMPANY_SITEMAP: '1', SE_SITE_ORIGIN: 'https://www.kreditrisker.se', SECRET_VALUATUM_API_TOKEN: 'secret' }, '2026-11-11') }
function setup() {
    const repo = temp(), dir = path.join(temp(), 'plan')
    writePlan(dir, createPlan(rows.join('\n'), '', context, 2))
    return { repo, dir }
}
function fake(settings: { reject?: boolean; duplicate?: boolean; drop?: boolean; fail?: boolean; wrongIdentity?: boolean; noindex?: boolean; missingSitemap?: boolean; missingHtml?: boolean } = {}): BuildSteps {
    return {
        fetch(env) {
            const selected = read(env.BUILD_STATIC_PARAMS_FILE!).trim().split('\n').map((l) => l.split('\t')).filter((c) => !c[4].endsWith('K'))
            assert.equal(env.SE_INDEXING, '1')
            const pages = selected.map((c) => ({ record: { orgnr: settings.wrongIdentity ? '5560659475' : c[4] }, path: `/foretag/${c[4]}/company-${c[0]}/` }))
            const index = new Map(read(env.SE_INDEX_IN!).split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.o, r] }))
            for (const p of pages) index.set(p.record.orgnr, { o: p.record.orgnr, p: p.path, rf: [], ix: true, syn: false })
            fs.writeFileSync(path.join(env.SE_BUILD_DIR!, 'pages.jsonl'), jsonl(settings.duplicate ? [...pages, pages[0]] : pages))
            fs.writeFileSync(path.join(env.SE_BUILD_DIR!, 'index.jsonl'), settings.drop ? '' : jsonl([...index.values()]))
            fs.writeFileSync(path.join(env.SE_BUILD_DIR!, 'rejected.jsonl'), settings.reject ? jsonl([{ reason: 'fixture' }]) : '')
            fs.writeFileSync(path.join(env.SE_BUILD_DIR!, 'warnings.jsonl'), '')
            fs.writeFileSync(path.join(env.SE_BUILD_DIR!, 'removed.txt'), '')
        },
        build(env) {
            if (settings.fail) throw new Error('synthetic build failure')
            const pages = read(path.join(env.SE_BUILD_DIR!, 'pages.jsonl')).trim().split('\n').map((l) => JSON.parse(l))
            const index = read(path.join(env.SE_BUILD_DIR!, 'index.jsonl')).trim().split('\n').map((l) => JSON.parse(l))
            assert.equal(index.length, 3, 'all renders must see the full frozen index')
            const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
            const html = (route: string) => `<html><meta name="robots" content="${settings.noindex ? 'noindex' : 'index'},follow"><link rel="canonical" href="https://www.kreditrisker.se${route}"></html>`
            for (const r of index) write(path.join(env.SE_OUT_DIR!, 'foretag', r.o, 'index.html'), 'redirect')
            for (const p of pages) if (!settings.missingHtml) write(path.join(env.SE_OUT_DIR!, p.path.slice(1), 'index.html'), html(p.path))
            for (const prefix of ['branscher', 'kommuner', 'konkurser']) write(path.join(env.SE_OUT_DIR!, prefix, 'index.html'), html(`/${prefix}/`))
            write(path.join(env.SE_OUT_DIR!, 'sitemap-index.xml'), '<loc>https://www.kreditrisker.se/sitemap-companies-1.xml</loc>')
            write(path.join(env.SE_OUT_DIR!, 'sitemap-companies-1.xml'), (settings.missingSitemap ? index.slice(1) : index).map((r) => `<loc>https://www.kreditrisker.se${r.p}</loc>`).join(''))
            write(path.join(env.SE_OUT_DIR!, '_astro', 'asset.js'), 'stable asset')
        },
    }
}
const next = (setup: {repo: string; dir: string}, phase: 'fetched' | 'rendered', steps = fake()) => runNext(setup.repo, setup.dir, context, phase, steps, {})
function complete(settings: Parameters<typeof fake>[0] = {}) {
    const s = setup()
    next(s, 'fetched'); next(s, 'fetched')
    next(s, 'rendered', fake(settings)); next(s, 'rendered', fake(settings))
    return s
}

test('16000 selected companies split deterministically under 10000 rows, independent of seed coverage', () => {
    const orgnr = (i: number) => {
        const base = String(556000000 + i)
        const sum = [...base].reduce((s, c, j) => { const v = Number(c) * (j % 2 ? 1 : 2); return s + (v > 9 ? v - 9 : v) }, 0)
        return base + ((10 - sum % 10) % 10)
    }
    const snapshot = Array.from({length: 16000}, (_, i) => `${i + 1}\tx\tFixture ${i}\t1\t${orgnr(i)}`)
    const p = createPlan(snapshot.join('\n'), '', context, 10000)
    assert.equal(p.plan.companies, 16000)
    assert.equal(createPlan(snapshot.join('\n'), '', context).plan.batches.length, 16, 'default parts are conservative 1000-row parts')
    assert.throws(() => candidateConfig({SE_INDEXING: '1', SE_COMPANY_SITEMAP: '0'}, '2026-11-11'), /explicit SE_COMPANY_SITEMAP=1/)
    assert.deepEqual(p.plan.batches.map((b) => b.rows), [10000, 6000])
    assert.deepEqual(createPlan(snapshot.reverse().join('\r\n'), '', context, 10000), p)
    assert.doesNotMatch(JSON.stringify(p.plan), /secret/)
    assert.equal(candidateConfig({}, '2026-11-11').SE_INDEXING, '', 'do not force launch flags')
    assert.throws(() => createPlan(rows.join('\n'), '', context, 10001), /maximum is 10000/)
    assert.throws(() => createPlan(rows.join('\n'), '', context, 1), /exceeds the batch row limit/)
    assert.throws(() => createPlan([rows[0], rows[0]].join('\n'), '', context), /duplicate fid/)
    assert.throws(() => createPlan(rows[1], '', context), /no base model/)
})

test('immutable snapshot, seed, code, config and batch hashes', () => {
    const {dir} = setup()
    assert.throws(() => writePlan(dir, createPlan(rows.join('\n'), '', context)), /EEXIST/)
    assert.throws(() => readPlan(dir, {...context, revision: 'b'.repeat(40)}), /Git revision differs/)
    assert.throws(() => readPlan(dir, {...context, config: {...context.config, SE_INDEXING: '0'}}), /configuration differs/)
    assert.throws(() => createPlan(rows.join('\n'), jsonl([{o: '5560659475'}]), context), /non-target/)
    fs.appendFileSync(path.join(dir, 'batch-00000.txt'), '\n')
    assert.throws(() => readPlan(dir), /Batch checksum changed/)
})

test('fetch all first, then render with same full index, resume and stage locally', () => {
    const s = setup()
    assert.throws(() => next(s, 'rendered'), /Fetch every batch/)
    assert.deepEqual(next(s, 'fetched'), {batch: 0, total: 2, phase: 'fetched'})
    assert.equal(fs.existsSync(path.join(s.dir, 'fetched', '00001')), false)
    assert.throws(() => verifyCandidate(s.dir), /fetch incomplete/)
    next(s, 'fetched')
    next(s, 'rendered')
    assert.throws(() => verifyCandidate(s.dir), /rendering incomplete/)
    next(s, 'rendered')
    assert.equal(verifyCandidate(s.dir).companies, 3)
    const out = path.join(temp(), 'stage')
    const staged = stageCandidate(s.dir, out)
    assert.equal(staged.companies, 3)
    assert.match(staged.sha256, /^[a-f0-9]{64}$/)
    assert.throws(() => stageCandidate(s.dir, out), /already exists/)
    assert.throws(() => next(s, 'rendered'), /All rendered batches are complete/)
    fs.appendFileSync(path.join(s.dir, 'rendered', '00000', 'output', '_astro', 'asset.js'), 'changed')
    assert.throws(() => verifyCandidate(s.dir), /Changed rendered checkpoint output/)
})

test('rejections, duplicates, unexpected identities, missing index and interrupted render never advance', () => {
    const s = setup()
    for (const [settings, error] of [[{reject: true}, /rejected companies/], [{duplicate: true}, /duplicate page/], [{wrongIdentity: true}, /Unexpected/], [{drop: true}, /coverage differs/]] as const) {
        assert.throws(() => next(s, 'fetched', fake(settings)), error)
        assert.equal(fs.existsSync(path.join(s.dir, 'fetched', '00000')), false)
    }
    next(s, 'fetched'); next(s, 'fetched')
    assert.throws(() => next(s, 'rendered', fake({fail: true})), /synthetic build failure/)
    assert.throws(() => next(s, 'rendered', fake({missingHtml: true})), /Missing built company page/)
    assert.equal(fs.existsSync(path.join(s.dir, 'rendered', '00000')), false)
    next(s, 'rendered'); next(s, 'rendered')
    assert.equal(verifyCandidate(s.dir).companies, 3)
    fs.writeFileSync(path.join(s.dir, '.lock'), 'other process')
    assert.throws(() => next(s, 'rendered'), /EEXIST/)
    assert.equal(read(path.join(s.dir, '.lock')), 'other process')
})

test('staging refuses incomplete sitemap coverage and noindex HTML without creating ready output', () => {
    for (const settings of [{missingSitemap: true}, {noindex: true}]) {
        const s = complete(settings)
        const out = path.join(temp(), 'stage')
        assert.throws(() => stageCandidate(s.dir, out), /Staging failed/)
        assert.equal(fs.existsSync(out), false)
    }
})



test('real fetch script uses isolated output and fixed import date, and rejects API identity mismatch using cache fixtures only', () => {
    const dir = temp(), cache = path.join(dir, 'cache'), output = path.join(dir, 'isolated')
    fs.mkdirSync(cache)
    const source = read(path.join(import.meta.dirname, 'fixtures-api-bundle.json'))
    fs.writeFileSync(path.join(cache, '900001.json'), source)
    const batch = path.join(dir, 'batch.txt')
    fs.writeFileSync(batch, '900001\tx\tTestbolaget\t1\t5569876542\n')
    const seed = path.join(dir, 'seed.jsonl')
    fs.writeFileSync(seed, '')
    const env = {...process.env, BUILD_STATIC_PARAMS_FILE: batch, BUILD_STATIC_PARAMS_FILE_ALL: batch, SE_BUILD_DIR: output, SE_INDEX_IN: seed, SE_API_CACHE_DIR: cache, SE_API_REFRESH: '0', SE_IMPORTED_AT: '2026-11-11T00:00:00.000Z', SE_DATA_AS_OF: '2026-11-11', PUBLIC_VALUATUM_API_BASE_URL: '', SECRET_VALUATUM_API_TOKEN: ''}
    const script = path.resolve(import.meta.dirname, '..', 'scripts', 'fetch.ts')
    execFileSync(process.execPath, [script], {cwd: dir, env, stdio: 'pipe'})
    assert.equal(fs.existsSync(path.join(dir, 'data', 'build')), false)
    assert.equal(JSON.parse(read(path.join(output, 'pages.jsonl')).trim()).record.provenance.importedAt, '2026-11-11T00:00:00.000Z')
    fs.writeFileSync(batch, '900001\tx\tWrong identity\t1\t5564480282\n')
    assert.throws(() => execFileSync(process.execPath, [script], {cwd: dir, env, stdio: 'pipe'}))
    assert.match(read(path.join(output, 'rejected.jsonl')), /API orgnr mismatch/)
})
