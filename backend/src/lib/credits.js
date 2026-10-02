'use strict'

const { GetCommand, TransactWriteCommand } = require('@aws-sdk/lib-dynamodb')
const { doc } = require('./dynamo')
const config = require('./config')

// Index of each item within its TransactItems array. Every condition failure
// arrives as the same TransactionCanceledException, so callers identify what
// failed by index — the order below is part of the contract.
const ITEM = {
    // purchaseAndReserve
    PURCHASE_BALANCE: 0,
    PURCHASE_GRANT_TXN: 1,
    PURCHASE_RESERVE_TXN: 2,
    PURCHASE_ORDER: 3,
    // reserveExisting / consume / release
    BALANCE: 0,
    TXN: 1,
    ORDER: 2,
}

// The redeem lookup and the webhook grant must land on the same partition.
function normalizeEmail(email) {
    return String(email || '')
        .trim()
        .toLowerCase()
}

const UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function normalizeRequestId(requestId) {
    if (typeof requestId !== 'string' || !UUID_V4.test(requestId)) return null
    return requestId.toLowerCase()
}

// Package purchases and redeem retries share an order keyed by request ID.
function packageSessionId(requestId) {
    return `pkg_${requestId}`
}

function customerKey(email) {
    return `CUST#${normalizeEmail(email)}`
}

function balanceKey(reportType) {
    return `BAL#${reportType}`
}

// `id` is the session, never a random value: a redelivered webhook must not
// grant or reserve twice. Manual ADJUST rows use TXN#ADJUST#<ts>.
function txnKey(kind, id) {
    return `TXN#${kind}#${id}`
}

function balanceItemKey(email, reportType) {
    return { pk: customerKey(email), sk: balanceKey(reportType) }
}

// GRANT and RELEASE rows also serve as the transactional email outbox.
function notificationFields({ kind, email, delta, occurredAt }) {
    if (kind !== 'GRANT' && kind !== 'RELEASE') return {}
    return {
        notificationType: kind === 'GRANT' ? 'CREDIT_GRANT' : 'CREDIT_RELEASE',
        notificationRecipient: normalizeEmail(email),
        notificationCount: kind === 'GRANT' ? delta : 1,
        notificationTemplateVersion: 1,
        notificationStatus: 'PENDING',
        notificationQueue: 'PENDING',
        notificationNextAttemptAt: occurredAt,
        notificationAttempts: 0,
    }
}

// `delta` is signed against unspent reports (`remaining + reserved`), so the
// ledger sums to the balance: GRANT +n, RESERVE 0, CONSUME -1, RELEASE 0.
function txnItem({
    email,
    reportType,
    kind,
    id,
    delta,
    sessionId,
    companyName,
    occurredAt,
}) {
    return {
        pk: customerKey(email),
        sk: txnKey(kind, id),
        kind,
        delta,
        reportType,
        orderId: sessionId,
        companyName: companyName || '',
        createdAt: occurredAt || new Date().toISOString(),
        ...notificationFields({ kind, email, delta, occurredAt }),
    }
}

function packageOrderItem(order, { email, reportType }) {
    // Keep the package payment out of paymentIntentId. The poller captures or
    // cancels that field.
    if (order.paymentIntentId) {
        throw new Error(
            'credits: a package-funded order must not carry paymentIntentId'
        )
    }
    return {
        ...order,
        funding: 'package',
        // Used to verify that an existing order belongs to this balance.
        creditKey: { email: normalizeEmail(email), reportType },
        creditState: 'RESERVED',
    }
}

function orderAttrExpression(attrs, nextCreditState, occurredAt) {
    const names = { '#creditState': 'creditState', '#updatedAt': 'updatedAt' }
    const values = {
        ':nextCreditState': nextCreditState,
        ':reserved': 'RESERVED',
        ':updatedAt': occurredAt || new Date().toISOString(),
    }
    const sets = ['#creditState = :nextCreditState', '#updatedAt = :updatedAt']
    Object.keys(attrs || {}).forEach((k, i) => {
        names[`#a${i}`] = k
        values[`:a${i}`] = attrs[k]
        sets.push(`#a${i} = :a${i}`)
    })
    return {
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: '#creditState = :reserved',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
    }
}

// ── Transaction builders (pure — they send nothing) ────────────────────────

