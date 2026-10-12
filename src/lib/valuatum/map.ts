// Maps a Valuatum REST bundle (modeldata + company register row) to the
// Swedish CompanyRecord contract. Pure. The variable names were checked
// against the Swedish backend (sweden.valuatum.com) on 2026-10-08.
//
// companyData has the Finnish COMPANYDATA keys, filled by the Bolagsverket
// import from /organisationer (profinder-environment organisation_metadata.py):
//   YHTIOMUOTO                     organisationsform code (AB, HB, KB ...)
//   PERUSTETTU                     registration date, DD-MM-YYYY
//   TILAKOODI                      "1" registered, "L" deregistered
//   MENETTELY, MENETTELY_PVM       ongoing bankruptcy, liquidation or reconstruction and its start date
//   LOPETTAMISSYY, LOPETTAMIS_PVM  deregistration reason and date
//   KOTIPAIKKA                     kommun of the registered seat (SCB's name, from the annual report)
//
// industryCode is the SNI 2025 code (5 digits; "0000" = not allocated) and industryTree its node,
// with the Swedish name in name.sv ("24.330 Tillverkning av ..."). sweden-db's 5-digit industry level
// is SNI 2025 since 2026-10-08.

import { SCHEMA_VERSION, type BalanceSheet, type CompanyRecord, type CompanyStatusCode, type FiscalPeriod, type IncomeStatement, type KeyRatios, type LegalFormCode, type SourceRef, type Value } from '../contract/types.ts'
import { KOMMUNER } from '../../config/kommuner.ts'
import { parseOrgnr } from '../orgnr.ts'
import type { Bundle } from './api.ts'

/** modeldata amounts are in millions of the model currency. */
const UNIT = 1e6

// The statement items are rows of the company view (CV) tables in sweden-db:
// income statement (CVSVTABLE 450), assets (447) and equity and liabilities (11638),
// checked on 2026-10-12. Rows between the subtotals that no Bolagsverket linking rule
// fills (leasing interest, exchange differences, extraordinary items ...) are left out:
// they are always empty for Swedish companies, so the shown rows still add up.
// The key ratios are the CV overview tables 442, 444 and 445 and personnel costs
// and employees the volume table 17088.

/** Contract field -> REST variable name. */
export const INCOME_VARS = {
    netSales: 'ns',
    personnelCosts: 'cr_employee_expenses',
    operatingProfit: 'ebit',
    incomeFromGroupCompanies: 'cr_income_from_group_members',
    incomeFromAssociates: 'cr_income_from_associates',
    incomeFromOtherFinancialAssets: 'cr_income_from_non_current_investments',
    interestIncome: 'cr_interest_income',
    otherFinancialIncome: 'cr_other_financial_income',
    financialAssetWriteDowns: 'cr_amortization_financial_assets',
    interestExpenses: 'cr_interest_expenses',
    otherFinancialExpenses: 'cr_other_financial_expenses',
    // Before the extraordinary items, which Swedish annual reports no longer have.
    profitAfterFinancialItems: 'cr_pre_tax_profit_less_eo',
    changeInAcceleratedDepreciation: 'cr_change_in_accelerated_depreciations',
    changeInUntaxedReserves: 'cr_change_in_untaxed_reserves',
    groupContributions: 'cr_group_contributions',
    incomeTaxes: 'cr_income_taxes',
    minorityShareOfProfit: 'cr_minorities',
    netProfit: 'cr_net_earnings',
} as const satisfies Record<keyof IncomeStatement, string>

export const BALANCE_VARS = {
    intangibleAssets: 'cr_intangible_assets_total',
    tangibleAssets: 'cr_tangibles_assets_total',
    financialAssets: 'cr_investments_total',
    // Of the CV's long-term receivables only the deferred tax asset is linked for Sweden.
    deferredTaxAssets: 'cr_long_term_receivables_total',
    // "Inventories total" in the CV, Bolagsverket's Varulager m.m.
    inventories: 'cr_current_assets_total',
    shortTermReceivables: 'cr_short_term_receivables_total',
    shortTermInvestments: 'cr_cash_equivalents_total',
    cash: 'cr_cash_and_bank_deposits',
    totalAssets: 'bs_total_assets',
    equity: 'cr_shareholders_equity',
    minorityInterest: 'minorities',
    untaxedReserves: 'cr_appropriations_total',
    provisions: 'cr_provisions',
    longTermLiabilities: 'cr_non_current_liabilities_total',
    currentLiabilities: 'cr_current_liabilities_total',
    totalEquityAndLiabilities: 'bs_total_liab',
} as const satisfies Record<keyof BalanceSheet, string>

export const RATIO_VARS = {
    revenueGrowth: 'ns_growth',
    operatingMargin: 'ebit_percent',
    profitMargin: 'cr_pre_tax_profit_less_eo_percent',
    equityRatio: 'cr_equity_ratio',
    quickRatio: 'cr_quick_ratio',
    returnOnEquity: 'cr_roe_percent_corrected',
} as const satisfies Record<keyof KeyRatios, string>

const EMPLOYEES = 'cr_employees_adjusted'
const PERIOD_MONTHS = 'cr_fiscal_period_length'
/** Period end as a number, e.g. 20251231. */
const PERIOD_END = 'cr_fiscal_year_end'
/** Every variable the mapper reads; the API cache keeps only these. */
export const USED_VARS = new Set<string>([
    ...Object.values(INCOME_VARS),
    ...Object.values(BALANCE_VARS),
    ...Object.values(RATIO_VARS),
    EMPLOYEES,
    PERIOD_MONTHS,
    PERIOD_END,
])

