import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { assertBundleIdentity } from '../src/lib/valuatum/identity.ts'
import { inventory, prepareRelease, verifyRelease, type Capture } from '../scripts/lib/release-plan.ts'
import { createHash } from 'node:crypto'
import { fetchConcurrency } from '../src/lib/valuatum/batch-limit.ts'
import { staticUrls, hubUrls } from '../src/lib/sitemap.ts'
import { buildSite, toRow } from '../src/lib/publish.ts'
import { assertPublicFiles, checkSitemaps, createPlan, writePlan, readPlan, candidateConfig, runNext, selectCompanies, verifyCandidate, stageCandidate, type BuildSteps, type Context } from '../scripts/lib/candidate.ts'

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'se-candidate-'))
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r) + '\n').join('')
const read = (file: string) => fs.readFileSync(file, 'utf8')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const rows = ['1\ta\tAlfa AB\t1\t5564480282', '2\ta\tAlfa AB\t1\t5564480282K', '3\tb\tBeta AB\t1\t5565675906', '4\tc\tGamma AB\t1\t5591844112']
const context: Context = { revision: 'a'.repeat(40), config: candidateConfig({ SE_INDEXING: '1', SE_COMPANY_SITEMAP: '1', SE_SITE_ORIGIN: 'https://www.kreditrisker.se', SECRET_VALUATUM_API_TOKEN: 'secret' }, '2026-11-11') }
function setup(customContext = context) {
    const repo = temp(), dir = path.join(temp(), 'plan')
    writePlan(dir, createPlan(rows.join('\n'), '', customContext, 2))
    return { repo, dir, context: customContext }
}
function fake(settings: { reject?: boolean; duplicate?: boolean; drop?: boolean; fail?: boolean; wrongIdentity?: boolean; noindex?: boolean; missingSitemap?: boolean; missingHtml?: boolean; directoryCount?: number; mutateExisting?: boolean; changedName?: boolean; includeNonselected?: boolean; omitRobots?: boolean; wrongRedirect?: boolean; omitRequiredSitemap?: boolean; emptyStaticSitemap?: boolean; emptyHubSitemap?: boolean; omitRedirectManifest?: boolean; wrongRedirectManifest?: boolean; eligible?: boolean; profileRobots?: 'index' | 'noindex' } = {}): BuildSteps {
    return {
        fetch(env) {
            const selected = read(env.BUILD_STATIC_PARAMS_FILE!).trim().split('\n').map((l) => l.split('\t')).filter((c) => !c[4].endsWith('K'))
            const pages = selected.map((c) => ({ record: { orgnr: settings.wrongIdentity ? '5560659475' : c[4], name: c[2] + (settings.changedName ? ' changed' : ''), status: {code: 'active'}, periods: [], provenance: {importedAt: '2026-11-11T00:00:00.000Z'}, synthetic: false, formerNames: [], sni: [{code: '1', label: 'Synthetic sector', version: '2025'}], municipality: {code: '0180', name: 'Stockholm'} }, path: `/foretag/${c[4]}/company-${c[0]}/`, redirectsFrom: [], freshness: 'current', quality: {indexable: settings.eligible ?? true, meetsThreshold: settings.eligible ?? true} }))
            const index = new Map(read(env.SE_INDEX_IN!).split('\n').filter(Boolean).map((l) => { const r = JSON.parse(l); return [r.o, r] }))
            for (const p of pages) index.set(p.record.orgnr, toRow(p as any))
            if (settings.mutateExisting && index.size) { const first = index.values().next().value; first.ix = false; first.n = 'corrupted'; first.ns = -999 }
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
            assert.equal(index.length, settings.directoryCount ?? 3, 'all renders must see the full frozen index')
            const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content) }
            const flag = (key: string) => env[key] === '1' || env[key]?.toLowerCase() === 'true'
            const open = flag('SE_INDEXING') && !flag('SE_PREVIEW')
            const htmlOpen = (flag('SE_INDEXING') || flag('SE_HTML_FINAL')) && !flag('SE_PREVIEW')
            const html = (route: string, verdict = open ? 'index' : 'noindex') => `<html><meta name="robots" content="${settings.noindex ? 'noindex' : verdict},follow"><link rel="canonical" href="https://www.kreditrisker.se${route}"></html>`
            for (const r of index) write(path.join(env.SE_OUT_DIR!, 'foretag', r.o, 'index.html'), `<link rel="canonical" href="https://www.kreditrisker.se${r.p}"><meta http-equiv="refresh" content="0;url=${settings.wrongRedirect ? '/wrong/' : r.p}">`)
            for (const p of pages) if (!settings.missingHtml) write(path.join(env.SE_OUT_DIR!, p.path.slice(1), 'index.html'), html(p.path, settings.profileRobots ?? (htmlOpen && p.quality.indexable && !p.record.synthetic ? 'index' : 'noindex')))
            for (const prefix of ['branscher', 'kommuner', 'konkurser']) write(path.join(env.SE_OUT_DIR!, prefix, 'index.html'), html(`/${prefix}/`))
            write(path.join(env.SE_OUT_DIR!, 'sitemap-index.xml'), (settings.omitRequiredSitemap ? ['sitemap-companies-1.xml'] : ['sitemap-pages.xml', 'sitemap-hubs.xml', 'sitemap-companies-1.xml']).map((f) => `<loc>https://www.kreditrisker.se/${f}</loc>`).join(''))
            const site = buildSite([], index, 'fixture')
            for (const [file, urls, empty] of [['sitemap-pages.xml', staticUrls(site, open), settings.emptyStaticSitemap], ['sitemap-hubs.xml', hubUrls(site, env.SE_DATA_AS_OF!, open), settings.emptyHubSitemap]] as const) {
                for (const {path: route} of urls) write(path.join(env.SE_OUT_DIR!, route.slice(1), 'index.html'), html(route))
                write(path.join(env.SE_OUT_DIR!, file), empty ? '<urlset/>' : urls.map((u) => `<loc>https://www.kreditrisker.se${u.path}</loc>`).join(''))
            }
            if (!settings.omitRedirectManifest) write(path.join(env.SE_OUT_DIR!, 'redirects.json'), JSON.stringify(site.redirects.map((r) => ({...r, to: settings.wrongRedirectManifest ? '/wrong/' : r.to, status: 301}))))
            if (!settings.omitRobots) write(path.join(env.SE_OUT_DIR!, 'robots.txt'), open ? 'User-agent: *\nDisallow: /bestall/\nDisallow: /sok/\n\nSitemap: https://www.kreditrisker.se/sitemap-index.xml\n' : '# Pre-launch or staging: nothing may be indexed.\nUser-agent: *\nDisallow: /\n')
            const selectedOrgnrs = new Set(read(env.SE_COMPANY_SITEMAP_FILE!).trim().split('\n').map((l) => l.split('\t')[4]))
            const sitemapRows = open ? (settings.includeNonselected ? index : index.filter((r) => selectedOrgnrs.has(r.o) && r.ix)) : []
            write(path.join(env.SE_OUT_DIR!, 'sitemap-companies-1.xml'), (settings.missingSitemap ? sitemapRows.slice(1) : sitemapRows).map((r) => `<loc>https://www.kreditrisker.se${r.p}</loc>`).join(''))
            write(path.join(env.SE_OUT_DIR!, '_astro', 'asset.js'), 'stable asset')
        },
    }
}
const next = (setup: {repo: string; dir: string; context?: Context}, phase: 'fetched' | 'rendered', steps = fake()) => runNext(setup.repo, setup.dir, setup.context ?? context, phase, steps, {})
function complete(settings: Parameters<typeof fake>[0] = {}) {
    const s = setup()
    next(s, 'fetched', fake(settings)); next(s, 'fetched', fake(settings))
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
    assert.equal(selectCompanies(snapshot.join('\n'), '', 16000), p.files.get('snapshot.txt'), 'exactly 16000 selected, independent of input order')
    assert.equal(createPlan(snapshot.join('\n'), '', context).plan.batches.length, 16, 'default parts are conservative 1000-row parts')
    assert.throws(() => candidateConfig({SE_INDEXING: '1', SE_COMPANY_SITEMAP: '0'}, '2026-11-11'), /explicit SE_COMPANY_SITEMAP=1/)
    assert.deepEqual(p.plan.batches.map((b) => b.rows), [10000, 6000])
    assert.deepEqual(createPlan(snapshot.reverse().join('\r\n'), '', context, 10000), p)
    assert.doesNotMatch(JSON.stringify(p.plan), /secret/)
    assert.equal(candidateConfig({}, '2026-11-11').SE_SITE_ORIGIN, 'https://www.kreditrisker.se')
    assert.throws(() => candidateConfig({SE_SITE_ORIGIN: 'not-a-url'}, '2026-11-11'))
    assert.throws(() => candidateConfig({SE_SITE_ORIGIN: 'https://example.com/path'}, '2026-11-11'), /valid HTTP/)
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
    assert.throws(() => createPlan(rows.join('\n'), jsonl([{o: '5560659475'}]), context), /non-directory/)
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
    for (const settings of [{missingSitemap: true}]) {
        const s = complete(settings)
        const out = path.join(temp(), 'stage')
        assert.throws(() => stageCandidate(s.dir, out), /Staging failed/)
        assert.equal(fs.existsSync(out), false)
    }
})



