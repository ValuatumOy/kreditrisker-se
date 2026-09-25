import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessQuality } from '../src/lib/quality.ts'
import { freshnessOf } from '../src/lib/freshness.ts'
import { summarize } from '../src/lib/summary.ts'
import { publishCompany } from '../src/lib/publish.ts'
import { AS_OF, batch1, byName } from './helpers.ts'
import type { CompanyRecord } from '../src/lib/contract/types.ts'

const asReal = (r: CompanyRecord): CompanyRecord => ({ ...r, synthetic: false })
const opts = { publishSoleTraders: false }

test('freshness: current, aging, stale, none', () => {
    const rows = batch1()
    assert.equal(freshnessOf(byName(rows, 'Exempel Mjukvara'), AS_OF), 'current')
    assert.equal(freshnessOf(byName(rows, 'Exempel Metall'), AS_OF), 'stale')
    assert.equal(freshnessOf(byName(rows, 'Exempel Nystart'), AS_OF), 'none')
    const aging = byName(rows, 'Exempel Mjukvara')
    aging.periods = aging.periods.slice(1) // newest now ends 2024-12-31, ~21 months before as-of
    assert.equal(freshnessOf(aging, AS_OF), 'aging')
})

test('full data passes the threshold but synthetic is never indexable', () => {
    const r = byName(batch1(), 'Exempel Mjukvara')
    const q = assessQuality(r, freshnessOf(r, AS_OF), opts)
    assert.equal(q.meetsThreshold, true)
    assert.equal(q.indexable, false)
    assert.deepEqual(q.reasons, ['syntetiska testdata'])
    assert.equal(assessQuality(asReal(r), 'current', opts).indexable, true)
})

test('sparse, stale and empty profiles are kept out of the index', () => {
    const rows = batch1().map(asReal)
    for (const [name, reason] of [
        ['Exempel Fastigheter', 'för få nyckelposter'],
        ['Exempel Metall', 'äldre än 31 månader'],
        ['Exempel Nystart', 'inget bokslut'],
    ] as const) {
        const r = byName(rows, name)
        const q = assessQuality(r, freshnessOf(r, AS_OF), opts)
        assert.equal(q.indexable, false, name)
        assert.ok(q.reasons.some((x) => x.includes(reason)), `${name}: ${q.reasons}`)
    }
})

test('sole traders are not published unless explicitly enabled', () => {
    const r = asReal(byName(batch1(), 'Exempel Frisör'))
    assert.equal(assessQuality(r, 'none', opts).publishable, false)
    assert.equal(assessQuality(r, 'none', { publishSoleTraders: true }).publishable, true)
})

test('summary states facts only and flags stale data', () => {
    const stale = publishCompany(byName(batch1(), 'Exempel Metall'), undefined, AS_OF)
    const text = summarize(stale).join(' ')
    assert.match(text, /Linköpings kommun/)
    assert.match(text, /avser 2022; nyare siffror finns inte/)
    assert.doesNotMatch(text, /frisk|stark|riskabel|svag|sund/i)
    const sparse = summarize(publishCompany(byName(batch1(), 'Exempel Fastigheter'), undefined, AS_OF)).join(' ')
    assert.match(sparse, /Umeå kommun/)
    assert.doesNotMatch(sparse, /Soliditeten/)
    assert.doesNotMatch(sparse, /rörelseresultatet/)
})
