'use strict'

const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

// Every provider is mocked, and transport calls fail immediately.
const noNetwork = () => { throw new Error('Unexpected network access') }
global.fetch = noNetwork
for (const protocol of [require('node:http'), require('node:https')]) { protocol.request = noNetwork; protocol.get = noNetwork }
require('node:net').Socket.prototype.connect = noNetwork
require('node:tls').connect = noNetwork
require('node:http2').connect = noNetwork

const SECRET = 'local-offer-test-only-'.repeat(3)
let signingKey = SECRET
require('../src/lib/secrets').loadSecrets = async () => ({ REPORT_PRICING_SIGNING_KEY: signingKey, STRIPE_WEBHOOK_SECRET: 'whsec_local_only' })
const offers = require('../src/lib/report-offers')
const configValue = () => ({
    storefrontVersion: 'runtime-offers-v1', version: 'test-v1', experimentId: 'local-fixture', allocationUnit: 'company', analyticsExperiment: 'e1',
    // Synthetic mock amounts/IDs only; no proposed live prices.
    variants: [
        { id: 'control', weight: 1, unitAmount: 1100, stripePriceId: 'price_mock_control', analyticsVariant: 'v1' },
        { id: 'variant', weight: 1, unitAmount: 1700, stripePriceId: 'price_mock_variant', analyticsVariant: 'v2' },
    ],
})
let sessions, priceOverride, productActive, priceCalls
const stripe = {
    products: { retrieve: async () => ({ active: productActive, default_price: {
        id: 'price_baseline', active: true, currency: 'sek', type: 'one_time', tax_behavior: 'inclusive', unit_amount: 2900,
    } }) },
    prices: { retrieve: async id => {
        priceCalls.push(id)
        const variant = configValue().variants.find(variant => variant.stripePriceId === id)
        return { id, active: true, product: 'prod_test_se_basic', currency: 'sek', type: 'one_time',
            tax_behavior: 'inclusive', billing_scheme: 'per_unit', unit_amount: variant.unitAmount, ...priceOverride }
    } },
    checkout: { sessions: { create: async params => { sessions.push(params); return { url: 'https://checkout.stripe.com/c/pay/cs_test_mock_only' } } } },
}
require('../src/lib/stripe').stripeClient = async () => stripe
const { handler } = require('../src/handlers/create-checkout')
const company = '556036-9208'
const get = (businessId = company, query = {}) => handler({ requestContext: { http: { method: 'GET' } }, queryStringParameters: { reportType: 'se_credit_risk', offer: '1', businessId, ...query } })
const post = (priceQuote, body = {}) => handler({ requestContext: { http: { method: 'POST' } }, body: JSON.stringify({ reportType: 'se_credit_risk', businessId: company, acceptedTermsVersion: 'test-v1', priceQuote, ...body }) })

beforeEach(() => {
    process.env.REPORT_PRICING_ENABLED = '1'
    process.env.REPORT_PRICING_CONFIG = JSON.stringify(configValue())
    signingKey = SECRET; sessions = []; priceCalls = []; priceOverride = {}; productActive = true
})

test('disabled default ignores malformed experiment config and retains 29 SEK legacy checkout', async () => {
    delete process.env.REPORT_PRICING_ENABLED
    process.env.REPORT_PRICING_CONFIG = 'invalid'
    signingKey = ''
    const response = await get()
    assert.match(response.headers['cache-control'], /no-store/)
    const value = JSON.parse(response.body)
    assert.equal(value.unitAmount, 2900)
    assert.equal(value.quote, undefined)
    assert.equal(value.remainingMs, 300000)
    assert.equal(value.analyticsExperiment, undefined)
    const summary = JSON.parse((await get(undefined, { offer: 'summary' })).body)
    assert.equal(summary.unitAmount, 2900)
    assert.equal(summary.from, false)
    assert.equal((await post()).statusCode, 200)
    assert.deepEqual(sessions[0].line_items, [{ quantity: 1, price: 'price_baseline' }])
    assert.equal(sessions[0].metadata.priceExperiment, undefined)
    assert.equal(sessions[0].allow_promotion_codes, true)
    assert.deepEqual(priceCalls, [])
})