test('real fetch script uses isolated output and actual import date, and rejects API identity mismatch using cache fixtures only', () => {
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
    assert.ok(Date.now() - Date.parse(JSON.parse(read(path.join(output, 'pages.jsonl')).trim()).record.provenance.importedAt) < 10000, 'real fetch timestamp, not plan midnight')
    fs.writeFileSync(batch, '900001\tx\tWrong identity\t1\t5564480282\n')
    assert.throws(() => execFileSync(process.execPath, [script], {cwd: dir, env, stdio: 'pipe'}))
    assert.match(read(path.join(output, 'rejected.jsonl')), /API orgnr mismatch/)
})


const nonselected = {o: '5560659475', n: 'Preserved AB', p: '/foretag/5560659475/preserved-ab/', rf: ['/foretag/5560659475/old-name/'], st: 'active', fr: 'current', ix: true, q: true, syn: false, im: '2026-01-01', ns: 12345}
const fullSnapshot = [...rows, '5\td\tPreserved AB\t1\t5560659475'].join('\n')

test('separate full list retains all nonselected fields and selected-only company sitemap', () => {
    const s = {repo: temp(), dir: path.join(temp(), 'plan')}
    writePlan(s.dir, createPlan(rows.join('\n'), jsonl([nonselected]), context, 2, fullSnapshot))
    assert.equal(readPlan(s.dir).plan.directoryCompanies, 4)
    next(s, 'fetched'); next(s, 'fetched')
    const index = path.join(s.dir, 'fetched', '00001', 'output', 'index.jsonl')
    assert.deepEqual(read(index).trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.o === nonselected.o), nonselected)
    next(s, 'rendered', fake({directoryCount: 4})); next(s, 'rendered', fake({directoryCount: 4}))
    const out = path.join(temp(), 'overlay')
    stageCandidate(s.dir, out)
    assert.doesNotMatch(read(path.join(out, 'sitemap-companies-1.xml')), /5560659475/)
    assert.equal(fs.existsSync(path.join(out, nonselected.p.slice(1), 'index.html')), false, 'nonselected canonical HTML remains in production, not this overlay')
    assert.throws(() => createPlan(rows.join('\n'), '', context, 2, fullSnapshot), /Nonselected company has no seed/)
    assert.throws(() => createPlan(fullSnapshot, '', context, 2, rows.join('\n')), /outside full snapshot/)
    assert.throws(() => createPlan(rows[0], jsonl([nonselected]), context, 2, fullSnapshot), /omitted a parent\/group/)
    for (const bad of [{...nonselected, n: undefined}, {...nonselected, syn: true}, {...nonselected, ix: undefined}]) assert.throws(() => createPlan(rows.join('\n'), jsonl([bad]), context, 2, fullSnapshot), /Invalid seed/)
    assert.throws(() => checkSitemaps(out, index, context.config, new Set(['5564480282'])), /Unexpected or duplicate/)
})

