// Internal links between profiles: spread over the whole directory, not the top of each hub.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSite, relatedCompanies, type IndexRow } from '../src/lib/publish.ts'
import type { PublishedCompany } from '../src/lib/contract/types.ts'

const sni = { code: '62010', label: 'Dataprogrammering', version: 'SNI2025' }
const row = (i: number, extra: Partial<IndexRow> = {}): IndexRow =>
    ({ o: String(5560000000 + i), n: `Bolag ${i}`, p: `/foretag/${5560000000 + i}/bolag-${i}/`, rf: [], st: 'active', fr: 'current', ix: true, q: true, syn: false, im: '2026-11-01', s: sni, k: { code: i % 2 ? '0180' : '1480', name: i % 2 ? 'Stockholm' : 'Göteborg' }, ns: 1000 * (500 - i), ...extra }) as IndexRow
const page = (r: IndexRow) => ({ record: { orgnr: r.o, sni: r.s ? [r.s] : [], municipality: r.k } }) as unknown as PublishedCompany

test('every threshold-passing profile is linked from its peers', () => {
    const rows = Array.from({ length: 400 }, (_, i) => row(i, i % 10 === 9 ? { q: false, ix: false } : {}))
    const site = buildSite([], rows, 't')
    const inbound = new Map<string, number>()
    for (const r of rows) {
        const links = relatedCompanies(site, page(r))
        assert.equal(links.length, 8)
        assert.ok(!links.some((x) => x.o === r.o), 'no link to itself')
        assert.ok(links.every((x) => x.q), 'no links to profiles below the threshold')
        assert.equal(new Set(links.map((x) => x.o)).size, 8)
        for (const x of links) inbound.set(x.o, (inbound.get(x.o) ?? 0) + 1)
    }
    const passing = rows.filter((r) => r.q)
    assert.ok(passing.every((r) => (inbound.get(r.o) ?? 0) >= 4), 'each profile has several inbound links')
    assert.ok(Math.max(...inbound.values()) <= 24, 'no profile collects the links of the whole hub')
})

test('neighbours are the nearest in size, and small hubs still fill the list', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i))
    const site = buildSite([], rows, 't')
    const links = relatedCompanies(site, page(rows[20]))
    assert.deepEqual(links.slice(0, 5).map((x) => x.n).sort(), ['Bolag 17', 'Bolag 18', 'Bolag 19', 'Bolag 21', 'Bolag 22'])
    const few = buildSite([], rows.slice(0, 4), 't')
    assert.equal(relatedCompanies(few, page(rows[0])).length, 3)
    const alone = row(900, { s: undefined, k: undefined })
    assert.deepEqual(relatedCompanies(buildSite([], [alone], 't'), page(alone)), [])
})