/** Bolagsverket organisationsform code (YHTIOMUOTO) -> contract code. */
const LEGAL_FORMS: Record<string, LegalFormCode> = {
    AB: 'AB',
    HB: 'HB',
    KB: 'KB',
    E: 'EF',
    EK: 'EK',
    BRF: 'BRF',
    I: 'IF',
    S: 'ST',
    FL: 'FL',
}

const isoDate = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)

/** DD-MM-YYYY (PERUSTETTU) -> YYYY-MM-DD. */
function isoFromFinnishDate(v?: string): string | undefined {
    const m = v?.match(/^(\d{2})-(\d{2})-(\d{4})$/)
    return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined
}

/** Deregistration first, then the ongoing procedure (MENETTELY holds Bolagsverket's klartext). */
function companyStatus(data: Record<string, string | undefined>): { code: CompanyStatusCode; since?: string } {
    if (data.TILAKOODI === 'L') return { code: 'deregistered', since: isoDate(data.LOPETTAMIS_PVM) }
    const procedure = (data.MENETTELY ?? '').toLowerCase()
    const since = isoDate(data.MENETTELY_PVM)
    if (procedure.includes('konkurs')) return { code: 'bankruptcy', since }
    if (procedure.includes('likvidation')) return { code: 'liquidation', since }
    if (procedure.includes('rekonstruktion')) return { code: 'reconstruction', since }
    return { code: data.TILAKOODI === '1' ? 'active' : 'unknown' }
}

export type MapResult = { ok: true; record: CompanyRecord } | { ok: false; reason: string }

const kommunByName = new Map(Object.entries(KOMMUNER).map(([code, k]) => [k.name.toLowerCase(), code]))

function municipality(name?: string): CompanyRecord['municipality'] {
    const c = name && kommunByName.get(name.trim().toLowerCase())
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
        const get = (name: string): number | undefined => (typeof row[name] === 'number' && Number.isFinite(row[name]) ? (row[name] as number) : undefined)
        if ([...Object.values(INCOME_VARS), ...Object.values(BALANCE_VARS)].every((name) => get(name) === undefined)) continue
        // The backend never stores zero values (checked in sweden-db on 2026-10-12), so an item
        // absent from a period is 0, as the CV pages show it. Only the key ratios can be missing.
        const value = (name: string, unit: number, zero: boolean): Value => {
            const v = get(name) ?? (zero ? 0 : undefined)
            if (v === undefined) return { status: 'missing', reason: 'not_in_source' }
            return { status: 'reported', value: unit === 1 ? v : Math.round(v * unit), source: src }
        }
        const values = <K extends string>(vars: Record<K, string>, unit: number, zero: boolean) =>
            Object.fromEntries(Object.entries<string>(vars).map(([k, name]) => [k, value(name, unit, zero)])) as Record<K, Value>
        const months = Math.round(get(PERIOD_MONTHS) ?? 12)
        // Without an end date the year is assumed to end in December.
        const endText = String(get(PERIOD_END) ?? '')
        const end = /^\d{8}$/.test(endText) ? `${endText.slice(0, 4)}-${endText.slice(4, 6)}-${endText.slice(6)}` : `${y}-12-31`
        const endDate = new Date(end + 'T00:00:00Z')
        const startDate = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - months + 1, 1))
        const employees = get(EMPLOYEES)
        periods.push({
            start: startDate.toISOString().slice(0, 10),
            end,
            months,
            currency: md.currency as 'SEK' | 'EUR',
            consolidated: company.companyCode.endsWith('K'),
            framework: 'unknown',
            source: src,
            income: values(INCOME_VARS, UNIT, true),
            balance: values(BALANCE_VARS, UNIT, true),
            ratios: values(RATIO_VARS, 1, false),
            employees: employees === undefined ? { status: 'missing', reason: 'not_in_source' } : { status: 'reported', value: Math.round(employees), source: src },
        })
    }

    const sniCode = (company.industryCode ?? '').replace(/\D/g, '')
    // The tree node's Swedish name without its code prefix ("24.330 ").
    const sniNode = company.industryTree?.nace === company.industryCode ? company.industryTree : undefined
    const sniLabel = sniNode?.name?.sv?.replace(/^[\d.]+\s+/, '')
    const record: CompanyRecord = {
        schemaVersion: SCHEMA_VERSION,
        orgnr: parsed.orgnr,
        synthetic: false,
        name: company.companyName.trim(),
        formerNames: [],
        legalForm: LEGAL_FORMS[(data.YHTIOMUOTO ?? '').trim().toUpperCase()] ?? 'OTHER',
        status: { ...companyStatus(data), source: src },
        registeredAt: isoFromFinnishDate(data.PERUSTETTU),
        municipality: municipality(data.KOTIPAIKKA),
        sni: /^\d{5}$/.test(sniCode) && sniLabel ? [{ version: 'SNI2025', code: sniCode, label: sniLabel }] : [],
        periods,
        provenance: { batchId: opts.batchId, importedAt: opts.importedAt, sources: [src] },
    }
    return { ok: true, record }
}
