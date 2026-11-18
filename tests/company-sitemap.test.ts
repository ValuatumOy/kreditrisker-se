import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { distinctCompanyRows, verifyCompanyHtml } from '../src/lib/company-sitemap.ts'
import { mapBundle } from '../src/lib/valuatum/map.ts'
import { publishCompany, toRow, type IndexRow } from '../src/lib/publish.ts'
import { readJsonl, writeJsonl } from '../src/lib/jsonl.ts'
import { automaticBatch } from '../src/lib/valuatum/params.ts'

const ROOT = path.join(import.meta.dirname, '..')
const ORIGIN = 'https://www.kreditrisker.se'
const head = (canonical: string, robots = 'index,follow') => `<!doctype html><html><head><meta name="robots" content="${robots}"><link rel="canonical" href="${canonical}"></head><body></body></html>`

test('company HTML verification requires one exact canonical and robots verdict', () => {
    const canonical = `${ORIGIN}/foretag/5569876542/test/`
    verifyCompanyHtml(head(canonical), canonical, true)
    verifyCompanyHtml(head(canonical, 'noindex,follow'), canonical, false)
    for (const html of [
        head(canonical, 'noindex,follow'),
        head(canonical + 'old/'),
        head(canonical).replace('</head>', '<meta name="robots" content="noindex"></head>'),
        head(canonical).replace('</head>', '<meta http-equiv="refresh" content="0;url=/"></head>'),
        head(canonical).replace('<head>', '<head><link rel="canonical" href="https://other.test/">'),
        '<head><script>const x = `<meta name="robots" content="index,follow">`</script></head>',
        `<!-- ${head(canonical)} -->`,
    ]) assert.throws(() => verifyCompanyHtml(html, canonical, true))
})

test('company index verification rejects duplicate ids, duplicate paths and non-company paths', () => {
    const row = { o: '5569876542', p: '/foretag/5569876542/test/' }
    distinctCompanyRows([row])
    for (const rows of [[row, row], [row, { ...row, p: '/foretag/5569876542/other/' }], [{ ...row, p: '/foretag/5569876542/../' }], [{ ...row, p: '/foretag/5569876542/test/../../' }], [{ ...row, o: '5564480282' }]])
        assert.throws(() => distinctCompanyRows(rows))
})

function candidate() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-company-sitemaps-'))
    const build = path.join(dir, 'data', 'build')
    fs.mkdirSync(build, { recursive: true })
    const mapped = mapBundle(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures-api-bundle.json'), 'utf8')), { batchId: 'test', importedAt: '2026-11-18T00:00:00Z' })
    assert.ok(mapped.ok)
    const page = publishCompany(mapped.record, ['gamla-namnet'], '2026-11-18')
    assert.ok(page.quality.indexable)
    const row = toRow(page)
    const extra = (o: string, sm = true): IndexRow => ({ ...row, o, n: o, p: `/foretag/${o}/test/`, rf: [], ...(sm ? { sm: true } : {}) })
    const old = { ...row, p: `/foretag/${row.o}/gamla-namnet/`, sm: true as const }
    const untouched = extra('5564480282')
    const legacy = extra('5565675906', false)
    const failed = extra('5591844112')
    const removed = extra('5560659475')
    const thin = structuredClone(page)
    thin.record.orgnr = '5560000019' as typeof thin.record.orgnr
    thin.path = '/foretag/5560000019/thin/'
    thin.slug = 'thin'
    thin.quality.indexable = false
    const thinOld = { ...toRow(thin), ix: true, sm: true as const }
    writeJsonl(path.join(dir, 'prev.jsonl'), [old, untouched, legacy, failed, removed, thinOld])
    writeJsonl(path.join(build, 'pages.jsonl'), [page, thin])
    writeJsonl(path.join(build, 'index.jsonl'), [row, untouched, legacy, failed, toRow(thin)])
    fs.writeFileSync(path.join(dir, 'batch.txt'), [row.o, failed.o, thin.record.orgnr].map((o) => `1\ttest\tTest AB\t1\t${o}\n`).join(''))
    for (const p of [page, thin]) {
        const file = path.join(dir, 'dist', p.path, 'index.html')
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, head(ORIGIN + p.path, p.quality.indexable ? 'index,follow' : 'noindex,follow'))
    }
    const run = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'company-sitemaps.ts')], {
        cwd: dir, encoding: 'utf8',
        env: { ...process.env, SE_INDEX_IN: path.join(dir, 'prev.jsonl'), BUILD_STATIC_PARAMS_FILE: path.join(dir, 'batch.txt'), SE_COMPANY_SITEMAP: 'verified', SE_SITE_ORIGIN: ORIGIN, SE_INDEXING: '1', SE_PREVIEW: '0', SE_OUT_DIR: 'dist', SE_DATA_AS_OF: '2026-11-18' },
    })
    return { dir, build, run, page, row, old, untouched, legacy, failed, removed, thin }
}

