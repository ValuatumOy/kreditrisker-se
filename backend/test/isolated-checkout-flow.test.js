'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

// All providers are in-memory fakes. The Stripe SDK only verifies a locally
// signed test event; this test cannot create a payment or report.
process.env.STRIPE_SECRET_KEY = 'sk_test_local_only'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_only'
process.env.SE_AI_FRAUD_ADDON = '1'
process.env.SITE_URL = 'https://se-checkout.example.test'
process.env.AWS_ACCESS_KEY_ID = 'local-test-only'
process.env.AWS_SECRET_ACCESS_KEY = 'local-test-only'
process.env.AWS_EC2_METADATA_DISABLED = 'true'
process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:1'
process.env.ORDERS_TABLE = 'local-test-orders'
process.env.CREDITS_TABLE = 'local-test-credits'
delete process.env.APP_SECRETS_ARN

// Block the HTTP transports used by Stripe and the AWS SDK as well as fetch.
const noNetwork = () => { throw new Error('Unexpected network access in isolated test') }
global.fetch = noNetwork
for (const protocol of [require('node:http'), require('node:https')]) {
    protocol.request = noNetwork
    protocol.get = noNetwork
}
const net = require('node:net')
net.connect = noNetwork
net.createConnection = noNetwork
net.Socket.prototype.connect = noNetwork
require('node:tls').connect = noNetwork
require('node:http2').connect = noNetwork

const Stripe = require('stripe')
const signer = new Stripe(process.env.STRIPE_SECRET_KEY)
const stripeModule = require('../src/lib/stripe')
const dynamo = require('../src/lib/dynamo')
const reportEngine = require('../src/lib/reportEngine')
const emailService = require('../src/lib/email')

let state
function reset() {
    state = { orders: new Map(), jobs: [], sessions: [], captures: [], cancellations: [], emails: [], confirmations: [], alerts: [], submitError: false, emailError: false }
}
reset()

const stripe = {
    webhooks: signer.webhooks,
    products: {
        retrieve: async id => ({
            active: true,
            default_price: {
                id: `price_${id}`, active: true, currency: 'sek',
                type: 'one_time', tax_behavior: 'inclusive',
                unit_amount: id === 'prod_test_se_basic' ? 2900 : 8625,
            },
        }),
    },
    checkout: { sessions: { create: async params => {
        const id = `cs_test_local_${state.sessions.length + 1}`
        state.sessions.push({ id, params })
        return { url: `https://checkout.stripe.com/c/pay/${id}` }
    } } },
    paymentIntents: {
        capture: async id => {
            if (state.captures.includes(id)) throw new Error('already captured')
            state.captures.push(id)
            return { status: 'succeeded' }
        },
        retrieve: async id => ({ status: state.captures.includes(id) ? 'succeeded' : 'requires_capture' }),
        cancel: async id => { state.cancellations.push(id); return { status: 'canceled' } },
    },
}

stripeModule.stripeClient = async () => stripe
dynamo.claimOrder = async order => {
    if (state.orders.has(order.sessionId)) return false
    state.orders.set(order.sessionId, { ...order })
    return true
}
dynamo.updateOrder = async (id, values) => {
    Object.assign(state.orders.get(id), values)
}
dynamo.deleteOrder = async id => { state.orders.delete(id) }
dynamo.getOrder = async id => state.orders.get(id)
dynamo.listWithdrawals = async () => []
dynamo.beginGeneration = async id => {
    const order = state.orders.get(id)
    if (order.status !== 'CONFIRMING' || order.withdrawalRequestId) return false
    order.status = 'GENERATING'
    return true
}
dynamo.claimDelivery = async id => !state.orders.get(id)?.withdrawalRequestId
dynamo.finishSingleOrder = async (id, values) => {
    const order = state.orders.get(id)
    if (order.withdrawalRequestId) return false
    Object.assign(order, values)
    return true
}
dynamo.listOrdersByStatus = async status => state.staleOrders ??
    [...state.orders.values()].filter(order => order.status === status)
reportEngine.submitJob = async request => {
    state.jobs.push(request)
    if (state.submitError) throw new Error('response lost after submission')
    return `job_local_${state.jobs.length}`
}
reportEngine.getJob = async () => ({
    status: 'DONE', s3Url: 'https://example.test/fake.pdf',
    ...(state.fraudAnalysis ? { reportFeatures: { fraudAnalysis: true } } : {}),
})
reportEngine.downloadPdf = async () => Buffer.from('%PDF-1.4 local fake')
emailService.sendReportEmail = async (to, details) => {
    if (state.emailError) throw new Error('test SES failure')
    state.emails.push({ to, details })
}
emailService.sendAdminGenerationAlert = async (...args) => { state.alerts.push(args) }
emailService.sendOrderReceivedEmail = async order => { state.confirmations.push(order.sessionId) }

const checkout = require('../src/handlers/create-checkout')
const webhook = require('../src/handlers/webhook')
const poller = require('../src/handlers/poller')

function signedEvent(session) {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: session } })
    return {
        requestContext: { http: { method: 'POST' } },
        headers: { 'stripe-signature': signer.webhooks.generateTestHeaderString({
            payload, secret: process.env.STRIPE_WEBHOOK_SECRET,
        }) },
        body: payload,
    }
}

