// Sitemaps and robots decisions, with indexing switched on and a "real" copy
// of the fixtures (synthetic flag cleared) so the threshold does the work.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AS_OF, batch1 } from './helpers.ts'
import { luhnCheckDigit } from '../src/lib/orgnr.ts'

process.env.SE_INDEXING = '1'
const { siteFromRelease } = await import('../src/lib/publish.ts')
const { stageBatch, publishRelease, emptyRelease } = await import('../src/lib/pipeline.ts')
const { companyUrls, hubUrls, staticUrls, sitemapIndex, urlset } = await import('../src/lib/sitemap.ts')

const realRelease = () => {
    // Real records may not use group 0 or the synthetic source; remap both.
    const json = JSON.stringify(batch1().map((r) => ({ ...r, synthetic: false }))).replaceAll('"source":"synthetic"', '"source":"bolagsverket-arsredovisning"')
    const fixed = JSON.parse(json).map((r: { orgnr: string }) => ({ ...r, orgnr: '5' + r.orgnr.slice(1, 9) + luhnCheckDigit('5' + r.orgnr.slice(1, 9)) }))
    const staged = stageBatch(fixed, { batchId: 'real', importedAt: '2026-09-01T00:00:00Z', current: emptyRelease() })
    assert.equal(staged.rejected.length, 0, JSON.stringify(staged.rejected[0]))
    return publishRelease(staged, emptyRelease(), { releaseId: 'real', createdAt: '2026-09-01T00:00:00Z' })
}

test('synthetic dataset: every sitemap is empty even with indexing on', () => {
    const site = siteFromRelease(publishRelease(stageBatch(batch1(), { batchId: 's', importedAt: '2026-09-01T00:00:00Z', current: emptyRelease() }), emptyRelease(), { releaseId: 's', createdAt: '' }), AS_OF)
    assert.equal(companyUrls(site).length, 0)
    assert.equal(hubUrls(site).length, 0)
    assert.equal(staticUrls(site).length, 0)
})

test('real dataset: only threshold-passing canonical profiles are listed', () => {
    const site = siteFromRelease(realRelease(), AS_OF)
    const urls = companyUrls(site).map((u) => u.path)
    const indexable = site.companies.filter((c) => c.quality.indexable)
    assert.ok(indexable.length >= 10)
    assert.equal(urls.length, indexable.length)
    const names = (paths: string[]) => site.companies.filter((c) => paths.includes(c.path)).map((c) => c.record.name)
    const listed = names(urls)
    for (const excluded of ['Exempel Fastigheter Umeå AB', 'Exempel Metall Linköping AB', 'Exempel Nystart Stockholm AB'])
        assert.ok(!listed.includes(excluded), `${excluded} must not be in the sitemap`)
    assert.ok(!urls.some((u) => site.redirects.some((r) => r.from === u)), 'no redirect source in sitemap')
    assert.ok(companyUrls(site).every((u) => /^\d{4}-\d{2}-\d{2}$/.test(u.lastmod!)))
})

test('company sitemaps can be held back while old profiles still contain noindex', () => {
    const site = siteFromRelease(realRelease(), AS_OF)
    process.env.SE_COMPANY_SITEMAP = '0'
    try {
        assert.equal(companyUrls(site).length, 0)
        assert.doesNotMatch(sitemapIndex(site), /sitemap-companies-/)
        assert.ok(staticUrls(site).length > 0)
    } finally {
        delete process.env.SE_COMPANY_SITEMAP
    }
    assert.ok(companyUrls(site).length > 0)
})

test('real dataset: hubs need three indexable profiles; index lists segments', () => {
    const site = siteFromRelease(realRelease(), AS_OF)
    const hubs = hubUrls(site).map((u) => u.path)
    for (const h of site.industries) assert.equal(hubs.includes(`/branscher/${h.slug}/`), h.companies.filter((c) => c.ix).length >= 3, h.name)
    const xml = sitemapIndex(site)
    assert.match(xml, /sitemap-companies-1\.xml/)
    assert.match(urlset(companyUrls(site)), /<loc>https:\/\/.+\/foretag\/5\d{9}\/exempel-/)
})

test('paginated hub and bankruptcy sitemap URLs match per-page indexing thresholds', async () => {
    const { buildSite, toRow } = await import('../src/lib/publish.ts')
    const { bankruptcyHubPath } = await import('../src/lib/bankruptcy.ts')
    const company = siteFromRelease(realRelease(), AS_OF).companies.find((c) => c.quality.indexable)!
    const first = { ...toRow(company), st: 'bankruptcy' as const, ss: '2026-08-01' }
    const rows = Array.from({ length: 203 }, (_, i) => ({ ...first, o: String(i), n: `Företag ${i}`, p: `/foretag/${i}/test/` }))
    let site = buildSite([], rows, 'test')
    let paths = hubUrls(site).map((u) => u.path)
    assert.ok(paths.includes('/konkurser/'))
    assert.ok(paths.includes('/konkurser/foretag/2/'))
    assert.ok(paths.includes('/konkurser/foretag/3/'))
    for (const h of [...site.industries, ...site.municipalities]) {
        assert.ok(paths.includes(`${bankruptcyHubPath(h)}3/`))
        assert.ok(paths.includes(`/${h.kind === 'bransch' ? 'branscher' : 'kommuner'}/${h.slug}/2/`))
    }
    site = buildSite([], rows.slice(0, 202), 'test')
    paths = hubUrls(site).map((u) => u.path)
    assert.ok(!paths.includes('/konkurser/foretag/3/'), 'a two-company last page is crawlable but noindex and outside sitemap')
    assert.ok(!paths.some((p) => /^\/(branscher|kommuner)\/.+\/2\/$/.test(p)), 'a two-company hub last page is noindex')
    assert.ok(staticUrls(site).some((u) => u.path === '/konkurser/om-konkurs/'))
})


test('candidate sitemap subset excludes retained eligible companies without changing full hubs or rows', () => {
    const site = siteFromRelease(realRelease(), AS_OF)
    const before = companyUrls(site)
    const selected = site.rows.find((r) => r.p === before[0].path)!
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-sitemap-subset-'))
    const file = path.join(dir, 'selected.txt')
    fs.writeFileSync(file, `1\tx\tSelected\t1\t${selected.o}\n`)
    const old = process.env.SE_COMPANY_SITEMAP_FILE
    try {
        process.env.SE_COMPANY_SITEMAP_FILE = file
        assert.deepEqual(companyUrls(site).map((u) => u.path), [selected.p])
        process.env.SE_COMPANY_SITEMAP = '0'
        assert.deepEqual(companyUrls(site), [], 'the production hold takes precedence over a selected sitemap file')
        delete process.env.SE_COMPANY_SITEMAP
        assert.ok(site.rows.length > 1)
        assert.ok(hubUrls(site).length > 0)
    } finally {
        delete process.env.SE_COMPANY_SITEMAP
        if (old === undefined) delete process.env.SE_COMPANY_SITEMAP_FILE
        else process.env.SE_COMPANY_SITEMAP_FILE = old
    }
})
