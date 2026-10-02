// The CloudFront Functions deployed by aws-infra, run as written.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { searchRewriteCode, siteRequestCode } from '../aws-infra/lib/functions.ts'

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

test('search rewrite: orgnr prefix, all-words name match, no client-supplied CloudSearch params', () => {
    const h = load(searchRewriteCode())
    const byNumber = h(req('/api/search', { q: '556987-65' }))
    assert.equal(byNumber.uri, '/2013-01-01/search')
    assert.equal(decodeURIComponent(byNumber.querystring.q.value), "(prefix field=orgnr '55698765')")
    const byName = h(req('/api/search', { q: "Testbolaget%20Norr'land%20AB", 'q.parser': 'lucene', 'return': '_all' }))
    const q = decodeURIComponent(byName.querystring.q.value)
    assert.equal(q, "(or (and (prefix field=name 'testbolaget') (prefix field=name 'norr') (prefix field=name 'land')) (and (prefix field=former 'testbolaget') (prefix field=former 'norr') (prefix field=former 'land')))")
    assert.equal(byName.querystring['q.parser'].value, 'structured')
    assert.ok(!byName.querystring.return.value.includes('_all'))
    const tooShort = h(req('/api/search', { q: 'a' }))
    assert.equal(tooShort.statusCode, 200)
    assert.equal(JSON.parse(tooShort.body).hits.found, 0)
})
