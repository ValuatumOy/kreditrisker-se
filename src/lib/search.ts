// Company search shared by the build (index generation) and the browser.
// Static builds ship /sok/index.json; at national scale set
// PUBLIC_SE_SEARCH_ENDPOINT to the search API (/api/search: the search Lambda,
// search/handler.ts), which returns the same SearchHit[].

import { periodLabel } from './format.ts'
import type { IndexRow } from './publish.ts'

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

/** The hit for a directory row (static index and search database alike). */
export function toSearchHit(c: IndexRow): SearchHit {
    const h: SearchHit = { o: c.o, n: c.n, p: c.p }
    if (c.f) h.f = c.f
    if (c.k) h.k = c.k.name
    if (c.s) h.s = c.s.label
    if (c.st !== 'active') h.st = c.st
    if (c.per) h.y = periodLabel(c.per)
    if (c.fr !== 'current') h.fr = c.fr
    return h
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

export const LEGAL_SUFFIX = /\b(ab|hb|kb|publ|aktiebolag|aktiebolaget|handelsbolag)\b/g

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

/** Search API response to SearchHit[]: keeps only well-formed hits that link inside the site. */
export function fromSearchApi(body: unknown): SearchHit[] {
    if (!Array.isArray(body)) return []
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
    return body.flatMap((x: Record<string, unknown>) => {
        const h: SearchHit = { o: str(x?.o) ?? '', n: str(x?.n) ?? '', p: str(x?.p) ?? '' }
        if (!h.o || !h.n || !h.p.startsWith('/foretag/')) return []
        for (const k of ['f', 'k', 's', 'st', 'y', 'fr'] as const) if (str(x[k])) h[k] = str(x[k])
        return [h]
    })
}

/** Company search for the browser: the search API when configured, else the static index. */
export async function findCompanies(endpoint: string | undefined, q: string, limit = 8, staticIndex?: () => Promise<SearchHit[]>): Promise<SearchHit[]> {
    if (endpoint) {
        if (q.trim().length < 2) return []
        const res = await fetch(`${endpoint}?q=${encodeURIComponent(q)}&size=${Math.min(limit, 99)}`).catch(() => null)
        return res?.ok ? fromSearchApi(await res.json().catch(() => null)) : []
    }
    const index = staticIndex ? await staticIndex() : await fetch('/sok/index.json').then((r) => (r.ok ? r.json() : [])).catch(() => [])
    return searchIndex(index, q, limit)
}
