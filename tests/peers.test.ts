// Industry comparison on the company page: medians and the place by net sales.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSite, type IndexRow } from '../src/lib/publish.ts'
import { benchmark, MIN_PEERS } from '../src/lib/peers.ts'

const sni = { code: '62010', label: 'Dataprogrammering', version: 'SNI2025' }
const row = (i: number, extra: Partial<IndexRow> = {}): IndexRow =>
    ({ o: String(5560000000 + i), n: `Bolag ${i}`, p: `/foretag/${5560000000 + i}/bolag-${i}/`, rf: [], st: 'active', fr: 'current', ix: true, q: true, syn: false, im: '2026-11-01', s: sni, per: { start: '2025-01-01', end: '2025-12-31', months: 12 }, ns: 1000 * (i + 1), er: (i + 1) / 100, ...extra }) as IndexRow

test('median and place come from comparable companies only', () => {
    const rows = [...Array.from({ length: 11 }, (_, i) => row(i)), row(50, { fr: 'stale', ns: 9e9 }), row(51, { per: { start: '2025-07-01', end: '2025-12-31', months: 6 }, ns: 9e9 })]
    const [hub] = buildSite([], rows, 't').industries
    const b = benchmark(hub, rows[0])!
    const sales = b.rows.find((r) => r.field === 'ns')!
    assert.deepEqual([sales.value, sales.median, sales.peers], [1000, 6000, 11])
    assert.equal(b.rows.find((r) => r.field === 'er')!.median, 0.06)
    assert.deepEqual([b.place, b.ranked], [11, 11], 'smallest of eleven; the stale and the six-month company are not counted')
    assert.equal(benchmark(hub, rows[10])!.place, 1)
    assert.equal(b.rows.some((r) => r.field === 'om'), false, 'no row for a figure the company lacks')
    assert.equal(benchmark(hub, rows[11]), null, 'a stale company is not compared')
})

test('no comparison without enough companies behind the median', () => {
    const rows = Array.from({ length: MIN_PEERS - 1 }, (_, i) => row(i))
    assert.equal(benchmark(buildSite([], rows, 't').industries[0], rows[0]), null)
    const even = Array.from({ length: MIN_PEERS }, (_, i) => row(i))
    assert.equal(benchmark(buildSite([], even, 't').industries[0], even[0])!.rows[0].median, 5500, 'even count: mean of the two middle values')
})
