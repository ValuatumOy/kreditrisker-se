'use strict'

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

process.env.CREDITS_TABLE = 'test-credits'
process.env.ORDERS_TABLE = 'test-orders'

const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb')
const credits = require('../src/lib/credits')

const ORDER = {
    sessionId: 'pkg_11111111-2222-4333-8444-555555555555',
    companyName: 'JYSK A/S',
}
const OCCURRED_AT = '2026-08-18T03:12:00.000Z'
const BASE = {
    email: 'Buyer@Example.COM ',
    reportType: 'se_credit_risk',
    order: ORDER,
    occurredAt: OCCURRED_AT,
}
const PURCHASE = {
    ...BASE,
    count: 3,
    checkoutSessionId: 'cs_test_1',
    order: {
        ...ORDER,
        purchaseSku: 'se_credit_risk_bundle',
        purchasePaymentIntentId: 'pi_test_1',
        amountTotal: 1500,
        currency: 'sek',
    },
}
const SETTLE = {
    email: BASE.email,
    reportType: 'se_credit_risk',
    sessionId: ORDER.sessionId,
    companyName: ORDER.companyName,
    occurredAt: OCCURRED_AT,
    orderAttrs: { status: 'FULFILLED' },
}

// One cancellation reason per transaction item, in item order.
function cancel(...codes) {
    const err = new Error('Transaction cancelled')
    err.name = 'TransactionCanceledException'
    err.CancellationReasons = codes.map(code => ({ Code: code }))
    return err
}
const OK = 'None'
const FAIL = 'ConditionalCheckFailed'

function mockSend(err) {
    mock.method(DynamoDBDocumentClient.prototype, 'send', async () => {
        if (err) throw err
        return {}
    })
}

beforeEach(() => mock.restoreAll())

const itemsOf = input => input.TransactItems
const balanceOf = input => itemsOf(input)[credits.ITEM.BALANCE].Update

test('a purchase grants the count, reserves one of it, and claims the order', () => {
    const input = credits.buildPurchaseAndReserve(PURCHASE)
    const balance = balanceOf(input)

    assert.deepEqual(balance.Key, {
        pk: 'CUST#buyer@example.com',
        sk: 'BAL#se_credit_risk',
    })
    // 3 bought, 1 held for the report generating now, 2 left spendable.
    assert.equal(balance.ExpressionAttributeValues[':granted'], 2)
    assert.equal(balance.ExpressionAttributeValues[':count'], 3)
    assert.equal(
        itemsOf(input).filter(i => i.Update?.Key?.sk === 'BAL#se_credit_risk')
            .length,
        1,
        'DynamoDB rejects two operations on one item'
    )

    const order = itemsOf(input)[credits.ITEM.PURCHASE_ORDER].Put
    assert.equal(order.TableName, 'test-orders')
    assert.equal(order.ConditionExpression, 'attribute_not_exists(sessionId)')
    assert.equal(order.Item.funding, 'package')
    assert.equal(order.Item.creditState, 'RESERVED')
    assert.deepEqual(order.Item.creditKey, {
        email: 'buyer@example.com',
        reportType: 'se_credit_risk',
    })
    assert.throws(
        () =>
            credits.buildReserveExisting({
                ...BASE,
                order: { ...ORDER, paymentIntentId: 'pi_1' },
            }),
        /must not carry paymentIntentId/
    )
})