async function createOrder(reportType, includeFraud) {
    const result = await checkout.handler({
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({
            reportType, businessId: '556036-9208', companyName: 'Älvsjö',
            lang: 'sv', reportLang: 'sv', acceptedTermsVersion: 'test-v1', includeFraud,
        }),
    })
    assert.equal(result.statusCode, 200)
    const session = state.sessions.at(-1)
    return {
        id: session.id,
        payment_status: 'unpaid',
        payment_intent: 'pi_test_local',
        amount_total: reportType === 'se_credit_risk' ? 2900 : 8625 + (includeFraud ? 2200 : 0),
        currency: 'sek',
        customer_details: { email: 'buyer@example.test', name: 'Local Test' },
        metadata: session.params.metadata,
    }
}

test('the isolated test cannot open the Stripe or AWS HTTP transports', () => {
    assert.throws(() => require('node:https').request('https://api.stripe.com'), /Unexpected network access/)
    assert.throws(() => require('node:http').request('http://127.0.0.1'), /Unexpected network access/)
    assert.throws(() => require('node:net').connect(443, 'example.test'), /Unexpected network access/)
})

test('both Swedish checkout flows connect to the expected report and delivery in isolation', async () => {
    for (const [reportType, template] of [
        ['se_credit_risk', 'staattinen_luottomuistio'],
        ['se_ai_credit_risk', 'luottomuistio'],
    ]) {
        reset()
        const session = await createOrder(reportType)
        const event = signedEvent(session)
        assert.equal((await webhook.handler(event)).statusCode, 200)
        assert.equal((await webhook.handler(event)).statusCode, 200)
        assert.equal(state.jobs.length, 0, 'Single reports wait for their order confirmation')
        await poller.handler()
        assert.deepEqual(state.confirmations, [session.id])
        assert.equal(state.jobs.length, 1, 'a repeated webhook must not start a second report')
        assert.equal(state.jobs[0].templateName, template)
        assert.equal(state.jobs[0].params.companyCode, '556036-9208')
        assert.equal(state.jobs[0].params.aspQueryKey, 'Sweden')
        assert.equal(state.jobs[0].params.lang, 'sv')
        assert.equal(state.jobs[0].params.currency, 'SEK')
        if (reportType === 'se_ai_credit_risk') assert.equal(state.jobs[0].params.includeFraud, false)
        else assert.equal(state.jobs[0].params.aiTexts, true)

        await poller.handler()
        assert.deepEqual(state.captures, ['pi_test_local'])
        assert.equal(state.emails.length, 1)
        assert.equal(state.emails[0].to, 'buyer@example.test')
        assert.match(state.emails[0].details.pdfBuffer.toString(), /^%PDF/)
        assert.equal(state.orders.get(session.id).status, 'FULFILLED')
    }
})

test('selected fraud analysis is sent to Stripe, preserved on redelivery and required before capture', async () => {
    for (const generated of [true, false]) {
        reset()
        const session = await createOrder('se_ai_credit_risk', true)
        const items = state.sessions[0].params.line_items
        assert.equal(items.length, 2)
        assert.equal(items[1].price_data.unit_amount, 2200)
        assert.equal(items[1].price_data.tax_behavior, 'inclusive')
        assert.equal(items[1].price_data.currency, 'sek')
        assert.equal(items[1].price_data.product_data.name, 'Bedrägerianalys')

        delete process.env.SE_AI_FRAUD_ADDON
        try {
            const event = signedEvent(session)
            assert.equal((await webhook.handler(event)).statusCode, 200)
            assert.equal((await webhook.handler(event)).statusCode, 200)
        } finally {
            process.env.SE_AI_FRAUD_ADDON = '1'
        }
        state.fraudAnalysis = generated
        await poller.handler()
        assert.equal(state.jobs.length, 1)
        assert.equal(state.jobs[0].params.includeFraud, true)

        assert.equal(state.orders.get(session.id).status, generated ? 'FULFILLED' : 'FAILED')
        assert.deepEqual(state.captures, generated ? ['pi_test_local'] : [])
        assert.deepEqual(state.cancellations, generated ? [] : ['pi_test_local'])
        assert.equal(state.emails.length, generated ? 1 : 0)
    }
})

