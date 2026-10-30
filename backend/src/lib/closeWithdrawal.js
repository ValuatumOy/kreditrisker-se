'use strict'

// This operation does not create a refund. It closes a manual-review item only
// after Stripe confirms the complete captured amount has been refunded.
async function closeWithdrawal(sessionId, stripe, store) {
    if (!/^cs_(?:test|live)_[A-Za-z0-9]+$/.test(sessionId || '')) throw new Error('Invalid Checkout session')
    const order = await store.getOrder(sessionId)
    if (!order || order.sessionId !== sessionId || order.reportType !== 'se_credit_risk' ||
        typeof order.withdrawalRequestId !== 'string' || !order.withdrawalRequestId ||
        order.status !== 'WITHDRAWN' || order.withdrawalState !== 'REVIEW_REQUIRED' ||
        order.withdrawalPaymentResolution !== 'REFUND_REQUIRED' || !/^pi_[A-Za-z0-9_]+$/.test(order.paymentIntentId || '') ||
        !Number.isSafeInteger(order.amountTotal) || order.amountTotal <= 0 || !/^[a-z]{3}$/.test(order.currency || ''))
        throw new Error('Order is not awaiting a captured-payment refund')

    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] })
    const intent = session.payment_intent
    if (session.id !== sessionId || session.livemode !== sessionId.startsWith('cs_live_') || session.metadata?.reportType !== order.reportType ||
        session.amount_total !== order.amountTotal || session.currency !== order.currency ||
        !intent || typeof intent !== 'object' || intent.id !== order.paymentIntentId ||
        intent.livemode !== session.livemode || intent.status !== 'succeeded' || intent.amount_received !== order.amountTotal || intent.currency !== order.currency)
        throw new Error('Stripe payment does not match the recorded order')

    const refunds = await stripe.refunds.list({ payment_intent: intent.id, limit: 100 })
    if (refunds.has_more) throw new Error('Refund list is incomplete')
    const completed = refunds.data.filter(refund => refund.status === 'succeeded')
    if (completed.some(refund => refund.payment_intent !== intent.id || refund.currency !== order.currency ||
        !/^re_[A-Za-z0-9]+$/.test(refund.id || '') || !Number.isSafeInteger(refund.amount) || refund.amount <= 0) ||
        completed.reduce((sum, refund) => sum + refund.amount, 0) !== order.amountTotal)
        throw new Error('The complete refund has not been confirmed by Stripe')

    if (!await store.closeRefundedWithdrawal(order, new Date().toISOString(), completed.map(refund => refund.id)))
        throw new Error('Order changed while checking the refund; review it again')
    return { status: 'CLOSED', refundedAmount: order.amountTotal, currency: order.currency }
}

module.exports = { closeWithdrawal }