test('same company has stable allocation across repeated quotes and version-only changes', async () => {
    const config = offers.configuration()
    const first = await offers.issueOffer(config, company, 0)
    const second = await offers.issueOffer(config, company.replace('-', ''), 1000)
    assert.equal(first.variant.id, second.variant.id)
    const third = await offers.issueOffer({ ...config, version: 'test-v2' }, company, 2000)
    assert.equal(first.variant.id, third.variant.id)
    assert.ok(configValue().variants.some(variant => variant.id === first.variant.id))
    const seen = new Set()
    for (let n = 0; n < 100; n++) seen.add((await offers.issueOffer(config, String(5560000000 + n), 0)).variant.id)
    assert.equal(seen.size, 2)
})

test('only an unexpired, untampered quote for the same company and exact config is accepted', async () => {
    const config = offers.configuration()
    const { quote } = await offers.issueOffer(config, company, 0)
    assert.ok(await offers.verifyOffer(config, company, quote, 299000))
    for (const [target, token, now] of [[company, quote, 300000], ['556016-0680', quote, 1000], [company, `${quote}x`, 1000], [company, '', 1000], [company, `${quote}.extra`, 1000]])
        await assert.rejects(offers.verifyOffer(config, target, token, now), offers.OfferError)
    await assert.rejects(offers.verifyOffer({ ...config, fingerprint: 'changed' }, company, quote, 1000), offers.OfferError)
})

test('GET offer equals the exact checkout line item and authoritative attribution', async () => {
    const response = await get()
    assert.equal(response.statusCode, 200)
    assert.match(response.headers['cache-control'], /private, no-store/)
    const value = JSON.parse(response.body)
    assert.ok(value.quote)
    assert.ok(value.remainingMs > 0 && value.remainingMs <= 300000)
    assert.equal(value.analyticsExperiment, 'e1')
    assert.equal(value.currency, 'sek')
    assert.equal(value.taxBehavior, 'inclusive')
    const variant = configValue().variants.find(variant => variant.id === value.variantId)
    assert.equal(value.unitAmount, variant.unitAmount)
    assert.equal((await post(value.quote, { unitAmount: 1, stripePriceId: 'price_attacker', variantId: 'attacker' })).statusCode, 200)
    const params = sessions[0]
    assert.deepEqual(params.line_items, [{ quantity: 1, price: variant.stripePriceId }])
    assert.equal(params.metadata.quotedUnitAmount, String(value.unitAmount))
    assert.equal(params.metadata.priceExperiment, value.experimentId)
    assert.equal(params.metadata.priceVariant, value.variantId)
    assert.equal(params.metadata.priceAnalyticsVariant, value.analyticsVariant)
    assert.deepEqual(params.payment_intent_data.metadata, offers.attribution(offers.configuration(), { variant }))
    assert.equal(params.payment_intent_data.capture_method, 'manual')
    assert.equal(params.currency, 'sek')
    assert.equal(params.automatic_tax.enabled, true)
    assert.equal(params.allow_promotion_codes, false)
    assert.equal('company' in JSON.parse(Buffer.from(value.quote.split('.')[0], 'base64url')), true)
    assert.equal(value.quote.includes(company), false)
})

test('generic summary verifies every allowed price and advertises only their actual minimum', async () => {
    const response = await get(undefined, { offer: 'summary' })
    assert.equal(response.statusCode, 200)
    const value = JSON.parse(response.body)
    assert.equal(value.unitAmount, 1100)
    assert.equal(value.from, true)
    assert.equal(value.quote, undefined)
    assert.equal(value.variantId, undefined)
    assert.deepEqual(priceCalls.sort(), ['price_mock_control', 'price_mock_variant'])
    assert.equal(sessions.length, 0)
    priceOverride = { active: false }
    assert.equal((await get(undefined, { offer: 'summary' })).statusCode, 503)
})

test('active pricing rejects old clients, forged tokens, company switches and arbitrary IDs before checkout', async () => {
    const value = JSON.parse((await get()).body)
    for (const response of [await post(), await post('forged'), await post(value.quote, { businessId: '556016-0680' }), await post(undefined, { stripePriceId: 'price_attacker', unitAmount: 1 })])
        assert.equal(response.statusCode, 409)
    assert.equal(sessions.length, 0)
    assert.equal((await get(company, { offer: '0' })).statusCode, 409)
    assert.equal((await get('800101-1231')).statusCode, 400)
})

