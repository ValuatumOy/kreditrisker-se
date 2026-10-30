'use strict'

// The signed Checkout total is required even when there is no PaymentIntent.
// Missing payment data must never be treated as a free or released payment.
function paymentFunding(order) {
    if (order.funding === 'package') return 'PACKAGE'
    if (!Number.isSafeInteger(order.amountTotal) || order.amountTotal < 0) {
        throw new Error('Payment review required: missing or invalid Checkout total')
    }
    if (typeof order.paymentIntentId === 'string' && /^pi_[A-Za-z0-9_]+$/.test(order.paymentIntentId)) {
        return 'STRIPE'
    }
    if (order.paymentIntentId == null && order.amountTotal === 0 && order.paymentStatus === 'no_payment_required') {
        return 'FREE'
    }
    throw new Error('Payment review required: no valid PaymentIntent or verified zero-total Checkout')
}

module.exports = { paymentFunding }
