import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateTestCheckoutSite } from '../aws-infra/lib/checkout-stack.ts'

const enabledTest = { environmentName: 'Test' as const, checkoutEnabled: true }

test('enabled test checkout rejects a missing, insecure or production return origin', () => {
    for (const siteUrl of ['', 'not-a-url', '//test.example.com', 'http://test.example.com',
        'https://kreditrisker.se', 'https://www.kreditrisker.se/', 'https://WWW.KREDITRISKER.SE.:443/']) {
        assert.throws(() => validateTestCheckoutSite({ ...enabledTest, siteUrl }), /set siteUrlTest/)
    }
})

test('enabled test checkout requires an origin without credentials, paths or query parameters', () => {
    for (const siteUrl of ['https://user:password@test.example.com', 'https://test.example.com/path',
        'https://test.example.com/?next=production', 'https://test.example.com/#checkout']) {
        assert.throws(() => validateTestCheckoutSite({ ...enabledTest, siteUrl }), /set siteUrlTest/)
    }
})

test('enabled test checkout accepts an explicit HTTPS test origin', () => {
    for (const siteUrl of ['https://d123example.cloudfront.net', 'https://test.kreditrisker.se/']) {
        assert.doesNotThrow(() => validateTestCheckoutSite({ ...enabledTest, siteUrl }))
    }
})

test('disabled test checkout and production retain their existing origin configuration', () => {
    assert.doesNotThrow(() => validateTestCheckoutSite({ environmentName: 'Test', checkoutEnabled: false, siteUrl: 'https://www.kreditrisker.se' }))
    assert.doesNotThrow(() => validateTestCheckoutSite({ environmentName: 'Test', siteUrl: 'https://www.kreditrisker.se' }))
    assert.doesNotThrow(() => validateTestCheckoutSite({ environmentName: 'Prod', checkoutEnabled: true, siteUrl: 'https://www.kreditrisker.se' }))
})
