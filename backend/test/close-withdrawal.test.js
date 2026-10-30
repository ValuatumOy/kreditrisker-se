'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
require('./no-network.cjs')
const { closeWithdrawal } = require('../src/lib/closeWithdrawal')
const dynamo = require('../src/lib/dynamo')

const id = 'cs_test_example123'
const order = { sessionId: id, reportType: 'se_credit_risk', status: 'WITHDRAWN', withdrawalRequestId: 'withdrawal-example', withdrawalState: 'REVIEW_REQUIRED', withdrawalPaymentResolution: 'REFUND_REQUIRED', paymentIntentId: 'pi_example123', amountTotal: 3625, currency: 'sek' }
const intent = { id: order.paymentIntentId, livemode: false, status: 'succeeded', amount_received: order.amountTotal, currency: 'sek' }
const session = { id, livemode: false, amount_total: order.amountTotal, currency: 'sek', payment_intent: intent, metadata: { reportType: 'se_credit_risk' } }
const refund = { id: 're_example123', payment_intent: intent.id, status: 'succeeded', amount: 3625, currency: 'sek' }

function adapters({ stored = order, checkout = session, refunds = [refund], hasMore = false, closed = true } = {}) {
    const calls = []
    const stripe = { checkout: { sessions: { retrieve: async () => checkout } }, refunds: { list: async () => ({ data: refunds, has_more: hasMore }) } }
    const store = { getOrder: async () => stored, closeRefundedWithdrawal: async (...args) => { calls.push(args); return closed } }
    return { stripe, store, calls }
}

test('fully refunded captured payment can be marked closed', async () => {
    const { stripe, store, calls } = adapters()
    assert.deepEqual(await closeWithdrawal(id, stripe, store), { status: 'CLOSED', refundedAmount: 3625, currency: 'sek' })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0][2], ['re_example123'])
})

test('partial, pending, mismatched or uncertain refunds stay in review', async () => {
    for (const scenario of [
        { refunds: [{ ...refund, amount: 1000 }] },
        { refunds: [{ ...refund, status: 'pending' }] },
        { refunds: [{ ...refund, currency: 'eur' }] },
        { refunds: [{ ...refund, payment_intent: 'pi_other' }] },
        { hasMore: true },
        { checkout: { ...session, livemode: true } },
        { stored: { ...order, withdrawalState: 'PENDING' } },
    ]) {
        const { stripe, store, calls } = adapters(scenario)
        await assert.rejects(closeWithdrawal(id, stripe, store))
        assert.equal(calls.length, 0)
    }
})

test('concurrent order changes cannot be silently marked closed', async () => {
    const { stripe, store } = adapters({ closed: false })
    await assert.rejects(closeWithdrawal(id, stripe, store), /Order changed/)
    const send = mock.method(dynamo.doc, 'send', async () => { const error = new Error('changed'); error.name = 'ConditionalCheckFailedException'; throw error })
    try {
        assert.equal(await dynamo.closeRefundedWithdrawal(order, '2026-10-30T00:00:00Z', ['re_example123']), false)
        const input = send.mock.calls[0].arguments[0].input
        assert.match(input.ConditionExpression, /withdrawalPaymentResolution = :required/)
        assert.match(input.ConditionExpression, /withdrawalRequestId = :request/)
        assert.match(input.ConditionExpression, /paymentIntentId = :intent/)
        assert.match(input.ConditionExpression, /amountTotal = :amount/)
    } finally { mock.restoreAll() }
})
