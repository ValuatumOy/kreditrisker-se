'use strict'
const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const dynamo = require('../src/lib/dynamo')

test('concurrent requests preserve the first withdrawal and do not remove the fulfillment status', async () => {
    const order = { sessionId: 'cs_test_order', email: ' Buyer@Example.com ', reportType: 'se_credit_risk', status: 'GENERATING' }
    const send = mock.method(dynamo.doc, 'send', async command => {
        if (command.constructor.name === 'GetCommand') return { Item: { ...order } }
        const input = command.input
        assert.match(input.ConditionExpression, /attribute_not_exists\(withdrawalRequestId\)/)
        assert.equal(input.ExpressionAttributeValues[':email'], order.email)
        if (order.withdrawalRequestId) throw Object.assign(new Error('already requested'), { name: 'ConditionalCheckFailedException' })
        for (const [name, field] of Object.entries(input.ExpressionAttributeNames)) {
            if (!name.startsWith('#a')) continue
            order[field] = input.ExpressionAttributeValues[name.replace('#', ':')]
        }
        return {}
    })
    try {
        const [a, b] = await Promise.all([
            dynamo.requestWithdrawal({ sessionId: order.sessionId, email: 'buyer@example.com', requestId: 'first', requestedAt: '2026-10-30T10:00:00Z', receiptMethod: 'email' }),
            dynamo.requestWithdrawal({ sessionId: order.sessionId, email: 'buyer@example.com', requestId: 'second', requestedAt: '2026-10-30T10:01:00Z', receiptMethod: 'email' }),
        ])
        assert.equal(a.withdrawalRequestId, 'first')
        assert.equal(b.withdrawalRequestId, 'first')
        assert.equal(b.withdrawalRequestedAt, '2026-10-30T10:00:00Z')
        assert.equal(order.status, 'GENERATING')
        assert.equal(order.withdrawalState, 'PENDING')
        assert.equal(order.withdrawalReceiptMethod, 'email')
        assert.ok(send.mock.callCount() >= 4)
    } finally { mock.restoreAll() }
})

test('generation, delivery, and final status writes use conditions that a withdrawal defeats', async () => {
    const calls = []
    mock.method(dynamo.doc, 'send', async command => {
        calls.push(command.input)
        throw Object.assign(new Error('withdrawal won'), { name: 'ConditionalCheckFailedException' })
    })
    try {
        assert.equal(await dynamo.beginGeneration('cs_test_order'), false)
        assert.equal(await dynamo.claimDelivery('cs_test_order'), false)
        assert.equal(await dynamo.finishSingleOrder('cs_test_order', { status: 'FULFILLED' }), false)
        assert.equal(calls.length, 3)
        for (const input of calls) assert.match(input.ConditionExpression, /attribute_not_exists\(withdrawalRequestId\)/)
        assert.match(calls[0].ConditionExpression, /#status = :confirming/)
        assert.match(calls[1].ConditionExpression, /#status = :generating/)
    } finally { mock.restoreAll() }
})

test('the withdrawal worker queries its durable pending index rather than depending on GENERATING', async () => {
    const queries = []
    mock.method(dynamo.doc, 'send', async command => {
        queries.push(command.input)
        return queries.length === 1
            ? { Items: [{ sessionId: 'a', status: 'WITHDRAWN' }], LastEvaluatedKey: { sessionId: 'a' } }
            : { Items: [{ sessionId: 'b', status: 'FULFILLED' }] }
    })
    try {
        assert.equal((await dynamo.listWithdrawals()).length, 2)
        assert.equal(queries[0].IndexName, 'WithdrawalIndex')
        assert.deepEqual(queries[0].ExpressionAttributeValues, { ':state': 'PENDING' })
        assert.deepEqual(queries[1].ExclusiveStartKey, { sessionId: 'a' })
    } finally { mock.restoreAll() }
})

test('withdrawal finalization cannot reopen a closed or changed request', async () => {
    const order = { sessionId: 'cs_test_order', withdrawalRequestId: 'request-1', withdrawalPaymentResolution: 'REFUND_REQUIRED' }
    let input
    mock.method(dynamo.doc, 'send', async command => {
        input = command.input
        throw Object.assign(new Error('order changed'), { name: 'ConditionalCheckFailedException' })
    })
    try {
        assert.equal(await dynamo.finishWithdrawal(order), false)
        assert.match(input.ConditionExpression, /#state = :pending/)
        assert.match(input.ConditionExpression, /withdrawalRequestId = :request/)
        assert.match(input.ConditionExpression, /withdrawalPaymentResolution = :resolution/)
        assert.match(input.ConditionExpression, /attribute_exists\(withdrawalCustomerAcceptedAt\)/)
        assert.match(input.ConditionExpression, /attribute_exists\(withdrawalAdminAcceptedAt\)/)
        assert.equal(input.ExpressionAttributeValues[':pending'], 'PENDING')
        assert.equal(input.ExpressionAttributeValues[':request'], order.withdrawalRequestId)
        assert.equal(input.ExpressionAttributeValues[':resolution'], 'REFUND_REQUIRED')
    } finally { mock.restoreAll() }
})