test('exact-count selection prioritizes missing companies and retains groups, with deterministic fill', () => {
    const seed = jsonl([nonselected])
    const selected = selectCompanies(fullSnapshot, seed, 3)
    assert.equal(selected.trim().split('\n').length, 4)
    assert.match(selected, /5564480282K/)
    assert.doesNotMatch(selected, /5560659475/)
    assert.equal(selectCompanies(fullSnapshot.split('\n').reverse().join('\n'), seed, 3), selected)
    assert.throws(() => selectCompanies(fullSnapshot, seed, 2), /cannot cover 3/)
    assert.throws(() => selectCompanies(fullSnapshot, seed, 5), /between 1 and 4/)
    assert.throws(() => selectCompanies(fullSnapshot, jsonl([{...nonselected, ix: undefined}]), 3), /Invalid seed/)
    assert.equal(selectCompanies(rows.join('\n'), '', 3), createPlan(rows.join('\n'), '', context).files.get('snapshot.txt'))
})

test('full slim row validation rejects changed financials or quality on retained/previous companies', () => {
    const s = {repo: temp(), dir: path.join(temp(), 'plan')}
    writePlan(s.dir, createPlan(rows.join('\n'), jsonl([nonselected]), context, 2, fullSnapshot))
    assert.throws(() => next(s, 'fetched', fake({mutateExisting: true})), /mismatched page/)
    const earlier = setup()
    next(earlier, 'fetched')
    assert.throws(() => next(earlier, 'fetched', fake({mutateExisting: true})), /mismatched page/)
})

