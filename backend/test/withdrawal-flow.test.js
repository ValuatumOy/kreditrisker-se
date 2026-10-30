'use strict'

const { test, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
process.env.STRIPE_SECRET_KEY = 'sk_test_local_only'
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_local_only'
process.env.AWS_ACCESS_KEY_ID = 'local-test-only'
process.env.AWS_SECRET_ACCESS_KEY = 'local-test-only'
process.env.AWS_EC2_METADATA_DISABLED = 'true'
process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:1'
delete process.env.APP_SECRETS_ARN
const noNetwork = () => { throw new Error('Unexpected network access') }
global.fetch = noNetwork
for (const protocol of [require('node:http'), require('node:https')]) {
    protocol.request = noNetwork
    protocol.get = noNetwork
}
require('node:net').Socket.prototype.connect = noNetwork
require('node:tls').connect = noNetwork
require('node:http2').connect = noNetwork

const dynamo = require('../src/lib/dynamo')
const email = require('../src/lib/email')
const engine = require('../src/lib/reportEngine')
const stripeLib = require('../src/lib/stripe')
const ID = 'cs_test_local_order_123456789'
let state
beforeEach(() => {
    state = { orders: new Map(), timeline: [], intents: new Map([['pi_local', 'requires_capture']]), receipts: 0, admin: 0, confirmation: 0 }
})
const stripe = {
    webhooks: { constructEvent: body => JSON.parse(body.toString()) },
    paymentIntents: {
        retrieve: async id => ({ status: state.intents.get(id) }),
        cancel: async id => {
            state.timeline.push('cancel')
            if (state.cancelError) throw new Error('Stripe cancel timed out')
            if (state.intents.get(id) === 'succeeded') throw new Error('already captured')
            state.intents.set(id, 'canceled')
            if (state.cancelLostResponse) throw new Error('response lost')
            return { status: 'canceled' }
        },
        capture: async id => {
            state.timeline.push('capture')
            if (state.onCapture) await state.onCapture()
            if (state.intents.get(id) === 'canceled') throw new Error('canceled')
            state.intents.set(id, 'succeeded')
            return { status: 'succeeded' }
        },
    },
}
stripeLib.stripeClient = async () => stripe
dynamo.claimOrder = async order => {
    if (state.orders.has(order.sessionId)) return false
    state.orders.set(order.sessionId, { ...order })
    return true
}
dynamo.getOrder = async id => {
    const order = state.orders.get(id)
    return order ? { ...order } : null
}
dynamo.updateOrder = async (id, attrs) => { Object.assign(state.orders.get(id), attrs) }
dynamo.listOrdersByStatus = async status => [...state.orders.values()].filter(order => order.status === status).map(order => ({ ...order }))
dynamo.listWithdrawals = async (status = 'PENDING') => [...state.orders.values()].filter(order => order.withdrawalState === status).map(order => ({ ...order }))
dynamo.beginGeneration = async id => {
    const order = state.orders.get(id)
    if (order.status !== 'CONFIRMING' || order.withdrawalRequestId) return false
    order.status = 'GENERATING'
    return true
}
dynamo.claimDelivery = async id => {
    if (state.beforeClaim) await state.beforeClaim()
    const order = state.orders.get(id)
    return order.status === 'GENERATING' && !order.withdrawalRequestId
}
dynamo.finishSingleOrder = async (id, attrs) => {
    const order = state.orders.get(id)
    if (order.withdrawalRequestId) return false
    Object.assign(order, attrs)
    return true
}
dynamo.finishWithdrawal = async snapshot => {
    const current = state.orders.get(snapshot.sessionId)
    if (current.withdrawalState !== 'PENDING' || current.withdrawalRequestId !== snapshot.withdrawalRequestId ||
        current.withdrawalPaymentResolution !== snapshot.withdrawalPaymentResolution || !current.withdrawalCustomerAcceptedAt || !current.withdrawalAdminAcceptedAt) return false
    current.withdrawalState = snapshot.withdrawalPaymentResolution === 'REFUND_REQUIRED' ? 'REVIEW_REQUIRED' : 'CLOSED'
    return true
}
dynamo.requestWithdrawal = async ({ sessionId, email: buyer, requestId, requestedAt, receiptMethod }) => {
    const order = state.orders.get(sessionId)
    if (!order || order.email.toLowerCase() !== buyer || order.reportType !== 'se_credit_risk' || order.funding === 'package') return null
    if (!order.withdrawalRequestId) Object.assign(order, { withdrawalRequestId: requestId, withdrawalRequestedAt: requestedAt, withdrawalState: 'PENDING', withdrawalReceiptMethod: receiptMethod })
    return { ...order }
}
engine.submitJob = async () => { state.timeline.push('submit'); if (state.submitError) throw new Error('submission response lost'); return 'job_local' }
engine.getJob = async () => ({ status: state.jobStatus || 'DONE', s3Url: 'https://example.test/fake.pdf' })
engine.downloadPdf = async () => Buffer.from('%PDF fake')
email.sendOrderReceivedEmail = async () => {
    if (state.confirmationError) throw new Error('SES confirmation failed')
    state.confirmation++
    state.timeline.push('confirmation')
}
email.sendReportEmail = async () => { state.timeline.push('report email') }
email.sendAdminGenerationAlert = async () => { state.generationAlerts = (state.generationAlerts || 0) + 1 }
email.sendWithdrawalReceipt = async () => {
    if (state.receiptError) throw new Error('SES receipt failed')
    state.receipts++
}
email.sendWithdrawalAdminAlert = async () => {
    if (state.adminError) throw new Error('SES admin failed')
    state.admin++
}
const webhook = require('../src/handlers/webhook')
const poller = require('../src/handlers/poller')
const withdrawal = require('../src/handlers/withdrawal')
const withdrawals = require('../src/lib/withdrawals')

function completedCheckout(overrides = {}) {
    return { requestContext: { http: { method: 'POST' } }, body: JSON.stringify({
        type: 'checkout.session.completed', data: { object: {
            id: ID, payment_intent: 'pi_local', payment_status: 'unpaid', amount_total: 3640, currency: 'sek',
            customer_details: { email: 'Buyer@example.test' },
            metadata: { reportType: 'se_credit_risk', businessId: '556036-9208', companyName: 'Example AB', lang: 'sv', reportLang: 'sv' },
            ...overrides,
        } },
    }) }
}
const request = (attrs = {}) => withdrawal.handler({ requestContext: { http: { method: 'POST' } },
    body: JSON.stringify({ sessionId: ID, email: 'buyer@example.test', confirmed: true, receiptMethod: 'email', ...attrs }) })
async function start() {
    assert.equal((await webhook.handler(completedCheckout())).statusCode, 200)
    return state.orders.get(ID)
}

test('Basic confirmation precedes one job and duplicate webhook/polling cannot resubmit', async () => {
    await start()
    await webhook.handler(completedCheckout())
    assert.deepEqual(state.timeline, [])
    await poller.handler()
    await poller.handler()
    assert.deepEqual(state.timeline, ['confirmation', 'submit', 'capture', 'report email'])
    assert.equal(state.orders.get(ID).status, 'FULFILLED')
})

test('a checkout event with a personal identifier never starts a report', async () => {
    const event = completedCheckout({ metadata: { reportType: 'se_credit_risk', businessId: '800101-1231' } })
    assert.equal((await webhook.handler(event)).statusCode, 200)
    await poller.handler()
    assert.equal(state.orders.size, 0)
    assert.deepEqual(state.timeline, [])
})

test('a malformed single-report payment retries at the webhook without claiming or generating', async () => {
    for (const overrides of [
        { payment_intent: null },
        { payment_intent: { id: '' } },
        { payment_intent: 'not-a-payment-intent' },
        { amount_total: undefined },
        { amount_total: -1 },
        { amount_total: 0, payment_intent: null, payment_status: 'unpaid' },
        { amount_total: 3640, payment_intent: null, payment_status: 'no_payment_required' },
    ]) {
        assert.equal((await webhook.handler(completedCheckout(overrides))).statusCode, 503)
        assert.equal((await webhook.handler(completedCheckout(overrides))).statusCode, 503)
    }
    await poller.handler()
    assert.equal(state.orders.size, 0)
    assert.deepEqual(state.timeline, [])
})

test('incomplete persisted payment stops Basic generation and remains visible for operational review', async () => {
    const order = await start()
    order.paymentIntentId = null
    order.createdAt = new Date(Date.now() - 90 * 60_000).toISOString()
    await poller.handler()
    await poller.handler()
    assert.equal(order.status, 'CONFIRMING', 'must not mark a missing authorization as released even after timeout')
    assert.deepEqual(state.timeline, [])
    assert.equal(state.generationAlerts || 0, 0)
    assert.equal(order.confirmationAcceptedAt, undefined)
})

test('incomplete payment blocks a finished report, direct delivery, failure and withdrawal release', async () => {
    const order = await start()
    order.status = 'GENERATING'
    order.jobId = 'job_local'
    order.paymentIntentId = null
    await poller.handler()
    await assert.rejects(poller.deliver(stripe, order, Buffer.from('pdf')), /Payment review required/)
    await assert.rejects(poller.fail(stripe, order, 'failed'), /Payment review required/)
    assert.equal(order.status, 'GENERATING')
    await request()
    await poller.handler()
    assert.equal(order.withdrawalState, 'PENDING')
    assert.equal(order.withdrawalPaymentResolution, undefined)
    assert.match(order.withdrawalPaymentError, /Payment review required/)
    assert.deepEqual(state.timeline, [])
    assert.equal(state.generationAlerts || 0, 0)
    assert.equal(state.admin, 0, 'must not send an authorization-released notice')
})

test('only a signed zero-total no_payment_required Checkout can complete without a PaymentIntent', async () => {
    assert.equal((await webhook.handler(completedCheckout({ amount_total: 0, payment_intent: null, payment_status: 'no_payment_required' }))).statusCode, 200)
    const order = state.orders.get(ID)
    assert.equal(order.paymentStatus, 'no_payment_required')
    await poller.handler()
    assert.deepEqual(state.timeline, ['confirmation', 'submit', 'report email'])
    assert.equal(order.status, 'FULFILLED')
    await request()
    await poller.handler()
    assert.equal(order.withdrawalPaymentResolution, 'NO_PAYMENT')
    assert.equal(order.withdrawalState, 'CLOSED')
})

test('withdrawal keeps an uncertain zero-total payment pending until no_payment_required is verified', async () => {
    const order = await start()
    order.amountTotal = 0
    order.paymentIntentId = null
    await request()
    for (const paymentStatus of [undefined, 'unpaid', 'paid']) {
        order.paymentStatus = paymentStatus
        await poller.handler()
        assert.equal(order.withdrawalState, 'PENDING')
        assert.equal(order.withdrawalPaymentResolution, undefined)
        assert.match(order.withdrawalPaymentError, /Payment review required/)
        assert.equal(state.admin, 0, 'must not claim there was no payment')
        assert.deepEqual(state.timeline, [])
    }
    order.paymentStatus = 'no_payment_required'
    await poller.handler()
    assert.equal(order.withdrawalPaymentResolution, 'NO_PAYMENT')
    assert.equal(order.withdrawalState, 'CLOSED')
    assert.equal(state.admin, 1)
    assert.deepEqual(state.timeline, [])
})

test('withdrawal rejects null, arrays and primitives as client errors', async () => {
    for (const body of [null, [], ['unexpected'], 42, 'text', true]) {
        const response = await withdrawal.handler({ requestContext: { http: { method: 'POST' } }, body: JSON.stringify(body) })
        assert.equal(response.statusCode, 400)
    }
    assert.equal(state.orders.size, 0)
})

test('confirmation failure holds generation and payment and retries the same order', async () => {
    const order = await start()
    state.confirmationError = true
    await poller.handler()
    assert.equal(order.status, 'CONFIRMING')
    assert.deepEqual(state.timeline, [])
    state.confirmationError = false
    await poller.handler()
    assert.equal(state.confirmation, 1)
    assert.equal(order.status, 'FULFILLED')
})

test('an unknown Basic submission response never triggers a second paid job', async () => {
    const order = await start()
    state.submitError = true
    await poller.handler()
    await poller.handler()
    assert.deepEqual(state.timeline, ['confirmation', 'submit'])
    assert.equal(order.status, 'GENERATING')
    order.createdAt = new Date(Date.now() - 10 * 60_000).toISOString()
    await poller.handler()
    assert.deepEqual(state.timeline, ['confirmation', 'submit', 'cancel'])
    assert.equal(order.status, 'FAILED')
})

test('withdrawal needs explicit confirmation and a matching order/email pair; repeats retain the original receipt', async () => {
    await start()
    assert.equal((await request({ confirmed: false })).statusCode, 400)
    assert.equal((await request({ receiptMethod: undefined })).statusCode, 400)
    assert.equal((await request({ email: 'wrong@example.test' })).statusCode, 404)
    assert.equal((await request({ sessionId: 'cs_test_unknown_123456789' })).statusCode, 404)
    const first = await request()
    const repeated = await request()
    assert.equal(first.statusCode, 202)
    assert.equal(JSON.parse(first.body).requestId, JSON.parse(repeated.body).requestId)
    assert.equal(JSON.parse(first.body).receivedAt, JSON.parse(repeated.body).receivedAt)
    assert.equal(state.receipts, 1)
    assert.equal(state.orders.get(ID).withdrawalReceiptMethod, 'email')
})

test('withdrawal before confirmation releases the hold and does not start a report', async () => {
    const order = await start()
    await request()
    await poller.handler()
    assert.deepEqual(state.timeline, ['cancel'])
    assert.equal(state.intents.get('pi_local'), 'canceled')
    assert.equal(order.status, 'WITHDRAWN')
    assert.equal(order.withdrawalState, 'CLOSED')
    assert.equal(state.admin, 1)
    assert.equal(state.receipts, 1)
})

test('withdrawal winning the delivery claim prevents capture and is resolved on the next tick', async () => {
    const order = await start()
    state.beforeClaim = async () => { state.beforeClaim = null; await request() }
    await poller.handler()
    assert.deepEqual(state.timeline, ['confirmation', 'submit'])
    await poller.handler()
    assert.deepEqual(state.timeline, ['confirmation', 'submit', 'cancel'])
    assert.equal(order.withdrawalState, 'CLOSED')
})

test('capture winning the race preserves the request and queues a manual refund without claiming one was issued', async () => {
    const order = await start()
    state.onCapture = async () => { state.onCapture = null; await request() }
    await poller.handler()
    assert.equal(order.status, 'GENERATING', 'fulfillment must not overwrite the durable withdrawal')
    await poller.handler()
    assert.equal(order.status, 'WITHDRAWN')
    assert.equal(order.withdrawalPaymentResolution, 'REFUND_REQUIRED')
    assert.equal(order.withdrawalState, 'REVIEW_REQUIRED')
    assert.equal(state.timeline.filter(event => event === 'capture').length, 1)
    assert.equal(state.admin, 1)
    await poller.handler()
    assert.equal(order.withdrawalState, 'REVIEW_REQUIRED', 'manual action remains pending until an operator verifies a refund')
    assert.equal(state.admin, 1, 'the ongoing backlog alarm must not spam another email')
})

test('a stale withdrawal worker cannot reopen a verified closed refund', async () => {
    const order = await start()
    await request()
    order.status = 'WITHDRAWN'
    order.withdrawalPaymentResolution = 'REFUND_REQUIRED'
    order.withdrawalCustomerAcceptedAt = '2026-10-30T00:00:00Z'
    order.withdrawalAdminAcceptedAt = '2026-10-30T00:00:00Z'
    const stale = { ...order }
    order.withdrawalState = 'CLOSED'
    await withdrawals.processWithdrawal(stripe, stale)
    assert.equal(order.withdrawalState, 'CLOSED')
})

test('a lost cancel response is resolved from Stripe status and an unresolved timeout remains queued', async () => {
    const order = await start()
    await request()
    state.cancelError = true
    await poller.handler()
    assert.equal(order.withdrawalState, 'PENDING')
    assert.equal(order.withdrawalPaymentResolution, undefined)
    assert.equal(state.admin, 0)
    state.cancelError = false
    state.cancelLostResponse = true
    await poller.handler()
    assert.equal(order.withdrawalState, 'CLOSED')
    assert.equal(order.withdrawalPaymentResolution, 'AUTHORIZATION_RELEASED')
    assert.equal(state.receipts, 1)
})

test('failed customer/admin receipts retry separately while accepted receipts are not repeated', async () => {
    const order = await start()
    state.receiptError = true
    const response = await request()
    assert.equal(response.statusCode, 202)
    assert.equal(JSON.parse(response.body).receiptEmailAccepted, false)
    state.adminError = true
    await poller.handler()
    assert.equal(order.withdrawalState, 'PENDING')
    assert.equal(order.withdrawalPaymentResolution, 'AUTHORIZATION_RELEASED')
    state.receiptError = false
    await poller.handler()
    assert.equal(state.receipts, 1)
    assert.equal(order.withdrawalState, 'PENDING')
    state.adminError = false
    await poller.handler()
    assert.equal(order.withdrawalState, 'CLOSED')
    assert.equal(state.receipts, 1)
    assert.equal(state.admin, 1)
    assert.equal(state.timeline.filter(event => event === 'cancel').length, 1)
})
