'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')

process.env.CREDITS_TABLE = 'test-credits'
process.env.ORDERS_TABLE = 'test-orders'

const { getProduct } = require('../src/lib/products')
const {
    buildLineItem,
    resolvePrice,
} = require('../src/handlers/create-checkout')

test('checkout resolves the current default price from the allowed Stripe product', async () => {
    const calls = []
    const stripe = {
        products: {
            retrieve: async (...args) => {
                calls.push(args)
                return {
                    id: 'prod_allowed',
                    active: true,
                    default_price: {
                        id: 'price_current',
                        active: true,
                        currency: 'sek',
                        type: 'one_time',
                        tax_behavior: 'inclusive',
                        unit_amount: 300,
                    },
                }
            },
        },
    }

    const item = await buildLineItem(
        stripe,
        {
            stripeProductId: 'prod_allowed',
            currency: 'sek',
            taxBehavior: 'inclusive',
        },
        'sv',
        'Rapportsprog: dansk.'
    )

    assert.deepEqual(calls, [['prod_allowed', { expand: ['default_price'] }]])
    assert.deepEqual(item, { quantity: 1, price: 'price_current' })
})

test('checkout rejects an inactive product or missing default price', async () => {
    for (const stripeProduct of [
        { active: false, default_price: 'price_old' },
        { active: true, default_price: null },
        { active: true, default_price: { id: 'price_old', active: false } },
    ]) {
        const stripe = {
            products: { retrieve: async () => stripeProduct },
        }
        await assert.rejects(
            buildLineItem(
                stripe,
                {
                    stripeProductId: 'prod_allowed',
                    currency: 'sek',
                    taxBehavior: 'inclusive',
                },
                'sv',
                ''
            ),
            /inactive|no active default price/
        )
    }
})

test('checkout rejects a default price with the wrong billing contract', async () => {
    for (const price of [
        {
            id: 'price_usd',
            active: true,
            currency: 'usd',
            type: 'one_time',
            tax_behavior: 'inclusive',
            unit_amount: 100,
        },
        {
            id: 'price_monthly',
            active: true,
            currency: 'sek',
            type: 'recurring',
            tax_behavior: 'inclusive',
            unit_amount: 100,
        },
        {
            id: 'price_exclusive',
            active: true,
            currency: 'sek',
            type: 'one_time',
            tax_behavior: 'exclusive',
            unit_amount: 100,
        },
        {
            id: 'price_custom',
            active: true,
            currency: 'sek',
            type: 'one_time',
            tax_behavior: 'inclusive',
            unit_amount: null,
        },
    ]) {
        const stripe = {
            products: {
                retrieve: async () => ({ active: true, default_price: price }),
            },
        }
        await assert.rejects(
            resolvePrice(stripe, {
                stripeProductId: 'prod_allowed',
                currency: 'sek',
                taxBehavior: 'inclusive',
            }),
            /invalid|no fixed unit amount/
        )
    }
})

test('a product without a Stripe product ID keeps the trusted server-side inline price', async () => {
    // Every catalog product currently has a stripeProductId — this covers the
    // price_data fallback branch itself, in case a future product ships
    // without one before its Stripe Product exists.
    const product = {
        currency: 'sek',
        priceCents: 600,
        taxBehavior: 'inclusive',
        taxCode: 'txcd_10000000',
        name: { en: 'Test product' },
        description: { en: 'Test description.' },
    }
    const item = await buildLineItem(
        {},
        product,
        'en',
        'Report language: English.'
    )

    assert.equal(item.price_data.unit_amount, 600)
    assert.equal(item.price_data.currency, 'sek')
    assert.match(item.price_data.product_data.description, /Report language/)
})

test('the AI 3-report bundle resolves its price from its Stripe product like the singles', async () => {
    const calls = []
    const stripe = {
        products: {
            retrieve: async (...args) => {
                calls.push(args)
                return {
                    id: 'prod_test_se_ai_bundle',
                    active: true,
                    default_price: {
                        id: 'price_ai_bundle_current',
                        active: true,
                        currency: 'sek',
                        type: 'one_time',
                        tax_behavior: 'inclusive',
                        unit_amount: 600,
                    },
                }
            },
        },
    }

    const item = await buildLineItem(
        stripe,
        getProduct('se_ai_credit_risk_bundle'),
        'sv',
        'Rapportsprog: dansk.'
    )

    assert.deepEqual(calls, [
        ['prod_test_se_ai_bundle', { expand: ['default_price'] }],
    ])
    assert.deepEqual(item, { quantity: 1, price: 'price_ai_bundle_current' })
})

test('the 3-report bundle resolves its price from its Stripe product like the singles', async () => {
    const calls = []
    const stripe = {
        products: {
            retrieve: async (...args) => {
                calls.push(args)
                return {
                    id: 'prod_test_se_basic_bundle',
                    active: true,
                    default_price: {
                        id: 'price_bundle_current',
                        active: true,
                        currency: 'sek',
                        type: 'one_time',
                        tax_behavior: 'inclusive',
                        unit_amount: 200,
                    },
                }
            },
        },
    }

    const item = await buildLineItem(
        stripe,
        getProduct('se_credit_risk_bundle'),
        'sv',
        'Rapportsprog: dansk.'
    )

    assert.deepEqual(calls, [
        ['prod_test_se_basic_bundle', { expand: ['default_price'] }],
    ])
    assert.deepEqual(item, { quantity: 1, price: 'price_bundle_current' })
})
