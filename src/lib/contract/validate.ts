// Runtime validation of incoming records against the contract in types.ts.
// Returns every problem found, so rejected-record logs are actionable.

import { parseOrgnr } from '../orgnr.ts'
import type { CompanyRecord } from './types.ts'
import { SCHEMA_VERSION } from './types.ts'

const SOURCES = new Set([
    'bolagsverket-foretagsinformation',
    'bolagsverket-arsredovisning',
    'scb-foretagsregister',
    'valuatum-credit-model',
    'valuatum-rest',
    'synthetic',
])
const LEGAL_FORMS = new Set(['AB', 'PUBL', 'HB', 'KB', 'EF', 'EK', 'BRF', 'IF', 'ST', 'FL', 'OTHER'])
const STATUSES = new Set(['active', 'liquidation', 'bankruptcy', 'reconstruction', 'deregistered', 'unknown'])
const MISSING = new Set(['not_filed', 'not_in_source', 'not_digitised', 'parse_failed', 'withheld'])
const INCOMPARABLE = new Set([
    'period_length',
    'period_gap',
    'denominator_not_positive',
    'framework_change',
    'consolidation_change',
    'no_prior_period',
])
const INCOME_FIELDS = [
    'netSales',
    'operatingProfit',
    'financialNet',
    'profitAfterFinancialItems',
    'netProfit',
    'personnelCosts',
] as const
const BALANCE_FIELDS = [
    'totalAssets',
    'equity',
    'untaxedReserves',
    'inventories',
    'cash',
    'currentAssets',
    'currentLiabilities',
    'longTermLiabilities',
] as const
// Items that cannot be negative in a correctly parsed statement.
const NON_NEGATIVE = new Set(['totalAssets', 'inventories', 'cash', 'currentAssets', 'currentLiabilities', 'longTermLiabilities', 'untaxedReserves'])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export interface ValidationResult {
    ok: boolean
    errors: string[]
}

function isObj(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isDate(v: unknown): v is string {
    return typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v))
}

function checkSource(s: unknown, path: string, errors: string[], synthetic: boolean) {
    if (!isObj(s)) return void errors.push(`${path}: source missing`)
    if (!SOURCES.has(s.source as string)) errors.push(`${path}.source: unknown source "${String(s.source)}"`)
    if (!isDate(s.retrievedAt)) errors.push(`${path}.retrievedAt: not an ISO date`)
    if (synthetic !== (s.source === 'synthetic')) errors.push(`${path}.source: synthetic flag and source disagree`)
}

function checkValue(v: unknown, path: string, errors: string[], synthetic: boolean, field: string) {
    if (!isObj(v)) return void errors.push(`${path}: value missing (use status "missing", never omit or 0)`)
    switch (v.status) {
        case 'reported':
            if (typeof v.value !== 'number' || !Number.isFinite(v.value)) errors.push(`${path}.value: not a finite number`)
            else if (NON_NEGATIVE.has(field) && v.value < 0) errors.push(`${path}.value: ${field} cannot be negative`)
            checkSource(v.source, `${path}.source`, errors, synthetic)
            break
        case 'derived':
            errors.push(`${path}: derived values are computed at build time, not imported`)
            break
        case 'missing':
            if (!MISSING.has(v.reason as string)) errors.push(`${path}.reason: unknown missing reason`)
            if ('value' in v) errors.push(`${path}: missing value must not carry a value`)
            break
        case 'not_applicable':
            if (typeof v.note !== 'string' || !v.note) errors.push(`${path}.note: required`)
            break
        case 'incomparable':
            if (!INCOMPARABLE.has(v.reason as string)) errors.push(`${path}.reason: unknown incomparable reason`)
            break
        default:
            errors.push(`${path}.status: unknown status "${String(v.status)}"`)
    }
}

function checkPeriod(p: unknown, path: string, errors: string[], synthetic: boolean) {
    if (!isObj(p)) return void errors.push(`${path}: not an object`)
    if (!isDate(p.start) || !isDate(p.end)) errors.push(`${path}: start/end must be ISO dates`)
    else if (p.start >= p.end) errors.push(`${path}: start must be before end`)
    if (typeof p.months !== 'number' || p.months < 1 || p.months > 18 || !Number.isInteger(p.months))
        errors.push(`${path}.months: must be an integer 1-18`)
    if (p.currency !== 'SEK' && p.currency !== 'EUR') errors.push(`${path}.currency: SEK or EUR`)
    if (typeof p.consolidated !== 'boolean') errors.push(`${path}.consolidated: boolean required`)
    checkSource(p.source, `${path}.source`, errors, synthetic)
    const income = isObj(p.income) ? p.income : {}
    const balance = isObj(p.balance) ? p.balance : {}
    for (const f of INCOME_FIELDS) checkValue(income[f], `${path}.income.${f}`, errors, synthetic, f)
    for (const f of BALANCE_FIELDS) checkValue(balance[f], `${path}.balance.${f}`, errors, synthetic, f)
    checkValue(p.employees, `${path}.employees`, errors, synthetic, 'employees')
}

