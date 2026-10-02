'use strict'

// POST /api/create-checkout — create a Stripe Checkout session for an on-the-fly
// generated report. The browser reaches this same-origin through CloudFront.
//
// Body: { reportType, fid, businessId, fiscalYear, companyName, lang?,
//         reportLang?, cancelPath?, promotionCode? }
//   - reportType selects the product (`se_ai_credit_risk`); the field
//     exists so future report types reuse this handler.
//   - Price + line-item label are derived SERVER-SIDE from reportType. The
//     client-supplied company fields only flow into metadata + the report job.
//   - lang ('sv' | 'en') localizes the Stripe line item + the thank-you/email
//     copy; defaults to 'sv'.
//   - reportLang ('sv' | 'en') is the language of the generated PDF, picked in
//     the purchase modal; defaults to 'en'. It never changes which language the
//     Stripe/email copy is WRITTEN in — but it is disclosed inside that copy, so
//     a buyer reading Danish still learns their PDF will be English.
//
// Charge policy: manual capture (authorize now, capture only after the report
// generates successfully).

const { json, jsonBody, method, header } = require('../lib/http')
const {
    getProduct,
    grantFor,
    normalizeLang,
    normalizeReportLang,
    reportLangDisclosure,
    localizedField,
} = require('../lib/products')
const credits = require('../lib/credits')
const fulfillment = require('../lib/fulfillment')
const { stripeClient } = require('../lib/stripe')
const config = require('../lib/config')

const INTERNAL_TEST_CODES = new Set((process.env.INTERNAL_TEST_CODES || '').split(',').filter(Boolean))
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Bundles capture immediately, so Swish (no manual capture) is allowed for them.
const PACKAGE_PAYMENT_METHOD_TYPES = ['card', 'klarna', 'swish']

function parsePackageCheckout(product, body) {
    if (!Array.isArray(product.grants)) return { packageCheckout: null }

    const requestId = credits.normalizeRequestId(body.requestId)
    if (!requestId) return { error: 'Invalid requestId' }
    const email = credits.normalizeEmail(body.email)
    if (!EMAIL.test(email) || email.length > 254)
        return { error: 'Invalid email' }

    const grant = grantFor(product, body.fulfillReportType)
    const fulfilledProduct = grant ? getProduct(grant.reportType) : null
    if (!grant || !fulfillment.isFulfillable(fulfilledProduct))
        return { error: 'Invalid fulfillReportType' }

    const companyIdentifier =
        fulfilledProduct.generator === 'reportEngine'
            ? body.businessId
            : body.fid
    if (typeof companyIdentifier !== 'string' || !companyIdentifier.trim()) {
        return { error: 'Missing company identifier' }
    }

    return {
        packageCheckout: {
            email,
            requestId,
            fulfillReportType: grant.reportType,
        },
    }
}

function requestOrigin(event) {
    const origin = header(event, 'origin')
    if (
        origin &&
        /^https:\/\/([a-z0-9-]+\.)?kreditrisker\.se$/i.test(origin)
    ) {
        return origin.replace(/\/$/, '')
    }

    const host =
        header(event, 'x-forwarded-host') ||
        header(event, 'host') ||
        event?.requestContext?.domainName
    if (host && /^([a-z0-9-]+\.)?kreditrisker\.se$/i.test(host)) {
        return `https://${host}`
    }

    return config.siteUrl
}

