// Static search index for the client-side company search.
import { getSite } from '../../lib/store.ts'
import type { SearchHit } from '../../lib/search.ts'
import { periodLabel } from '../../lib/format.ts'

export function GET() {
    const hits: SearchHit[] = getSite().companies.map((c) => {
        const r = c.record
        const h: SearchHit = { o: r.orgnr, n: r.name, p: c.path }
        if (r.formerNames.length) h.f = r.formerNames.map((f) => f.name).join(' ')
        if (r.municipality) h.k = r.municipality.name
        if (r.sni[0]) h.s = r.sni[0].label
        if (r.status.code !== 'active') h.st = r.status.code
        if (r.periods[0]) h.y = periodLabel(r.periods[0])
        if (c.freshness !== 'current') h.fr = c.freshness
        return h
    })
    return new Response(JSON.stringify(hits), { headers: { 'content-type': 'application/json' } })
}
