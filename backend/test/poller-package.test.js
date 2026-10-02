'use strict'

const { test, mock, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

process.env.CREDITS_TABLE = 'test-credits'
process.env.ORDERS_TABLE = 'test-orders'

const credits = require('../src/lib/credits')
const dynamo = require('../src/lib/dynamo')
const emailService = require('../src/lib/email')
const {
    settleFunding,
    releaseFunding,
    deliver,
    fail,
} = require('../src/handlers/poller')

const PACKAGE_ORDER = {
    sessionId: 'pkg_11111111-2222-4333-8444-555555555555',
    funding: 'package',
    creditKey: { email: 'buyer@example.com', reportType: 'se_credit_risk' },
    companyName: 'JYSK A/S',
    email: 'buyer@example.com',
}

beforeEach(() => {
    mock.restoreAll()
    mock.method(emailService, 'sendReportEmail', async () => undefined)
    mock.method(emailService, 'sendCreditReleaseEmail', async () => undefined)
    mock.method(emailService, 'sendAdminGenerationAlert', async () => undefined)
})

test('package success consumes the reservation and ends the order atomically', async () => {
    const consume = mock.method(credits, 'consume', async () => ({
        status: 'SETTLED',
    }))
    const updateOrder = mock.method(dynamo, 'updateOrder')

    await settleFunding(PACKAGE_ORDER)

    assert.equal(consume.mock.callCount(), 1)
    const input = consume.mock.calls[0].arguments[0]
    assert.equal(input.email, 'buyer@example.com')
    assert.equal(input.reportType, 'se_credit_risk')
    assert.equal(input.sessionId, PACKAGE_ORDER.sessionId)
    assert.equal(input.companyName, 'JYSK A/S')
    assert.match(input.occurredAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.deepEqual(input.orderAttrs, { status: 'FULFILLED' })
    assert.equal(updateOrder.mock.callCount(), 0)
})

test('package failure returns the reservation and ends the order atomically', async () => {
    const release = mock.method(credits, 'release', async () => ({
        status: 'SETTLED',
    }))
    const updateOrder = mock.method(dynamo, 'updateOrder')

    await releaseFunding(PACKAGE_ORDER, 'Generation timed out')

    assert.deepEqual(release.mock.calls[0].arguments[0].orderAttrs, {
        status: 'FAILED',
        error: 'Generation timed out',
    })
    assert.equal(updateOrder.mock.callCount(), 0)
})

test('package delivery counts what is left once this report is spent', async () => {
    // This balance still includes the report being delivered.
    const getBalance = mock.method(credits, 'getBalance', async () => ({
        remaining: 1,
        reserved: 2,
    }))
    const consume = mock.method(credits, 'consume', async () => ({
        status: 'SETTLED',
    }))

    await deliver({}, PACKAGE_ORDER, Buffer.from('pdf'))

    assert.equal(emailService.sendReportEmail.mock.callCount(), 1)
    const emailDetails = emailService.sendReportEmail.mock.calls[0].arguments[1]
    assert.equal(emailDetails.remainingReports, 2)
    assert.equal(getBalance.mock.callCount(), 1)
    assert.equal(consume.mock.callCount(), 1)
})

test('a balance read failure does not block report delivery', async () => {
    mock.method(credits, 'getBalance', async () => {
        throw new Error('DynamoDB unavailable')
    })
    const consume = mock.method(credits, 'consume', async () => ({
        status: 'SETTLED',
    }))

    await deliver({}, PACKAGE_ORDER, Buffer.from('pdf'))

    const emailDetails = emailService.sendReportEmail.mock.calls[0].arguments[1]
    assert.equal(emailDetails.remainingReports, undefined)
    assert.equal(consume.mock.callCount(), 1)
})

test('package failure relies on the transactional release outbox', async () => {
    const release = mock.method(credits, 'release', async () => ({
        status: 'SETTLED',
    }))

    await fail({}, PACKAGE_ORDER, 'Generation timed out')

    assert.equal(emailService.sendCreditReleaseEmail.mock.callCount(), 0)
    assert.equal(emailService.sendAdminGenerationAlert.mock.callCount(), 1)

    release.mock.mockImplementation(async () => ({ status: 'ALREADY_SETTLED' }))
    await fail({}, PACKAGE_ORDER, 'Generation timed out')
    assert.equal(emailService.sendCreditReleaseEmail.mock.callCount(), 0)
    assert.equal(emailService.sendAdminGenerationAlert.mock.callCount(), 2)
})

test('legacy Stripe orders still use ordinary order updates', async () => {
    const consume = mock.method(credits, 'consume')
    const release = mock.method(credits, 'release')
    const updateOrder = mock.method(
        dynamo,
        'updateOrder',
        async () => undefined
    )
    const order = { sessionId: 'cs_test_single' }

    await settleFunding(order, { deliveryPayload: { rating: 'A' } })
    await releaseFunding(order, 'Generation failed')

    assert.deepEqual(
        updateOrder.mock.calls.map(call => call.arguments),
        [
            [
                'cs_test_single',
                { deliveryPayload: { rating: 'A' }, status: 'FULFILLED' },
            ],
            [
                'cs_test_single',
                { status: 'FAILED', error: 'Generation failed' },
            ],
        ]
    )
    assert.equal(consume.mock.callCount(), 0)
    assert.equal(release.mock.callCount(), 0)
})

test('a malformed package order is not settled against a guessed balance', async () => {
    const consume = mock.method(credits, 'consume')

    await assert.rejects(
        () => settleFunding({ ...PACKAGE_ORDER, creditKey: undefined }),
        /missing its creditKey/
    )
    assert.equal(consume.mock.callCount(), 0)
})
