import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMetrics, UNTAXED_RESERVE_EQUITY_SHARE } from '../src/lib/metrics.ts'
import { compactSek, percent, tkr } from '../src/lib/format.ts'
import type { Value } from '../src/lib/contract/types.ts'
import { batch1, byName } from './helpers.ts'

const n = (v: Value) => {
    if (v.status !== 'reported' && v.status !== 'derived') throw new Error(`expected number, got ${v.status}`)
    return v.value
}

test('full data: ratios derive from reported inputs with formula ids', () => {
    const r = byName(batch1(), 'Exempel Mjukvara')
    const [p, prior] = r.periods
    const m = computeMetrics(p, prior)
    assert.equal(m.revenueGrowth.status, 'derived')
    assert.ok(Math.abs(n(m.revenueGrowth) - (n(p.income.netSales) / n(prior.income.netSales) - 1)) < 1e-12)
    const expectedEq = (n(p.balance.equity) + UNTAXED_RESERVE_EQUITY_SHARE * n(p.balance.untaxedReserves)) / n(p.balance.totalAssets)
    assert.ok(Math.abs(n(m.equityRatio) - expectedEq) < 1e-12)
    assert.equal(m.operatingMargin.status === 'derived' && m.operatingMargin.formula, 'rorelsemarginal.v1')
})

test('sparse data: missing inputs give missing ratios, never zero', () => {
    const r = byName(batch1(), 'Exempel Fastigheter')
    const m = computeMetrics(r.periods[0])
    assert.equal(m.equityRatio.status, 'missing')
    assert.equal(m.quickRatio.status, 'missing')
    assert.equal(m.operatingMargin.status, 'missing')
    assert.equal(m.revenueGrowth.status, 'incomparable')
    assert.equal(percent(m.equityRatio).text, 'saknas')
    assert.equal(tkr(r.periods[0].balance.equity).state, 'missing')
    assert.notEqual(tkr(r.periods[0].balance.equity).text, '0')
})

test('zero net sales: shown as 0, margins and growth incomparable', () => {
    const r = byName(batch1(), 'Exempel Holding')
    const p = r.periods[0]
    assert.equal(compactSek(p.income.netSales).text, '0 kr')
    assert.equal(compactSek(p.income.netSales).state, 'zero')
    const m = computeMetrics(p, r.periods[1])
    assert.deepEqual(m.operatingMargin, { status: 'incomparable', reason: 'denominator_not_positive' })
    assert.deepEqual(m.revenueGrowth, { status: 'incomparable', reason: 'denominator_not_positive' })
})

test('negative equity: soliditet negative, return on equity incomparable', () => {
    const r = byName(batch1(), 'Exempel Restaurang')
    const m = computeMetrics(r.periods[0], r.periods[1])
    assert.equal(percent(m.equityRatio).state, 'negative')
    assert.ok(percent(m.equityRatio).text.startsWith('−'))
    assert.deepEqual(m.returnOnEquity, { status: 'incomparable', reason: 'denominator_not_positive' })
})

test('18-month period: growth incomparable, margins still computed', () => {
    const r = byName(batch1(), 'Exempel Åkeri')
    const m = computeMetrics(r.periods[0], r.periods[1])
    assert.deepEqual(m.revenueGrowth, { status: 'incomparable', reason: 'period_length' })
    assert.equal(m.operatingMargin.status, 'derived')
})

test('consolidation change between years makes growth incomparable', () => {
    const r = byName(batch1(), 'Exempel Koncern')
    const prior = structuredClone(r.periods[1])
    prior.consolidated = false
    assert.deepEqual(computeMetrics(r.periods[0], prior).revenueGrowth, { status: 'incomparable', reason: 'consolidation_change' })
})

test('missing or overlapping fiscal years are not annual growth', () => {
    const r = byName(batch1(), 'Exempel Mjukvara')
    assert.deepEqual(computeMetrics(r.periods[0], r.periods[2]).revenueGrowth, { status: 'incomparable', reason: 'period_gap' })
    assert.deepEqual(computeMetrics(r.periods[0], r.periods[0]).revenueGrowth, { status: 'incomparable', reason: 'period_gap' })
})

test('consecutive broken fiscal years remain comparable', () => {
    const r = byName(batch1(), 'Exempel Mjukvara')
    const p = structuredClone(r.periods[0])
    const prior = structuredClone(r.periods[1])
    p.start = '2025-07-01'
    p.end = '2026-06-30'
    prior.start = '2024-07-01'
    prior.end = '2025-06-30'
    assert.equal(computeMetrics(p, prior).revenueGrowth.status, 'derived')
})
