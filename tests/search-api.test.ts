// CloudSearch documents written by the build, and the hits the browser reads back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromCloudSearch } from '../src/lib/search.ts'
import { searchDoc } from '../scripts/search-docs.ts'
import type { IndexRow } from '../src/lib/publish.ts'

const row: IndexRow = {
    o: '5569876542',
    n: 'Testbolaget Norrland AB',
    f: 'Gamla Namnet AB',
    p: '/foretag/5569876542/testbolaget-norrland-ab/',
    rf: [],
    st: 'active',
    k: { code: '2480', name: 'Umeå', county: 'Västerbottens län' },
    s: { version: 'SNI2007', code: '47599', label: 'Övrig specialiserad butikshandel' },
    fr: 'current',
    ix: true,
    q: true,
    syn: false,
    per: { start: '2025-01-01', end: '2025-12-31', months: 12 },
    ns: 6_518_822_000,
    im: '2026-10-02',
}

test('search document round-trips to a SearchHit', () => {
    const doc = searchDoc(row)
    assert.equal(doc.id, '5569876542')
    assert.equal(doc.fields.sales, 6_518_822)
    // CloudSearch returns single-valued fields as strings or arrays
    const body = { hits: { found: 1, hit: [{ id: doc.id, fields: { ...doc.fields, name: [doc.fields.name] } }] } }
    assert.deepEqual(fromCloudSearch(body), [
        { o: '5569876542', n: 'Testbolaget Norrland AB', p: row.p, f: 'Gamla Namnet AB', k: 'Umeå', s: 'Övrig specialiserad butikshandel', st: 'active', y: '2025', fr: 'current' },
    ])
})

test('malformed search responses yield no hits', () => {
    assert.deepEqual(fromCloudSearch(null), [])
    assert.deepEqual(fromCloudSearch({ hits: { hit: [{ fields: { orgnr: '1', name: 'x', path: 'https://evil.example/' } }] } }), [])
})
