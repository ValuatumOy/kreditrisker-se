// Swedish company-data contract, schema version 2.
//
// One CompanyRecord per organisationsnummer. Every figure is a Value: it is
// either reported by a named source, derived by a named formula from other
// values, or explicitly absent with a reason. Absence is never encoded as 0.
// The statement items and key ratios are the rows of the Valuatum company
// view (CV) pages; the comment on each field names its CV variable.
// See docs/DATA-CONTRACT.md for field semantics and the import rules.

import type { Orgnr } from '../orgnr.ts'

export const SCHEMA_VERSION = 3

// ---------------------------------------------------------------- sources

export type SourceId =
    | 'bolagsverket-foretagsinformation' // Värdefulla datamängder: namn, form, adress, SNI
    | 'bolagsverket-arsredovisning' // Digitally filed annual report (iXBRL)
    | 'scb-foretagsregister' // SCB business register
    | 'valuatum-credit-model' // Valuatum model output (Sweden: not yet validated)
    | 'valuatum-rest' // Valuatum REST API (annual-report figures and register data as Valuatum holds them)
    | 'synthetic' // Development fixture, never real

export interface SourceRef {
    source: SourceId
    /** ISO date the data was retrieved from the source. */
    retrievedAt: string
    /** Source-side document id, e.g. the annual report's registration number. */
    documentId?: string
    /** ISO date the source says the fact was registered or filed. */
    registeredAt?: string
}

// ---------------------------------------------------------------- values

export type MissingReason =
    | 'not_filed' // No annual report filed for the period
    | 'not_in_source' // Item is absent from the supplied source data
    | 'not_digitised' // Filed on paper; not machine-readable
    | 'parse_failed' // Source present but could not be parsed reliably
    | 'withheld' // Excluded on purpose (privacy, licence)

export type IncomparableReason =
    | 'period_length' // Fiscal period is not 12 months
    | 'period_gap' // Fiscal periods are not consecutive
    | 'denominator_not_positive' // Ratio base is zero or negative
    | 'framework_change' // K2/K3/IFRS switch between periods
    | 'consolidation_change' // Group vs. entity accounts
    | 'no_prior_period'

export interface ReportedValue<T> {
    status: 'reported'
    value: T
    source: SourceRef
}

export interface DerivedValue {
    status: 'derived'
    value: number
    /** What the value was computed with, e.g. "median" for an industry median. */
    formula: string
    /** Field paths the value was computed from. */
    inputs: string[]
}

export interface MissingValue {
    status: 'missing'
    reason: MissingReason
}

export interface NotApplicableValue {
    status: 'not_applicable'
    note: string
}

export interface IncomparableValue {
    status: 'incomparable'
    reason: IncomparableReason
}

export type Value<T = number> =
    | ReportedValue<T>
    | DerivedValue
    | MissingValue
    | NotApplicableValue
    | IncomparableValue

// ---------------------------------------------------------------- company

export type LegalFormCode =
    | 'AB' // Aktiebolag
    | 'PUBL' // Publikt aktiebolag
    | 'HB' // Handelsbolag
    | 'KB' // Kommanditbolag
    | 'EF' // Enskild näringsidkare (personal data)
    | 'EK' // Ekonomisk förening
    | 'BRF' // Bostadsrättsförening
    | 'IF' // Ideell förening
    | 'ST' // Stiftelse
    | 'FL' // Filial till utländskt bolag
    | 'OTHER'

export type CompanyStatusCode =
    | 'active'
    | 'liquidation'
    | 'bankruptcy'
    | 'reconstruction'
    | 'deregistered'
    | 'unknown'

export interface Municipality {
    /** Four-digit kommunkod from SCB, e.g. "0180" = Stockholm. */
    code: string
    name: string
    county?: string
}

export interface SniCode {
    version: 'SNI2007' | 'SNI2025'
    /** Five-digit code, e.g. "62010". */
    code: string
    label: string
}

export type Currency = 'SEK' | 'EUR'

export type AccountingFramework = 'K2' | 'K3' | 'IFRS' | 'unknown'

/**
 * Amounts are in whole currency units (kronor), not thousands, with the sign
 * the source gives them: costs and other deductions are negative.
 * The items are the rows of the Valuatum company view (CV) statement tables;
 * src/lib/valuatum/map.ts maps each to its CV variable.
 */
export const INCOME_FIELDS = [
    'netSales',
    'changeInInventories',
    'ownWorkCapitalised',
    'otherOperatingIncome',
    'rawMaterialsAndGoods',
    'costOfGoodsSold',
    'sellingExpenses',
    'administrativeExpenses',
    'wagesAndSalaries',
    'socialSecurityCosts',
    'otherOperatingExpenses',
    'shareOfAssociatesResult',
    'ebitda',
    'depreciation',
    'operatingProfit',
    'interestIncome',
    'otherFinancialIncome',
    'interestExpenses',
    'otherFinancialExpenses',
    'incomeFromOtherFinancialAssets',
    'incomeFromGroupCompanies',
    'incomeFromAssociates',
    'financialAssetWriteDowns',
    'profitAfterFinancialItems',
    'changeInAcceleratedDepreciation',
    'changeInUntaxedReserves',
    'groupContributions',
    'incomeTaxes',
    'minorityShareOfProfit',
    'netProfit',
] as const
export type IncomeStatement = Record<(typeof INCOME_FIELDS)[number], Value>

