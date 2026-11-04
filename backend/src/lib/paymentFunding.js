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
    // A fully discounted Checkout can be completed as either status without a PaymentIntent.
    if (order.paymentIntentId == null && order.amountTotal === 0 && ['no_payment_required', 'paid'].includes(order.paymentStatus)) {
        return 'FREE'
    }
    throw new Error('Payment review required: no valid PaymentIntent or verified zero-total Checkout')
}

module.exports = { paymentFunding }