test('incremental verification promotes refreshed HTML, preserves untouched eligibility and checkpoints withdrawals', () => {
    const c = candidate()
    try {
        const result = c.run()
        assert.equal(result.status, 0, result.stdout + result.stderr)
        const rows = readJsonl<IndexRow>(path.join(c.build, 'index.jsonl'))
        assert.deepEqual(rows.filter((r) => r.sm).map((r) => r.o), [c.row.o, c.untouched.o])
        assert.equal(rows.find((r) => r.o === c.row.o)!.rv, null, 'unknown source revision is recorded after successful HTML verification')
        assert.equal(rows.find((r) => r.o === c.thin.record.orgnr)!.rv, null, 'verified noindex HTML is rendered too')
        assert.equal(rows.find((r) => r.o === c.failed.o)!.rv, undefined, 'a rejected fetch never advances rendered revision')
        const final = fs.readFileSync(path.join(c.dir, 'dist', 'sitemap-companies-1.xml'), 'utf8')
        assert.ok(final.includes(ORIGIN + c.row.p))
        assert.ok(final.includes(ORIGIN + c.untouched.p))
        for (const excluded of [c.old, c.legacy, c.failed, c.removed]) assert.ok(!final.includes(ORIGIN + excluded.p))
        assert.ok(!final.includes(ORIGIN + c.thin.path))
        const checkpoint = readJsonl<IndexRow>(path.join(c.build, 'index-checkpoint.jsonl'))
        assert.deepEqual(checkpoint.filter((r) => r.sm).map((r) => r.o), [c.untouched.o])
        assert.equal(checkpoint.find((r) => r.o === c.row.o)!.p, c.old.p, 'checkpoint preserves old metadata until targets upload')
        assert.ok(checkpoint.some((r) => r.o === c.removed.o), 'a retry must still delete pending removals')
        const withdrawal = fs.readFileSync(path.join(c.build, 'sitemap-withdrawal', 'sitemap-companies-1.xml'), 'utf8')
        assert.ok(withdrawal.includes(ORIGIN + c.untouched.p))
        assert.ok(!withdrawal.includes(c.row.o))
        // A later empty batch carries only persisted eligibility; no legacy promotion.
        fs.copyFileSync(path.join(c.build, 'index.jsonl'), path.join(c.dir, 'prev.jsonl'))
        fs.writeFileSync(path.join(c.build, 'pages.jsonl'), '')
        fs.writeFileSync(path.join(c.dir, 'batch.txt'), '')
        assert.equal(c.run().status, 0)
        assert.equal(fs.readFileSync(path.join(c.dir, 'dist', 'sitemap-companies-1.xml'), 'utf8'), final)
    } finally { fs.rmSync(c.dir, { recursive: true, force: true }) }
})

test('rendered revision records the selected source save time only after HTML verification', () => {
    const c = candidate()
    try {
        const batch = path.join(c.dir, 'batch.txt')
        fs.writeFileSync(batch, fs.readFileSync(batch, 'utf8').replace(`${c.row.o}\n`, `${c.row.o}\t1794960000000\n`))
        assert.equal(c.run().status, 0)
        const row = readJsonl<IndexRow>(path.join(c.build, 'index.jsonl')).find((r) => r.o === c.row.o)!
        assert.equal(row.rv, new Date(1794960000000).toISOString())
        assert.equal(readJsonl<IndexRow>(path.join(c.build, 'index-checkpoint.jsonl')).find((r) => r.o === c.row.o)!.rv, undefined, 'pre-upload checkpoint does not claim the new render')
    } finally { fs.rmSync(c.dir, { recursive: true, force: true }) }
})

test('an interrupted unchanged-source rebuild and a rejected refresh clear revision so automatic repair selects them', () => {
    const c = candidate()
    try {
        for (const file of [path.join(c.dir, 'prev.jsonl'), path.join(c.build, 'index.jsonl')]) {
            const rows = readJsonl<IndexRow>(file)
            for (const row of rows) row.rv = null
            writeJsonl(file, rows)
        }
        assert.equal(c.run().status, 0)
        const checkpoint = readJsonl<IndexRow>(path.join(c.build, 'index-checkpoint.jsonl'))
        const next = readJsonl<IndexRow>(path.join(c.build, 'index.jsonl'))
        const params = [c.row, c.failed].map((r) => ({ fid: r.o, orgnr: r.o, name: r.n }))
        assert.deepEqual(automaticBatch(params, checkpoint, 10, 0).map((p) => p.orgnr), [c.row.o, c.failed.o])
        assert.deepEqual(automaticBatch(params, next, 10, 0).map((p) => p.orgnr), [c.failed.o])
        assert.equal(checkpoint.find((r) => r.o === c.untouched.o)!.rv, null, 'untouched revisions survive')
    } finally { fs.rmSync(c.dir, { recursive: true, force: true }) }
})

