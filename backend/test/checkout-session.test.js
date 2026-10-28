'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

const stripeModule = require('../src/lib/stripe')
const sessions = []
stripeModule.stripeClient = async () => ({
    products: {
        retrieve: async id => ({
            active: true,
            default_price: {
                id: 'price_test', active: true, currency: 'sek', type: 'one_time',
                tax_behavior: 'exclusive', unit_amount: id === 'prod_test_se_basic' ? 2900 : 6900,
            },
        }),
    },
    checkout: { sessions: { create: async params => {
        sessions.push(params)
        return { url: 'https://checkout.stripe.com/c/pay/cs_test_example' }
    } } },
})
const { handler } = require('../src/handlers/create-checkout')

test('single reports create Swedish tax-aware sessions with manual capture', async () => {
    for (const reportType of ['se_credit_risk', 'se_ai_credit_risk']) {
        const response = await handler({
            requestContext: { http: { method: 'POST' } },
            headers: { origin: 'https://www.kreditrisker.se' },
            body: JSON.stringify({ reportType, businessId: '556036-9208', lang: 'sv', reportLang: 'sv', acceptedTermsVersion: 'test-v1' }),
        })
        assert.equal(response.statusCode, 200)
        const params = sessions.at(-1)
        assert.equal(params.locale, 'sv')
        assert.equal(params.automatic_tax.enabled, true)
        assert.equal(params.payment_intent_data.capture_method, 'manual')
        assert.equal(params.metadata.acceptedTermsVersion, 'test-v1')
        assert.ok(params.metadata.termsAcceptedAt)
        assert.deepEqual(params.line_items, [{ quantity: 1, price: 'price_test' }])
    }
})

test('checkout refuses orders without the current terms version', async () => {
    for (const acceptedTermsVersion of ['', 'old-version']) {
        const response = await handler({
            requestContext: { http: { method: 'POST' } },
            body: JSON.stringify({ reportType: 'se_credit_risk', acceptedTermsVersion }),
        })
        assert.equal(response.statusCode, 400)
    }
})

test('checkout stays closed at the API even when product IDs exist', async () => {
    process.env.REPORT_CHECKOUT_ENABLED = '0'
    try {
        const response = await handler({ requestContext: { http: { method: 'POST' } }, body: JSON.stringify({ reportType: 'se_credit_risk' }) })
        assert.equal(response.statusCode, 503)
    } finally {
        process.env.REPORT_CHECKOUT_ENABLED = '1'
    }
})
