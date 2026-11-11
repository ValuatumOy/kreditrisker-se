import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bankruptcyRows, bankruptcySummary, bankruptcyIndexable, procedureDate, bankruptcyGroups } from '../src/lib/bankruptcy.ts'
import { buildSite, publishCompany, toRow, type IndexRow } from '../src/lib/publish.ts'
import { pageNumbers, pagePath, pageRows } from '../src/lib/pagination.ts'
import { AS_OF, batch1 } from './helpers.ts'

const row = (o: string, st: IndexRow['st'], ss?: string): IndexRow => ({ o, n: o, p: `/foretag/${o}/test/`, rf: [], st, ss, syn: false, q: false, ix: false, fr: 'none', im: '2026-11-11' })

test('only registry bankruptcy status selects a case, regardless of profile quality or name', () => {
    const rows = [row('Konkurs AB', 'active'), row('1', 'deregistered'), row('2', 'reconstruction'), row('3', 'liquidation'), row('4', 'unknown'), row('5', 'bankruptcy')]
    assert.deepEqual(bankruptcyRows(rows, AS_OF).map((r) => r.o), ['5'])
    assert.equal(bankruptcyIndexable(rows), false)
    assert.equal(bankruptcyIndexable([row('1', 'bankruptcy'), row('2', 'bankruptcy'), row('3', 'bankruptcy')]), true)
    assert.equal(bankruptcyIndexable([row('1', 'bankruptcy'), row('2', 'bankruptcy'), { ...row('3', 'bankruptcy'), syn: true }]), false)
})

test('snapshot month buckets exclude older, absent, invalid and future procedure dates', () => {
    const rows = [row('a', 'bankruptcy', '2026-11-11'), row('b', 'bankruptcy', '2025-12-01'), row('c', 'bankruptcy', '2025-11-30'), row('d', 'bankruptcy'), row('e', 'bankruptcy', '2026-02-30'), row('f', 'bankruptcy', '2026-11-12'), row('g', 'active', '2026-10-01')]
    const result = bankruptcySummary(rows, '2026-11-11')
    assert.equal(result.cases.length, 6)
    assert.equal(result.months.length, 12)
    assert.deepEqual(result.months[0], { month: '2025-12', count: 1 })
    assert.deepEqual(result.months.at(-1), { month: '2026-11', count: 1 })
    assert.equal(result.older, 1)
    assert.equal(result.undated, 3)
    assert.equal(result.recent.length, 2)
    assert.equal(result.recent.length + result.older + result.undated, result.cases.length)
    assert.equal(procedureDate(rows[3], '2026-11-11'), undefined, 'import date is never substituted')
})

test('staff subset never substitutes missing or stale figures; group denominators are the snapshot', () => {
    const rows: IndexRow[] = [0, 9, 10, 49, 50, 249, 250].map((emp, i) => ({ ...row(String(i), 'bankruptcy', '2026-10-01'), fr: 'current', emp }))
    rows.push({ ...rows[0], o: 'missing', emp: undefined }, { ...rows[0], o: 'stale', fr: 'stale', emp: 1000 })
    const result = bankruptcySummary(rows, '2026-11-11')
    assert.equal(result.withEmployees.length, 7)
    assert.deepEqual(result.sizes.map((s) => s.count), [2, 2, 2, 1])
    assert.equal(result.sizes.reduce((n, s) => n + s.employees, 0), 617)
    const site = buildSite([], [...rows, row('active', 'active')].map((r) => ({ ...r, k: { code: '0180', name: 'Stockholm' } })), 'test')
    assert.deepEqual(bankruptcyGroups(site.municipalities, '2026-11-11').map((g) => [g.count, g.total]), [[9, 10]])
})

test('slim index preserves exact status date and provenance and accepts older rows without them', () => {
    const record = batch1()[0]
    record.status.code = 'bankruptcy'
    record.status.since = '2026-08-13'
    const index = toRow(publishCompany(record, undefined, AS_OF))
    assert.equal(index.ss, record.status.since)
    assert.deepEqual(index.sr, record.status.source)
    delete index.ss
    delete index.sr
    assert.equal(bankruptcyRows([index], AS_OF).length, 1)
    assert.equal(bankruptcySummary([index], AS_OF).undated, 1)
})

test('pagination preserves all companies, first URL and self-canonical later URLs', () => {
    const rows = Array.from({ length: 403 }, (_, i) => i)
    const pages = pageNumbers(rows.length, 200)
    assert.deepEqual(pages, [1, 2, 3])
    assert.deepEqual(pages.flatMap((page) => pageRows(rows, page, 200)), rows)
    assert.equal(pagePath('/kommuner/stockholm/', 1), '/kommuner/stockholm/')
    assert.equal(pagePath('/kommuner/stockholm/', 2), '/kommuner/stockholm/2/')
    assert.deepEqual(pageNumbers(0, 100), [1])
})

test('immutable build arrays reuse sorted cases and groups, while as-of changes refresh the cache', () => {
    const rows = [row('future', 'bankruptcy', '2027-01-01'), row('known', 'bankruptcy', '2026-10-01')]
    const first = bankruptcyRows(rows, '2026-11-11')
    assert.deepEqual(first.map((r) => r.o), ['known', 'future'])
    assert.strictEqual(bankruptcyRows(rows, '2026-11-11'), first)
    const next = bankruptcyRows(rows, '2027-02-01')
    assert.notStrictEqual(next, first)
    assert.deepEqual(next.map((r) => r.o), ['future', 'known'])
    const hubs = buildSite([], rows.map((r) => ({ ...r, k: { code: '0180', name: 'Stockholm' } })), 'test').municipalities
    const groups = bankruptcyGroups(hubs, '2026-11-11')
    assert.strictEqual(bankruptcyGroups(hubs, '2026-11-11'), groups)
    assert.notStrictEqual(bankruptcyGroups(hubs, '2027-02-01'), groups)
})