test('a failed or filtered company render cannot grant or persist eligibility', () => {
    for (const change of ['noindex', 'canonical', 'missing', 'duplicate-page', 'duplicate-index']) {
        const c = candidate()
        try {
            const file = path.join(c.dir, 'dist', c.page.path, 'index.html')
            if (change === 'noindex') fs.writeFileSync(file, head(ORIGIN + c.page.path, 'noindex,follow'))
            if (change === 'canonical') fs.writeFileSync(file, head(ORIGIN + c.old.p))
            if (change === 'missing') fs.unlinkSync(file)
            if (change === 'duplicate-page') writeJsonl(path.join(c.build, 'pages.jsonl'), [c.page, c.page])
            if (change === 'duplicate-index') writeJsonl(path.join(c.build, 'index.jsonl'), [c.row, c.row])
            const before = fs.readFileSync(path.join(c.build, 'index.jsonl'), 'utf8')
            assert.notEqual(c.run().status, 0, change)
            assert.equal(fs.readFileSync(path.join(c.build, 'index.jsonl'), 'utf8'), before)
            assert.equal(fs.existsSync(path.join(c.build, 'index-checkpoint.jsonl')), false)
        } finally { fs.rmSync(c.dir, { recursive: true, force: true }) }
    }
})

test('the first gradual batch promotes only refreshed profiles from wholly legacy state', () => {
    const c = candidate()
    try {
        for (const file of [path.join(c.dir, 'prev.jsonl'), path.join(c.build, 'index.jsonl')]) {
            const rows = readJsonl<IndexRow>(file)
            for (const row of rows) delete row.sm
            writeJsonl(file, rows)
        }
        assert.equal(c.run().status, 0)
        const rows = readJsonl<IndexRow>(path.join(c.build, 'index.jsonl'))
        assert.deepEqual(rows.filter((r) => r.sm).map((r) => r.o), [c.row.o])
        const withdrawal = path.join(c.build, 'sitemap-withdrawal')
        assert.deepEqual(fs.readdirSync(withdrawal), ['sitemap-index.xml'])
        assert.doesNotMatch(fs.readFileSync(path.join(withdrawal, 'sitemap-index.xml'), 'utf8'), /sitemap-companies-/)
    } finally { fs.rmSync(c.dir, { recursive: true, force: true }) }
})

test('retry after an interrupted deployment cannot restore withdrawn eligibility', () => {
    const c = candidate()
    try {
        assert.equal(c.run().status, 0)
        fs.copyFileSync(path.join(c.build, 'index-checkpoint.jsonl'), path.join(c.dir, 'prev.jsonl'))
        fs.copyFileSync(path.join(c.dir, 'prev.jsonl'), path.join(c.build, 'index.jsonl'))
        fs.writeFileSync(path.join(c.build, 'pages.jsonl'), '')
        fs.writeFileSync(path.join(c.dir, 'batch.txt'), '')
        assert.equal(c.run().status, 0)
        const rows = readJsonl<IndexRow>(path.join(c.build, 'index.jsonl'))
        assert.deepEqual(rows.filter((r) => r.sm).map((r) => r.o), [c.untouched.o])
        assert.ok(rows.some((r) => r.o === c.removed.o), 'pending removal remains recoverable')
    } finally { fs.rmSync(c.dir, { recursive: true, force: true }) }
})

