// Sitemaps and robots decisions, with indexing switched on and a "real" copy
// of the fixtures (synthetic flag cleared) so the threshold does the work.

import { test } from 'node:test'
import assert from 'node:assert/strict'
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

test('real dataset: hubs need three indexable profiles; index lists segments', () => {
    const site = siteFromRelease(realRelease(), AS_OF)
    const hubs = hubUrls(site).map((u) => u.path)
    for (const h of site.industries) assert.equal(hubs.includes(`/branscher/${h.slug}/`), h.companies.filter((c) => c.ix).length >= 3, h.name)
    const xml = sitemapIndex(site)
    assert.match(xml, /sitemap-companies-1\.xml/)
    assert.match(urlset(companyUrls(site)), /<loc>https:\/\/.+\/foretag\/5\d{9}\/exempel-/)
})