export const BALANCE_FIELDS = [
    'developmentExpenditure',
    'intangibleRights',
    'goodwill',
    'otherIntangibleAssets',
    'intangibleAdvancePayments',
    'intangibleAssetsUnspecified',
    'intangibleAssets',
    'buildingsAndLand',
    'machineryAndEquipment',
    'constructionInProgress',
    'otherTangibleAssets',
    'tangibleAssetsUnspecified',
    'tangibleAssets',
    'sharesInGroupCompanies',
    'sharesInAssociates',
    'otherShareholdings',
    'receivablesFromGroupCompaniesLongTerm',
    'receivablesFromAssociatesLongTerm',
    'otherLongTermSecurities',
    'otherLongTermReceivables',
    'financialAssetsUnspecified',
    'financialAssets',
    'deferredTaxAssets',
    'longTermReceivablesUnspecified',
    'longTermReceivables',
    'rawMaterials',
    'workInProgress',
    'otherInventories',
    'finishedGoods',
    'advancesToSuppliers',
    'inventoriesUnspecified',
    'inventories',
    'tradeReceivables',
    'receivablesFromGroupCompanies',
    'receivablesFromAssociates',
    'unpaidShareCapital',
    'prepaidExpenses',
    'otherReceivables',
    'shortTermReceivablesUnspecified',
    'shortTermReceivables',
    'otherShortTermInvestments',
    'shortTermSharesInGroupCompanies',
    'shortTermInvestmentsUnspecified',
    'shortTermInvestments',
    'cash',
    'totalAssets',
    'shareCapital',
    'sharePremiumReserve',
    'revaluationReserve',
    'fairValueReserve',
    'statutoryReserve',
    'otherReserves',
    'unregisteredShareCapital',
    'otherEquity',
    'retainedEarnings',
    'profitForTheYear',
    'equity',
    'minorityInterest',
    'accumulatedAcceleratedDepreciation',
    'taxAllocationReserves',
    'untaxedReservesUnspecified',
    'untaxedReserves',
    'provisions',
    'bondLoans',
    'liabilitiesToCreditInstitutions',
    'liabilitiesToGroupCompaniesLongTerm',
    'liabilitiesToAssociatesLongTerm',
    'otherLongTermLiabilities',
    'longTermLiabilitiesUnspecified',
    'longTermLiabilities',
    'shortTermBondLoans',
    'shortTermLiabilitiesToCreditInstitutions',
    'advancesFromCustomers',
    'tradePayables',
    'billsOfExchange',
    'liabilitiesToAssociates',
    'liabilitiesToGroupCompanies',
    'otherCurrentLiabilities',
    'accruedExpenses',
    'currentLiabilitiesUnspecified',
    'currentLiabilities',
    'totalEquityAndLiabilities',
] as const
export type BalanceSheet = Record<(typeof BALANCE_FIELDS)[number], Value>

/** Key ratios as fractions (0.25 = 25 %); kassalikviditet is a ratio (1.5 = 150 %). */
export interface KeyRatios {
    revenueGrowth: Value // ns_growth
    operatingMargin: Value // ebit_percent
    profitMargin: Value // cr_pre_tax_profit_less_eo_percent
    equityRatio: Value // cr_equity_ratio
    quickRatio: Value // cr_quick_ratio
    returnOnEquity: Value // cr_roe_percent_corrected
}

export type RatioKey = keyof KeyRatios

export interface FiscalPeriod {
    /** ISO dates, inclusive. */
    start: string
    end: string
    /** Length in whole months (12 for a normal year; 1-18 allowed by law). */
    months: number
    currency: Currency
    consolidated: boolean
    framework: AccountingFramework
    /** ISO date the annual report was registered at Bolagsverket. */
    filedAt?: string
    source: SourceRef
    income: IncomeStatement
    balance: BalanceSheet
    ratios: KeyRatios
    employees: Value // cr_employees_adjusted
}

/** Output of a credit model. Displayed only when validated for Sweden. */
export interface CreditModelOutput {
    modelId: string
    modelVersion: string
    generatedAt: string
    /** Period end of the financial statements the model used. */
    inputsPeriodEnd: string
    horizonMonths: number
    score: number
    scale: { min: number; max: number; higherIsBetter: boolean }
    riskClass?: string
    probabilityOfDefault?: number
    /** Sign-off by the Swedish model owner. Without it, nothing is shown. */
    validation?: {
        validatedForSweden: true
        approvedBy: string
        approvedAt: string
        methodologyUrl: string
    }
    source: SourceRef
}

export interface CompanyRecord {
    schemaVersion: typeof SCHEMA_VERSION
    orgnr: Orgnr
    /** True only for development fixtures. Synthetic records are never indexed. */
    synthetic: boolean
    name: string
    formerNames: { name: string; until?: string }[]
    legalForm: LegalFormCode
    status: { code: CompanyStatusCode; since?: string; source: SourceRef }
    registeredAt?: string
    municipality?: Municipality
    /** Primary code first. */
    sni: SniCode[]
    businessDescription?: ReportedValue<string>
    /** Newest first. */
    periods: FiscalPeriod[]
    model?: CreditModelOutput
    provenance: {
        batchId: string
        importedAt: string
        sources: SourceRef[]
    }
}

// ---------------------------------------------------------------- derived

export type Freshness = 'current' | 'aging' | 'stale' | 'none'

export interface PublishedCompany {
    record: CompanyRecord
    slug: string
    path: string
    /** Previous paths that must redirect here (name changes). */
    redirectsFrom: string[]
    freshness: Freshness
    quality: QualityVerdict
}

export interface QualityVerdict {
    indexable: boolean
    /** Content passes the threshold (synthetic flag ignored). Used for rankings in previews. */
    meetsThreshold: boolean
    /** Page is generated at all (false for sole traders when disabled). */
    publishable: boolean
    score: number
    reasons: string[]
}
