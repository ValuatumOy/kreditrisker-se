// Isolated synthetic-only build: exercises real routes beyond both page sizes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fixtureRelease } from '../src/lib/store.ts'
import { publishCompany, toRow } from '../src/lib/publish.ts'
import { luhnCheckDigit } from '../src/lib/orgnr.ts'
import { writeJsonl } from '../src/lib/jsonl.ts'

const root = process.cwd()
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'se-bankruptcy-build-'))
for (const name of ['src', 'public', 'backend', 'node_modules']) fs.symlinkSync(path.join(root, name), path.join(temp, name), 'junction')
for (const name of ['package.json', 'astro.config.mjs', 'tsconfig.json']) fs.copyFileSync(path.join(root, name), path.join(temp, name))
fs.mkdirSync(path.join(temp, 'data', 'fixtures'), { recursive: true })
fs.copyFileSync(path.join(root, 'data', 'fixtures', 'synthetic-batch-001.jsonl'), path.join(temp, 'data', 'fixtures', 'synthetic-batch-001.jsonl'))
const base = fixtureRelease().companies[0]
const pages = Array.from({ length: 203 }, (_, i) => {
    const r = structuredClone(base)
    const number = `002${String(100000 + i).padStart(6, '0')}`
    r.orgnr = (number + luhnCheckDigit(number)) as typeof r.orgnr
    r.name = `Syntetiskt konkursbolag ${String(i).padStart(3, '0')} AB`
    r.formerNames = []
    r.status.code = 'bankruptcy'
    r.status.since = i === 0 ? undefined : i === 1 ? '2024-01-01' : '2026-10-01'
    return publishCompany(r, undefined, '2026-11-11')
})
const buildDir = path.join(temp, 'data', 'build')
fs.mkdirSync(buildDir, { recursive: true })
writeJsonl(path.join(buildDir, 'pages.jsonl'), pages)
writeJsonl(path.join(buildDir, 'index.jsonl'), pages.map(toRow))
const result = spawnSync(process.execPath, [path.join(root, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build'], {
    cwd: temp, encoding: 'utf8', maxBuffer: 10_000_000,
    env: { ...process.env, SE_DATA_SOURCE: 'build', SE_DATA_AS_OF: '2026-11-11', SE_INDEXING: '1', SE_PREVIEW: '0', SE_BUILD_ONLY: '', SE_OUT_DIR: path.join(temp, 'dist') },
})
assert.equal(result.status, 0, result.stdout + result.stderr)
const read = (url: string) => fs.readFileSync(path.join(temp, 'dist', url, 'index.html'), 'utf8')
const index = pages.map(toRow)
const { buildSite } = await import('../src/lib/publish.ts')
const site = buildSite(pages, index, 'synthetic-test')
const hubPaths = [`/branscher/${site.industries[0].slug}/`, `/kommuner/${site.municipalities[0].slug}/`]
const listPaths = ['/konkurser/foretag/', `/konkurser/branscher/${site.industries[0].slug}/`, `/konkurser/kommuner/${site.municipalities[0].slug}/`]
for (const base of [...hubPaths, ...listPaths]) {
    const first = read(base)
    const second = read(`${base}2/`)
    const canonical = /<link rel="canonical" href="([^"]+)"/.exec(first)![1]
    assert.ok(second.includes(`rel="canonical" href="${canonical}2/"`), base)
    assert.ok(first.includes(`href="${base}2/" rel="next"`), `${base} next link`)
    assert.ok(second.includes(`href="${base}" rel="prev"`), `${base} previous link`)
    assert.match(second, /name="robots" content="noindex,follow"/)
}
for (const base of listPaths) {
    assert.ok(read(`${base}2/`).includes(`href="${base}3/" rel="next"`))
    assert.match(read(`${base}3/`), new RegExp(`href="${base}"[^>]*>Första sidan`))
}
const overview = read('/konkurser/')
assert.match(overview, /ingen fullständig konkursstatistik/)
assert.match(overview, /Syntetiska testdata/)
assert.match(read(pages[0].path), /href="\/konkurser\/"/)
const out = path.join(temp, 'dist')
assert.match(fs.readFileSync(path.join(out, 'robots.txt'), 'utf8'), /Disallow: \/\s*$/)
for (const file of ['sitemap-pages.xml', 'sitemap-hubs.xml']) assert.doesNotMatch(fs.readFileSync(path.join(out, file), 'utf8'), /<url>/)
console.log(`Synthetic route build passed: 203 companies, ${hubPaths.length} hubs, ${listPaths.length} bankruptcy lists. Output: ${out}`)
