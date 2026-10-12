import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { metricsOf, numeric } from '../src/lib/metrics.ts'
import { compactSek, percent, tkr } from '../src/lib/format.ts'
import { BALANCE_ROWS, INCOME_ROWS } from '../src/config/statement.ts'
import { BALANCE_VARS, INCOME_VARS, mapBundle, RATIO_VARS } from '../src/lib/valuatum/map.ts'
import type { Bundle } from '../src/lib/valuatum/api.ts'
import type { FiscalPeriod } from '../src/lib/contract/types.ts'
import { batch1, byName, statementGaps } from './helpers.ts'

const sample = (): Bundle => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'data', 'sample', 'api-cache', '52.json'), 'utf8'))
const samplePeriods = () => {
    const res = mapBundle(sample(), { batchId: 't', importedAt: '2026-10-12T00:00:00Z' })
    assert.ok(res.ok)
    return res.record.periods
}

test('key ratios are the CV values as the source gives them', () => {
    const b = sample()
    const [p] = samplePeriods()
    const row = b.modeldata.dataMap['2025']
    const m = metricsOf(p)
    for (const [k, name] of Object.entries(RATIO_VARS)) assert.equal(numeric(m[k as keyof typeof RATIO_VARS]), row[name], k)
    assert.equal(percent(m.quickRatio, 0).text, '213 %', 'kassalikviditet 2.13 is shown as a percentage')
})

test('every Bokslut row has a CV variable and every statement field a row', () => {
    assert.deepEqual(INCOME_ROWS.map((r) => r.key).sort(), Object.keys(INCOME_VARS).sort())
    assert.deepEqual(BALANCE_ROWS.map((r) => r.key).sort(), Object.keys(BALANCE_VARS).sort())
})

test('real sample: the Bokslut rows add up to their subtotals', () => {
    for (const p of samplePeriods()) assert.deepEqual(statementGaps(p), [])
})

test('sparse data: missing ratios show as saknas, never zero', () => {
    const r = byName(batch1(), 'Exempel Fastigheter')
    const m = metricsOf(r.periods[0])
    assert.equal(m.equityRatio.status, 'missing')
    assert.equal(m.quickRatio.status, 'missing')
    assert.equal(percent(m.equityRatio).text, 'saknas')
    assert.equal(tkr(r.periods[0].balance.equity).state, 'missing')
    assert.notEqual(tkr(r.periods[0].balance.equity).text, '0')
})

test('zero net sales: shown as 0 kr', () => {
    const r = byName(batch1(), 'Exempel Holding')
    const p = r.periods[0]
    assert.equal(compactSek(p.income.netSales).text, '0 kr')
    assert.equal(compactSek(p.income.netSales).state, 'zero')
    assert.equal(metricsOf(p).operatingMargin.status, 'missing')
})

test('an amount that rounds to 0 tkr prints 0, not −0', () => {
    const src = { source: 'synthetic' as const, retrievedAt: '2026-10-12' }
    assert.deepEqual(tkr({ status: 'reported', value: -400, source: src }), { text: '0', state: 'zero' })
    assert.equal(tkr({ status: 'reported', value: -600, source: src }).text, '−1')
})

test('negative equity: soliditet negative', () => {
    const r = byName(batch1(), 'Exempel Restaurang')
    const m = metricsOf(r.periods[0])
    assert.equal(percent(m.equityRatio).state, 'negative')
    assert.ok(percent(m.equityRatio).text.startsWith('−'))
})