test('ledger ids are fixed by the session, so redelivery cannot grant or reserve twice', () => {
    const items = itemsOf(credits.buildPurchaseAndReserve(PURCHASE))
    for (const [index, sk, delta] of [
        [credits.ITEM.PURCHASE_GRANT_TXN, 'TXN#GRANT#cs_test_1', 3],
        [credits.ITEM.PURCHASE_RESERVE_TXN, 'TXN#RESERVE#cs_test_1', 0],
    ]) {
        assert.equal(items[index].Put.Item.sk, sk)
        assert.equal(items[index].Put.Item.delta, delta)
        assert.equal(items[index].Put.Item.createdAt, OCCURRED_AT)
        assert.equal(
            items[index].Put.ConditionExpression,
            'attribute_not_exists(pk)'
        )
    }

    const grant = items[credits.ITEM.PURCHASE_GRANT_TXN].Put.Item
    assert.equal(grant.notificationType, 'CREDIT_GRANT')
    assert.equal(grant.notificationRecipient, 'buyer@example.com')
    assert.equal(grant.notificationCount, 3)
    assert.equal(grant.notificationStatus, 'PENDING')
    assert.equal(grant.notificationQueue, 'PENDING')
    assert.equal(grant.notificationNextAttemptAt, OCCURRED_AT)

    const reserve = itemsOf(credits.buildReserveExisting(BASE))[
        credits.ITEM.TXN
    ].Put
    assert.equal(reserve.Item.sk, `TXN#RESERVE#${ORDER.sessionId}`)
    assert.equal(reserve.Item.notificationQueue, undefined)
})

test('a redelivered webhook reports DUPLICATE instead of granting again', async () => {
    for (const codes of [
        [OK, FAIL, OK, OK], // grant already written
        [OK, OK, FAIL, OK], // reservation already written
    ]) {
        mockSend(cancel(...codes))
        const res = await credits.purchaseAndReserve(PURCHASE)
        assert.deepEqual(res, { status: 'DUPLICATE' }, codes.join(','))
        mock.restoreAll()
    }
})

test('a paid bundle grants all credits when its fulfillment order already exists', async () => {
    const sent = []
    mock.method(DynamoDBDocumentClient.prototype, 'send', async command => {
        sent.push(command.input)
        if (sent.length === 1) throw cancel(OK, OK, OK, FAIL)
        return {}
    })

    assert.deepEqual(await credits.purchaseAndReserve(PURCHASE), {
        status: 'GRANTED_EXISTING_ORDER',
    })
    assert.equal(sent.length, 2)

    const fallback = sent[1]
    assert.equal(fallback.TransactItems.length, 3)
    assert.equal(balanceOf(fallback).ExpressionAttributeValues[':count'], 3)
    assert.equal(balanceOf(fallback).ExpressionAttributeValues[':zero'], 0)

    const grant = itemsOf(fallback)[credits.ITEM.TXN].Put
    assert.equal(grant.Item.sk, 'TXN#GRANT#cs_test_1')
    assert.equal(grant.Item.delta, 3)
    assert.equal(grant.Item.notificationQueue, 'PENDING')
    assert.equal(grant.Item.notificationCount, 3)
    assert.equal(grant.ConditionExpression, 'attribute_not_exists(pk)')

    const order = itemsOf(fallback)[credits.ITEM.ORDER].Update
    assert.deepEqual(order.Key, { sessionId: ORDER.sessionId })
    assert.equal(order.ExpressionAttributeValues[':package'], 'package')
    assert.equal(order.ExpressionAttributeValues[':email'], 'buyer@example.com')
    assert.equal(
        order.ExpressionAttributeValues[':reportType'],
        'se_credit_risk'
    )
    assert.equal(
        order.ExpressionAttributeValues[':checkoutSessionId'],
        'cs_test_1'
    )
    assert.equal(
        order.ExpressionAttributeValues[':purchaseSku'],
        'se_credit_risk_bundle'
    )
    assert.equal(
        order.ExpressionAttributeValues[':purchasePaymentIntentId'],
        'pi_test_1'
    )
    assert.equal(order.ExpressionAttributeValues[':amountTotal'], 1500)
    assert.equal(order.ExpressionAttributeValues[':currency'], 'sek')
})

