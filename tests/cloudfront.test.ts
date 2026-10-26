// The CloudFront Functions deployed by aws-infra, run as written.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { siteRequestCode } from '../aws-infra/lib/functions.ts'

const load = (code: string) => new Function(`${code}; return handler`)() as (e: unknown) => any
const req = (uri: string, query: Record<string, string> = {}, host = 'www.kreditrisker.se') => ({
    request: { uri, headers: { host: { value: host } }, querystring: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, { value: v }])) },
})

test('site request: index rewrite, trailing slash, apex redirect', () => {
    const h = load(siteRequestCode('kreditrisker.se'))
    assert.equal(h(req('/foretag/5569876542/testbolaget-ab/')).uri, '/foretag/5569876542/testbolaget-ab/index.html')
    assert.equal(h(req('/')).uri, '/index.html')
    assert.equal(h(req('/sitemap-index.xml')).uri, '/sitemap-index.xml')
    const slash = h(req('/kommuner', { q: 'x' }))
    assert.equal(slash.statusCode, 301)
    assert.equal(slash.headers.location.value, '/kommuner/?q=x')
    const apex = h(req('/metod/', {}, 'kreditrisker.se'))
    assert.equal(apex.headers.location.value, 'https://www.kreditrisker.se/metod/')
})
