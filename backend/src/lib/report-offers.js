'use strict'

const { createHmac, createHash, timingSafeEqual } = require('node:crypto')
const { loadSecrets } = require('./secrets')

const REPORT_TYPE = 'se_credit_risk'
const TTL_SECONDS = 300
const LABEL = /^[a-z][a-z0-9_-]{0,39}$/
const isLabel = value => typeof value === 'string' && LABEL.test(value)
const NO_STORE = { 'cache-control': 'private, no-store, max-age=0', pragma: 'no-cache' }

class OfferError extends Error {
    constructor(message, statusCode = 409) { super(message); this.statusCode = statusCode }
}

function configuration() {
    if (process.env.REPORT_PRICING_ENABLED !== '1') return null
    try {
        const value = JSON.parse(process.env.REPORT_PRICING_CONFIG || '')
        if (value.storefrontVersion !== 'runtime-offers-v1' || !isLabel(value.version) ||
            !isLabel(value.experimentId) || value.allocationUnit !== 'company' ||
            !['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'].includes(value.analyticsExperiment) ||
            !Array.isArray(value.variants) || !value.variants.length || value.variants.length > 4)
            throw new Error()
        const ids = new Set()
        const analyticsVariants = new Set()
        for (const variant of value.variants) {
            if (!isLabel(variant.id) || ids.has(variant.id) ||
                !['v1', 'v2', 'v3', 'v4'].includes(variant.analyticsVariant) || analyticsVariants.has(variant.analyticsVariant) ||
                !Number.isInteger(variant.weight) || variant.weight <= 0 || variant.weight > 10000 ||
                !Number.isSafeInteger(variant.unitAmount) || variant.unitAmount <= 0 ||
                variant.unitAmount > 99999999 || typeof variant.stripePriceId !== 'string' || !/^price_[A-Za-z0-9_]{1,200}$/.test(variant.stripePriceId))
                throw new Error()
            ids.add(variant.id)
            analyticsVariants.add(variant.analyticsVariant)
        }
        return { ...value, fingerprint: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
    } catch { throw new OfferError('Pricing configuration is unavailable', 503) }
}

async function key() {
    const { REPORT_PRICING_SIGNING_KEY: value } = await loadSecrets()
    if (typeof value !== 'string' || Buffer.byteLength(value) < 32)
        throw new OfferError('Pricing configuration is unavailable', 503)
    return value
}

function mac(secret, data) { return createHmac('sha256', secret).update(data).digest('base64url') }
function companyKey(secret, businessId) { return mac(secret, `company:${businessId.replace('-', '')}`) }
function variantFor(config, secret, businessId) {
    // Version changes invalidate quotes; experimentId changes the allocation.
    const digest = createHmac('sha256', secret).update(`${config.experimentId}:${businessId.replace('-', '')}`).digest()
    const total = config.variants.reduce((sum, variant) => sum + variant.weight, 0)
    let bucket = digest.readUInt32BE(0) / 0x100000000 * total
    return config.variants.find(variant => (bucket -= variant.weight) < 0)
}

async function issueOffer(config, businessId, now = Date.now()) {
    const secret = await key()
    const variant = variantFor(config, secret, businessId)
    const expiresAt = Math.floor(now / 1000) + TTL_SECONDS
    const payload = Buffer.from(JSON.stringify({
        config: config.fingerprint, company: companyKey(secret, businessId), variant: variant.id, expiresAt,
    })).toString('base64url')
    return { variant, expiresAt, quote: `${payload}.${mac(secret, payload)}` }
}

async function verifyOffer(config, businessId, quote, now = Date.now()) {
    if (typeof quote !== 'string' || quote.length > 2048) throw new OfferError('Reload the current price before ordering')
    const secret = await key()
    const [payload, signature, extra] = quote.split('.')
    const expected = mac(secret, payload || '')
    if (extra !== undefined || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
        throw new OfferError('Reload the current price before ordering')
    let value
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()) } catch { throw new OfferError('Invalid price quote') }
    const variant = variantFor(config, secret, businessId)
    if (value.config !== config.fingerprint || value.company !== companyKey(secret, businessId) || value.variant !== variant.id ||
        !Number.isInteger(value.expiresAt) || value.expiresAt <= Math.floor(now / 1000) || value.expiresAt > Math.floor(now / 1000) + TTL_SECONDS)
        throw new OfferError('The price quote has expired or changed. Reload the price before ordering')
    return { variant, expiresAt: value.expiresAt }
}

async function resolveOfferPrice(stripe, product, variant) {
    const [stripeProduct, price] = await Promise.all([
        stripe.products.retrieve(product.stripeProductId), stripe.prices.retrieve(variant.stripePriceId),
    ])
    const productId = typeof price.product === 'string' ? price.product : price.product?.id
    if (!stripeProduct.active || price.id !== variant.stripePriceId || !price.active || productId !== product.stripeProductId ||
        price.currency !== 'sek' || price.type !== 'one_time' || price.tax_behavior !== 'inclusive' ||
        price.billing_scheme !== 'per_unit' || price.transform_quantity || price.custom_unit_amount ||
        price.unit_amount !== variant.unitAmount)
        throw new OfferError('The configured price could not be verified', 503)
    return price
}

function attribution(config, offer) {
    return {
        priceVersion: config.version, priceExperiment: config.experimentId, priceVariant: offer.variant.id,
        priceAllocationUnit: config.allocationUnit, quotedUnitAmount: String(offer.variant.unitAmount),
        quotedCurrency: 'sek', quotedTaxBehavior: 'inclusive',
        priceAnalyticsExperiment: config.analyticsExperiment, priceAnalyticsVariant: offer.variant.analyticsVariant,
    }
}

module.exports = { REPORT_TYPE, TTL_SECONDS, NO_STORE, OfferError, configuration, issueOffer, verifyOffer, resolveOfferPrice, attribution }