test('new paid AI sessions keep fraud disabled with the flag off, including after a later flag change', async () => {
    const previousFlag = process.env.SE_AI_FRAUD_ADDON
    try {
        for (const choice of [undefined, false]) {
            reset()
            process.env.SE_AI_FRAUD_ADDON = '0'
            const quote = await checkout.handler({ requestContext: { http: { method: 'GET' } },
                queryStringParameters: { reportType: 'se_ai_credit_risk' } })
            assert.equal(quote.statusCode, 200)
            assert.equal(JSON.parse(quote.body).unitAmount, 8625)
            assert.equal(JSON.parse(quote.body).fraudAddonCents, undefined)
            const session = await createOrder('se_ai_credit_risk', choice)
            assert.equal(state.sessions[0].params.line_items.length, 1)
            assert.equal(session.amount_total, 8625)
            assert.equal(session.metadata.aiFraudAddonVersion, '1')
            assert.equal(session.metadata.includeFraud, 'false')
            assert.equal(session.metadata.fraudAddonCents, '0')
            process.env.SE_AI_FRAUD_ADDON = '1'
            const event = signedEvent(session)
            assert.equal((await webhook.handler(event)).statusCode, 200)
            assert.equal((await webhook.handler(event)).statusCode, 200)
            assert.equal(state.orders.get(session.id).params.includeFraud, false)
            assert.equal(state.orders.get(session.id).fraudAddonPurchased, undefined)
            await poller.handler()
            assert.equal(state.jobs.length, 1)
            assert.equal(state.jobs[0].params.includeFraud, false)
            assert.equal(state.orders.get(session.id).status, 'FULFILLED')
            assert.deepEqual(state.captures, ['pi_test_local'])
        }
        reset()
        process.env.SE_AI_FRAUD_ADDON = '0'
        const response = await checkout.handler({
            requestContext: { http: { method: 'POST' } },
            body: JSON.stringify({ reportType: 'se_ai_credit_risk', businessId: '556036-9208',
                acceptedTermsVersion: 'test-v1', includeFraud: true }),
        })
        assert.equal(response.statusCode, 409)
        assert.equal(state.sessions.length, 0)
    } finally {
        if (previousFlag === undefined) delete process.env.SE_AI_FRAUD_ADDON
        else process.env.SE_AI_FRAUD_ADDON = previousFlag
    }
})

test('historical AI metadata and persisted choices retain their replay semantics with the flag off', async () => {
    const previousFlag = process.env.SE_AI_FRAUD_ADDON
    try {
        process.env.SE_AI_FRAUD_ADDON = '0'
        for (const savedChoice of [true, false]) {
            reset()
            const session = await createOrder('se_ai_credit_risk')
            delete session.metadata.aiFraudAddonVersion
            delete session.metadata.includeFraud
            delete session.metadata.fraudAddonCents
            const event = signedEvent(session)
            assert.equal((await webhook.handler(event)).statusCode, 200)
            const order = state.orders.get(session.id)
            assert.equal(order.params.includeFraud, true, 'unversioned historical metadata keeps the legacy catalog default')
            order.params.includeFraud = savedChoice
            assert.equal((await webhook.handler(event)).statusCode, 200)
            assert.equal(order.params.includeFraud, savedChoice, 'replay does not overwrite a persisted choice')
            await poller.handler()
            assert.equal(state.jobs[0].params.includeFraud, savedChoice)
        }
    } finally {
        if (previousFlag === undefined) delete process.env.SE_AI_FRAUD_ADDON
        else process.env.SE_AI_FRAUD_ADDON = previousFlag
    }
})

test('an uncertain submission is never automatically repeated or charged', async () => {
    reset()
    state.submitError = true
    const session = await createOrder('se_ai_credit_risk')
    const event = signedEvent(session)
    assert.equal((await webhook.handler(event)).statusCode, 200)
    assert.equal((await webhook.handler(event)).statusCode, 200)
    await poller.handler()
    assert.equal(state.jobs.length, 1)
    const order = state.orders.get(session.id)
    assert.equal(order.status, 'GENERATING')
    assert.equal(order.jobId, undefined)

    order.createdAt = new Date(Date.now() - 10 * 60_000).toISOString()
    await poller.handler()
    assert.deepEqual(state.cancellations, ['pi_test_local'])
    assert.deepEqual(state.captures, [])
    assert.equal(state.emails.length, 0)
    assert.equal(state.alerts.length, 1)
    assert.equal(order.status, 'FAILED')
})

test('a failed email after capture is logged and retried without another capture', async t => {
    reset()
    state.emailError = true
    const session = await createOrder('se_credit_risk')
    await webhook.handler(signedEvent(session))
    const errorLog = t.mock.method(console, 'error', () => {})

    await poller.handler()
    assert.deepEqual(state.captures, ['pi_test_local'])
    assert.equal(state.emails.length, 0)
    assert.equal(state.orders.get(session.id).status, 'GENERATING')
    assert.ok(errorLog.mock.calls.some(call => call.arguments[0] === 'poller: order error'))

    state.emailError = false
    await poller.handler()
    assert.deepEqual(state.captures, ['pi_test_local'])
    assert.equal(state.jobs.length, 1)
    assert.equal(state.emails.length, 1)
    assert.equal(state.orders.get(session.id).status, 'FULFILLED')
})

test('the poller rereads an order before acting on a stale status-index entry', async () => {
    reset()
    const session = await createOrder('se_credit_risk')
    await webhook.handler(signedEvent(session))
    const order = state.orders.get(session.id)
    state.staleOrders = [{
        ...order, jobId: undefined,
        createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }]

    await poller.handler()
    assert.deepEqual(state.cancellations, [])
    assert.deepEqual(state.captures, ['pi_test_local'])
    assert.equal(order.status, 'FULFILLED')

    await poller.handler()
    assert.equal(state.emails.length, 1, 'a stale GENERATING entry must not deliver twice')
})
