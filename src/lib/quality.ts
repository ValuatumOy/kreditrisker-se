// Minimum-quality threshold for indexing a company profile.
// Documented for editors on /metod/ and in docs/DATA-CONTRACT.md.
//
// A profile is publishable (a page is generated) unless it is an enskild
// näringsidkare and sole-trader publishing is off: their orgnr is a personnummer.
//
// A publishable profile is indexable only if ALL of these hold:
//   1. not synthetic
//   2. registration status is known
//   3. municipality and a primary SNI code are present
//   4. at least one fiscal period exists and the newest is not stale
//   5. the newest period reports at least MIN_CORE_ITEMS of the CORE_ITEMS
// Everything else gets <meta name="robots" content="noindex,follow"> and is
// left out of the sitemaps. The global INDEXING flag overrides to noindex.

import type { CompanyRecord, Freshness, QualityVerdict } from './contract/types.ts'

export const CORE_ITEMS = [
    ['income', 'netSales'],
    ['income', 'operatingProfit'],
    ['income', 'netProfit'],
    ['balance', 'totalAssets'],
    ['balance', 'equity'],
    ['balance', 'currentLiabilities'],
    ['employees', ''],
] as const
export const MIN_CORE_ITEMS = 5
export const SYNTHETIC_REASON = 'syntetiska testdata'

export function coreItemsReported(record: CompanyRecord): number {
    const p = record.periods[0]
    if (!p) return 0
    let n = 0
    for (const [group, key] of CORE_ITEMS) {
        const v = group === 'employees' ? p.employees : (p[group] as unknown as Record<string, { status: string }>)[key]
        if (v?.status === 'reported') n++
    }
    return n
}

export function assessQuality(
    record: CompanyRecord,
    freshness: Freshness,
    opts: { publishSoleTraders: boolean },
): QualityVerdict {
    const reasons: string[] = []
    const publishable = record.legalForm !== 'EF' || opts.publishSoleTraders
    if (!publishable) reasons.push('enskild näringsidkare: personuppgifter, sidan genereras inte')
    if (record.synthetic) reasons.push(SYNTHETIC_REASON)
    if (record.status.code === 'unknown') reasons.push('registreringsstatus okänd')
    if (!record.municipality) reasons.push('kommun saknas')
    if (!record.sni[0]) reasons.push('SNI-kod saknas')
    if (freshness === 'none') reasons.push('inget bokslut')
    if (freshness === 'stale') reasons.push('senaste bokslut äldre än 31 månader')
    const core = coreItemsReported(record)
    if (freshness !== 'none' && core < MIN_CORE_ITEMS) reasons.push(`för få nyckelposter (${core}/${CORE_ITEMS.length}, krav ${MIN_CORE_ITEMS})`)
    const meetsThreshold = publishable && reasons.every((r) => r === SYNTHETIC_REASON)
    return { publishable, meetsThreshold, indexable: meetsThreshold && !record.synthetic, score: core, reasons }
}
