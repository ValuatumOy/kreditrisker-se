'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
require('./no-network.cjs')
process.env.REPORT_ISOLATED_FIXTURE_TEST = '1'
process.env.ADMIN_EMAIL = 'success@simulator.amazonses.com'
const { SESv2Client } = require('@aws-sdk/client-sesv2')
const sends = []
SESv2Client.prototype.send = async command => { sends.push(command.input); return { MessageId: 'fake' } }
const email = require('../src/lib/email')

test('fixture email adapter blocks real recipients before contacting SES', async () => {
    const details = { companyName: 'Test', pdfBuffer: Buffer.from('test'), lang: 'sv' }
    await assert.rejects(email.sendReportEmail('person@example.com', details), /only sends to the SES success simulator/)
    assert.equal(sends.length, 0)
    await email.sendReportEmail('success@simulator.amazonses.com', details)
    assert.equal(sends.length, 1)
    assert.deepEqual(sends[0].Destination.ToAddresses, ['success@simulator.amazonses.com'])
})
