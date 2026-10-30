'use strict'

const { randomUUID } = require('node:crypto')
const { json, jsonBody, method } = require('../lib/http')
const dynamo = require('../lib/dynamo')
const withdrawals = require('../lib/withdrawals')

const SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9_]{8,240}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const notFound = () => json(404, { error: 'Order not found. Check the order reference and checkout email.' })

exports.handler = async event => {
    if (method(event) !== 'POST') return json(405, { error: 'Method not allowed' })
    if (typeof event.body === 'string' && event.body.length > 4096) return json(413, { error: 'Request too large' })
    const body = jsonBody(event)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, { error: 'Request must be a JSON object.' })
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!SESSION_ID.test(sessionId) || !EMAIL.test(email) || email.length > 254) return notFound()
    if (body.confirmed !== true) return json(400, { error: 'Confirm that you want to withdraw from this order.' })
    if (body.receiptMethod !== 'email') return json(400, { error: 'Confirm email as the receipt method.' })
    try {
        const order = await dynamo.requestWithdrawal({ sessionId, email, requestId: randomUUID(), requestedAt: new Date().toISOString(), receiptMethod: 'email' })
        if (!order) return notFound()
        try {
            await withdrawals.acknowledge(order)
        } catch (error) {
            await dynamo.updateOrder(sessionId, { withdrawalCustomerError: error.message })
            console.error('withdrawal: processing error', { sessionId, step: 'customer receipt', error: error.message })
        }
        return json(202, {
            received: true, requestId: order.withdrawalRequestId, receivedAt: order.withdrawalRequestedAt,
            receiptEmailAccepted: Boolean(order.withdrawalCustomerAcceptedAt),
        }, { 'cache-control': 'no-store' })
    } catch (error) {
        console.error('withdrawal: processing error', { sessionId, step: 'record request', error: error.message })
        return json(503, { error: 'The request could not be recorded. Please try again.' })
    }
}
