'use strict'

// The Swedish SEK checkout uses the local equivalent of the Finnish €2 fee.
const UNIT_AMOUNT = require('./report-price-targets.json').fraudAddon
const REPORT_TYPE = 'se_ai_credit_risk'

function available(reportType) {
    return reportType === REPORT_TYPE && process.env.SE_AI_FRAUD_ADDON === '1'
}

function sessionSelection(metadata) {
    if (metadata.aiFraudAddonVersion === undefined) return undefined
    const included = metadata.includeFraud === 'true'
    const amount = Number(metadata.fraudAddonCents)
    if (metadata.aiFraudAddonVersion !== '1' || !['true', 'false'].includes(metadata.includeFraud) ||
        !Number.isSafeInteger(amount) || String(amount) !== metadata.fraudAddonCents ||
        (included ? amount <= 0 : amount !== 0)) {
        throw new Error('Invalid fraud add-on metadata')
    }
    return included
}

module.exports = { UNIT_AMOUNT, REPORT_TYPE, available, sessionSelection }