function buildPurchaseAndReserve({
    email,
    reportType,
    count,
    checkoutSessionId,
    order,
    occurredAt,
}) {
    if (!Number.isInteger(count) || count < 1) {
        throw new Error(`credits: invalid grant count ${count}`)
    }
    const now = occurredAt || new Date().toISOString()
    return {
        TransactItems: [
            {
                // Grant and reservation fold into one update — DynamoDB rejects two
                // operations on the same item. Unconditional: idempotency comes from
                // the ledger rows below.
                Update: {
                    TableName: config.creditsTable,
                    Key: balanceItemKey(email, reportType),
                    UpdateExpression:
                        'SET #expiresAt = if_not_exists(#expiresAt, :null), ' +
                        '#createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now ' +
                        'ADD #remaining :granted, #reserved :one, #grantedTotal :count, #usedTotal :zero',
                    ExpressionAttributeNames: {
                        '#expiresAt': 'expiresAt',
                        '#createdAt': 'createdAt',
                        '#updatedAt': 'updatedAt',
                        '#remaining': 'remaining',
                        '#reserved': 'reserved',
                        '#grantedTotal': 'grantedTotal',
                        '#usedTotal': 'usedTotal',
                    },
                    ExpressionAttributeValues: {
                        ':null': null,
                        ':now': now,
                        // One of the granted reports goes straight into the reservation.
                        ':granted': count - 1,
                        ':one': 1,
                        ':count': count,
                        // ADD 0 so usedTotal exists from the first write.
                        ':zero': 0,
                    },
                },
            },
            {
                Put: {
                    TableName: config.creditsTable,
                    Item: txnItem({
                        email,
                        reportType,
                        kind: 'GRANT',
                        id: checkoutSessionId,
                        delta: count,
                        sessionId: order.sessionId,
                        companyName: order.companyName,
                        occurredAt: now,
                    }),
                    ConditionExpression: 'attribute_not_exists(pk)',
                },
            },
            {
                Put: {
                    TableName: config.creditsTable,
                    Item: txnItem({
                        email,
                        reportType,
                        kind: 'RESERVE',
                        id: checkoutSessionId,
                        delta: 0,
                        sessionId: order.sessionId,
                        companyName: order.companyName,
                        occurredAt: now,
                    }),
                    ConditionExpression: 'attribute_not_exists(pk)',
                },
            },
            {
                Put: {
                    TableName: config.ordersTable,
                    Item: packageOrderItem(order, { email, reportType }),
                    ConditionExpression: 'attribute_not_exists(sessionId)',
                },
            },
        ],
    }
}

// If the same request claimed its fulfillment order through reserveExisting
// while the Stripe webhook was in flight, that order already owns a credit
// reservation. The paid package must still grant all of its reports, but must
// not reserve a second one or try to claim the order again.
function buildGrantForExistingOrder({
    email,
    reportType,
    count,
    checkoutSessionId,
    order,
    occurredAt,
}) {
    if (!Number.isInteger(count) || count < 1) {
        throw new Error(`credits: invalid grant count ${count}`)
    }
    const now = occurredAt || new Date().toISOString()
    return {
        TransactItems: [
            {
                Update: {
                    TableName: config.creditsTable,
                    Key: balanceItemKey(email, reportType),
                    UpdateExpression:
                        'SET #expiresAt = if_not_exists(#expiresAt, :null), ' +
                        '#createdAt = if_not_exists(#createdAt, :now), #updatedAt = :now ' +
                        'ADD #remaining :count, #reserved :zero, #grantedTotal :count, #usedTotal :zero',
                    ExpressionAttributeNames: {
                        '#expiresAt': 'expiresAt',
                        '#createdAt': 'createdAt',
                        '#updatedAt': 'updatedAt',
                        '#remaining': 'remaining',
                        '#reserved': 'reserved',
                        '#grantedTotal': 'grantedTotal',
                        '#usedTotal': 'usedTotal',
                    },
                    ExpressionAttributeValues: {
                        ':null': null,
                        ':now': now,
                        ':count': count,
                        ':zero': 0,
                    },
                },
            },
            {
                Put: {
                    TableName: config.creditsTable,
                    Item: txnItem({
                        email,
                        reportType,
                        kind: 'GRANT',
                        id: checkoutSessionId,
                        delta: count,
                        sessionId: order.sessionId,
                        companyName: order.companyName,
                        occurredAt: now,
                    }),
                    ConditionExpression: 'attribute_not_exists(pk)',
                },
            },
            {
                Update: {
                    TableName: config.ordersTable,
                    Key: { sessionId: order.sessionId },
                    UpdateExpression:
                        'SET #checkoutSessionId = :checkoutSessionId, #purchaseSku = :purchaseSku, ' +
                        '#purchasePaymentIntentId = :purchasePaymentIntentId, #amountTotal = :amountTotal, ' +
                        '#currency = :currency, #updatedAt = :updatedAt',
                    ConditionExpression:
                        '#funding = :package AND #creditKey.#email = :email ' +
                        'AND #creditKey.#reportType = :reportType',
                    ExpressionAttributeNames: {
                        '#funding': 'funding',
                        '#creditKey': 'creditKey',
                        '#email': 'email',
                        '#reportType': 'reportType',
                        '#checkoutSessionId': 'checkoutSessionId',
                        '#purchaseSku': 'purchaseSku',
                        '#purchasePaymentIntentId': 'purchasePaymentIntentId',
                        '#amountTotal': 'amountTotal',
                        '#currency': 'currency',
                        '#updatedAt': 'updatedAt',
                    },
                    ExpressionAttributeValues: {
                        ':package': 'package',
                        ':email': normalizeEmail(email),
                        ':reportType': reportType,
                        ':checkoutSessionId': checkoutSessionId,
                        ':purchaseSku': order.purchaseSku || null,
                        ':purchasePaymentIntentId':
                            order.purchasePaymentIntentId || null,
                        ':amountTotal': order.amountTotal ?? null,
                        ':currency': order.currency || null,
                        ':updatedAt': now,
                    },
                },
            },
        ],
    }
}