function appendParams(path, params) {
    const hashIndex = path.indexOf('#')
    const base = hashIndex >= 0 ? path.slice(0, hashIndex) : path
    const hash = hashIndex >= 0 ? path.slice(hashIndex) : ''
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}${params}${hash}`
}

async function resolvePrice(stripe, product) {
    if (product.stripeProductId) {
        const stripeProduct = await stripe.products.retrieve(
            product.stripeProductId,
            { expand: ['default_price'] }
        )
        if (!stripeProduct.active)
            throw new Error(
                `Stripe product is inactive: ${product.stripeProductId}`
            )

        let price = stripeProduct.default_price
        if (typeof price === 'string')
            price = await stripe.prices.retrieve(price)
        if (!price?.id || !price.active)
            throw new Error(
                `Stripe product has no active default price: ${product.stripeProductId}`
            )
        if (price.currency !== product.currency || price.type !== 'one_time')
            throw new Error(
                `Stripe product default price has invalid currency or type: ${product.stripeProductId}`
            )
        if (price.tax_behavior !== product.taxBehavior)
            throw new Error(
                `Stripe product default price has invalid tax behavior: ${product.stripeProductId}`
            )
        if (!Number.isInteger(price.unit_amount) || price.unit_amount < 0)
            throw new Error(
                `Stripe product default price has no fixed unit amount: ${product.stripeProductId}`
            )

        return price
    }

    return {
        currency: product.currency,
        unit_amount: product.priceCents,
    }
}

async function buildLineItem(stripe, product, language, langDisclosure) {
    if (product.stripeProductId) {
        const price = await resolvePrice(stripe, product)
        return { quantity: 1, price: price.id }
    }

    return {
        quantity: 1,
        price_data: {
            currency: product.currency,
            unit_amount: product.priceCents,
            tax_behavior: product.taxBehavior,
            product_data: {
                name: localizedField(product.name, language),
                description:
                    `${localizedField(product.description, language)} ${langDisclosure}`.trim(),
                tax_code: product.taxCode,
            },
        },
    }
}

exports.handler = async event => {
    const requestMethod = method(event)
    if (!['GET', 'POST'].includes(requestMethod))
        return json(405, { error: 'Method not allowed' })

    if (requestMethod === 'GET') {
        const reportType = event?.queryStringParameters?.reportType
        const product = getProduct(reportType)
        if (!product) return json(400, { error: 'Unknown reportType' })

        try {
            const stripe = product.stripeProductId ? await stripeClient() : null
            const price = await resolvePrice(stripe, product)
            return json(200, {
                reportType,
                unitAmount: price.unit_amount,
                currency: price.currency,
            })
        } catch (err) {
            console.error('get-checkout-price:', err.message)
            return json(500, { error: 'Could not load checkout price' })
        }
    }

    const {
        reportType,
        fid,
        businessId,
        fiscalYear,
        companyName,
        lang,
        reportLang,
        cancelPath,
        promotionCode,
        email,
        requestId,
        fulfillReportType,
    } = jsonBody(event)

    const product = getProduct(reportType)
    if (!product) return json(400, { error: 'Unknown reportType' })

    const language = normalizeLang(lang)
    const { error: packageError, packageCheckout } = parsePackageCheckout(
        product,
        { email, requestId, fulfillReportType, fid, businessId }
    )
    if (packageError) return json(400, { error: packageError })

    const reportLanguage = normalizeReportLang(reportLang)
    const normalizedPromotionCode =
        typeof promotionCode === 'string'
            ? promotionCode.trim().toUpperCase()
            : ''
    const internalTest = INTERNAL_TEST_CODES.has(normalizedPromotionCode)
    // Disclosed to the buyer before payment, written in `language`.
    const langDisclosure = reportLangDisclosure(reportLanguage, language)

    // Only same-origin relative paths are honored for Stripe redirects.
    const origin = requestOrigin(event)
    const returnPath =
        typeof cancelPath === 'string' && cancelPath.startsWith('/')
            ? cancelPath
            : `/${language}/`
    const cancelUrl = `${origin}${returnPath}`
    const successPath = appendParams(
        returnPath,
        `checkout=success&session_id={CHECKOUT_SESSION_ID}&report=${encodeURIComponent(reportType)}${
            companyName
                ? `&company=${encodeURIComponent(String(companyName))}`
                : ''
        }${internalTest ? '&internal_test=1' : ''}`
    )

    try {
        const stripe = await stripeClient()
        let promotionCodeId
        if (normalizedPromotionCode) {
            const promotionCodes = await stripe.promotionCodes.list({
                code: normalizedPromotionCode,
                active: true,
                limit: 1,
            })
            promotionCodeId = promotionCodes.data[0]?.id
            if (!promotionCodeId)
                return json(400, { error: 'Invalid promotion code' })
        }

        const lineItem = await buildLineItem(
            stripe,
            product,
            language,
            langDisclosure
        )

        const sessionParams = {
            mode: 'payment',
            customer_creation: 'always',
            ...(packageCheckout
                ? {
                      customer_email: packageCheckout.email,
                      payment_method_types: PACKAGE_PAYMENT_METHOD_TYPES,
                  }
                : typeof email === 'string' && EMAIL.test(email.trim()) && email.length <= 254
                  ? { customer_email: email.trim() } // prefill: the order page already asked for it
                  : {}),
            line_items: [lineItem],
            ...(promotionCodeId
                ? { discounts: [{ promotion_code: promotionCodeId }] }
                : { allow_promotion_codes: true }),
            // Automatic Stripe Tax — Checkout collects the customer address itself for
            // jurisdiction. Requires Stripe Tax enabled + a registration in the dashboard.
            automatic_tax: { enabled: true },
            // EU B2B: a valid VAT id from another EU country makes Stripe Tax apply
            // the reverse charge. Prices are VAT-inclusive, so the gross stays the
            // same and the VAT line becomes 0. Optional for the buyer.
            tax_id_collection: { enabled: true },
            // Post-payment invoice (PDF + hosted page) with the VAT breakdown and
            // both VAT ids (customer_creation above provides the Customer). Stripe
            // refuses it together with manual capture ("Post-payment invoice
            // creation does not support separate authorization and capture"), so
            // only the immediately captured products (packages) get one; single
            // reports keep the plain Stripe receipt, which still itemises the VAT.
            ...(product.immediateCapture
                ? { invoice_creation: { enabled: true } }
                : {}),
            // Authorize only; the poller captures after the report generates (or
            // cancels the hold on failure → no charge ever occurs on failure).
            payment_intent_data: {
                capture_method: product.immediateCapture
                    ? 'automatic'
                    : 'manual',
            },
            custom_text: { submit: { message: langDisclosure } },
            metadata: {
                reportType,
                ...(packageCheckout
                    ? {
                          requestId: packageCheckout.requestId,
                          fulfillReportType: packageCheckout.fulfillReportType,
                      }
                    : {}),
                lang: language,
                reportLang: reportLanguage,
                fid: fid ? String(fid) : '',
                businessId: businessId ? String(businessId) : '',
                fiscalYear: fiscalYear ? String(fiscalYear) : '',
                companyName: companyName ? String(companyName) : '',
                internalTest: internalTest ? 'true' : 'false',
            },
            // `company` lets the thank-you page name the ordered company, and `report`
            // lets it tailor the wording + conversion event per product — both without
            // a Stripe session lookup. Cosmetic only — never trusted server-side.
            success_url: `${origin}${successPath}`,
            cancel_url: cancelUrl,
        }

        const session = packageCheckout
            ? await stripe.checkout.sessions.create(sessionParams, {
                  idempotencyKey: packageCheckout.requestId,
              })
            : await stripe.checkout.sessions.create(sessionParams)

        return json(200, { url: session.url })
    } catch (err) {
        console.error('create-checkout:', err.message)
        return json(500, { error: 'Could not create checkout session' })
    }
}

exports.parsePackageCheckout = parsePackageCheckout
exports.buildLineItem = buildLineItem
exports.resolvePrice = resolvePrice
