'use strict'

const dynamo = require('./dynamo')
const email = require('./email')
const { paymentFunding } = require('./paymentFunding')

async function acknowledge(order) {
    if (order.withdrawalCustomerAcceptedAt) return
    const attemptedAt = new Date().toISOString()
    await dynamo.updateOrder(order.sessionId, { withdrawalCustomerAttemptedAt: attemptedAt })
    await email.sendWithdrawalReceipt(order)
    const acceptedAt = new Date().toISOString()
    await dynamo.updateOrder(order.sessionId, { withdrawalCustomerAcceptedAt: acceptedAt, withdrawalCustomerError: '' })
    order.withdrawalCustomerAcceptedAt = acceptedAt
}

async function resolvePayment(stripe, order) {
    if (order.withdrawalPaymentResolution) return order.withdrawalPaymentResolution
    if (paymentFunding(order) === 'FREE') return 'NO_PAYMENT'
    let intent = await stripe.paymentIntents.retrieve(order.paymentIntentId)
    if (intent.status === 'succeeded') return 'REFUND_REQUIRED'
    if (intent.status === 'canceled') return 'AUTHORIZATION_RELEASED'
    try {
        intent = await stripe.paymentIntents.cancel(order.paymentIntentId, {}, {
            idempotencyKey: `se-withdrawal-${order.withdrawalRequestId}`,
        })
    } catch (error) {
        // A lost response may mean cancellation succeeded or capture won.
        intent = await stripe.paymentIntents.retrieve(order.paymentIntentId)
        if (!['canceled', 'succeeded'].includes(intent.status)) throw error
    }
    if (intent.status === 'canceled') return 'AUTHORIZATION_RELEASED'
    if (intent.status === 'succeeded') return 'REFUND_REQUIRED'
    throw new Error(`Withdrawal payment remains unresolved (${intent.status})`)
}

async function processWithdrawal(stripe, order) {
    if (order.withdrawalState !== 'PENDING' || !order.withdrawalRequestId) return
    let failed = false
    try {
        await acknowledge(order)
    } catch (error) {
        failed = true
        await dynamo.updateOrder(order.sessionId, { withdrawalCustomerError: error.message })
        console.error('withdrawal: processing error', { sessionId: order.sessionId, step: 'customer receipt', error: error.message })
    }
    try {
        const resolution = await resolvePayment(stripe, order)
        await dynamo.updateOrder(order.sessionId, { status: 'WITHDRAWN', withdrawalPaymentResolution: resolution, withdrawalPaymentError: '' })
        order.withdrawalPaymentResolution = resolution
    } catch (error) {
        failed = true
        await dynamo.updateOrder(order.sessionId, { withdrawalPaymentError: error.message })
        console.error('withdrawal: processing error', { sessionId: order.sessionId, step: 'payment', error: error.message })
    }
    if (order.withdrawalPaymentResolution && !order.withdrawalAdminAcceptedAt) {
        try {
            await dynamo.updateOrder(order.sessionId, { withdrawalAdminAttemptedAt: new Date().toISOString() })
            await email.sendWithdrawalAdminAlert(order)
            const acceptedAt = new Date().toISOString()
            await dynamo.updateOrder(order.sessionId, { withdrawalAdminAcceptedAt: acceptedAt, withdrawalAdminError: '' })
            order.withdrawalAdminAcceptedAt = acceptedAt
        } catch (error) {
            failed = true
            await dynamo.updateOrder(order.sessionId, { withdrawalAdminError: error.message })
            console.error('withdrawal: processing error', { sessionId: order.sessionId, step: 'admin receipt', error: error.message })
        }
    }
    if (!failed && order.withdrawalPaymentResolution && order.withdrawalAdminAcceptedAt && order.withdrawalCustomerAcceptedAt) {
        const finished = await dynamo.finishWithdrawal(order)
        if (finished && order.withdrawalPaymentResolution === 'REFUND_REQUIRED') {
            console.warn('withdrawal: manual refund required', { sessionId: order.sessionId })
        }
    }
}

module.exports = { acknowledge, processWithdrawal, resolvePayment }
