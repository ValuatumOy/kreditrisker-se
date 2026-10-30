'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./no-network.cjs')
process.env.REPORT_ISOLATED_FIXTURE_TEST = '1'
process.env.STRIPE_SECRET_KEY = 'sk_live_NOT_A_REAL_KEY'
delete process.env.APP_SECRETS_ARN

test('fixture mode refuses a live Stripe key before creating a client', async () => {
    await assert.rejects(require('../src/lib/stripe').stripeClient(), /requires a Stripe test secret key/)
})