export function validateRecord(input: unknown): ValidationResult {
    const errors: string[] = []
    if (!isObj(input)) return { ok: false, errors: ['record: not an object'] }
    const r = input
    const synthetic = r.synthetic === true

    if (r.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion: expected ${SCHEMA_VERSION}`)
    if (typeof r.synthetic !== 'boolean') errors.push('synthetic: boolean required')

    const parsed = typeof r.orgnr === 'string' ? parseOrgnr(r.orgnr) : null
    if (!parsed || !parsed.ok) errors.push(`orgnr: invalid (${parsed && !parsed.ok ? parsed.error : 'missing'})`)
    else {
        if (parsed.orgnr !== r.orgnr) errors.push('orgnr: must be normalised to 10 digits without hyphen')
        if (parsed.kind === 'synthetic' && !synthetic) errors.push('orgnr: group 0 is reserved for synthetic records')
        if (parsed.kind !== 'synthetic' && synthetic) errors.push('orgnr: synthetic records must use group 0')
        if (parsed.kind === 'personnummer' && r.legalForm !== 'EF') errors.push('orgnr: personnummer is only valid for EF')
    }

    if (typeof r.name !== 'string' || r.name.trim().length < 2) errors.push('name: required')
    if (!Array.isArray(r.formerNames)) errors.push('formerNames: array required (may be empty)')
    if (!LEGAL_FORMS.has(r.legalForm as string)) errors.push(`legalForm: unknown "${String(r.legalForm)}"`)

    if (!isObj(r.status) || !STATUSES.has(r.status.code as string)) errors.push('status.code: unknown')
    else checkSource(r.status.source, 'status.source', errors, synthetic)

    if (r.municipality !== undefined) {
        const m = r.municipality
        if (!isObj(m) || typeof m.code !== 'string' || !/^\d{4}$/.test(m.code) || typeof m.name !== 'string')
            errors.push('municipality: needs 4-digit code and name')
    }

    if (!Array.isArray(r.sni)) errors.push('sni: array required (may be empty)')
    else
        r.sni.forEach((s, i) => {
            if (!isObj(s) || !/^\d{5}$/.test(String(s.code)) || (s.version !== 'SNI2007' && s.version !== 'SNI2025') || !s.label)
                errors.push(`sni[${i}]: needs version, 5-digit code and label`)
        })

    if (!Array.isArray(r.periods)) errors.push('periods: array required (may be empty)')
    else {
        r.periods.forEach((p, i) => checkPeriod(p, `periods[${i}]`, errors, synthetic))
        const ends = r.periods.map((p) => (isObj(p) ? String(p.end) : ''))
        for (let i = 1; i < ends.length; i++) if (ends[i] >= ends[i - 1]) errors.push('periods: must be sorted newest first without duplicates')
    }

    if (r.model !== undefined) {
        const m = r.model
        if (!isObj(m)) errors.push('model: not an object')
        else {
            if (typeof m.score !== 'number') errors.push('model.score: number required')
            if (!isObj(m.scale) || typeof m.scale.min !== 'number' || typeof m.scale.max !== 'number')
                errors.push('model.scale: min/max required')
            else if (typeof m.score === 'number' && (m.score < m.scale.min || m.score > m.scale.max))
                errors.push('model.score: outside scale')
            if (typeof m.horizonMonths !== 'number' || m.horizonMonths <= 0) errors.push('model.horizonMonths: required')
            if (!isDate(m.inputsPeriodEnd)) errors.push('model.inputsPeriodEnd: ISO date required')
            checkSource(m.source, 'model.source', errors, synthetic)
        }
    }

    if (!isObj(r.provenance) || typeof r.provenance.batchId !== 'string' || !isDate(String(r.provenance.importedAt).slice(0, 10)))
        errors.push('provenance: batchId and importedAt required')

    return { ok: errors.length === 0, errors }
}

export function assertRecord(input: unknown): CompanyRecord {
    const res = validateRecord(input)
    if (!res.ok) throw new Error(res.errors.join('; '))
    return input as CompanyRecord
}

