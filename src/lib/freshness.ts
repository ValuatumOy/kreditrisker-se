// Freshness of a company's newest annual report, relative to the data as-of date.
//
// Aktiebolag must file within 7 months of the fiscal year end, so the newest
// report that should exist ends at most 19 months before as-of.
//   current: newest period ended <= 19 months before as-of
//   aging:   19-31 months (one filing missed or late)
//   stale:   > 31 months (two or more years without a report)
//   none:    no fiscal periods at all

import type { CompanyRecord, Freshness } from './contract/types.ts'

export const CURRENT_MONTHS = 19
export const STALE_MONTHS = 31

export function monthsBetween(fromIso: string, toIso: string): number {
    const a = new Date(fromIso + 'T00:00:00Z')
    const b = new Date(toIso + 'T00:00:00Z')
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + (b.getUTCDate() - a.getUTCDate()) / 31
}

export function freshnessOf(record: CompanyRecord, asOf: string): Freshness {
    const latest = record.periods[0]
    if (!latest) return 'none'
    const age = monthsBetween(latest.end, asOf)
    if (age <= CURRENT_MONTHS) return 'current'
    if (age <= STALE_MONTHS) return 'aging'
    return 'stale'
}
