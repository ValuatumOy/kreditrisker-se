// Where a company stands in its industry: the median of each key figure and its
// place by net sales. Built from the index rows, so it covers the whole
// directory even when only a batch of pages is built.

import type { Hub, IndexRow } from './publish.ts'

/** A median is shown only with at least this many companies behind it. */
export const MIN_PEERS = 10

export const PEER_FIELDS = ['ns', 'om', 'er', 'rg', 'emp'] as const
export type PeerField = (typeof PEER_FIELDS)[number]

export interface Benchmark {
    rows: { field: PeerField; value: number; median: number; peers: number }[]
    /** Place by net sales among the `ranked` companies, largest first. */
    place?: number
    ranked: number
}

// Same selection as the rankings: a current report covering 12 months.
const comparable = (r: IndexRow) => r.fr === 'current' && r.per?.months === 12

const cache = new WeakMap<Hub, { sorted: Record<PeerField, number[]>; place: Map<string, number> }>()

const median = (s: number[]) => (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2)

export function benchmark(hub: Hub, row: IndexRow): Benchmark | null {
    if (!comparable(row)) return null
    let c = cache.get(hub)
    if (!c) {
        const peers = hub.companies.filter(comparable)
        const sorted = Object.fromEntries(PEER_FIELDS.map((f) => [f, peers.flatMap((r) => (r[f] === undefined ? [] : [r[f]])).sort((a, b) => a - b)])) as Record<PeerField, number[]>
        // hub.companies is ordered by net sales, largest first.
        cache.set(hub, (c = { sorted, place: new Map(peers.filter((r) => r.ns !== undefined).map((r, i) => [r.o, i + 1])) }))
    }
    const { sorted, place } = c
    const rows = PEER_FIELDS.flatMap((field) => {
        const value = row[field]
        return value === undefined || sorted[field].length < MIN_PEERS ? [] : [{ field, value, median: median(sorted[field]), peers: sorted[field].length }]
    })
    return rows.length ? { rows, place: sorted.ns.length >= MIN_PEERS ? place.get(row.o) : undefined, ranked: sorted.ns.length } : null
}
