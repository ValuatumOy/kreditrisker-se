'use strict'

const { closeWithdrawal } = require('../src/lib/closeWithdrawal')
const { stripeClient } = require('../src/lib/stripe')
const dynamo = require('../src/lib/dynamo')

async function main() {
    if (!process.env.ORDERS_TABLE || !process.env.APP_SECRETS_ARN) throw new Error('Set ORDERS_TABLE and APP_SECRETS_ARN for the intended environment')
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/close-withdrawal.js <checkout-session-id>')
    const result = await closeWithdrawal(process.argv[2], await stripeClient(), dynamo)
    console.log(JSON.stringify(result))
}
main().catch(error => { console.error('Refund review not closed:', error.message); process.exitCode = 1 })
