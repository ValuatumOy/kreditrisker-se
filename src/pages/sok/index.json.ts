// Static search index for the client-side company search.
import { getSite } from '../../lib/store.ts'
import { toSearchHit } from '../../lib/search.ts'

// ponytail: a static file is fine for previews; at national scale set
// PUBLIC_SE_SEARCH_ENDPOINT (the search Lambda, search/handler.ts) and this ships empty.
const MAX_STATIC = 50_000

export function GET() {
    const rows = getSite().rows
    const hits = (rows.length > MAX_STATIC ? [] : rows).map(toSearchHit)
    return new Response(JSON.stringify(hits), { headers: { 'content-type': 'application/json' } })
}