function buildReserveExisting({ email, reportType, order, occurredAt }) {
    const now = occurredAt || new Date().toISOString()
    return {
        TransactItems: [
            {
                Update: {
                    TableName: config.creditsTable,
                    Key: balanceItemKey(email, reportType),
                    // attribute_exists also covers a customer with no balance item.
                    ConditionExpression:
                        'attribute_exists(pk) AND #remaining >= :one',
                    UpdateExpression:
                        'SET #updatedAt = :now ADD #remaining :minusOne, #reserved :one',
                    ExpressionAttributeNames: {
                        '#remaining': 'remaining',
                        '#reserved': 'reserved',
                        '#updatedAt': 'updatedAt',
                    },
                    ExpressionAttributeValues: {
                        ':one': 1,
                        ':minusOne': -1,
                        ':now': now,
                    },
                },
            },
            {
                Put: {
                    TableName: config.creditsTable,
                    Item: txnItem({
                        email,
                        reportType,
                        kind: 'RESERVE',
                        id: order.sessionId,
                        delta: 0,
                        sessionId: order.sessionId,
                        companyName: order.companyName,
                        occurredAt: now,
                    }),
                    ConditionExpression: 'attribute_not_exists(pk)',
                },
            },
            {
                Put: {
                    TableName: config.ordersTable,
                    Item: packageOrderItem(order, { email, reportType }),
                    ConditionExpression: 'attribute_not_exists(sessionId)',
                },
            },
        ],
    }
}

// CONSUME (delivered, credit spent) or RELEASE (generation failed, credit back).
// The order's creditState flips in the same transaction, so a crash cannot
// leave a terminal order with a live reservation.
function buildSettle({
    kind,
    email,
    reportType,
    sessionId,
    companyName,
    occurredAt,
    orderAttrs,
}) {
    const consuming = kind === 'CONSUME'
    const now = occurredAt || new Date().toISOString()
    return {
        TransactItems: [
            {
                Update: {
                    TableName: config.creditsTable,
                    Key: balanceItemKey(email, reportType),
                    ConditionExpression: '#reserved >= :one',
                    UpdateExpression: consuming
                        ? 'SET #updatedAt = :now ADD #reserved :minusOne, #usedTotal :one'
                        : 'SET #updatedAt = :now ADD #reserved :minusOne, #remaining :one',
                    ExpressionAttributeNames: {
                        '#reserved': 'reserved',
                        '#updatedAt': 'updatedAt',
                        ...(consuming
                            ? { '#usedTotal': 'usedTotal' }
                            : { '#remaining': 'remaining' }),
                    },
                    ExpressionAttributeValues: {
                        ':one': 1,
                        ':minusOne': -1,
                        ':now': now,
                    },
                },
            },
            {
                Put: {
                    TableName: config.creditsTable,
                    Item: txnItem({
                        email,
                        reportType,
                        kind,
                        id: sessionId,
                        delta: consuming ? -1 : 0,
                        sessionId,
                        companyName,
                        occurredAt: now,
                    }),
                    ConditionExpression: 'attribute_not_exists(pk)',
                },
            },
            {
                Update: {
                    TableName: config.ordersTable,
                    Key: { sessionId },
                    ...orderAttrExpression(
                        orderAttrs,
                        consuming ? 'CONSUMED' : 'RELEASED',
                        now
                    ),
                },
            },
        ],
    }
}

