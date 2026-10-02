// Maps a Valuatum REST bundle (modeldata + company register row) to the
// Swedish CompanyRecord contract. Pure. The variable names follow the Danish
// directory; confirm each against the Swedish backend before launch
// (docs/VALUATUM-API.md lists the open questions).

import type { CompanyRecord, CompanyStatusCode, FiscalPeriod, LegalFormCode, SourceRef, Value } from '../contract/types.ts'
import { KOMMUNER } from '../../config/kommuner.ts'
import { parseOrgnr } from '../orgnr.ts'
import type { Bundle } from './api.ts'

/** modeldata amounts are in millions of the model currency. */
const UNIT = 1e6

/** Contract field -> REST variable names, first present wins. */
export const VARS = {
    netSales: ['ns'],
    operatingProfit: ['ebit'],
    financialNet: ['fundu_financial_income_and_expenses'],
    profitAfterFinancialItems: ['pre_tax_profit'],
    netProfit: ['cr_net_earnings', 'net_earnings'],
    personnelCosts: ['cr_employee_benefit_expenses'],
    totalAssets: ['bs_total_assets'],
    equity: ['cr_shareholders_equity'],
    untaxedReserves: ['cr_untaxed_reserves'],
    inventories: ['cr_inventory', 'inventories'],
    cash: ['cr_cash_and_cash_eq_total', 'cr_cash_and_bank_deposits'],
    currentAssets: ['cr_current_assets_total'],
    currentLiabilities: ['cr_current_liabilities_total'],
    longTermLiabilities: ['cr_non_current_liabilities_total'],
    employees: ['cr_employees'],
} as const
const PERIOD_MONTHS = 'cr_fiscal_period_length'
const PERIOD_END = 'text_fiscal_period_end'
/** Every variable the mapper reads; the API cache keeps only these. */
export const USED_VARS = new Set<string>([...Object.values(VARS).flat(), PERIOD_MONTHS, PERIOD_END])

const LEGAL_FORMS: Record<string, LegalFormCode> = {
    aktiebolag: 'AB',
    'publikt aktiebolag': 'PUBL',
    handelsbolag: 'HB',
    kommanditbolag: 'KB',
    'enskild näringsidkare': 'EF',
    'ekonomisk förening': 'EK',
    bostadsrättsförening: 'BRF',
    'ideell förening': 'IF',
    stiftelse: 'ST',
    filial: 'FL',
}
const STATUSES: Record<string, CompanyStatusCode> = {
    NORMAL: 'active',
    AKTIV: 'active',
    LIKVIDATION: 'liquidation',
    KONKURS: 'bankruptcy',
    REKONSTRUKTION: 'reconstruction',
    AVREGISTRERAD: 'deregistered',
}

export type MapResult = { ok: true; record: CompanyRecord } | { ok: false; reason: string }

const kommunByName = new Map(Object.entries(KOMMUNER).map(([code, k]) => [k.name.toLowerCase(), code]))

function municipality(raw?: string, code?: string): CompanyRecord['municipality'] {
    const c = code && KOMMUNER[code] ? code : raw && kommunByName.get(raw.trim().toLowerCase())
    if (!c) return undefined
    return { code: c, name: KOMMUNER[c].name, county: KOMMUNER[c].county }
}

