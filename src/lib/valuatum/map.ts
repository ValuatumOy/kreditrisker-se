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

// The statement items are the rows of the company view (CV) tables in sweden-db:
// income statement (CVSVTABLE 450), assets (447) and equity and liabilities (11638),
// checked on 2026-10-12. Left out are the rows that no Bolagsverket linking rule fills
// and that are empty for every Swedish company (leasing, extraordinary items ...), the
// sub-rows that repeat their parent (depreciation, loans from credit institutions), and
// the result after extraordinary items, which equals the result after financial items. The "unspecified" items are the part of a Bolagsverket
// subtotal the filing does not break down. In the income statement each subtotal is the
// previous one plus the items between; associates' share of the result belongs above
// EBITDA, although the CV lists it below depreciation.
// The key ratios are the CV overview tables 442, 444 and 445 and employees the volume table 17088.

/** Contract field -> REST variable name. */
export const INCOME_VARS = {
    netSales: 'ns',
    changeInInventories: 'cr_change_in_finished_goods_inv',
    ownWorkCapitalised: 'cr_manufacturing_for_own_use',
    otherOperatingIncome: 'cr_other_operating_income',
    rawMaterialsAndGoods: 'cr_purchases_during_fy',
    costOfGoodsSold: 'cr_costs_of_manufacturing',
    // Its content depends on the report format, so it is shown only where it adds up (src/config/statement.ts).
    grossProfit: 'cr_gross_profit',
    sellingExpenses: 'cr_costs_of_marketing',
    administrativeExpenses: 'cr_costs_of_management',
    wagesAndSalaries: 'cr_wages_and_salaries',
    socialSecurityCosts: 'cr_social_security_expenses',
    otherOperatingExpenses: 'cr_other_oper_expenses',
    shareOfAssociatesResult: 'cr_net_income_from_associates',
    ebitda: 'cr_ebitda',
    depreciation: 'cr_depreciation',
    operatingProfit: 'ebit',
    interestIncome: 'cr_interest_income',
    otherFinancialIncome: 'cr_other_financial_income',
    interestExpenses: 'cr_interest_expenses',
    otherFinancialExpenses: 'cr_other_financial_expenses',
    incomeFromOtherFinancialAssets: 'cr_income_from_non_current_investments',
    incomeFromGroupCompanies: 'cr_income_from_group_members',
    incomeFromAssociates: 'cr_income_from_associates',
    financialAssetWriteDowns: 'cr_amortization_financial_assets',
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
    developmentExpenditure: 'cr_development_expenditure',
    intangibleRights: 'cr_intangible_rights',
    goodwill: 'cr_goodwill',
    otherIntangibleAssets: 'cr_other_capitalised_lt_expen',
    intangibleAdvancePayments: 'cr_advance_payments_lt',
    intangibleAssetsUnspecified: 'cr_input_intangible_assets_total',
    intangibleAssets: 'cr_intangible_assets_total',
    buildingsAndLand: 'cr_buildings',
    machineryAndEquipment: 'cr_machinery_and_equipment',
    constructionInProgress: 'cr_advance_payments_and_cons_in_prog',
    otherTangibleAssets: 'cr_other_tangible_assets',
    tangibleAssetsUnspecified: 'cr_input_tangibles_assets_total',
    tangibleAssets: 'cr_tangibles_assets_total',
    sharesInGroupCompanies: 'cr_holdings_in_group_companies',
    sharesInAssociates: 'cr_participating_interests',
    otherShareholdings: 'cr_other_shares_and_ownership',
    receivablesFromGroupCompaniesLongTerm: 'cr_receivables_from_group_member',
    receivablesFromAssociatesLongTerm: 'cr_receivables_from_participating',
    otherLongTermSecurities: 'cr_other_non_curr_investments',
    otherLongTermReceivables: 'cr_other_receivables',
    financialAssetsUnspecified: 'cr_input_investments_total',
    financialAssets: 'cr_investments_total',
    // Of the CV's long-term receivables only the deferred tax asset is linked for Sweden.
    deferredTaxAssets: 'cr_lt_tax_assets',
    longTermReceivablesUnspecified: 'cr_input_long_term_receivables_total',
    longTermReceivables: 'cr_long_term_receivables_total',
    rawMaterials: 'cr_raw_materials',
    workInProgress: 'cr_semifinished_products',
    otherInventories: 'cr_other_stocks',
    finishedGoods: 'cr_finished_goods',
    advancesToSuppliers: 'cr_advance_payments',
    inventoriesUnspecified: 'cr_input_current_assets_total',
    // "Inventories total" in the CV, Bolagsverket's Varulager m.m.
    inventories: 'cr_current_assets_total',
    tradeReceivables: 'cr_curr_trade_debtors',
    receivablesFromGroupCompanies: 'cr_curr_owed_by_group_member',
    receivablesFromAssociates: 'cr_curr_owed_by_participating',
    unpaidShareCapital: 'cr_current_unpaid_shares',
    prepaidExpenses: 'cr_curr_prepayments_and_accured_inc',
    otherReceivables: 'cr_curr_other_receivables',
    shortTermReceivablesUnspecified: 'cr_input_short_term_receivables_total',
    shortTermReceivables: 'cr_short_term_receivables_total',
    otherShortTermInvestments: 'cr_other_curr_investments',
    shortTermSharesInGroupCompanies: 'cr_holdings_in_group_member',
    shortTermInvestmentsUnspecified: 'cr_input_cash_equivalents_total',
    shortTermInvestments: 'cr_cash_equivalents_total',
    cash: 'cr_cash_and_bank_deposits',
    totalAssets: 'bs_total_assets',
    shareCapital: 'share_cap',
    sharePremiumReserve: 'cr_share_premium_account',
    revaluationReserve: 'asset_revaluation_res',
    fairValueReserve: 'cr_fair_value_reserve',
    statutoryReserve: 'cr_legal_reserve',
    otherReserves: 'cr_other_reserves',
    unregisteredShareCapital: 'cr_other_restricted_equity',
    // The rest of the equity the filing does not break down.
    otherEquity: 'cr_other_equity',
    retainedEarnings: 'cr_retained_earnings',
    profitForTheYear: 'cr_profit_for_fy',
    // cr_shareholders_equity leaves out the minority interest, which the CV lists above it.
    equity: 'cr_shareholders_equity',
    minorityInterest: 'minorities',
    accumulatedAcceleratedDepreciation: 'cr_cumulative_accelerated_depreciations',
    taxAllocationReserves: 'cr_untaxed_reserves',
    untaxedReservesUnspecified: 'cr_input_appropriations_total',
    untaxedReserves: 'cr_appropriations_total',
    provisions: 'cr_provisions',
    bondLoans: 'cr_non_current_bonds',
    liabilitiesToCreditInstitutions: 'cr_non_current_loans_from_credit_total',
    liabilitiesToGroupCompaniesLongTerm: 'cr_non_current_owed_to_group_member',
    liabilitiesToAssociatesLongTerm: 'cr_non_current_owed_to_participating',
    otherLongTermLiabilities: 'cr_non_current_other_liabilities',
    longTermLiabilitiesUnspecified: 'cr_input_non_current_liabilities_total',
    longTermLiabilities: 'cr_non_current_liabilities_total',
    shortTermBondLoans: 'cr_current_bonds',
    shortTermLiabilitiesToCreditInstitutions: 'cr_current_loans_from_credit_total',
    advancesFromCustomers: 'cr_current_advances_received',
    tradePayables: 'cr_current_trade_creditors',
    billsOfExchange: 'cr_bills_of_exhange',
    liabilitiesToAssociates: 'cr_current_owed_to_participating',
    liabilitiesToGroupCompanies: 'cr_current_owed_to_group_member',
    otherCurrentLiabilities: 'cr_other_current_creditors',
    accruedExpenses: 'cr_current_accruals_and_deferred_income',
    currentLiabilitiesUnspecified: 'cr_input_current_liabilities_total',
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
