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
                tax_behavior: id === 'prod_test_se_basic' ? 'inclusive' : 'exclusive', unit_amount: id === 'prod_test_se_basic' ? 2900 : 6900,
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

test('Stripe return URLs use SITE_URL in test and production despite request origin headers', async () => {
    const configPath = require.resolve('../src/lib/config')
    const handlerPath = require.resolve('../src/handlers/create-checkout')
    const previousConfig = require.cache[configPath]
    const previousHandler = require.cache[handlerPath]
    const previousSiteUrl = process.env.SITE_URL
    const cancelPath = '/foretag/5560369208/alvsjo/'
    try {
        for (const [siteUrl, requestOrigin] of [
            ['https://d123example.cloudfront.net', 'https://www.kreditrisker.se'],
            ['https://www.kreditrisker.se', 'https://kreditrisker.se'],
        ]) {
            process.env.SITE_URL = siteUrl
            delete require.cache[configPath]
            delete require.cache[handlerPath]
            const configuredHandler = require('../src/handlers/create-checkout').handler
            const response = await configuredHandler({
                requestContext: { http: { method: 'POST' }, domainName: 'www.kreditrisker.se' },
                headers: { origin: requestOrigin, host: 'www.kreditrisker.se', 'x-forwarded-host': 'kreditrisker.se' },
                body: JSON.stringify({ reportType: 'se_credit_risk', businessId: '556036-9208',
                    lang: 'sv', reportLang: 'sv', acceptedTermsVersion: 'test-v1', cancelPath }),
            })
            assert.equal(response.statusCode, 200)
            const params = sessions.at(-1)
            const success = new URL(params.success_url)
            assert.equal(success.origin, siteUrl)
            assert.equal(success.pathname, cancelPath)
            assert.equal(success.searchParams.get('checkout'), 'success')
            assert.equal(success.searchParams.has('session_id'), false, 'Basic reference is delivered by email instead of request URLs')
            assert.equal(params.cancel_url, `${siteUrl}${cancelPath}`)
        }
    } finally {
        require.cache[configPath] = previousConfig
        require.cache[handlerPath] = previousHandler
        if (previousSiteUrl === undefined) delete process.env.SITE_URL
        else process.env.SITE_URL = previousSiteUrl
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

test('real checkout rejects personnummer, synthetic numbers and invalid organisation numbers', async () => {
    const initialCount = sessions.length
    for (const businessId of ['800101-1231', '002000-1012', '556036-9200', '', undefined]) {
        const response = await handler({
            requestContext: { http: { method: 'POST' } },
            body: JSON.stringify({ reportType: 'se_credit_risk', businessId, acceptedTermsVersion: 'test-v1' }),
        })
        assert.equal(response.statusCode, 400)
    }
    assert.equal(sessions.length, initialCount)
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
