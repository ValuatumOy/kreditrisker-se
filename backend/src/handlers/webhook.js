'use strict'

// POST /api/webhook — Stripe webhook. Configure Stripe to call the API Gateway
// URL DIRECTLY (not via CloudFront) so the raw body + Stripe-Signature header
// arrive intact for signature verification.
//
// On checkout.session.completed, claim a fulfillment order, hand it to the
// poller, and return without polling, capturing, or emailing. The hand-off lives
// in lib/fulfillment.js and is shared with /api/redeem.
//
// Package products also grant credits and reserve one for the requested report.
// Their order uses the same `pkg_<requestId>` key as /api/redeem.

const { json, text, rawBody, header, method } = require('../lib/http')
const { stripeClient } = require('../lib/stripe')
const { loadSecrets } = require('../lib/secrets')
const {
    getProduct,
    grantFor,
    buildReportParams,
    normalizeLang,
    normalizeReportLang,
} = require('../lib/products')
const dynamo = require('../lib/dynamo')
const credits = require('../lib/credits')
const fulfillment = require('../lib/fulfillment')

// Manual-capture sessions remain unpaid until the poller captures them. Only
// immediate-capture products require a settled status here.
const SETTLED_PAYMENT_STATUSES = new Set(['paid', 'no_payment_required'])

function sessionFacts(session) {
    const meta = session.metadata || {}
    return {
        meta,
        sessionId: session.id,
        email: session.customer_details?.email || session.customer_email || '',
        customerName: session.customer_details?.name || '',
        amountTotal: Number.isInteger(session.amount_total)
            ? session.amount_total
            : undefined,
        currency: session.currency || undefined,
        paymentIntentId:
            typeof session.payment_intent === 'string'
                ? session.payment_intent
                : session.payment_intent?.id,
    }
}

async function fulfillSingleReport(session, product) {
    const {
        meta,
        sessionId,
        email,
        customerName,
        amountTotal,
        currency,
        paymentIntentId,
    } = sessionFacts(session)
    const reportType = meta.reportType

    if (!fulfillment.isFulfillable(product)) {
        console.error('webhook: product has no fulfillable generator', {
            sessionId,
            reportType,
            generator: product.generator ?? null,
        })
        return json(200, { received: true })
    }

    const params = buildReportParams(product, {
        businessId: meta.businessId,
        fid: meta.fid,
        fiscalYear: meta.fiscalYear,
        reportLang: normalizeReportLang(meta.reportLang),
    })

    const claimed = await dynamo.claimOrder({
        sessionId,
        status: 'GENERATING',
        paymentIntentId,
        email,
        customerName,
        amountTotal,
        currency,
        reportType,
        lang: normalizeLang(meta.lang),
        reportLang: normalizeReportLang(meta.reportLang),
        params,
        companyName: meta.companyName || '',
        internalTest: meta.internalTest === 'true',
        createdAt: new Date().toISOString(),
    })
    if (!claimed) {
        console.log('webhook: session already processed, skipping', {
            sessionId,
        })
        return json(200, { received: true })
    }

    let jobId
    try {
        ;({ jobId } = await fulfillment.startFulfillment(
            { sessionId, params },
            product
        ))
    } catch (err) {
        if (err instanceof fulfillment.FulfillmentTrackingError) {
            console.error('webhook: submitted job could not be recorded', {
                sessionId,
                jobId: err.jobId,
                error: err.cause?.message || err.message,
            })
            return text(500, 'Job tracking failed')
        }
        console.error('webhook: job submission failed', {
            sessionId,
            error: err.message,
        })
        await dynamo
            .deleteOrder(sessionId)
            .catch(e => console.error('cleanup failed', e.message))
        return text(500, 'Job submission failed')
    }

    console.log('webhook: fulfillment started', {
        sessionId,
        reportType,
        generator: product.generator,
        jobId,
    })

    return json(200, { received: true })
}