test('Jenkins deploy withdraws first, checkpoints before targets, and publishes final sitemaps after uploads', () => {
    const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles!, 'Git', 'usr', 'bin', 'bash.exe') : 'bash'
    const pipeline = fs.readFileSync(path.join(ROOT, 'jenkins', 'kreditrisker-se.groovy'), 'utf8')
    const script = /stage\('Deploy'\)[\s\S]*?sh '''([\s\S]*?)'''/.exec(pipeline)![1].replace(/\r/g, '')
    const mock = `
        export PATH="/usr/bin:$PATH"
        aws() {
            printf '%s\\n' "$*" >> "$JOURNAL"
            if [ -n "$FAIL_PATTERN" ] && [[ "$*" == *"$FAIL_PATTERN"* ]]; then return 77; fi
            if [ "$1 $2" = 's3 cp' ] && [ "$4" = "$STATE_URI" ]; then cp "$3" "$STATE_LOCAL"; fi
            if [ "$1 $2" = 'cloudfront create-invalidation' ]; then printf 'test-invalidation\\n'; fi
            return 0
        }
    `
    for (const fail of ['', '--recursive dist', 's3 cp dist/sitemap-index.xml']) {
        const c = candidate()
        try {
            assert.equal(c.run().status, 0)
            fs.writeFileSync(path.join(c.build, 'removed.txt'), `foretag/${c.removed.o}/\n`)
            const journal = path.join(c.dir, 'aws.log')
            const state = path.join(c.dir, 'deployed-state.jsonl')
            const result = spawnSync(bash, ['--noprofile', '--norc', '-c', mock + script], {
                cwd: c.dir, encoding: 'utf8',
                env: { ...process.env, JOURNAL: journal.replaceAll('\\', '/'), STATE_LOCAL: state.replaceAll('\\', '/'), FAIL_PATTERN: fail, COMPANIES: '', BUILD_BUCKET: 'test-bucket', STATE_URI: 's3://test-state/index.jsonl', CLOUDFRONT_DISTRIBUTION_ID: 'test-distribution' },
            })
            assert.equal(result.status, fail ? 77 : 0, result.stdout + result.stderr)
            const commands = fs.readFileSync(journal, 'utf8').trim().split('\n')
            const locate = (match: string) => commands.findIndex((line) => line.includes(match))
            assert.ok(locate('s3 sync data/build/sitemap-withdrawal/') < locate('s3 cp data/build/index-checkpoint.jsonl'))
            assert.ok(locate('s3 cp data/build/index-checkpoint.jsonl') < locate('s3 cp --recursive dist'))
            assert.match(commands[locate('s3 cp --recursive dist')], /--exclude sitemap-\*\.xml/)
            const saved = readJsonl<IndexRow>(state)
            assert.deepEqual(saved.filter((r) => r.sm).map((r) => r.o), fail ? [c.untouched.o] : [c.row.o, c.untouched.o])
            if (fail === '--recursive dist') {
                assert.equal(locate('s3 sync dist/'), -1, 'upload failure cannot publish final sitemaps')
            } else {
                assert.ok(locate('cloudfront wait invalidation-completed') < locate('s3 cp --recursive dist'))
                assert.ok(locate('s3 sync dist/branscher/') < locate('s3 sync dist/ s3://test-bucket/ --delete --exclude * --include sitemap-companies-*.xml'))
                assert.ok(locate(`s3 rm --recursive s3://test-bucket/foretag/${c.removed.o}/`) < locate('s3 cp dist/sitemap-index.xml'))
                assert.ok(locate('s3 sync dist/ s3://test-bucket/ --delete --exclude * --include sitemap-companies-*.xml') < locate('s3 cp dist/sitemap-index.xml'))
                const indexUpload = locate('s3 cp dist/sitemap-index.xml')
                const stateUpload = locate('s3 cp data/build/index.jsonl')
                assert.ok(fail ? stateUpload === -1 : indexUpload < stateUpload)
            }
        } finally { fs.rmSync(c.dir, { recursive: true, force: true }) }
    }
})

test('real Astro incremental build verifies refreshed HTML while legacy targets stay outside the sitemap', () => {
    const c = candidate()
    try {
        for (const name of ['src', 'public', 'backend', 'node_modules']) fs.symlinkSync(path.join(ROOT, name), path.join(c.dir, name), 'junction')
        for (const name of ['package.json', 'astro.config.mjs', 'tsconfig.json']) fs.copyFileSync(path.join(ROOT, name), path.join(c.dir, name))
        fs.mkdirSync(path.join(c.dir, 'data/fixtures'), { recursive: true })
        fs.copyFileSync(path.join(ROOT, 'data/fixtures/synthetic-batch-001.jsonl'), path.join(c.dir, 'data/fixtures/synthetic-batch-001.jsonl'))
        const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'build'], {
            cwd: c.dir, encoding: 'utf8', maxBuffer: 10_000_000,
            env: { ...process.env, SE_DATA_SOURCE: 'build', SE_DATA_AS_OF: '2026-11-18', SE_INDEXING: '1', SE_COMPANY_SITEMAP: 'verified', SE_PREVIEW: '0', SE_BUILD_ONLY: '', SE_OUT_DIR: path.join(c.dir, 'dist') },
        })
        assert.equal(result.status, 0, result.stdout + result.stderr)
        const verified = c.run()
        assert.equal(verified.status, 0, verified.stdout + verified.stderr)
        const sitemap = fs.readFileSync(path.join(c.dir, 'dist/sitemap-companies-1.xml'), 'utf8')
        assert.ok(sitemap.includes(ORIGIN + c.page.path))
        assert.ok(!sitemap.includes(ORIGIN + c.legacy.p))
        assert.ok(!sitemap.includes(ORIGIN + c.thin.path))
    } finally { fs.rmSync(c.dir, { recursive: true, force: true }) }
})
