'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./no-network.cjs')

process.env.REPORT_ISOLATED_FIXTURE_TEST = '1'
process.env.STRIPE_SECRET_KEY = 'sk_test_local_only'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_only'
delete process.env.APP_SECRETS_ARN

const sessions = []
const claimedOrders = []
const stripeModule = require('../src/lib/stripe')
stripeModule.stripeClient = async () => ({
    products: { retrieve: async () => ({
        active: true,
        default_price: {
            id: 'price_test', active: true, currency: 'sek', type: 'one_time',
            tax_behavior: 'inclusive', unit_amount: 2900,
        },
    }) },
    checkout: { sessions: { create: async params => {
        sessions.push(params)
        return { url: 'https://checkout.stripe.com/c/pay/cs_test_example' }
    } } },
    webhooks: { constructEvent: body => JSON.parse(body) },
})
require('../src/lib/dynamo').claimOrder = async order => {
    claimedOrders.push(order)
    return true
}
const checkout = require('../src/handlers/create-checkout').handler
const webhook = require('../src/handlers/webhook').handler
const redeem = require('../src/handlers/redeem').handler

const fixture = {
    reportType: 'se_credit_risk', businessId: '0020001012',
    email: 'success@simulator.amazonses.com', acceptedTermsVersion: 'test-v1',
}

function request(body) {
    return { requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) }
}

function webhookEvent(overrides = {}) {
    const session = {
        id: 'cs_test_fixture', payment_intent: 'pi_test_fixture',
        payment_status: 'unpaid', amount_total: 2900, currency: 'sek',
        customer_details: { email: fixture.email },
        metadata: { reportType: fixture.reportType, businessId: fixture.businessId },
        ...overrides,
    }
    return request({ type: 'checkout.session.completed', livemode: false, data: { object: session } })
}

test('isolated checkout only starts sessions for the synthetic Basic order and simulator email', async () => {
    for (const change of [
        { businessId: '5560369208' },
        { reportType: 'se_ai_credit_risk' },
        { email: 'somebody@example.com' },
        { email: undefined },
    ]) {
        assert.equal((await checkout(request({ ...fixture, ...change }))).statusCode, 403)
    }
    assert.equal(sessions.length, 0)
    const result = await checkout(request({ ...fixture, businessId: '002000-1012' }))
    assert.equal(result.statusCode, 200)
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0].customer_email, fixture.email)
})

test('isolated webhook refuses other orders, changed checkout email and live events', async () => {
    for (const change of [
        { metadata: { ...fixture, businessId: '5560369208' } },
        { metadata: { ...fixture, reportType: 'se_ai_credit_risk' } },
        { customer_details: { email: 'somebody@example.com' }, customer_email: fixture.email },
        { customer_details: {}, customer_email: 'somebody@example.com' },
    ]) {
        assert.equal((await webhook(webhookEvent(change))).statusCode, 200)
    }
    const live = JSON.parse(webhookEvent().body)
    live.livemode = true
    assert.equal((await webhook(request(live))).statusCode, 200)
    assert.equal(claimedOrders.length, 0)
    assert.equal((await webhook(webhookEvent())).statusCode, 200)
    assert.equal(claimedOrders.length, 1)
    assert.equal(claimedOrders[0].email, fixture.email)
    assert.equal(claimedOrders[0].status, 'CONFIRMING')
})

test('isolated test has no package redemption route', async () => {
    assert.equal((await redeem(request(fixture))).statusCode, 403)
})

test('fulfillment refuses non-fixture orders before calling the engine', async () => {
    const engine = require('../src/lib/reportEngine')
    let submissions = 0
    engine.submitJob = async () => { submissions++; return 'job_test' }
    require('../src/lib/dynamo').updateOrder = async () => {}
    const fulfillment = require('../src/lib/fulfillment')
    const product = { generator: 'reportEngine', templateName: 'staattinen_luottomuistio' }
    const order = { sessionId: 'cs_test_fixture', reportType: fixture.reportType, email: fixture.email, params: { companyCode: fixture.businessId } }
    await assert.rejects(fulfillment.startFulfillment({ ...order, params: { companyCode: '5560369208' } }, product), /only fulfills/)
    await assert.rejects(fulfillment.startFulfillment(order, { ...product, templateName: 'luottomuistio' }), /only fulfills/)
    assert.equal(submissions, 0)
    await fulfillment.startFulfillment(order, product)
    assert.equal(submissions, 1)
})
