// Static search index for the client-side company search.
import { getSite } from '../../lib/store.ts'
import type { SearchHit } from '../../lib/search.ts'
import { periodLabel } from '../../lib/format.ts'

// ponytail: a static file is fine for previews; at national scale set
// PUBLIC_SE_SEARCH_ENDPOINT (CloudSearch, as on the Finnish site) and this ships empty.
const MAX_STATIC = 50_000

export function GET() {
    const rows = getSite().rows
    const hits: SearchHit[] = (rows.length > MAX_STATIC ? [] : rows).map((c) => {
        const h: SearchHit = { o: c.o, n: c.n, p: c.p }
        if (c.f) h.f = c.f
        if (c.k) h.k = c.k.name
        if (c.s) h.s = c.s.label
        if (c.st !== 'active') h.st = c.st
        if (c.per) h.y = periodLabel(c.per)
        if (c.fr !== 'current') h.fr = c.fr
        return h
    })
    return new Response(JSON.stringify(hits), { headers: { 'content-type': 'application/json' } })
}
