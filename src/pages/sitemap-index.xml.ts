import { getSite } from '../lib/store.ts'
import { sitemapIndex } from '../lib/sitemap.ts'
export const GET = () => new Response(sitemapIndex(getSite()), { headers: { 'content-type': 'application/xml' } })