test('an empty balance sends the customer to Stripe, a repeated request id does not', async () => {
    assert.equal(
        balanceOf(credits.buildReserveExisting(BASE)).ConditionExpression,
        'attribute_exists(pk) AND #remaining >= :one'
    )

    mockSend(cancel(FAIL, OK, OK))
    assert.deepEqual(await credits.reserveExisting(BASE), {
        status: 'NEEDS_PURCHASE',
    })
    mock.restoreAll()

    // Same exception, opposite answer: duplicate markers mean this request
    // already reserved — even when that reservation used the last credit and the
    // balance condition now fails too.
    for (const codes of [
        [OK, FAIL, FAIL],
        [OK, OK, FAIL],
        [OK, FAIL, OK],
        [FAIL, FAIL, FAIL],
    ]) {
        mockSend(cancel(...codes))
        assert.deepEqual(
            await credits.reserveExisting(BASE),
            { status: 'DUPLICATE' },
            codes.join(',')
        )
        mock.restoreAll()
    }
})

test('a cancellation that is not a condition failure keeps throwing', async () => {
    mockSend(cancel('TransactionConflict', OK, OK))
    await assert.rejects(credits.reserveExisting(BASE), /Transaction cancelled/)
    mock.restoreAll()
    mockSend(
        Object.assign(new Error('boom'), {
            name: 'ProvisionedThroughputExceededException',
        })
    )
    await assert.rejects(credits.reserveExisting(BASE), /boom/)
})

test('consume spends the held report, release returns it, both only from RESERVED', () => {
    const consumed = credits.buildSettle({ kind: 'CONSUME', ...SETTLE })
    const released = credits.buildSettle({ kind: 'RELEASE', ...SETTLE })

    assert.match(
        balanceOf(consumed).UpdateExpression,
        /ADD #reserved :minusOne, #usedTotal :one/
    )
    assert.match(
        balanceOf(released).UpdateExpression,
        /ADD #reserved :minusOne, #remaining :one/
    )
    assert.equal(itemsOf(consumed)[credits.ITEM.TXN].Put.Item.delta, -1)
    assert.equal(
        itemsOf(consumed)[credits.ITEM.TXN].Put.Item.notificationQueue,
        undefined
    )
    assert.equal(itemsOf(released)[credits.ITEM.TXN].Put.Item.delta, 0)
    assert.equal(
        itemsOf(released)[credits.ITEM.TXN].Put.Item.notificationType,
        'CREDIT_RELEASE'
    )
    assert.equal(
        itemsOf(released)[credits.ITEM.TXN].Put.Item.notificationCount,
        1
    )
    assert.equal(
        itemsOf(released)[credits.ITEM.TXN].Put.Item.notificationQueue,
        'PENDING'
    )
    assert.equal(
        itemsOf(released)[credits.ITEM.TXN].Put.Item.notificationNextAttemptAt,
        OCCURRED_AT
    )
    assert.equal(
        itemsOf(consumed)[credits.ITEM.TXN].Put.Item.createdAt,
        OCCURRED_AT
    )

    for (const [input, next] of [
        [consumed, 'CONSUMED'],
        [released, 'RELEASED'],
    ]) {
        const order = itemsOf(input)[credits.ITEM.ORDER].Update
        assert.deepEqual(order.Key, { sessionId: ORDER.sessionId })
        // An overlapping poller tick cannot spend or return the same report twice.
        assert.equal(order.ConditionExpression, '#creditState = :reserved')
        assert.equal(order.ExpressionAttributeValues[':nextCreditState'], next)
        // The caller's terminal status rides along in the same transaction.
        assert.equal(order.ExpressionAttributeValues[':a0'], 'FULFILLED')
    }
})

test('a settlement done elsewhere is reported; a disagreeing ledger throws', async () => {
    for (const codes of [
        [OK, OK, FAIL],
        [OK, FAIL, OK],
    ]) {
        mockSend(cancel(...codes))
        assert.deepEqual(await credits.consume(SETTLE), {
            status: 'ALREADY_SETTLED',
        })
        mock.restoreAll()
    }
    mockSend(cancel(FAIL, OK, OK))
    await assert.rejects(credits.release(SETTLE), /Transaction cancelled/)
})
