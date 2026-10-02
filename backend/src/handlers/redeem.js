'use strict'

// POST /api/redeem — spend one report from an email's package balance.
// No credits → { needsPurchase: true } and the client goes to Checkout.
//
// The client reuses one UUIDv4 requestId per report request, so retries return
// the existing order instead of spending another credit.

const { json, jsonBody, method } = require('../lib/http')
const {
    getProduct,
    buildReportParams,
    normalizeLang,
    normalizeReportLang,
} = require('../lib/products')
const dynamo = require('../lib/dynamo')
const credits = require('../lib/credits')
const fulfillment = require('../lib/fulfillment')

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// → { error } for a rejected request, or the order row to reserve against.
function parseRedeemRequest(body) {
    const {
        requestId,
        email,
        reportType,
        fid,
        businessId,
        fiscalYear,
        companyName,
        lang,
        reportLang,
    } = body || {}

    // Case-folded, so a retry in another case is still the same order.
    const id = credits.normalizeRequestId(requestId)
    if (!id) return { error: 'Invalid requestId' }
    const normalizedEmail = credits.normalizeEmail(email)
    if (!EMAIL.test(normalizedEmail) || normalizedEmail.length > 254) {
        return { error: 'Invalid email' }
    }
    const product = getProduct(reportType)
    if (!product || !fulfillment.isFulfillable(product)) {
        return { error: 'Unknown reportType' }
    }
    const companyIdentifier =
        product.generator === 'reportEngine' ? businessId : fid
    if (typeof companyIdentifier !== 'string' || !companyIdentifier.trim()) {
        return { error: 'Missing company identifier' }
    }

    return {
        product,
        email: normalizedEmail,
        reportType,
        order: {
            sessionId: credits.packageSessionId(id),
            status: 'GENERATING',
            requestId: id,
            email: normalizedEmail,
            reportType,
            lang: normalizeLang(lang),
            reportLang: normalizeReportLang(reportLang),
            params: buildReportParams(product, {
                businessId,
                fid,
                fiscalYear,
                reportLang: normalizeReportLang(reportLang),
            }),
            companyName: companyName ? String(companyName) : '',
            createdAt: new Date().toISOString(),
        },
    }
}

// Request ids are global order keys, so a stale one from another customer can
// land here. Answering with its order would drop this request silently.
function belongsTo(order, { email, reportType }) {
    return (
        order.creditKey?.email === email &&
        order.creditKey?.reportType === reportType
    )
}

// A balance read failure should not fail a request after the order was claimed.
async function remainingReports(email, reportType) {
    try {
        return (await credits.getBalance(email, reportType)).remaining
    } catch (err) {
        console.error('redeem: balance read failed', { error: err.message })
        return null
    }
}

exports.handler = async event => {
    if (method(event) !== 'POST')
        return json(405, { error: 'Method not allowed' })

    const { error, product, email, reportType, order } = parseRedeemRequest(
        jsonBody(event)
    )
    if (error) return json(400, { error })

    const { sessionId } = order
    const { status } = await credits.reserveExisting({
        email,
        reportType,
        order,
        occurredAt: order.createdAt,
    })

    if (status === 'NEEDS_PURCHASE') {
        return json(200, { needsPurchase: true })
    }

    if (status === 'DUPLICATE') {
        const existing = await dynamo.getOrder(sessionId)
        if (existing && !belongsTo(existing, { email, reportType })) {
            console.error(
                'redeem: request id is already another order, refusing to answer with it',
                {
                    sessionId,
                    reportType,
                }
            )
            return json(409, {
                error: 'Request id already used',
                code: 'REQUEST_ID_CONFLICT',
            })
        }
        console.log(
            'redeem: request already spent a report, returning its order',
            {
                sessionId,
                status: existing?.status,
            }
        )
        return json(200, {
            status: existing?.status || 'GENERATING',
            sessionId,
            remaining: await remainingReports(email, reportType),
            duplicate: true,
        })
    }

    try {
        await fulfillment.startFulfillment(order, product)
    } catch (err) {
        if (err instanceof fulfillment.FulfillmentTrackingError) {
            // The generator accepted the job, so keep the reservation.
            console.error('redeem: submitted job could not be recorded', {
                sessionId,
                jobId: err.jobId,
                error: err.cause?.message || err.message,
            })
            return json(500, { error: 'Could not start report generation' })
        }
        console.error('redeem: job submission failed', {
            sessionId,
            error: err.message,
        })
        const occurredAt = new Date().toISOString()
        try {
            await credits.release({
                email,
                reportType,
                sessionId,
                companyName: order.companyName,
                occurredAt,
                orderAttrs: {
                    status: 'FAILED',
                    error: `Job submission failed: ${err.message}`,
                },
            })
        } catch (releaseError) {
            console.error('redeem: reservation release failed', {
                sessionId,
                error: releaseError.message,
            })
        }
        return json(500, { error: 'Could not start report generation' })
    }

    console.log('redeem: fulfillment started', {
        sessionId,
        reportType,
        generator: product.generator,
    })

    return json(200, {
        status: 'GENERATING',
        sessionId,
        remaining: await remainingReports(email, reportType),
    })
}

exports.parseRedeemRequest = parseRedeemRequest
