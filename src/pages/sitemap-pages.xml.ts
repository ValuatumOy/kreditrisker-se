import { getSite } from '../lib/store.ts'
import { staticUrls, urlset } from '../lib/sitemap.ts'
export const GET = () => new Response(urlset(staticUrls(getSite())), { headers: { 'content-type': 'application/xml' } })