test('render receipts bind terminal fetch/index and prohibit tail refetch under old rendered lineage', () => {
    const s = setup()
    next(s, 'fetched'); next(s, 'fetched'); next(s, 'rendered')
    const tail = path.join(s.dir, 'fetched', '00001')
    fs.renameSync(tail, path.join(s.dir, 'lost-tail'))
    assert.throws(() => next(s, 'fetched'), /existing render lineage/)
    assert.throws(() => next(s, 'rendered'), /Fetch every batch/)
    fs.renameSync(path.join(s.dir, 'rendered'), path.join(s.dir, 'old-renders'))
    next(s, 'fetched', fake({changedName: true}))
    fs.renameSync(path.join(s.dir, 'old-renders'), path.join(s.dir, 'rendered'))
    assert.throws(() => next(s, 'rendered'), /Changed rendered checkpoint input/)
})

test('robots, required sitemap files and real redirect targets are mandatory', () => {
    for (const settings of [{omitRobots: true}, {omitRequiredSitemap: true}]) {
        const s = complete(settings)
        assert.throws(() => stageCandidate(s.dir, path.join(temp(), 'overlay')), /Staging failed/)
    }
    const s = setup()
    next(s, 'fetched'); next(s, 'fetched')
    assert.throws(() => next(s, 'rendered', fake({wrongRedirect: true})), /Invalid redirect destination/)
})

test('API identity rejects wrong model fid, group accounts and inconsistent register codes', () => {
    const bundle = JSON.parse(read(path.join(import.meta.dirname, 'fixtures-api-bundle.json')))
    const expected = {fid: '900001', name: 'Testbolaget', orgnr: '5569876542'}
    assertBundleIdentity(bundle, expected)
    for (const mutate of [
        (b: any) => {b.modeldata.followedModelId = 999},
        (b: any) => {b.fid = '999'},
        (b: any) => {b.modeldata.companyCode += 'K'},
        (b: any) => {b.companies[0].companyCode += 'K'},
        (b: any) => {b.companies[0].companyCode = '5564480282'},
        (b: any) => {b.companies[0].models[0].followedModelId = 999},
    ]) {
        const bad = structuredClone(bundle); mutate(bad)
        assert.throws(() => assertBundleIdentity(bad, expected), /API/)
    }
    for (const n of ['0', 'NaN', 'Infinity', '10000', '-1', '2.5', '']) assert.throws(() => fetchConcurrency(n), /integer from 1 to 16/)
    assert.equal(fetchConcurrency(), 8)
    assert.equal(fetchConcurrency('16'), 16)
    assert.throws(() => candidateConfig({SE_FETCH_CONCURRENCY: '10000'}, '2026-11-11'), /integer from 1 to 16/)
})

