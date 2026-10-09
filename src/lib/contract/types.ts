// Swedish company-data contract, schema version 1.
//
// One CompanyRecord per organisationsnummer. Every figure is a Value: it is
// either reported by a named source, derived by a named formula from other
// values, or explicitly absent with a reason. Absence is never encoded as 0.
// See docs/DATA-CONTRACT.md for field semantics and the import rules.

import type { Orgnr } from '../orgnr.ts'

export const SCHEMA_VERSION = 1

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
    /** Formula id from src/lib/metrics.ts, e.g. "soliditet.v1". */
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

/** Amounts are in whole currency units (kronor), not thousands. */
export interface IncomeStatement {
    netSales: Value // Nettoomsättning
    operatingProfit: Value // Rörelseresultat
    financialNet: Value // Finansnetto
    profitAfterFinancialItems: Value // Resultat efter finansiella poster
    netProfit: Value // Årets resultat
    personnelCosts: Value // Personalkostnader
}

export interface BalanceSheet {
    totalAssets: Value // Summa tillgångar
    equity: Value // Eget kapital
    untaxedReserves: Value // Obeskattade reserver
    inventories: Value // Varulager
    cash: Value // Kassa och bank
    currentAssets: Value // Summa omsättningstillgångar
    currentLiabilities: Value // Kortfristiga skulder
    longTermLiabilities: Value // Långfristiga skulder
}

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
    employees: Value // Medelantal anställda
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