// Return 200 when redelivery cannot fix the metadata or restart fulfillment.
async function fulfillPackagePurchase(session, product) {
    const {
        meta,
        sessionId,
        email,
        customerName,
        amountTotal,
        currency,
        paymentIntentId,
    } = sessionFacts(session)
    const purchaseSku = meta.reportType

    const requestId = credits.normalizeRequestId(meta.requestId)
    if (!requestId) {
        console.error(
            'webhook: package purchase has no usable requestId, cannot fulfill',
            {
                sessionId,
                purchaseSku,
            }
        )
        return json(200, { received: true })
    }
    const customerEmail = credits.normalizeEmail(email)
    if (!customerEmail) {
        console.error(
            'webhook: package purchase has no email, cannot key the balance',
            {
                sessionId,
                purchaseSku,
            }
        )
        return json(200, { received: true })
    }

    const reportType = meta.fulfillReportType
    const grant = grantFor(product, reportType)
    const fulfilled = grant ? getProduct(reportType) : null
    if (!grant || !fulfilled || !fulfillment.isFulfillable(fulfilled)) {
        console.error('webhook: package does not grant the requested report', {
            sessionId,
            purchaseSku,
            reportType,
        })
        return json(200, { received: true })
    }

    const occurredAt = new Date().toISOString()
    const order = {
        sessionId: credits.packageSessionId(requestId),
        status: 'GENERATING',
        requestId,
        email: customerEmail,
        customerName,
        reportType,
        // The poller dispatches on reportType, not the package SKU.
        purchaseSku,
        checkoutSessionId: sessionId,
        // Keep the package payment out of paymentIntentId, which the poller settles.
        purchasePaymentIntentId: paymentIntentId,
        amountTotal,
        currency,
        params: buildReportParams(fulfilled, {
            businessId: meta.businessId,
            fid: meta.fid,
            fiscalYear: meta.fiscalYear,
            reportLang: normalizeReportLang(meta.reportLang),
        }),
        companyName: meta.companyName || '',
        lang: normalizeLang(meta.lang),
        reportLang: normalizeReportLang(meta.reportLang),
        internalTest: meta.internalTest === 'true',
        createdAt: occurredAt,
    }

    const { status } = await credits.purchaseAndReserve({
        email: customerEmail,
        reportType,
        count: grant.count,
        checkoutSessionId: sessionId,
        order,
        occurredAt,
    })

    if (status !== 'RESERVED') {
        console.log('webhook: package granted, order already owned elsewhere', {
            sessionId,
            orderId: order.sessionId,
            status,
        })
        return json(200, { received: true })
    }

    try {
        await fulfillment.startFulfillment(order, fulfilled)
    } catch (err) {
        if (err instanceof fulfillment.FulfillmentTrackingError) {
            // The generator accepted the job, so keep the reservation.
            console.error('webhook: submitted job could not be recorded', {
                sessionId,
                orderId: order.sessionId,
                jobId: err.jobId,
                error: err.cause?.message || err.message,
            })
            return json(200, { received: true })
        }
        console.error('webhook: package job submission failed', {
            sessionId,
            orderId: order.sessionId,
            error: err.message,
        })
        // Return the reserved report without undoing the package grant.
        const releaseAt = new Date().toISOString()
        try {
            await credits.release({
                email: customerEmail,
                reportType,
                sessionId: order.sessionId,
                companyName: order.companyName,
                occurredAt: releaseAt,
                orderAttrs: {
                    status: 'FAILED',
                    error: `Job submission failed: ${err.message}`,
                },
            })
        } catch (releaseError) {
            console.error('webhook: reservation release failed', {
                orderId: order.sessionId,
                error: releaseError.message,
            })
        }
        return json(200, { received: true })
    }

    console.log('webhook: package purchased and fulfillment started', {
        sessionId,
        orderId: order.sessionId,
        purchaseSku,
        reportType,
        granted: grant.count,
    })

    return json(200, { received: true })
}

exports.handler = async event => {
    if (method(event) !== 'POST')
        return json(405, { error: 'Method not allowed' })

    const { STRIPE_WEBHOOK_SECRET } = await loadSecrets()
    if (!STRIPE_WEBHOOK_SECRET) {
        console.error('STRIPE_WEBHOOK_SECRET is not set')
        return text(500, 'Webhook Error: STRIPE_WEBHOOK_SECRET is not set')
    }

    const stripe = await stripeClient()
    let stripeEvent
    try {
        stripeEvent = stripe.webhooks.constructEvent(
            rawBody(event),
            header(event, 'stripe-signature'),
            STRIPE_WEBHOOK_SECRET
        )
    } catch (err) {
        console.error('Webhook sig failed:', err.message)
        return text(400, `Webhook Error: ${err.message}`)
    }

    if (stripeEvent.type !== 'checkout.session.completed') {
        return json(200, { received: true })
    }

    const session = stripeEvent.data.object
    const sessionId = session.id
    const reportType = session.metadata?.reportType

    const product = getProduct(reportType)
    if (!product) {
        console.error('webhook: unknown reportType, cannot fulfill', {
            sessionId,
            reportType,
        })
        return json(200, { received: true })
    }

    if (
        product.immediateCapture &&
        !SETTLED_PAYMENT_STATUSES.has(session.payment_status)
    ) {
        console.error('webhook: session completed unpaid, not fulfilling', {
            sessionId,
            reportType,
            paymentStatus: session.payment_status,
        })
        return json(200, { received: true })
    }

    return Array.isArray(product.grants)
        ? fulfillPackagePurchase(session, product)
        : fulfillSingleReport(session, product)
}
