'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

process.env.CREDITS_TABLE = 'test-credits'
process.env.ORDERS_TABLE = 'test-orders'

const { getProduct, grantFor } = require('../src/lib/products')
const { parsePackageCheckout } = require('../src/handlers/create-checkout')
const { parseRedeemRequest } = require('../src/handlers/redeem')

const REQUEST_ID = '11111111-2222-4333-8444-555555555555'

test('both bundles grant three reports of their own type', () => {
    for (const [bundleSku, reportType] of [
        ['se_credit_risk_bundle', 'se_credit_risk'],
        ['se_ai_credit_risk_bundle', 'se_ai_credit_risk'],
    ]) {
        const bundle = getProduct(bundleSku)
        assert.equal(bundle.immediateCapture, true)
        assert.deepEqual(grantFor(bundle, reportType), { reportType, count: 3 })
        assert.equal(
            grantFor(
                bundle,
                reportType === 'se_credit_risk'
                    ? 'se_ai_credit_risk'
                    : 'se_credit_risk'
            ),
            null
        )
    }
})

test('both bundles price from their own Stripe product, not a hardcoded amount', () => {
    assert.equal(
        getProduct('se_credit_risk_bundle').stripeProductId,
        'prod_test_se_basic_bundle'
    )
    assert.equal(
        getProduct('se_ai_credit_risk_bundle').stripeProductId,
        'prod_test_se_ai_bundle'
    )
    assert.equal(getProduct('se_credit_risk_bundle').priceCents, undefined)
    assert.equal(getProduct('se_ai_credit_risk_bundle').priceCents, undefined)
})

test('package checkout requires a stable request, email and matching report type', () => {
    const basic = getProduct('se_credit_risk_bundle')
    const valid = {
        requestId: REQUEST_ID,
        email: ' Buyer@Example.com ',
        fulfillReportType: 'se_credit_risk',
        fid: '133268',
    }
    assert.deepEqual(parsePackageCheckout(basic, valid), {
        packageCheckout: {
            requestId: REQUEST_ID,
            email: 'buyer@example.com',
            fulfillReportType: 'se_credit_risk',
        },
    })
    assert.equal(
        parsePackageCheckout(basic, { ...valid, email: 'bad@' }).error,
        'Invalid email'
    )
    assert.equal(
        parsePackageCheckout(basic, {
            ...valid,
            fulfillReportType: 'se_ai_credit_risk',
        }).error,
        'Invalid fulfillReportType'
    )
})

test('redeeming preserves Swedish checkout and PDF languages', () => {
    const parsed = parseRedeemRequest({
        requestId: REQUEST_ID,
        email: 'buyer@example.com',
        reportType: 'se_ai_credit_risk',
        businessId: '10150817',
        fid: '133268',
        fiscalYear: '2025',
        companyName: 'JYSK A/S',
        lang: 'sv',
        reportLang: 'en',
    })
    assert.equal(parsed.error, undefined)
    assert.equal(parsed.order.lang, 'sv')
    assert.equal(parsed.order.reportLang, 'en')
    assert.equal(parsed.order.params.lang, 'en')
    assert.equal(parsed.order.params.country, 'SE')
    assert.equal(parsed.order.sessionId, `pkg_${REQUEST_ID}`)
})
