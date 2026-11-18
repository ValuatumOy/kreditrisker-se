// Finalize a normal incremental build after checking the actual company HTML.
// The withdrawal files and checkpoint are deployed before any target changes.
import fs from 'node:fs'
import path from 'node:path'
import { SITE } from '../src/config/site.ts'
import type { PublishedCompany } from '../src/lib/contract/types.ts'
import { distinctCompanyRows, verifyCompanyHtml } from '../src/lib/company-sitemap.ts'
import { readJsonl, writeJsonl } from '../src/lib/jsonl.ts'
import { buildSite, type IndexRow } from '../src/lib/publish.ts'
import { pageIndexable } from '../src/lib/seo.ts'
import { companyChunks, sitemapIndex, urlset } from '../src/lib/sitemap.ts'
import { readParams } from '../src/lib/valuatum/params.ts'

if (process.env.SE_COMPANY_SITEMAP !== 'verified') throw new Error('Company sitemap verification requires SE_COMPANY_SITEMAP=verified')
if (!process.env.SE_INDEX_IN || !process.env.BUILD_STATIC_PARAMS_FILE) throw new Error('Company sitemap verification requires the previous index and selected batch')
const build = path.resolve('data/build')
const dist = path.resolve(process.env.SE_OUT_DIR ?? 'dist')
const previous = readJsonl<IndexRow>(process.env.SE_INDEX_IN)
const rows = readJsonl<IndexRow>(path.join(build, 'index.jsonl'))
const pages = readJsonl<PublishedCompany>(path.join(build, 'pages.jsonl'))
if (!previous.length || !rows.length) throw new Error('Refusing an empty company sitemap index state')
distinctCompanyRows(previous)
distinctCompanyRows(rows)
distinctCompanyRows(pages.map((p) => ({ o: p.record.orgnr, p: p.path })))
const byId = new Map(rows.map((r) => [r.o, r]))
const synthetic = rows.some((r) => r.syn)
const batch = readParams(process.env.BUILD_STATIC_PARAMS_FILE!)
const touched = new Set(batch.flatMap((p) => p.orgnr ? [p.orgnr] : []))
for (const page of pages) {
    const row = byId.get(page.record.orgnr)
    if (!row || row.p !== page.path || row.ix !== page.quality.indexable || row.syn !== page.record.synthetic)
        throw new Error(`Company page differs from index: ${page.path}`)
    const indexable = pageIndexable(!row.ix, synthetic)
    verifyCompanyHtml(fs.readFileSync(path.join(dist, page.path, 'index.html'), 'utf8'), SITE.origin + page.path, indexable)
    delete row.sm
    if (indexable) row.sm = true
    touched.add(row.o)
}
// No failed fetch, removal, or untouched legacy row can acquire eligibility.
const rendered = new Set(pages.map((p) => p.record.orgnr as string))
const oldById = new Map(previous.map((r) => [r.o, r]))
for (const row of rows) {
    if (rendered.has(row.o)) continue
    const old = oldById.get(row.o)
    if (touched.has(row.o)) delete row.sm
    if (row.sm && (!old?.sm || old.p !== row.p || old.ix !== row.ix || old.syn !== row.syn))
        throw new Error(`Unverified sitemap eligibility: ${row.p}`)
}
const checkpoint = previous.map((row) => {
    const copy = { ...row }
    if (touched.has(row.o) || !byId.has(row.o)) delete copy.sm
    return copy
})
function writeSitemaps(directory: string, index: IndexRow[]) {
    fs.mkdirSync(directory, { recursive: true })
    for (const name of fs.readdirSync(directory)) if (/^sitemap-companies-\d+\.xml$/.test(name)) fs.unlinkSync(path.join(directory, name))
    const site = buildSite([], index, 'build')
    companyChunks(site).forEach((chunk, i) => fs.writeFileSync(path.join(directory, `sitemap-companies-${i + 1}.xml`), urlset(chunk)))
    fs.writeFileSync(path.join(directory, 'sitemap-index.xml'), sitemapIndex(site))
}
writeSitemaps(dist, rows)
writeSitemaps(path.join(build, 'sitemap-withdrawal'), checkpoint)
writeJsonl(path.join(build, 'index-checkpoint.jsonl'), checkpoint)
writeJsonl(path.join(build, 'index.jsonl'), rows)
console.log(`Verified ${pages.length} distinct company pages; ${rows.filter((r) => r.sm).length} HTML-verified sitemap candidates`)
