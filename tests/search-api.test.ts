// The search database written by the build, and the hits the browser reads back.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fromSearchApi, toSearchHit, type SearchHit } from '../src/lib/search.ts'
import { buildSearchDb, openSearchDb, searchDb } from '../src/lib/search-db.ts'
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

const hit = (o: string, n: string, extra: Partial<SearchHit> = {}): SearchHit => ({ o, n, p: `/foretag/${o}/${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/`, ...extra })

function withDb(rows: { hit: SearchHit; sales?: number }[], fn: (search: (q: string, limit?: number) => SearchHit[]) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-db-'))
    try {
        buildSearchDb(path.join(dir, 'search.sqlite'), rows)
        const db = openSearchDb(path.join(dir, 'search.sqlite'))
        fn((q, limit = 8) => searchDb(db, q, limit))
        db.close()
    } finally {
        fs.rmSync(dir, { recursive: true, force: true })
    }
}

test('directory row to search hit', () => {
    assert.deepEqual(toSearchHit(row), { o: '5569876542', n: 'Testbolaget Norrland AB', p: row.p, f: 'Gamla Namnet AB', k: 'Umeå', s: 'Övrig specialiserad butikshandel', y: '2025' })
    assert.deepEqual(toSearchHit({ ...row, f: undefined, k: undefined, s: undefined, per: undefined, st: 'bankruptcy', fr: 'stale' }), { o: row.o, n: row.n, p: row.p, st: 'bankruptcy', fr: 'stale' })
})

test('hits round-trip through the database unchanged', () => {
    const h = toSearchHit(row)
    withDb([{ hit: h }], (search) => assert.deepEqual(search('testbolaget'), [h]))
})

test('search: orgnr prefix, word prefixes, inside words, former names, ranking', () => {
    const rows = [
        { hit: hit('5560125790', 'Aktiebolaget Volvo'), sales: 1 },
        { hit: hit('5568775760', 'Volvo Car Technology Fund AB'), sales: 50 },
        { hit: hit('5591406433', 'Bilvolvo Service AB'), sales: 900 },
        { hit: hit('5561111111', 'Svenssons Byggtjänst i Kode AB'), sales: 10 },
        { hit: hit('5562222222', 'Andersbygg Öst AB'), sales: 20 },
        { hit: hit('5563333333', 'Nya Namnet AB', { f: 'Gamla Bygg AB' }), sales: 30 },
        { hit: hit('5564444444', 'Östgöta Plattsättning AB'), sales: 5 },
    ]
    withDb(rows, (searchHits) => {
        const search = (q: string, limit?: number) => searchHits(q, limit).map((h) => h.n)
        // orgnr prefix, hyphen allowed, ordered by number
        assert.deepEqual(search('556012-57'), ['Aktiebolaget Volvo'])
        assert.deepEqual(search('5561', 2), ['Svenssons Byggtjänst i Kode AB'])
        // word prefix before inside-word; a name starting with the query first, then sales;
        // "Aktiebolaget" is a legal form, so that name starts with "volvo"
        assert.deepEqual(search('volvo'), ['Volvo Car Technology Fund AB', 'Aktiebolaget Volvo', 'Bilvolvo Service AB'])
        assert.deepEqual(search('volvo car'), ['Volvo Car Technology Fund AB'])
        // inside compound words, then former names last
        assert.deepEqual(search('bygg'), ['Svenssons Byggtjänst i Kode AB', 'Andersbygg Öst AB', 'Nya Namnet AB'])
        // å/ä/ö folded both ways; legal form ignored; short words prefix-match
        assert.deepEqual(search('ostgota ab'), ['Östgöta Plattsättning AB'])
        assert.deepEqual(search('Östgöta'), ['Östgöta Plattsättning AB'])
        assert.deepEqual(search('sv bygg'), ['Svenssons Byggtjänst i Kode AB'])
        // too short, legal form only, nothing
        assert.deepEqual(search('v'), [])
        assert.deepEqual(search('ab'), [])
        assert.deepEqual(search('xyz'), [])
        // query syntax is data, not FTS5 syntax
        assert.deepEqual(search('"bygg OR volvo*'), [])
        assert.deepEqual(search('volvo', 1).length, 1)
    })
})

test('malformed search responses yield no hits', () => {
    assert.deepEqual(fromSearchApi(null), [])
    assert.deepEqual(fromSearchApi({ hits: [] }), [])
    assert.deepEqual(fromSearchApi([{ o: '1', n: 'x', p: 'https://evil.example/' }, null, 'x']), [])
    const h = toSearchHit(row)
    assert.deepEqual(fromSearchApi([{ ...h, extra: '<script>' }]), [h])
})
