import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatOrgnr, luhnCheckDigit, parseOrgnr } from '../src/lib/orgnr.ts'
import { slugify } from '../src/lib/slug.ts'

const withCheck = (nine: string) => nine + luhnCheckDigit(nine)

test('parses and normalises a legal-person orgnr', () => {
    const full = withCheck('556677889')
    assert.deepEqual(parseOrgnr(formatOrgnr(full)), { ok: true, orgnr: full, kind: 'legal_person' })
    assert.equal(parseOrgnr('16' + full).ok, true)
})

test('rejects bad checksum and bad format', () => {
    const full = withCheck('556677889')
    const wrong = full.slice(0, 9) + ((Number(full[9]) + 1) % 10)
    assert.deepEqual(parseOrgnr(wrong), { ok: false, error: 'checksum' })
    assert.deepEqual(parseOrgnr('12345'), { ok: false, error: 'format' })
})

test('group 0 is synthetic; a month-like third digit is a personnummer', () => {
    const syn = parseOrgnr(withCheck('002000101'))
    assert.equal(syn.ok && syn.kind, 'synthetic')
    const pnr = parseOrgnr(withCheck('800101123'))
    assert.equal(pnr.ok && pnr.kind, 'personnummer')
})

test('slugs are deterministic and ASCII', () => {
    assert.equal(slugify('Exempel Åkeri & Logistik AB'), 'exempel-akeri-logistik-ab')
    assert.equal(slugify('Örebro Tandvård AB'), 'orebro-tandvard-ab')
    assert.equal(slugify('!!!'), 'foretag')
})
