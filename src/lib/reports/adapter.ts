// Report backend adapters. Selected by PUBLIC_SE_REPORT_ADAPTER.
//   disabled: every product unavailable (default, production-safe)
//   mock:     simulated lifecycle for development and preview only
//   http:     the future Swedish backend (endpoints documented in docs/REPORTS.md)
// Runs in the browser, so it must not import Node modules.

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
        async availability() {
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

export function httpBackend(base: string, fetchImpl: typeof fetch = fetch): ReportBackend {
    const call = async (path: string, init?: RequestInit): Promise<ReportState> => {
        try {
            const res = await fetchImpl(new URL(path, base), { ...init, headers: { 'content-type': 'application/json' } })
            if (!res.ok) return { kind: 'failure', code: `http_${res.status}`, retryable: res.status >= 500 }
            return parseState(await res.json())
        } catch {
            return { kind: 'unavailable', reason: 'backend_unreachable' }
        }
    }
    return {
        availability: (orgnr, product) => call(`se/reports/${product}/availability?orgnr=${encodeURIComponent(orgnr)}`),
        createOrder: (req) => call(`se/reports/${req.product}/orders`, { method: 'POST', body: JSON.stringify(req) }),
        orderStatus: (orderId, product) => call(`se/reports/${product}/orders/${encodeURIComponent(orderId)}`),
    }
}

/** Accepts only well-formed states from the backend; anything else is a failure. */
export function parseState(x: unknown): ReportState {
    const o = (x ?? {}) as Record<string, unknown>
    switch (o.kind) {
        case 'unavailable':
            return { kind: 'unavailable', reason: (['not_launched', 'company_not_supported', 'insufficient_data', 'backend_unreachable'].includes(o.reason as string) ? o.reason : 'not_launched') as never }
        case 'sample':
            return typeof o.sampleHref === 'string' ? { kind: 'sample', sampleHref: o.sampleHref } : bad()
        case 'available':
            return { kind: 'available' } // prices come only from VERIFIED_PRICES, never from the wire
        case 'processing':
            return typeof o.orderId === 'string' ? { kind: 'processing', orderId: o.orderId, startedAt: String(o.startedAt ?? '') } : bad()
        case 'success':
            return typeof o.orderId === 'string' && typeof o.downloadHref === 'string' && /^https:\/\//.test(o.downloadHref)
                ? { kind: 'success', orderId: o.orderId, downloadHref: o.downloadHref, expiresAt: typeof o.expiresAt === 'string' ? o.expiresAt : undefined }
                : bad()
        case 'failure':
            return { kind: 'failure', orderId: typeof o.orderId === 'string' ? o.orderId : undefined, code: String(o.code ?? 'unknown'), retryable: o.retryable === true }
        default:
            return bad()
    }
}
const bad = (): ReportState => ({ kind: 'failure', code: 'malformed_response', retryable: true })

export function selectBackend(kind: string | undefined, apiBase: string | undefined): ReportBackend {
    if (kind === 'http' && apiBase) return httpBackend(apiBase)
    if (kind === 'mock') return mockBackend()
    return disabledBackend
}
