'use strict'

// The isolated AWS test can exercise only the synthetic company and SES's
// success simulator. No customer's mailbox or real company is involved.
function isFixtureEmail(email) {
  return typeof email === 'string' && email.trim().toLowerCase() === 'success@simulator.amazonses.com'
}

function isFixturePurchase({ reportType, businessId, email }) {
  return reportType === 'se_credit_risk'
    && typeof businessId === 'string'
    && ['0020001012', '002000-1012'].includes(businessId)
    && isFixtureEmail(email)
}

function isFixtureOrder(order) {
  return typeof order?.sessionId === 'string' && order.sessionId.startsWith('cs_test_')
    && order.funding !== 'package'
    && isFixturePurchase({ reportType: order.reportType, businessId: order.params?.companyCode, email: order.email })
}

module.exports = { isFixtureEmail, isFixturePurchase, isFixtureOrder }
