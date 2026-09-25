// Company search shared by the build (index generation) and the browser.
// Static builds ship /sok/index.json; at national scale set
// PUBLIC_SE_SEARCH_ENDPOINT to a search API that returns the same SearchHit[].

export interface SearchHit {
    /** orgnr, 10 digits */
    o: string
    /** current name */
    n: string
    /** former names, joined */
    f?: string
    /** municipality */
    k?: string
    /** primary SNI label */
    s?: string
    /** canonical path */
    p: string
    /** status code when not active */
    st?: string
    /** newest fiscal year label */
    y?: string
    /** freshness of newest report when not current: aging | stale | none */
    fr?: string
}

export function norm(s: string): string {
    return s
        .toLocaleLowerCase('sv-SE')
        .replace(/[åä]/g, 'a')
        .replace(/ö/g, 'o')
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

const LEGAL_SUFFIX = /\b(ab|hb|kb|publ|aktiebolag|handelsbolag)\b/g

/** Ranked match: orgnr prefix, then name prefix, then all tokens, then former names. */
export function searchIndex(index: SearchHit[], query: string, limit = 8): SearchHit[] {
    const digits = query.replace(/[\s-]/g, '')
    if (/^\d{2,10}$/.test(digits)) return index.filter((h) => h.o.startsWith(digits)).slice(0, limit)
    const q = norm(query).replace(LEGAL_SUFFIX, '').trim()
    if (q.length < 2) return []
    const tokens = q.split(' ')
    const scored: { h: SearchHit; score: number }[] = []
    for (const h of index) {
        const name = norm(h.n)
        let score = 0
        if (name.startsWith(q)) score = 4
        else if (name.split(' ').some((w) => w.startsWith(q))) score = 3
        else if (tokens.every((t) => name.includes(t))) score = 2
        else if (h.f && tokens.every((t) => norm(h.f!).includes(t))) score = 1
        if (score) scored.push({ h, score })
    }
    return scored
        .sort((a, b) => b.score - a.score || a.h.n.localeCompare(b.h.n, 'sv'))
        .slice(0, limit)
        .map((x) => x.h)
}