test('quote changes and rollback demand explicit reload instead of silently substituting a price', async () => {
    const value = JSON.parse((await get()).body)
    process.env.REPORT_PRICING_CONFIG = JSON.stringify({ ...configValue(), version: 'test-v2' })
    assert.equal((await post(value.quote)).statusCode, 409)
    process.env.REPORT_PRICING_ENABLED = '0'
    assert.equal((await post(value.quote)).statusCode, 409)
    assert.equal(sessions.length, 0)
})

test('misconfiguration and missing secret fail closed', async () => {
    for (const value of ['malformed', '{}', JSON.stringify({ ...configValue(), allocationUnit: 'visitor' }), JSON.stringify({ ...configValue(), variants: [{ id: 'bad', weight: 0, unitAmount: 1, stripePriceId: 'price_bad' }] })]) {
        process.env.REPORT_PRICING_CONFIG = value
        assert.equal((await get()).statusCode, 503)
        assert.equal((await post()).statusCode, 503)
    }
    process.env.REPORT_PRICING_CONFIG = JSON.stringify(configValue())
    signingKey = ''
    assert.equal((await get()).statusCode, 503)
    assert.equal(sessions.length, 0)
})

test('analytics slots are small fixed labels and variant slots cannot collide', async () => {
    for (const change of [
        { analyticsExperiment: 'company-name' }, { analyticsExperiment: 'e9' },
        { variants: configValue().variants.map(value => ({ ...value, analyticsVariant: 'v1' })) },
        { variants: configValue().variants.map(value => ({ ...value, analyticsVariant: 'private@example.test' })) },
    ]) {
        process.env.REPORT_PRICING_CONFIG = JSON.stringify({ ...configValue(), ...change })
        assert.equal((await get()).statusCode, 503)
        assert.equal((await post()).statusCode, 503)
    }
    assert.equal(sessions.length, 0)
})

test('wrong Stripe price amount, product, currency, tax, type or billing contract is never quoted or sold', async () => {
    const quote = JSON.parse((await get()).body).quote
    for (const override of [
        { active: false }, { product: 'prod_attacker' }, { id: 'price_attacker' }, { currency: 'eur' },
        { tax_behavior: 'exclusive' }, { type: 'recurring' }, { billing_scheme: 'tiered' },
        { transform_quantity: { divide_by: 2 } }, { custom_unit_amount: { enabled: true } }, { unit_amount: 1 },
    ]) {
        priceOverride = override
        assert.equal((await get()).statusCode, 503)
        assert.equal((await post(quote)).statusCode, 503)
    }
    priceOverride = {}; productActive = false
    assert.equal((await post(quote)).statusCode, 503)
    assert.equal(sessions.length, 0)
})

test('active offers reject promotion codes rather than confounding assigned prices', async () => {
    const quote = JSON.parse((await get()).body).quote
    assert.equal((await post(quote, { promotionCode: 'TEST_ONLY' })).statusCode, 400)
    assert.equal(sessions.length, 0)
})

test('signed Stripe webhook persists pricing attribution with the paid order', async () => {
    const quote = JSON.parse((await get()).body).quote
    await post(quote)
    let claimed
    require('../src/lib/dynamo').claimOrder = async value => { claimed = value; return true }
    const Stripe = require('stripe')
    const signer = new Stripe('sk_test_local_only')
    stripe.webhooks = signer.webhooks
    const { handler: webhook } = require('../src/handlers/webhook')
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: {
        id: 'cs_test_offer_only', metadata: sessions[0].metadata, payment_intent: 'pi_test_offer_only',
        payment_status: 'unpaid', amount_total: Number(sessions[0].metadata.quotedUnitAmount), currency: 'sek',
        customer_details: { email: 'buyer@example.test' },
    } } })
    const response = await webhook({ requestContext: { http: { method: 'POST' } }, body: payload,
        headers: { 'stripe-signature': signer.webhooks.generateTestHeaderString({ payload, secret: 'whsec_local_only' }) } })
    assert.equal(response.statusCode, 200)
    assert.equal(claimed.pricing.variantId, sessions[0].metadata.priceVariant)
    assert.equal(claimed.pricing.unitAmount, sessions[0].metadata.quotedUnitAmount)
    assert.equal(claimed.status, 'CONFIRMING')
})
