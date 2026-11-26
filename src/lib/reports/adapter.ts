// Report backend adapters. Selected by PUBLIC_SE_REPORT_ADAPTER.
//   disabled: every product unavailable (default, production-safe)
//   mock:     simulated lifecycle for development and preview only
//   http:     the Stripe checkout backend in backend/ (PUBLIC_SE_REPORT_API=/api/)
// Runs in the browser, so it must not import Node modules.

import { formatOrgnr } from '../orgnr.ts'
import { fetchCheckoutPrice, loadReportOffer } from './offers.ts'
import priceTargets from '../../../backend/src/lib/report-price-targets.json' with { type: 'json' }
import type { OrderRequest, ReportBackend, ReportProduct, ReportState } from './types.ts'

export const disabledBackend: ReportBackend = {
    async availability() {
        return { kind: 'unavailable', reason: 'not_launched' }
    },
    async createOrder() {
        return { kind: 'unavailable', reason: 'not_launched' }
    },
    async orderStatus() {
        return { kind: 'unavailable', reason: 'not_launched' }
    },
}

/**
 * Deterministic mock: orders whose email contains "fail" fail, others succeed
 * after `processingMs`. Never used in indexable builds (enforced in config).
 */
export function mockBackend(processingMs = 2500, now: () => number = Date.now): ReportBackend {
    const orders = new Map<string, { product: ReportProduct; fail: boolean; at: number }>()
    return {
        async availability(_, product) {
            if (product === 'ai') return {
                kind: 'available',
                price: { amountSek: priceTargets.ai / 100, vatIncluded: true },
                fraudAddonSek: priceTargets.fraudAddon / 100,
            }
            return { kind: 'available' }
        },
        async createOrder(req: OrderRequest) {
            const orderId = `mock-${req.product}-${orders.size + 1}`
            orders.set(orderId, { product: req.product, fail: req.email.includes('fail'), at: now() })
            return { kind: 'processing', orderId, startedAt: new Date(now()).toISOString() }
        },
        async orderStatus(orderId: string) {
            const o = orders.get(orderId)
            if (!o) return { kind: 'failure', orderId, code: 'unknown_order', retryable: false }
            if (now() - o.at < processingMs) return { kind: 'processing', orderId, startedAt: new Date(o.at).toISOString() }
            if (o.fail) return { kind: 'failure', orderId, code: 'generation_failed', retryable: true }
            return { kind: 'success', orderId, downloadHref: '#mock-download' }
        },
    }
}

/** Swedish product ids in the checkout backend (backend/src/lib/products.js). */
export const REPORT_TYPE: Record<ReportProduct, string> = { basic: 'se_credit_risk', ai: 'se_ai_credit_risk' }

/**
 * The checkout backend (backend/, ported from the Danish directory): POST
 * /api/create-checkout returns a Stripe Checkout URL. Payment is authorised,
 * the report generated, then captured and emailed; a failed report is never
 * charged. The backend supplies the prices and selects the Stripe line items.
 */
export function httpBackend(base: string, fetchImpl: typeof fetch = fetch, origin = globalThis.location?.origin): ReportBackend {
    return {
        async availability(orgnr, product) {
            try {
                if (product === 'ai') {
                    const url = new URL('create-checkout', new URL(base, origin))
                    url.search = new URLSearchParams({ reportType: REPORT_TYPE.ai, offer: '1', businessId: formatOrgnr(orgnr) }).toString()
                    const quote = await fetchCheckoutPrice(url, fetchImpl)
                    if (quote.reportType !== REPORT_TYPE.ai || quote.currency !== 'sek' ||
                        quote.unitAmount !== priceTargets.ai || quote.taxBehavior !== 'inclusive' ||
                        (quote.fraudAddonCents !== undefined && quote.fraudAddonCents !== priceTargets.fraudAddon))
                        throw new Error('Invalid AI report price')
                    return {
                        kind: 'available',
                        price: { amountSek: quote.unitAmount / 100, vatIncluded: true },
                        fraudAddonSek: quote.fraudAddonCents === undefined ? undefined : quote.fraudAddonCents / 100,
                    }
                }
                const offer = await loadReportOffer(base, orgnr, fetchImpl, origin)
                return { kind: 'available', offer, price: { amountSek: offer.unitAmount / 100, vatIncluded: true } }
            } catch { return { kind: 'unavailable', reason: 'backend_unreachable' } }
        },
        async createOrder(req) {
            try {
                const res = await fetchImpl(new URL('create-checkout', new URL(base, origin)), {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        reportType: REPORT_TYPE[req.product],
                        fid: req.fid,
                        // Valuatum stores a Swedish organisationsnummer with its dash (556987-6542)
                        businessId: formatOrgnr(req.orgnr),
                        companyName: req.companyName,
                        email: req.email,
                        acceptedTermsVersion: req.acceptedTermsVersion,
                        priceQuote: req.priceQuote,
                        ...(req.product === 'ai' ? { includeFraud: req.includeFraud === true } : {}),
                        lang: 'sv',
                        reportLang: 'sv',
                        cancelPath: req.returnPath,
                    }),
                })
                if (!res.ok) return { kind: 'failure', code: `http_${res.status}`, retryable: res.status >= 500 }
                const { url } = (await res.json()) as { url?: unknown }
                return typeof url === 'string' && url.startsWith('https://checkout.stripe.com/') ? { kind: 'redirect', url } : { kind: 'failure', code: 'malformed_response', retryable: true }
            } catch {
                return { kind: 'unavailable', reason: 'backend_unreachable' }
            }
        },
        async orderStatus() {
            return { kind: 'paid' } // delivery is by email; there is no status endpoint
        },
    }
}

export function selectBackend(kind: string | undefined, apiBase: string | undefined): ReportBackend {
    if (kind === 'http' && apiBase) return httpBackend(apiBase)
    if (kind === 'mock') return mockBackend()
    return disabledBackend
}