// ── Operations ─────────────────────────────────────────────────────────────

// Per-item cancellation codes, or null if the error is not a cancellation
// (a throttle, a validation error — those must keep throwing).
function cancellationCodes(err) {
    if (err?.name !== 'TransactionCanceledException') return null
    return (err.CancellationReasons || []).map(reason => reason?.Code || 'None')
}

function failed(codes, index) {
    return codes[index] === 'ConditionalCheckFailed'
}

function onlyFailed(codes, index) {
    return (
        codes.length > index &&
        codes.every(
            (code, i) =>
                code === (i === index ? 'ConditionalCheckFailed' : 'None')
        )
    )
}

async function grantForExistingOrder(input) {
    try {
        await doc.send(
            new TransactWriteCommand(buildGrantForExistingOrder(input))
        )
        return { status: 'GRANTED_EXISTING_ORDER' }
    } catch (err) {
        const codes = cancellationCodes(err)
        if (!codes) throw err
        // Another invocation completed this fallback first.
        if (failed(codes, ITEM.TXN)) return { status: 'DUPLICATE' }
        throw err
    }
}

// → { status: 'RESERVED' | 'GRANTED_EXISTING_ORDER' | 'DUPLICATE' }
async function purchaseAndReserve(input) {
    try {
        await doc.send(new TransactWriteCommand(buildPurchaseAndReserve(input)))
        return { status: 'RESERVED' }
    } catch (err) {
        const codes = cancellationCodes(err)
        if (!codes) throw err
        if (
            failed(codes, ITEM.PURCHASE_GRANT_TXN) ||
            failed(codes, ITEM.PURCHASE_RESERVE_TXN)
        ) {
            return { status: 'DUPLICATE' }
        }
        if (onlyFailed(codes, ITEM.PURCHASE_ORDER)) {
            return grantForExistingOrder(input)
        }
        throw err
    }
}

// → { status: 'RESERVED' }
//   { status: 'NEEDS_PURCHASE' } — no credits: send the customer to Stripe.
//   { status: 'DUPLICATE' }      — same request id: return the existing order.
// Duplicate markers win over the balance check: after reserving the last
// available credit, a retry fails all three conditions but must not say "go pay".
async function reserveExisting(input) {
    try {
        await doc.send(new TransactWriteCommand(buildReserveExisting(input)))
        return { status: 'RESERVED' }
    } catch (err) {
        const codes = cancellationCodes(err)
        if (!codes) throw err
        if (failed(codes, ITEM.TXN) || failed(codes, ITEM.ORDER)) {
            return { status: 'DUPLICATE' }
        }
        if (failed(codes, ITEM.BALANCE)) return { status: 'NEEDS_PURCHASE' }
        throw err
    }
}

// → { status: 'SETTLED' | 'ALREADY_SETTLED' }. A balance condition failure on a
// still-RESERVED order means ledger and order disagree — only a manual ADJUST
// can cause that, and it throws rather than reporting a settlement that did not
// happen.
async function settle(kind, input) {
    try {
        await doc.send(
            new TransactWriteCommand(buildSettle({ kind, ...input }))
        )
        return { status: 'SETTLED' }
    } catch (err) {
        const codes = cancellationCodes(err)
        if (!codes) throw err
        if (failed(codes, ITEM.ORDER) || failed(codes, ITEM.TXN)) {
            return { status: 'ALREADY_SETTLED' }
        }
        throw err
    }
}

const consume = input => settle('CONSUME', input)
const release = input => settle('RELEASE', input)

// Reserved reports are not spent until CONSUME.
function unspentReports(balance) {
    return (balance?.remaining || 0) + (balance?.reserved || 0)
}

async function getBalance(email, reportType) {
    const res = await doc.send(
        new GetCommand({
            TableName: config.creditsTable,
            Key: balanceItemKey(email, reportType),
            ConsistentRead: true,
        })
    )
    const item = res.Item || {}
    return {
        remaining: item.remaining || 0,
        reserved: item.reserved || 0,
        grantedTotal: item.grantedTotal || 0,
        usedTotal: item.usedTotal || 0,
    }
}

module.exports = {
    ITEM,
    normalizeEmail,
    normalizeRequestId,
    packageSessionId,
    buildPurchaseAndReserve,
    buildGrantForExistingOrder,
    buildReserveExisting,
    buildSettle,
    purchaseAndReserve,
    reserveExisting,
    consume,
    release,
    getBalance,
    unspentReports,
}