export function mapBundle(b: Bundle, opts: { batchId: string; importedAt: string }): MapResult {
    const md = b.modeldata
    const company = b.companies.find((c) => String(c.companyId) === String(md.companyId))
    if (!company) return { ok: false, reason: 'company row missing from /rest/company response' }
    const code = company.companyCode.replace(/\D/g, '')
    const parsed = parseOrgnr(code)
    if (!parsed.ok) return { ok: false, reason: `companyCode "${company.companyCode}" is not an organisationsnummer` }
    if (md.currency !== 'SEK' && md.currency !== 'EUR') return { ok: false, reason: `currency ${md.currency}` }

    const src: SourceRef = { source: 'valuatum-rest', retrievedAt: b.retrievedAt, documentId: `fid:${b.fid}` }
    const data = company.companyData ?? {}
    const years = Object.keys(md.dataMap)
        .filter((k) => /^\d{4}$/.test(k))
        .sort()
        .reverse()

    const periods: FiscalPeriod[] = []
    for (const y of years) {
        const row = md.dataMap[y]
        const get = (names: readonly string[]): number | undefined => {
            for (const n of names) if (typeof row[n] === 'number' && Number.isFinite(row[n])) return row[n] as number
        }
        const amount = (names: readonly string[], opts: { abs?: boolean } = {}): Value => {
            const v = get(names)
            if (v === undefined) return { status: 'missing', reason: 'not_in_source' }
            return { status: 'reported', value: Math.round((opts.abs ? Math.abs(v) : v) * UNIT), source: src }
        }
        if (get(VARS.netSales) === undefined && get(VARS.totalAssets) === undefined) continue
        const months = Math.round(get([PERIOD_MONTHS]) ?? 12)
        // ponytail: without an explicit end date the year is assumed to end in December;
        // broken fiscal years (brutet räkenskapsår) need text_fiscal_period_end from the backend.
        const endText = typeof row[PERIOD_END] === 'string' ? (row[PERIOD_END] as string) : undefined
        const end = endText && /^\d{4}-\d{2}-\d{2}$/.test(endText) ? endText : `${y}-12-31`
        const endDate = new Date(end + 'T00:00:00Z')
        const startDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - months + 1, 1))
        const employees = get(VARS.employees)
        periods.push({
            start: startDate.toISOString().slice(0, 10),
            end,
            months,
            currency: md.currency as 'SEK' | 'EUR',
            consolidated: company.companyCode.endsWith('K'),
            framework: 'unknown',
            source: src,
            income: {
                netSales: amount(VARS.netSales),
                operatingProfit: amount(VARS.operatingProfit),
                financialNet: amount(VARS.financialNet),
                profitAfterFinancialItems: amount(VARS.profitAfterFinancialItems),
                netProfit: amount(VARS.netProfit),
                personnelCosts: amount(VARS.personnelCosts, { abs: true }),
            },
            balance: {
                totalAssets: amount(VARS.totalAssets),
                equity: amount(VARS.equity),
                untaxedReserves: amount(VARS.untaxedReserves),
                inventories: amount(VARS.inventories),
                cash: amount(VARS.cash),
                currentAssets: amount(VARS.currentAssets),
                currentLiabilities: amount(VARS.currentLiabilities),
                longTermLiabilities: amount(VARS.longTermLiabilities),
            },
            employees: employees === undefined ? { status: 'missing', reason: 'not_in_source' } : { status: 'reported', value: Math.round(employees), source: src },
        })
    }

    const sniCode = (company.industryCode ?? '').replace(/\D/g, '')
    const sniLabel = data.industryText ?? company.industryTree?.name?.sv
    const record: CompanyRecord = {
        schemaVersion: 1,
        orgnr: parsed.orgnr,
        synthetic: false,
        name: company.companyName.trim(),
        formerNames: [],
        legalForm: LEGAL_FORMS[(data.businessType ?? '').toLowerCase()] ?? 'OTHER',
        status: { code: STATUSES[(data.status ?? '').toUpperCase()] ?? 'unknown', source: src },
        registeredAt: data.dateEstablished && /^\d{4}-\d{2}-\d{2}$/.test(data.dateEstablished) ? data.dateEstablished : undefined,
        municipality: municipality(data.municipality, data.municipalityCode),
        sni: /^\d{5}$/.test(sniCode) && sniLabel ? [{ version: 'SNI2007', code: sniCode, label: sniLabel }] : [],
        periods,
        provenance: { batchId: opts.batchId, importedAt: opts.importedAt, sources: [src] },
    }
    return { ok: true, record }
}