test('ignored public extras are rejected independently of git clean status', () => {
    const repo = temp()
    fs.mkdirSync(path.join(repo, 'public'))
    fs.writeFileSync(path.join(repo, 'public', 'known.txt'), 'known')
    assertPublicFiles(repo, ['public/known.txt'])
    fs.writeFileSync(path.join(repo, 'public', '.env'), 'must-not-be-copied')
    assert.throws(() => assertPublicFiles(repo, ['public/known.txt']), /unsafe public file/)
    assert.throws(() => assertPublicFiles(repo, ['public/known.txt', 'public/.env']), /unsafe public file/)
})


test('verify and stage CLI refuse a different or dirty current revision before reporting success', () => {
    const s = setup()
    const script = path.resolve(import.meta.dirname, '..', 'scripts', 'candidate.ts')
    for (const command of ['verify', 'stage']) {
        const args = [script, command, '--plan', s.dir, ...(command === 'stage' ? ['--out', path.join(temp(), 'overlay')] : [])]
        assert.throws(() => execFileSync(process.execPath, args, {env: {...process.env, SECRET_VALUATUM_API_TOKEN: ''}, stdio: 'pipe'}), /clean, dedicated|Git revision differs/)
    }
})

test('public junctions/symlinks are refused before recursive copying', () => {
    const repo = temp()
    fs.mkdirSync(path.join(repo, 'public'))
    const target = temp()
    fs.symlinkSync(target, path.join(repo, 'public', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => assertPublicFiles(repo, []), /Symlink/)
})


test('staging requires exact static/hub sitemap coverage and full directory redirect manifest', () => {
    for (const settings of [{emptyStaticSitemap: true}, {emptyHubSitemap: true}, {omitRedirectManifest: true}, {wrongRedirectManifest: true}]) {
        const s = complete(settings)
        const out = path.join(temp(), 'overlay')
        assert.throws(() => stageCandidate(s.dir, out), /Staging failed/)
        assert.equal(fs.existsSync(out), false)
    }
})


test('all selected profiles must carry frozen HTML robots verdict even outside the sitemap', () => {
    const cases = [
        {env: {SE_INDEXING: '1', SE_COMPANY_SITEMAP: '1'}, eligible: false, wrong: 'index'},
        {env: {SE_INDEXING: '0', SE_HTML_FINAL: '1'}, eligible: true, wrong: 'noindex'},
        {env: {SE_INDEXING: '1', SE_COMPANY_SITEMAP: '1', SE_HTML_FINAL: '1', SE_PREVIEW: '1'}, eligible: true, wrong: 'index'},
        {env: {SE_INDEXING: '0', SE_HTML_FINAL: '0'}, eligible: true, wrong: 'index'},
    ] as const
    for (const c of cases) {
        const customContext = {...context, config: candidateConfig(c.env, '2026-11-11')}
        const s = setup(customContext)
        const steps = fake({eligible: c.eligible})
        next(s, 'fetched', steps); next(s, 'fetched', steps)
        assert.throws(() => next(s, 'rendered', fake({eligible: c.eligible, profileRobots: c.wrong})), /robots verdict differs/)
        assert.equal(fs.existsSync(path.join(s.dir, 'rendered', '00000')), false)
        next(s, 'rendered', steps); next(s, 'rendered', steps)
        assert.equal(verifyCandidate(s.dir).companies, 3)
        stageCandidate(s.dir, path.join(temp(), 'overlay'))
    }
})


test('plans pin a usable default API origin and reject invalid or unsafe API endpoints', () => {
    assert.equal(candidateConfig({}, '2026-11-11').PUBLIC_VALUATUM_API_BASE_URL, 'https://sweden.valuatum.com')
    assert.equal(candidateConfig({PUBLIC_VALUATUM_API_BASE_URL: 'https://sweden.valuatum.com/'}, '2026-11-11').PUBLIC_VALUATUM_API_BASE_URL, 'https://sweden.valuatum.com')
    for (const endpoint of ['not-a-url', 'http://sweden.valuatum.com', 'https://user:secret@sweden.valuatum.com', 'https://sweden.valuatum.com/rest', 'https://sweden.valuatum.com/?token=secret']) assert.throws(() => candidateConfig({PUBLIC_VALUATUM_API_BASE_URL: endpoint}, '2026-11-11'))
})

test('offline promotion package verifies the candidate, preserves 857 nonselected profiles, and detects package corruption', () => {
    const s = complete(), stage = path.join(temp(), 'stage')
    stageCandidate(s.dir, stage)
    const captureDir = temp(), site = path.join(captureDir, 'site')
    fs.mkdirSync(site)
    const write = (key: string, text: string) => {
        const file = path.join(site, key); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text)
    }
    for (let i = 0; i < 857; i++) write(`foretag/${9000000000 + i}/legacy/index.html`, `synthetic nonselected profile ${i} with noindex`)
    write('_astro/legacy.js', 'synthetic retained old asset')
    write('sitemap-companies-99.xml', '<old-synthetic-sitemap/>')
    const before = inventory(site), liveIndex = read(path.join(s.dir, 'seed-index.jsonl'))
    fs.writeFileSync(path.join(captureDir, 'index.jsonl'), liveIndex)
    const capture: Capture = {
        version: 1, capturedAt: '2026-11-11T12:00:00Z', complete: true,
        site: { bucket: 'synthetic-site', versioning: 'Enabled', objects: Object.fromEntries(Object.entries(before).map(([key, value]) => [key, { ...value, versionId: 'synthetic-original', head: {} }])) },
        state: { uri: 's3://synthetic-state/index.jsonl', versioning: 'Enabled', versionId: 'synthetic-index', sha256: hash(liveIndex), head: {} },
        policy: { uri: 's3://synthetic-state/sitemap-policy.json', versionId: null, sha256: null },
        search: { function: 'synthetic-search', imageUri: 'example.invalid/search@sha256:' + 'a'.repeat(64), revisionId: 'synthetic-revision', indexSha256: hash(liveIndex) },
        distributionId: 'SYNTHETIC',
    }
    fs.writeFileSync(path.join(captureDir, 'capture.json'), JSON.stringify(capture, null, 2) + '\n')
    const out = path.join(temp(), 'release')
    const result = prepareRelease(s.dir, stage, captureDir, out)
    assert.equal(result.promotionAllowed, false)
    assert.equal(verifyRelease(out).preservedCompanyKeys, 857)
    assert.deepEqual(inventory(path.join(out, 'backup', 'site')), before)
    const release = JSON.parse(read(path.join(out, 'release.json')))
    assert.equal(release.preserved.companyKeys.length, 857)
    assert.equal(inventory(path.join(out, 'overlay'))['foretag/9000000000/legacy/index.html'], undefined)
    const simulated = { ...before, ...Object.fromEntries(Object.entries(release.writes).map(([key, value]: [string, any]) => [key, value.after])) }
    for (const key of release.rollback.removeNew) delete simulated[key]
    for (const key of release.rollback.restore) simulated[key] = before[key]
    assert.deepEqual(simulated, before, 'rollback plan restores exact original inventory including newly created keys')
    fs.appendFileSync(path.join(out, 'overlay', 'sitemap-companies-99.xml'), 'tampered')
    assert.throws(() => verifyRelease(out), /overlay differs/)
    assert.deepEqual(inventory(site), before, 'preparation never mutates the snapshot')
    const edited = path.join(temp(), 'edited')
    fs.cpSync(stage, edited, { recursive: true })
    fs.appendFileSync(path.join(edited, 'index.html'), 'tampered')
    const failed = path.join(temp(), 'failed')
    assert.throws(() => prepareRelease(s.dir, edited, captureDir, failed), /Offline release preparation failed/)
    assert.equal(fs.existsSync(failed), false)
})
