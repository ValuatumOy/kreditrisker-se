import { SITE } from '../config/site.ts'
import { getSite } from '../lib/store.ts'
import { isIndexable } from '../lib/seo.ts'

export function GET() {
    const open = isIndexable(false, getSite().synthetic)
    const body = open
        ? `User-agent: *\nDisallow: /bestall/\nDisallow: /sok/\n\nSitemap: ${SITE.origin}/sitemap-index.xml\n`
        : `# Pre-launch or staging: nothing may be indexed.\nUser-agent: *\nDisallow: /\n`
    return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
