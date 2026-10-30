'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const credits = require('../src/lib/credits')
const fulfillment = require('../src/lib/fulfillment')
const { handler } = require('../src/handlers/redeem')

test('an unconfirmed redeemed job preserves its reservation for the poller', async () => {
    mock.method(credits, 'reserveExisting', async () => ({ status: 'RESERVED' }))
    const release = mock.method(credits, 'release', async () => ({}))
    mock.method(fulfillment, 'startFulfillment', async () => {
        throw new fulfillment.FulfillmentSubmissionUnknownError(new Error('connection lost'))
    })
    try {
        const result = await handler({
            requestContext: { http: { method: 'POST' } },
            body: JSON.stringify({
                requestId: '11111111-2222-4333-8444-555555555555',
                email: 'buyer@example.test',
                reportType: 'se_credit_risk',
                businessId: '556036-9208',
            }),
        })
        assert.equal(result.statusCode, 500)
        assert.equal(release.mock.callCount(), 0)
    } finally {
        mock.restoreAll()
    }
})
