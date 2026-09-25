// Build-time availability of each report product for a company. The static
// page shows this; the order page may refine it at runtime via the adapter.

import { FLAGS, VERIFIED_PRICES, type ReportMode } from '../../config/site.ts'
import type { PublishedCompany } from '../contract/types.ts'
import type { ReportProduct, ReportState } from './types.ts'

export const SAMPLE_HREF: Record<ReportProduct, string> = {
    basic: '/rapporter/exempel/#basrapport',
    ai: '/rapporter/exempel/#ai-rapport',
}

export function staticReportState(
    product: ReportProduct,
    company: PublishedCompany | null,
    mode: ReportMode = FLAGS.reports[product],
    checkout: boolean = FLAGS.checkout,
): ReportState {
    if (mode === 'unavailable') return { kind: 'unavailable', reason: 'not_launched' }
    if (mode === 'sample') return { kind: 'sample', sampleHref: SAMPLE_HREF[product] }
    // mode === 'live': still unavailable until real checkout is switched on.
    if (!checkout) return { kind: 'unavailable', reason: 'not_launched' }
    if (company && company.record.legalForm === 'EF') return { kind: 'unavailable', reason: 'company_not_supported' }
    if (company && company.record.periods.length === 0) return { kind: 'unavailable', reason: 'insufficient_data' }
    const price = VERIFIED_PRICES[product]
    return { kind: 'available', price: price && { amountSek: price.amountSek, vatIncluded: price.vatIncluded } }
}
