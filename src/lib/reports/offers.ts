import { formatOrgnr } from '../orgnr.ts'

export interface ReportOffer {
    unitAmount: number
    currency: 'sek'
    taxBehavior: 'inclusive'
    expiresAt: number
    quote?: string
    version?: string
    experimentId?: string
    variantId?: string
    from?: boolean
}

export async function loadReportOffer(base: string, orgnr: string | undefined, fetchImpl: typeof fetch = fetch, origin = globalThis.location?.origin): Promise<ReportOffer> {
    const url = new URL('create-checkout', new URL(base, origin))
    url.search = new URLSearchParams({ reportType: 'se_credit_risk', offer: orgnr ? '1' : 'summary', ...(orgnr ? { businessId: formatOrgnr(orgnr) } : {}) }).toString()
    const response = await fetchImpl(url, { cache: 'no-store', credentials: 'same-origin', signal: AbortSignal.timeout(10000) })
    if (!response.ok) throw new Error('Price unavailable')
    const value = await response.json()
    if (value.reportType !== 'se_credit_risk' || !Number.isSafeInteger(value.unitAmount) || value.unitAmount <= 0 ||
        value.currency !== 'sek' || value.taxBehavior !== 'inclusive' || !Number.isInteger(value.expiresAt) ||
        value.expiresAt <= Date.now() / 1000 || value.expiresAt > Date.now() / 1000 + 310 ||
        (!orgnr && typeof value.from !== 'boolean') || (orgnr && value.from !== undefined) ||
        (value.quote !== undefined && (typeof value.quote !== 'string' || value.quote.length > 2048)))
        throw new Error('Invalid price offer')
    return value
}

export function offerLabel(offer: ReportOffer): string {
    return `${offer.from ? 'Från ' : ''}${(offer.unitAmount / 100).toLocaleString('sv-SE')} kr inkl. moms för konsument i Sverige`
}
