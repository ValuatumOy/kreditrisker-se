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

const { json: jsonResponse, jsonBody, method } = require('../lib/http')
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
const { isFixturePurchase } = require('../lib/fixtureTest')
const { isSwedishCompany } = require('../lib/swedishCompany')
const offers = require('../lib/report-offers')
const json = (statusCode, body, headers) => jsonResponse(statusCode, body, { ...offers.NO_STORE, ...headers })

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
        if (product.expectedUnitAmount !== undefined && price.unit_amount !== product.expectedUnitAmount)
            throw new Error(
                `Stripe product default price differs from approved price: ${product.stripeProductId}`
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
    if (process.env.REPORT_CHECKOUT_ENABLED !== '1')
        return json(503, { error: 'Report checkout is not available' })

    if (requestMethod === 'GET') {
        const reportType = event?.queryStringParameters?.reportType
        const product = getProduct(reportType)
        if (!product) return json(400, { error: 'Unknown reportType' })

        try {
            const pricing = reportType === offers.REPORT_TYPE ? offers.configuration() : null
            const quoteRequested = event?.queryStringParameters?.offer === '1'
            const summaryRequested = reportType === offers.REPORT_TYPE && event?.queryStringParameters?.offer === 'summary'
            const businessId = event?.queryStringParameters?.businessId
            const validCompany = config.isolatedFixtureTest
                ? isFixturePurchase({ reportType, businessId, email: 'success@simulator.amazonses.com' })
                : isSwedishCompany(businessId)
            if (quoteRequested && !validCompany)
                return json(400, { error: 'A valid Swedish organisation number is required' }, offers.NO_STORE)
            if (pricing && !quoteRequested && !summaryRequested)
                return json(409, { error: 'Select a company to load the current price' }, offers.NO_STORE)
            const stripe = product.stripeProductId ? await stripeClient() : null
            const offer = pricing && quoteRequested ? await offers.issueOffer(pricing, businessId) : null
            const verifiedPrices = pricing && summaryRequested
                ? await Promise.all(pricing.variants.map(variant => offers.resolveOfferPrice(stripe, product, variant)))
                : null
            const price = verifiedPrices ? verifiedPrices.reduce((lowest, price) => price.unit_amount < lowest.unit_amount ? price : lowest)
                : offer ? await offers.resolveOfferPrice(stripe, product, offer.variant) : await resolvePrice(stripe, product)
            return json(200, {
                reportType,
                unitAmount: price.unit_amount,
                currency: price.currency,
                taxBehavior: product.taxBehavior,
                ...(summaryRequested ? { from: Boolean(pricing && pricing.variants.length > 1) } : {}),
                ...(quoteRequested || summaryRequested ? {
                    expiresAt: offer?.expiresAt ?? Math.floor(Date.now() / 1000) + offers.TTL_SECONDS,
                    remainingMs: offer ? Math.max(0, offer.expiresAt * 1000 - Date.now()) : offers.TTL_SECONDS * 1000,
                    ...(offer ? { quote: offer.quote, version: pricing.version, experimentId: pricing.experimentId, variantId: offer.variant.id,
                        analyticsExperiment: pricing.analyticsExperiment, analyticsVariant: offer.variant.analyticsVariant } : {}),
                } : {}),
            }, offers.NO_STORE)
        } catch (err) {
            console.error('get-checkout-price:', err.message)
            return json(err.statusCode || 500, { error: 'Could not load checkout price' }, offers.NO_STORE)
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
        acceptedTermsVersion,
        requestId,
        fulfillReportType,
        priceQuote,
    } = jsonBody(event)

    if (config.isolatedFixtureTest && !isFixturePurchase({ reportType, businessId, email }))
        return json(403, { error: 'Isolated checkout accepts only the synthetic test order' })

    if (!config.termsVersion || acceptedTermsVersion !== config.termsVersion)
        return json(400, { error: 'Purchase terms have not been accepted' })

    const product = getProduct(reportType)
    if (!product) return json(400, { error: 'Unknown reportType' })

    if (!config.isolatedFixtureTest && !isSwedishCompany(businessId))
        return json(400, { error: 'A valid Swedish organisation number is required' })

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
    const origin = config.siteUrl
    const returnPath =
        typeof cancelPath === 'string' && cancelPath.startsWith('/')
            ? cancelPath
            : `/${language}/`
    const cancelUrl = `${origin}${returnPath}`
    const successPath = appendParams(
        returnPath,
        `checkout=success${reportType === 'se_credit_risk' ? '' : '&session_id={CHECKOUT_SESSION_ID}'}&report=${encodeURIComponent(reportType)}${
            companyName
                ? `&company=${encodeURIComponent(String(companyName))}`
                : ''
        }${internalTest ? '&internal_test=1' : ''}`
    )

    try {
        const pricing = reportType === offers.REPORT_TYPE ? offers.configuration() : null
        if (!pricing && priceQuote) throw new offers.OfferError('The price has changed. Reload the current price before ordering')
        const offer = pricing ? await offers.verifyOffer(pricing, businessId, priceQuote) : null
        if (offer && normalizedPromotionCode)
            return json(400, { error: 'Promotion codes cannot be combined with this offer' }, offers.NO_STORE)
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

        const lineItem = offer ? { quantity: 1, price: (await offers.resolveOfferPrice(stripe, product, offer.variant)).id } : await buildLineItem(
            stripe,
            product,
            language,
            langDisclosure
        )

        const sessionParams = {
            mode: 'payment',
            ...(offer ? { currency: 'sek' } : {}),
            locale: language,
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
                : { allow_promotion_codes: !offer }),
            // Automatic Stripe Tax — Checkout collects the customer address itself for
            // jurisdiction. Requires Stripe Tax enabled + a registration in the dashboard.
            automatic_tax: { enabled: true },
            // EU B2B: a valid VAT id from another EU country makes Stripe Tax apply
            // the reverse charge when applicable. Optional for the buyer.
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
                ...(offer ? { metadata: offers.attribution(pricing, offer) } : {}),
                capture_method: product.immediateCapture
                    ? 'automatic'
                    : 'manual',
            },
            custom_text: { submit: { message: langDisclosure } },
            metadata: {
                ...(offer ? offers.attribution(pricing, offer) : {}),
                reportType,
                ...(packageCheckout
                    ? {
                          requestId: packageCheckout.requestId,
                          fulfillReportType: packageCheckout.fulfillReportType,
                      }
                    : {}),
                lang: language,
                reportLang: reportLanguage,
                acceptedTermsVersion: config.termsVersion,
                termsAcceptedAt: new Date().toISOString(),
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

        if (offer) await offers.verifyOffer(pricing, businessId, priceQuote)
        const session = packageCheckout
            ? await stripe.checkout.sessions.create(sessionParams, {
                  idempotencyKey: packageCheckout.requestId,
              })
            : await stripe.checkout.sessions.create(sessionParams)

        return json(200, { url: session.url }, offers.NO_STORE)
    } catch (err) {
        console.error('create-checkout:', err.message)
        return json(err.statusCode || 500, { error: err instanceof offers.OfferError ? err.message : 'Could not create checkout session' }, offers.NO_STORE)
    }
}

exports.parsePackageCheckout = parsePackageCheckout
exports.buildLineItem = buildLineItem
exports.resolvePrice = resolvePrice
