import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ANALYTICS_PAGES, ANALYTICS_REFERRERS, analyticsPage, analyticsReferrer } from '../src/lib/analytics.ts'

test('analytics maps sensitive and unknown page paths to fixed categories', () => {
    for (const path of ['/foretag/5569876542/hemligt-foretag/', '/foretag/private@example.test/']) {
        assert.equal(analyticsPage(path), 'company')
        assert.deepEqual(ANALYTICS_PAGES[analyticsPage(path)], { path: '/foretag/', title: 'Företagsprofil' })
    }
    assert.equal(analyticsPage('/sok/'), 'search')
    assert.equal(analyticsPage('/bestall/'), 'checkout')
    assert.equal(analyticsPage('/other/private@example.test/'), 'other')
    assert.equal(analyticsPage('/foretagish/private/'), 'other')
})

test('referrers are selected from a fixed allowlist, without paths or queries', () => {
    assert.equal(analyticsReferrer('https://www.google.se/search?q=private@example.test'), 'google')
    assert.equal(ANALYTICS_REFERRERS[analyticsReferrer('https://chatgpt.com/private/order') as 'chatgpt'], 'https://chatgpt.com/')
    assert.equal(analyticsReferrer('https://google.se.evil.test/?q=secret'), '')
    assert.equal(analyticsReferrer('https://www.kreditrisker.se/sok/?q=secret'), '')
    assert.equal(analyticsReferrer('https://secret.example.test/path'), '')
    assert.equal(analyticsReferrer('not a URL'), '')
})
