'use strict'

// Shared hand-off from "an order row exists" to "generation is running", so
// /api/redeem can start a package-funded order the same way the webhook starts
// a paid one. Direct-fulfill generators submit nothing here — the poller
// renders those from the order's params.

const reportEngine = require('./reportEngine')
const dynamo = require('./dynamo')
const config = require('./config')

const DIRECT_FULFILL_GENERATORS = new Set(['valuatumRest', 'microProduct'])
const FULFILLABLE_GENERATORS = new Set([
    'reportEngine',
    'valuatumRest',
    'microProduct',
])

function isFulfillable(product) {
    return FULFILLABLE_GENERATORS.has(product?.generator)
}

class FulfillmentTrackingError extends Error {
    constructor(jobId, cause) {
        super(`job ${jobId} was submitted but could not be recorded`, { cause })
        this.name = 'FulfillmentTrackingError'
        this.jobId = jobId
    }
}

// Throws if job submission or tracking fails. Callers must not release the
// order when a FulfillmentTrackingError says the generator already accepted it.
async function startFulfillment(order, product) {
    if (DIRECT_FULFILL_GENERATORS.has(product.generator)) return { jobId: null }

    const jobId = await reportEngine.submitJob({
        username: config.reportUsername,
        templateName: product.templateName,
        params: order.params,
    })
    try {
        await dynamo.updateOrder(order.sessionId, { jobId })
    } catch (err) {
        throw new FulfillmentTrackingError(jobId, err)
    }
    return { jobId }
}

module.exports = {
    startFulfillment,
    isFulfillable,
    FulfillmentTrackingError,
    FULFILLABLE_GENERATORS,
    DIRECT_FULFILL_GENERATORS,
}
