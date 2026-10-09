// Segmented XML sitemaps. A URL is listed only if its page renders
// index,follow (same rule as Base.astro via isIndexable).

import { SITE } from '../config/site.ts'
import { GUIDES } from '../content/guides.ts'
import { MIN_RANKING_ENTRIES, recentlyUpdated, type Site } from './publish.ts'
import { isIndexable } from './seo.ts'

export const COMPANIES_PER_SITEMAP = 40_000

export interface SitemapUrl {
    path: string
    lastmod?: string
}

export function staticUrls(site: Site): SitemapUrl[] {
    const pages = ['/', '/rapporter/', '/rapporter/bas/', '/rapporter/ai/', '/rapporter/exempel/', '/metod/', '/kallor/', '/fragor/', '/om/', '/guider/', ...GUIDES.map((g) => `/guider/${g.slug}/`)]
    return pages.filter(() => isIndexable(false, site.synthetic)).map((path) => ({ path }))
}

export function hubUrls(site: Site): SitemapUrl[] {
    const out: SitemapUrl[] = []
    if (site.industries.some((h) => h.indexable)) out.push({ path: '/branscher/' })
    if (site.municipalities.some((h) => h.indexable)) out.push({ path: '/kommuner/' })
    for (const h of site.industries) if (h.indexable) out.push({ path: `/branscher/${h.slug}/` })
    for (const h of site.municipalities) if (h.indexable) out.push({ path: `/kommuner/${h.slug}/` })
    const rankings = site.rankings.filter((r) => r.entries.length >= MIN_RANKING_ENTRIES)
    if (recentlyUpdated(site.rows).length) out.push({ path: '/senast-uppdaterade/' })
    if (rankings.length) out.push({ path: '/topplistor/' })
    for (const r of rankings) out.push({ path: `/topplistor/${r.slug}/` })
    return out.filter(() => isIndexable(false, site.synthetic))
}

export function companyUrls(site: Site): SitemapUrl[] {
    return site.rows.filter((c) => isIndexable(!c.ix, site.synthetic)).map((c) => ({ path: c.p, lastmod: c.per?.filedAt ?? c.im }))
}

export function companyChunks(site: Site): SitemapUrl[][] {
    const urls = companyUrls(site)
    const chunks: SitemapUrl[][] = []
    for (let i = 0; i < urls.length; i += COMPANIES_PER_SITEMAP) chunks.push(urls.slice(i, i + COMPANIES_PER_SITEMAP))
    return chunks
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export function urlset(urls: SitemapUrl[]): string {
    const body = urls.map((u) => `<url><loc>${esc(SITE.origin + u.path)}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ''}</url>`).join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`
}

export function sitemapIndex(site: Site): string {
    const files = ['sitemap-pages.xml', 'sitemap-hubs.xml', ...companyChunks(site).map((_, i) => `sitemap-companies-${i + 1}.xml`)]
    const body = files.map((f) => `<sitemap><loc>${SITE.origin}/${f}</loc></sitemap>`).join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`
}
