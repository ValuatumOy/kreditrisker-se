'use strict'

const notifications = require('../lib/creditNotifications')
const credits = require('../lib/credits')
const emailService = require('../lib/email')

// Send without a count if the balance read fails.
async function readUnspentReports(item) {
    try {
        const balance = await credits.getBalance(
            item.notificationRecipient,
            item.reportType
        )
        return credits.unspentReports(balance)
    } catch (err) {
        console.error(
            'credit notification balance read failed; omitting report count',
            {
                pk: item.pk,
                sk: item.sk,
                error: err.message,
            }
        )
        return undefined
    }
}

async function sendNotification(item) {
    const details = {
        count: item.notificationCount,
        remainingReports: await readUnspentReports(item),
        occurredAt: item.createdAt,
    }
    if (item.notificationType === 'CREDIT_GRANT') {
        return emailService.sendCreditGrantEmail(
            item.notificationRecipient,
            details
        )
    }
    if (item.notificationType === 'CREDIT_RELEASE') {
        return emailService.sendCreditReleaseEmail(
            item.notificationRecipient,
            details
        )
    }
    throw new Error(
        `Unsupported credit notification type: ${item.notificationType || 'missing'}`
    )
}

exports.handler = async (_event, context = {}) => {
    const due = await notifications.listDueNotifications()
    const stats = {
        due: due.length,
        sent: 0,
        retried: 0,
        dead: 0,
        skipped: 0,
        errors: 0,
    }

    for (const candidate of due) {
        if (
            typeof context.getRemainingTimeInMillis === 'function' &&
            context.getRemainingTimeInMillis() < 5000
        ) {
            break
        }

        try {
            const claimed = await notifications.claimNotification(candidate)
            if (!claimed) {
                stats.skipped += 1
                continue
            }

            const leaseToken = claimed.notificationLeaseToken
            if (
                Number(claimed.notificationAttempts) >
                notifications.MAX_ATTEMPTS
            ) {
                await notifications.markNotificationFailed(
                    claimed,
                    leaseToken,
                    new Error(
                        'Notification exceeded the attempt limit after an expired lease'
                    )
                )
                stats.dead += 1
                console.error('credit notification attempt limit exceeded', {
                    pk: claimed.pk,
                    sk: claimed.sk,
                    attempts: claimed.notificationAttempts,
                })
                continue
            }

            try {
                await sendNotification(claimed)
            } catch (err) {
                const result = await notifications.markNotificationFailed(
                    claimed,
                    leaseToken,
                    err
                )
                stats[result.status === 'DEAD' ? 'dead' : 'retried'] += 1
                console.error('credit notification send failed', {
                    pk: claimed.pk,
                    sk: claimed.sk,
                    attempts: claimed.notificationAttempts,
                    status: result.status,
                    error: err.message,
                })
                continue
            }

            await notifications.markNotificationSent(claimed, leaseToken)
            stats.sent += 1
        } catch (err) {
            stats.errors += 1
            console.error('credit notification processing failed', {
                pk: candidate.pk,
                sk: candidate.sk,
                error: err.message,
            })
        }
    }

    console.log('credit notification tick', stats)
    // Retriable row failures stay queued; DEAD rows fail the invocation.
    if (stats.dead) {
        throw new Error(
            `Credit notifications abandoned after ${notifications.MAX_ATTEMPTS} attempts: dead=${stats.dead}`
        )
    }
    return stats
}

exports.sendNotification = sendNotification
