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
    remainingMs: number
    validUntil: number
    analyticsExperiment?: string
    analyticsVariant?: string
}

export async function loadReportOffer(base: string, orgnr: string | undefined, fetchImpl: typeof fetch = fetch, origin = globalThis.location?.origin, now = () => performance.now()): Promise<ReportOffer> {
    const startedAt = now()
    const url = new URL('create-checkout', new URL(base, origin))
    url.search = new URLSearchParams({ reportType: 'se_credit_risk', offer: orgnr ? '1' : 'summary', ...(orgnr ? { businessId: formatOrgnr(orgnr) } : {}) }).toString()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10000)
    let value
    try {
        const response = await fetchImpl(url, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal })
        if (!response.ok) throw new Error('Price unavailable')
        value = await response.json()
    } finally { clearTimeout(timeout) }
    if (value.reportType !== 'se_credit_risk' || !Number.isSafeInteger(value.unitAmount) || value.unitAmount <= 0 ||
        value.currency !== 'sek' || value.taxBehavior !== 'inclusive' || !Number.isInteger(value.expiresAt) ||
        !Number.isFinite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > 300000 ||
        (!orgnr && typeof value.from !== 'boolean') || (orgnr && value.from !== undefined) ||
        (value.quote !== undefined && (typeof value.quote !== 'string' || value.quote.length > 2048)))
        throw new Error('Invalid price offer')
    const validUntil = startedAt + value.remainingMs
    if (validUntil <= now()) throw new Error('Expired price offer')
    return { ...value, validUntil }
}

export const offerRemainingMs = (offer: ReportOffer, now = performance.now()) => Math.max(0, offer.validUntil - now)

export function offerLabel(offer: ReportOffer): string {
    return `${offer.from ? 'Från ' : ''}${(offer.unitAmount / 100).toLocaleString('sv-SE')} kr inkl. moms för konsument i Sverige`
}
