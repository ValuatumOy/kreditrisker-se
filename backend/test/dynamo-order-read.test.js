'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const { GetCommand } = require('@aws-sdk/lib-dynamodb')
const dynamo = require('../src/lib/dynamo')

test('order lookup uses a strongly consistent read before poller decisions', async () => {
    const send = mock.method(dynamo.doc, 'send', async () => ({
        Item: { sessionId: 'cs_test_local', status: 'GENERATING', jobId: 'job_1' },
    }))
    try {
        const order = await dynamo.getOrder('cs_test_local')
        assert.equal(order.jobId, 'job_1')
        assert.ok(send.mock.calls[0].arguments[0] instanceof GetCommand)
        assert.equal(send.mock.calls[0].arguments[0].input.ConsistentRead, true)
    } finally {
        mock.restoreAll()
    }
})
