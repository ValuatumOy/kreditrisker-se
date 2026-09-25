import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateRecord } from '../src/lib/contract/validate.ts'
import { batch1, batch2, byName } from './helpers.ts'

test('every batch-1 fixture satisfies the contract', () => {
    for (const r of batch1()) assert.deepEqual(validateRecord(r).errors, [], r.name)
})

test('a raw 0 in place of a Value is rejected (missing must never be zero)', () => {
    const bad = byName(batch2(), 'Exempel Nolla')
    const res = validateRecord(bad)
    assert.equal(res.ok, false)
    assert.ok(res.errors.some((e) => e.includes('personnelCosts') && e.includes('never omit or 0')))
})

test('omitted fields are rejected, explicit missing is accepted', () => {
    const r = byName(batch1(), 'Exempel Fastigheter')
    assert.equal(validateRecord(r).ok, true)
    delete (r.periods[0].balance as Partial<typeof r.periods[0]['balance']>).equity
    assert.ok(validateRecord(r).errors.some((e) => e.includes('balance.equity')))
})

test('negative amounts are allowed for results and equity but not for assets', () => {
    const r = byName(batch1(), 'Exempel Restaurang')
    assert.equal(validateRecord(r).ok, true) // negative equity, negative operating profit
    r.periods[0].balance.totalAssets = { status: 'reported', value: -5, source: r.status.source }
    assert.ok(validateRecord(r).errors.some((e) => e.includes('totalAssets cannot be negative')))
})

test('synthetic flag, source and orgnr group must agree', () => {
    const r = byName(batch1(), 'Exempel Elinstallation')
    r.synthetic = false
    const errs = validateRecord(r).errors
    assert.ok(errs.some((e) => e.includes('group 0 is reserved')))
    assert.ok(errs.some((e) => e.includes('synthetic flag and source disagree')))
})

test('periods must be newest first; model score must be on its scale', () => {
    const r = byName(batch1(), 'Exempel Mjukvara')
    r.periods.reverse()
    assert.ok(validateRecord(r).errors.some((e) => e.includes('newest first')))
    const m = byName(batch1(), 'Exempel Mjukvara')
    m.model!.score = 140
    assert.ok(validateRecord(m).errors.some((e) => e.includes('outside scale')))
})
