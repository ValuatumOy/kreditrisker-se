// SE_HTML_FINAL: pages state their own verdict while the site stays closed.

import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.SE_HTML_FINAL = '1'
delete process.env.SE_INDEXING
const { isIndexable, pageIndexable } = await import('../src/lib/seo.ts')

test('the HTML verdict is final while robots.txt and the sitemaps stay closed', () => {
    assert.equal(pageIndexable(false, false), true)
    assert.equal(pageIndexable(true, false), false, 'a thin page stays noindex')
    assert.equal(pageIndexable(false, true), false, 'synthetic data stays noindex')
    assert.equal(isIndexable(false, false), false, 'robots.txt and sitemaps follow SE_INDEXING only')
})
