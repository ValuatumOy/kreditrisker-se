import type { APIContext } from 'astro'
import { getSite } from '../lib/store.ts'
import { companyChunks, urlset } from '../lib/sitemap.ts'

export function getStaticPaths() {
    return companyChunks(getSite()).map((_, i) => ({ params: { n: String(i + 1) } }))
}
export const GET = ({ params }: APIContext) =>
    new Response(urlset(companyChunks(getSite())[Number(params.n) - 1] ?? []), { headers: { 'content-type': 'application/xml' } })
