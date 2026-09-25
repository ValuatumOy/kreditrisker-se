import { getSite } from '../lib/store.ts'
import { hubUrls, urlset } from '../lib/sitemap.ts'
export const GET = () => new Response(urlset(hubUrls(getSite())), { headers: { 'content-type': 'application/xml' } })
