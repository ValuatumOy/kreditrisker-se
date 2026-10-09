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
    // pre_tax_profit is after bokslutsdispositioner, so it cannot substitute this line.
    profitAfterFinancialItems: ['cr_pre_tax_profit'],
    netProfit: ['cr_net_earnings', 'net_earnings'],
    personnelCosts: ['fundu_personnel_expenses', 'cr_employee_expenses'],
    totalAssets: ['bs_total_assets'],
    equity: ['cr_shareholders_equity'],
    untaxedReserves: ['cr_appropriations_total'],
    inventories: ['cr_inventory', 'inventories'],
    cash: ['cr_cash_and_cash_eq_total', 'cr_cash_and_bank_deposits'],
    // cr_current_assets_total leaves the receivables out; the IFRS total is the whole sum.
    currentAssets: ['cr_ifrs_current_assets_total'],
    currentLiabilities: ['cr_current_liabilities_total'],
    longTermLiabilities: ['cr_non_current_liabilities_total'],
    employees: ['cr_employees'],
} as const
const PERIOD_MONTHS = 'cr_fiscal_period_length'
/** Period end as a number, e.g. 20251231. */
const PERIOD_END = 'cr_fiscal_year_end'
/** Every variable the mapper reads; the API cache keeps only these. */
export const USED_VARS = new Set<string>([...Object.values(VARS).flat(), PERIOD_MONTHS, PERIOD_END])

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
        // Without an end date the year is assumed to end in December.
        const endText = String(get([PERIOD_END]) ?? '')
        const end = /^\d{8}$/.test(endText) ? `${endText.slice(0, 4)}-${endText.slice(4, 6)}-${endText.slice(6)}` : `${y}-12-31`
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
    // The tree node's Swedish name without its code prefix ("24.330 ").
    const sniNode = company.industryTree?.nace === company.industryCode ? company.industryTree : undefined
    const sniLabel = sniNode?.name?.sv?.replace(/^[\d.]+\s+/, '')
    const record: CompanyRecord = {
        schemaVersion: 1,
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
