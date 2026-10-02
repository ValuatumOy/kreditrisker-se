'use strict'

const { randomUUID } = require('node:crypto')
const { QueryCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb')
const { doc } = require('./dynamo')
const config = require('./config')

const MAX_ATTEMPTS = 8
const DEFAULT_BATCH_SIZE = 25
const LEASE_SECONDS = 180
const MAX_RETRY_SECONDS = 6 * 60 * 60

function conditionalFailure(err) {
    return err?.name === 'ConditionalCheckFailedException'
}

function isoAfter(iso, seconds) {
    return new Date(Date.parse(iso) + seconds * 1000).toISOString()
}

function retryDelaySeconds(attempt, random = Math.random) {
    const base = Math.min(MAX_RETRY_SECONDS, 60 * 2 ** Math.max(0, attempt - 1))
    return base + Math.floor(base * 0.2 * random())
}

async function listDueNotifications({
    now = new Date().toISOString(),
    limit = DEFAULT_BATCH_SIZE,
} = {}) {
    const res = await doc.send(
        new QueryCommand({
            TableName: config.creditsTable,
            IndexName: config.creditsNotificationIndex,
            KeyConditionExpression: '#queue = :pending AND #due <= :now',
            ExpressionAttributeNames: {
                '#queue': 'notificationQueue',
                '#due': 'notificationNextAttemptAt',
            },
            ExpressionAttributeValues: {
                ':pending': 'PENDING',
                ':now': now,
            },
            ScanIndexForward: true,
            Limit: limit,
        })
    )
    return res.Items || []
}

async function claimNotification(
    item,
    {
        now = new Date().toISOString(),
        leaseToken = randomUUID(),
        leaseSeconds = LEASE_SECONDS,
    } = {}
) {
    try {
        const res = await doc.send(
            new UpdateCommand({
                TableName: config.creditsTable,
                Key: { pk: item.pk, sk: item.sk },
                UpdateExpression:
                    'SET #due = :leaseUntil, #lease = :leaseToken, #updatedAt = :now ' +
                    'ADD #attempts :one',
                ConditionExpression: '#queue = :pending AND #due <= :now',
                ExpressionAttributeNames: {
                    '#queue': 'notificationQueue',
                    '#due': 'notificationNextAttemptAt',
                    '#lease': 'notificationLeaseToken',
                    '#attempts': 'notificationAttempts',
                    '#updatedAt': 'notificationUpdatedAt',
                },
                ExpressionAttributeValues: {
                    ':pending': 'PENDING',
                    ':now': now,
                    ':leaseUntil': isoAfter(now, leaseSeconds),
                    ':leaseToken': leaseToken,
                    ':one': 1,
                },
                ReturnValues: 'ALL_NEW',
            })
        )
        return res.Attributes || null
    } catch (err) {
        if (conditionalFailure(err)) return null
        throw err
    }
}

async function markNotificationSent(
    item,
    leaseToken,
    now = new Date().toISOString()
) {
    await doc.send(
        new UpdateCommand({
            TableName: config.creditsTable,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression:
                'SET #status = :sent, #sentAt = :now, #updatedAt = :now ' +
                'REMOVE #queue, #due, #lease, #lastError',
            ConditionExpression: '#queue = :pending AND #lease = :leaseToken',
            ExpressionAttributeNames: {
                '#status': 'notificationStatus',
                '#sentAt': 'notificationSentAt',
                '#updatedAt': 'notificationUpdatedAt',
                '#queue': 'notificationQueue',
                '#due': 'notificationNextAttemptAt',
                '#lease': 'notificationLeaseToken',
                '#lastError': 'notificationLastError',
            },
            ExpressionAttributeValues: {
                ':sent': 'SENT',
                ':pending': 'PENDING',
                ':now': now,
                ':leaseToken': leaseToken,
            },
        })
    )
}

async function markNotificationFailed(
    item,
    leaseToken,
    error,
    { now = new Date().toISOString(), random = Math.random } = {}
) {
    const attempts = Number(item.notificationAttempts) || 1
    const lastError = String(
        error?.message || error || 'Unknown email error'
    ).slice(0, 1000)
    const dead = attempts >= MAX_ATTEMPTS
    const names = {
        '#status': 'notificationStatus',
        '#updatedAt': 'notificationUpdatedAt',
        '#lastError': 'notificationLastError',
        '#queue': 'notificationQueue',
        '#due': 'notificationNextAttemptAt',
        '#lease': 'notificationLeaseToken',
    }
    const values = {
        ':pending': 'PENDING',
        ':now': now,
        ':lastError': lastError,
        ':leaseToken': leaseToken,
    }

    let updateExpression
    if (dead) {
        names['#failedAt'] = 'notificationFailedAt'
        values[':dead'] = 'DEAD'
        updateExpression =
            'SET #status = :dead, #failedAt = :now, #updatedAt = :now, #lastError = :lastError ' +
            'REMOVE #queue, #due, #lease'
    } else {
        values[':retryAt'] = isoAfter(now, retryDelaySeconds(attempts, random))
        updateExpression =
            'SET #status = :pending, #due = :retryAt, #updatedAt = :now, #lastError = :lastError ' +
            'REMOVE #lease'
    }

    await doc.send(
        new UpdateCommand({
            TableName: config.creditsTable,
            Key: { pk: item.pk, sk: item.sk },
            UpdateExpression: updateExpression,
            ConditionExpression: '#queue = :pending AND #lease = :leaseToken',
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
        })
    )
    return { status: dead ? 'DEAD' : 'PENDING' }
}

module.exports = {
    MAX_ATTEMPTS,
    retryDelaySeconds,
    listDueNotifications,
    claimNotification,
    markNotificationSent,
    markNotificationFailed,
}
