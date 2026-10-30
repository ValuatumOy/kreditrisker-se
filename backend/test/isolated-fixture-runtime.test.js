'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./no-network.cjs')
process.env.REPORT_ISOLATED_FIXTURE_TEST = '1'

const fixture = {
    sessionId: 'cs_test_fixture_123456', status: 'CONFIRMING',
    reportType: 'se_credit_risk', email: 'success@simulator.amazonses.com',
    params: { companyCode: '0020001012' }, createdAt: new Date().toISOString(),
    amountTotal: 0, paymentStatus: 'no_payment_required',
}
const other = { ...fixture, sessionId: 'cs_test_other_123456', params: { companyCode: '5560369208' } }
const otherGenerating = { ...other, sessionId: 'cs_test_generating_123456', status: 'GENERATING', jobId: 'job_test' }
const calls = []
const dynamo = require('../src/lib/dynamo')
dynamo.listWithdrawals = async state => state ? [] : [{ sessionId: other.sessionId }]
dynamo.listOrdersByStatus = async state => state === 'CONFIRMING' ? [other, fixture] : [otherGenerating]
dynamo.getOrder = async id => id === fixture.sessionId ? fixture : id === otherGenerating.sessionId ? otherGenerating : other
dynamo.updateOrder = async () => {}
dynamo.beginGeneration = async () => true
require('../src/lib/stripe').stripeClient = async () => ({})
require('../src/lib/email').sendOrderReceivedEmail = async order => calls.push(`email:${order.sessionId}`)
require('../src/lib/fulfillment').startFulfillment = async order => calls.push(`report:${order.sessionId}`)
require('../src/lib/reportEngine').getJob = async () => { calls.push('getJob'); return { status: 'PENDING' } }
require('../src/lib/withdrawals').processWithdrawal = async (_stripe, order) => calls.push(`withdraw:${order.sessionId}`)
const poller = require('../src/handlers/poller').handler
const notifications = require('../src/handlers/credit-notifications').handler
const withdrawal = require('../src/handlers/withdrawal').handler

test('poller ignores non-fixture orders while processing the synthetic order', async () => {
    await poller()
    assert.deepEqual(calls, [`email:${fixture.sessionId}`, `report:${fixture.sessionId}`])
})

test('fixture mode disables credit notifications and non-fixture withdrawal', async () => {
    assert.deepEqual(await notifications(), { disabled: true })
    const response = await withdrawal({
        requestContext: { http: { method: 'POST' } },
        body: JSON.stringify({ sessionId: other.sessionId, email: other.email, confirmed: true, receiptMethod: 'email' }),
    })
    assert.equal(response.statusCode, 404)
})
