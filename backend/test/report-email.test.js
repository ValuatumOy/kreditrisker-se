'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const { SESv2Client } = require('@aws-sdk/client-sesv2')
const { sendReportEmail, sendAdminGenerationAlert } = require('../src/lib/email')

test('a report is addressed only to the customer', async () => {
    const send = mock.method(SESv2Client.prototype, 'send', async () => ({ MessageId: 'test-message' }))
    try {
        await sendReportEmail('buyer@example.com', { companyName: 'Example', pdfBuffer: Buffer.from('pdf'), lang: 'sv' })
        const destination = send.mock.calls[0].arguments[0].input.Destination
        assert.deepEqual(destination.ToAddresses, ['buyer@example.com'])
        assert.equal(destination.BccAddresses, undefined)
        assert.equal(destination.CcAddresses, undefined)
    } finally {
        mock.restoreAll()
    }
})

test('customer and admin emails escape externally supplied text', async () => {
    const send = mock.method(SESv2Client.prototype, 'send', async () => ({ MessageId: 'test-message' }))
    try {
        const malicious = '<img src=x onerror=alert(1)>'
        await sendReportEmail('buyer@example.com', { companyName: malicious, pdfBuffer: Buffer.from('pdf'), lang: 'sv' })
        await sendAdminGenerationAlert({ companyName: malicious, email: malicious }, malicious, 'report')
        for (const call of send.mock.calls) {
            const html = call.arguments[0].input.Content.Simple.Body.Html.Data
            assert.ok(!html.includes(malicious))
            assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'))
        }
    } finally {
        mock.restoreAll()
    }
})
