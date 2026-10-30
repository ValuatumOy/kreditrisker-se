'use strict'

const { test, mock } = require('node:test')
const assert = require('node:assert/strict')
const { SESv2Client } = require('@aws-sdk/client-sesv2')
const { sendReportEmail, sendAdminGenerationAlert, sendOrderReceivedEmail, sendWithdrawalReceipt, sendWithdrawalAdminAlert } = require('../src/lib/email')

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

test('order and withdrawal messages preserve the reference and never claim an automatic refund', async () => {
    const send = mock.method(SESv2Client.prototype, 'send', async () => ({ MessageId: 'test-message' }))
    const order = {
        sessionId: 'cs_test_reference123456', email: 'buyer@example.com', companyName: '<Wrong company>',
        params: { companyCode: '556036-9208' },
        amountTotal: 3640, currency: 'sek', acceptedTermsVersion: 'reviewed-version',
        withdrawalRequestId: 'withdrawal-123', withdrawalRequestedAt: '2026-10-30T12:00:00Z',
        withdrawalPaymentResolution: 'REFUND_REQUIRED', paymentIntentId: 'pi_local',
    }
    try {
        await sendOrderReceivedEmail(order, 'Kreditriskrapport')
        await sendWithdrawalReceipt(order)
        await sendWithdrawalAdminAlert(order)
        const inputs = send.mock.calls.map(call => call.arguments[0].input)
        const confirmation = inputs[0].Content.Simple.Body.Html.Data
        assert.match(confirmation, /36,40/)
        assert.match(confirmation, /Beloppet reserveras/)
        assert.match(confirmation, /14 dagar/)
        assert.match(confirmation, /reviewed-version/)
        assert.match(confirmation, /angra-kop/)
        assert.doesNotMatch(confirmation, /href="[^"]*(?:cs_test_|order=)/)
        assert.match(confirmation, /Ångerblankett/)
        assert.match(confirmation, /Företag: Valuatum Oy/)
        assert.match(confirmation, /Postadress: Linnanrakentajantie/)
        assert.match(confirmation, /E-post till företaget:/)
        assert.match(confirmation, /Köparens\/köparnas namn/)
        assert.match(confirmation, /endast på papper/)
        for (const input of inputs) {
            const html = input.Content.Simple.Body.Html.Data
            assert.match(html, /cs_test_reference123456/)
            assert.match(html, /556036-9208/)
            assert.doesNotMatch(html, /Wrong company/)
            assert.doesNotMatch(input.Content.Simple.Subject.Data, /Wrong company/)
            assert.equal(input.Destination.BccAddresses, undefined)
        }
        assert.deepEqual(inputs[1].Destination.ToAddresses, ['buyer@example.com'])
        assert.match(inputs[1].Content.Simple.Body.Html.Data, /Produkt: Kreditriskrapport/)
        assert.match(inputs[1].Content.Simple.Body.Html.Data, /2026-10-30T12:00:00Z/)
        assert.match(inputs[1].Content.Simple.Body.Html.Data, /inte genomförd/)
        assert.match(inputs[2].Content.Simple.Body.Html.Data, /No refund has been issued automatically/)
        assert.match(confirmation, /Kreditriskrapport, organisationsnummer: 556036-9208/)
    } finally { mock.restoreAll() }
})

test('zero-total confirmation does not describe a nonexistent payment reservation', async () => {
    const send = mock.method(SESv2Client.prototype, 'send', async () => ({ MessageId: 'test-message' }))
    try {
        await sendOrderReceivedEmail({ sessionId: 'cs_test_free', email: 'buyer@example.com', amountTotal: 0, currency: 'sek', params: { companyCode: '556036-9208' } }, 'Kreditriskrapport')
        const html = send.mock.calls[0].arguments[0].input.Content.Simple.Body.Html.Data
        assert.match(html, /Ingen betalning krävs/)
        assert.doesNotMatch(html, /reserveras|släpps reservationen/)
    } finally { mock.restoreAll() }
})
