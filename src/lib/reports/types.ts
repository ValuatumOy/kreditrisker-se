// Report products and their states. Basic and AI are modelled separately:
// each has its own availability, order and delivery lifecycle.

export type ReportProduct = 'basic' | 'ai'

export type UnavailableReason =
    | 'not_launched' // Product not live in Sweden yet
    | 'company_not_supported' // Legal form or data not supported
    | 'insufficient_data' // No usable annual report
    | 'backend_unreachable'

export type ReportState =
    | { kind: 'unavailable'; reason: UnavailableReason }
    | { kind: 'sample'; sampleHref: string }
    | { kind: 'available'; price?: { amountSek: number; vatIncluded: boolean } }
    | { kind: 'processing'; orderId: string; startedAt: string }
    | { kind: 'success'; orderId: string; downloadHref: string; expiresAt?: string }
    | { kind: 'failure'; orderId?: string; code: string; retryable: boolean }
    // Stripe Checkout flow (backend/): leave for Stripe, then come back paid; the PDF arrives by email.
    | { kind: 'redirect'; url: string }
    | { kind: 'paid' }

export const STATE_KINDS = ['unavailable', 'sample', 'available', 'processing', 'success', 'failure'] as const

export interface OrderRequest {
    orgnr: string
    product: ReportProduct
    email: string
    acceptedTermsVersion: string
    /** Valuatum followed-model id; the basic report is generated from it. */
    fid?: string
    companyName?: string
    /** Same-origin path Stripe returns to (with ?checkout=success) or cancels to. */
    returnPath?: string
}

/** Contract for the future Swedish report backend. */
export interface ReportBackend {
    availability(orgnr: string, product: ReportProduct): Promise<ReportState>
    createOrder(req: OrderRequest): Promise<ReportState>
    orderStatus(orderId: string, product: ReportProduct): Promise<ReportState>
}
