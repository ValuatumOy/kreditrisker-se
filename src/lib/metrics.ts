// Key ratios (nyckeltal). The values are the Valuatum company view (CV) ratio
// variables as the REST API returns them; nothing is computed here, so the
// site, the CV pages and the reports show the same figures. The definitions
// below describe the CV formulas (sweden-db DYNAMICVARIABLE, checked
// 2026-10-12) for /metod/. A ratio the source leaves out is missing.

import type { FiscalPeriod, KeyRatios, RatioKey, Value } from './contract/types.ts'

export interface FormulaDef {
    /** The CV variable the value comes from. */
    id: string
    label: string
    unit: 'percent' | 'ratio'
    formula: string
    explanation: string
}

export const FORMULAS: Record<MetricKey, FormulaDef> = {
    revenueGrowth: {
        id: 'ns_growth',
        label: 'Omsättningstillväxt',
        unit: 'percent',
        formula: '(Nettoomsättning år t / Nettoomsättning år t−1) − 1',
        explanation: 'Förändringen i nettoomsättning mot föregående räkenskapsår.',
    },
    operatingMargin: {
        id: 'ebit_percent',
        label: 'Rörelsemarginal',
        unit: 'percent',
        formula: 'Rörelseresultat / Nettoomsättning',
        explanation: 'Visar hur stor del av omsättningen som blir kvar efter rörelsens kostnader.',
    },
    profitMargin: {
        id: 'cr_pre_tax_profit_less_eo_percent',
        label: 'Vinstmarginal',
        unit: 'percent',
        formula: 'Resultat efter finansiella poster / Nettoomsättning',
        explanation: 'Som rörelsemarginalen, men efter räntor och andra finansiella poster.',
    },
    equityRatio: {
        id: 'cr_equity_ratio',
        label: 'Soliditet',
        unit: 'percent',
        formula: '(Eget kapital + obeskattade reserver) / (Summa eget kapital och skulder − förskott från kunder)',
        explanation:
            'Obeskattade reserver räknas i sin helhet som eget kapital. Förskott från kunder räknas bort från balansomslutningen. Är det egna kapitalet negativt består nämnaren bara av skulderna och avsättningarna.',
    },
    quickRatio: {
        id: 'cr_quick_ratio',
        label: 'Kassalikviditet',
        unit: 'ratio',
        formula: '(Kortfristiga fordringar + kassa, bank och kortfristiga placeringar) / (Kortfristiga skulder − förskott från kunder)',
        explanation: 'Förmåga att betala kortfristiga skulder med likvida tillgångar. Varulager räknas inte som likvida. Kring 100 % brukar ses som balans.',
    },
    returnOnEquity: {
        id: 'cr_roe_percent_corrected',
        label: 'Avkastning på eget kapital',
        unit: 'percent',
        formula: 'Årets resultat / Genomsnittligt eget kapital',
        explanation:
            'Genomsnittet av ingående och utgående eget kapital, utan minoritetsintresse. Är det egna kapitalet negativt används balansomslutningen. För det första året, som saknar ingående balans, halveras värdet.',
    },
}

export type MetricKey = RatioKey

export type Metrics = KeyRatios

/** The period's key ratios. */
export function metricsOf(p: FiscalPeriod): Metrics {
    return p.ratios
}

/** True when prior is the fiscal year directly before p (for year-on-year changes). */
export function periodsConsecutive(p: FiscalPeriod, prior?: FiscalPeriod): boolean {
    return !!prior && p.start === new Date(Date.parse(prior.end + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)
}

/** Numeric value if usable, else undefined. For charts and rankings only. */
export function numeric(v: Value | undefined): number | undefined {
    return v && (v.status === 'reported' || v.status === 'derived') ? v.value : undefined
}
