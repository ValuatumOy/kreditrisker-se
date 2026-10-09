// Derived key ratios (nyckeltal). Each formula has a versioned id that is
// stored on the derived value and explained on /metod/.
//
// Rules:
// - Any missing / not-applicable input -> the ratio is missing (reason of the
//   first unusable input), never 0.
// - A zero or negative denominator -> incomparable ('denominator_not_positive').
// - Growth needs two consecutive 12-month periods with the same consolidation
//   and accounting framework; otherwise incomparable.

import type {
    BalanceSheet,
    FiscalPeriod,
    IncomeStatement,
    MissingValue,
    Value,
} from './contract/types.ts'

/** Swedish corporate tax 20.6 % since 2021: equity share of untaxed reserves. */
export const UNTAXED_RESERVE_EQUITY_SHARE = 1 - 0.206

export interface FormulaDef {
    id: string
    label: string
    unit: 'percent' | 'ratio'
    formula: string
    explanation: string
}

export const FORMULAS: Record<MetricKey, FormulaDef> = {
    revenueGrowth: {
        id: 'omsattningstillvaxt.v1',
        label: 'Omsättningstillväxt',
        unit: 'percent',
        formula: '(Nettoomsättning år t / Nettoomsättning år t−1) − 1',
        explanation:
            'Räknas bara mellan två på varandra följande räkenskapsår på 12 månader med samma redovisningsregelverk och koncernstatus.',
    },
    operatingMargin: {
        id: 'rorelsemarginal.v1',
        label: 'Rörelsemarginal',
        unit: 'percent',
        formula: 'Rörelseresultat / Nettoomsättning',
        explanation: 'Visar hur stor del av omsättningen som blir kvar efter rörelsens kostnader.',
    },
    profitMargin: {
        id: 'vinstmarginal.v1',
        label: 'Vinstmarginal',
        unit: 'percent',
        formula: 'Resultat efter finansiella poster / Nettoomsättning',
        explanation: 'Som rörelsemarginalen, men efter räntor och andra finansiella poster.',
    },
    equityRatio: {
        id: 'soliditet.v1',
        label: 'Soliditet',
        unit: 'percent',
        formula: '(Eget kapital + 79,4 % av obeskattade reserver) / Summa tillgångar',
        explanation:
            'Andel av tillgångarna som finansieras med justerat eget kapital. Obeskattade reserver räknas in efter avdrag för latent skatt (20,6 %). Har balansräkningen ingen post för obeskattade reserver räknas de som noll; är balansräkningen ofullständig visas ingen soliditet.',
    },
    quickRatio: {
        id: 'kassalikviditet.v1',
        label: 'Kassalikviditet',
        unit: 'percent',
        formula: '(Omsättningstillgångar − Varulager) / Kortfristiga skulder',
        explanation: 'Förmåga att betala kortfristiga skulder med likvida tillgångar. Kring 100 % brukar ses som balans.',
    },
    returnOnEquity: {
        id: 'avkastning-eget-kapital.v1',
        label: 'Avkastning på eget kapital',
        unit: 'percent',
        formula: 'Årets resultat / Eget kapital',
        explanation: 'Räknas inte när eget kapital är noll eller negativt.',
    },
}

export type MetricKey =
    | 'revenueGrowth'
    | 'operatingMargin'
    | 'profitMargin'
    | 'equityRatio'
    | 'quickRatio'
    | 'returnOnEquity'

export type Metrics = Record<MetricKey, Value>

type Numeric = { ok: true; value: number } | { ok: false; out: Value }

function num(v: Value): Numeric {
    if (v.status === 'reported' || v.status === 'derived') return { ok: true, value: v.value }
    if (v.status === 'missing') return { ok: false, out: v }
    if (v.status === 'incomparable') return { ok: false, out: v }
    return { ok: false, out: { status: 'missing', reason: 'not_in_source' } satisfies MissingValue }
}

function ratio(
    key: MetricKey,
    top: [string, Value],
    bottom: [string, Value],
    transformTop: (n: number) => number = (n) => n,
): Value {
    const a = num(top[1])
    if (!a.ok) return a.out
    const b = num(bottom[1])
    if (!b.ok) return b.out
    if (b.value <= 0) return { status: 'incomparable', reason: 'denominator_not_positive' }
    return {
        status: 'derived',
        value: transformTop(a.value) / b.value,
        formula: FORMULAS[key].id,
        inputs: [top[0], bottom[0]],
    }
}

const inc = (p: FiscalPeriod, k: keyof IncomeStatement): [string, Value] => [`income.${k}`, p.income[k]]
const bal = (p: FiscalPeriod, k: keyof BalanceSheet): [string, Value] => [`balance.${k}`, p.balance[k]]

export function computeMetrics(p: FiscalPeriod, prior?: FiscalPeriod): Metrics {
    return {
        revenueGrowth: growth(p, prior),
        operatingMargin: ratio('operatingMargin', inc(p, 'operatingProfit'), inc(p, 'netSales')),
        profitMargin: ratio('profitMargin', inc(p, 'profitAfterFinancialItems'), inc(p, 'netSales')),
        equityRatio: equityRatio(p),
        quickRatio: quickRatio(p),
        returnOnEquity: ratio('returnOnEquity', inc(p, 'netProfit'), bal(p, 'equity')),
    }
}

export function periodsConsecutive(p: FiscalPeriod, prior?: FiscalPeriod): boolean {
    return !!prior && p.start === new Date(Date.parse(prior.end + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10)
}

function growth(p: FiscalPeriod, prior?: FiscalPeriod): Value {
    if (!prior) return { status: 'incomparable', reason: 'no_prior_period' }
    if (p.months !== 12 || prior.months !== 12) return { status: 'incomparable', reason: 'period_length' }
    if (!periodsConsecutive(p, prior)) return { status: 'incomparable', reason: 'period_gap' }
    if (p.consolidated !== prior.consolidated) return { status: 'incomparable', reason: 'consolidation_change' }
    if (p.framework !== prior.framework && p.framework !== 'unknown' && prior.framework !== 'unknown')
        return { status: 'incomparable', reason: 'framework_change' }
    const r = ratio('revenueGrowth', ['income.netSales', p.income.netSales], ['prior.income.netSales', prior.income.netSales])
    if (r.status !== 'derived') return r
    return { ...r, value: r.value - 1 }
}

function equityRatio(p: FiscalPeriod): Value {
    const eq = num(p.balance.equity)
    if (!eq.ok) return eq.out
    const ur = num(p.balance.untaxedReserves)
    if (!ur.ok) return ur.out
    return ratio(
        'equityRatio',
        ['balance.equity+untaxedReserves', { status: 'derived', value: eq.value + UNTAXED_RESERVE_EQUITY_SHARE * ur.value, formula: 'justerat-eget-kapital.v1', inputs: [] }],
        bal(p, 'totalAssets'),
    )
}

function quickRatio(p: FiscalPeriod): Value {
    const ca = num(p.balance.currentAssets)
    if (!ca.ok) return ca.out
    const invent = num(p.balance.inventories)
    if (!invent.ok) return invent.out
    return ratio(
        'quickRatio',
        ['balance.currentAssets-inventories', { status: 'derived', value: ca.value - invent.value, formula: 'likvida-tillgangar.v1', inputs: [] }],
        bal(p, 'currentLiabilities'),
    )
}

/** Numeric value if usable, else undefined. For charts and rankings only. */
export function numeric(v: Value | undefined): number | undefined {
    return v && (v.status === 'reported' || v.status === 'derived') ? v.value : undefined
}
