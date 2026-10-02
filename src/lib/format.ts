// Presentation of values in Swedish. Every Value renders to a Display that
// keeps its state, so templates can never show a missing figure as 0.

import type { Freshness, IncomparableReason, MissingReason, Value } from './contract/types.ts'

export type DisplayState = 'positive' | 'zero' | 'negative' | 'missing' | 'not_applicable' | 'incomparable'

export interface Display {
    text: string
    state: DisplayState
    /** Explanation for tooltips and footnotes. */
    note?: string
}

const nf = (digits: number) => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: digits, maximumFractionDigits: digits })

export const MISSING_TEXT: Record<MissingReason, string> = {
    not_filed: 'Inget bokslut har lämnats för perioden.',
    not_in_source: 'Posten finns inte i det inlämnade bokslutet.',
    not_digitised: 'Bokslutet är inte digitalt inlämnat och har inte kunnat läsas.',
    parse_failed: 'Uppgiften kunde inte läsas tillförlitligt ur källan.',
    withheld: 'Uppgiften visas inte.',
}

export const INCOMPARABLE_TEXT: Record<IncomparableReason, string> = {
    period_length: 'Räkenskapsåret är inte 12 månader, så jämförelsen blir missvisande.',
    denominator_not_positive: 'Går inte att räkna eftersom nämnaren är noll eller negativ.',
    framework_change: 'Redovisningsregelverket har bytts mellan åren.',
    consolidation_change: 'Jämförelsen blandar koncern- och moderbolagssiffror.',
    no_prior_period: 'Det finns inget tidigare år att jämföra med.',
}

function absent(v: Value): Display | null {
    if (v.status === 'missing') return { text: 'saknas', state: 'missing', note: MISSING_TEXT[v.reason] }
    if (v.status === 'not_applicable') return { text: 'ej tillämpligt', state: 'not_applicable', note: v.note }
    if (v.status === 'incomparable') return { text: 'ej jämförbar', state: 'incomparable', note: INCOMPARABLE_TEXT[v.reason] }
    return null
}

const sign = (n: number): DisplayState => (n === 0 ? 'zero' : n < 0 ? 'negative' : 'positive')

/** Amount in kronor, shown in tkr (thousands) as in Swedish annual reports. */
export function tkr(v: Value): Display {
    const a = absent(v)
    if (a) return a
    const n = (v as { value: number }).value
    return { text: nf(0).format(Math.round(n / 1000)), state: sign(n) }
}

/** Compact amount for headlines: "30,2 Mkr", "412 tkr", "0 kr". */
export function compactSek(v: Value): Display {
    const a = absent(v)
    if (a) return a
    const n = (v as { value: number }).value
    const abs = Math.abs(n)
    const text =
        abs >= 1e9 ? `${nf(1).format(n / 1e9)} mdkr` : abs >= 1e6 ? `${nf(1).format(n / 1e6)} Mkr` : abs >= 1e3 ? `${nf(0).format(n / 1e3)} tkr` : `${nf(0).format(n)} kr`
    return { text, state: sign(n) }
}

export function percent(v: Value, digits = 1): Display {
    const a = absent(v)
    if (a) return a
    const n = (v as { value: number }).value
    return { text: `${nf(digits).format(n * 100)} %`, state: sign(n) }
}

export function count(v: Value): Display {
    const a = absent(v)
    if (a) return a
    const n = (v as { value: number }).value
    return { text: nf(0).format(n), state: sign(n) }
}

const months = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec']
export function date(iso: string): string {
    const [y, m, d] = iso.split('-').map(Number)
    return `${d} ${months[m - 1]} ${y}`
}

export function periodLabel(p: { start: string; end: string; months: number }): string {
    const sameYear = p.start.slice(0, 4) === p.end.slice(0, 4)
    if (p.months === 12 && p.start.endsWith('-01-01')) return p.end.slice(0, 4)
    return sameYear ? p.end.slice(0, 4) : `${p.start.slice(0, 4)}/${p.end.slice(2, 4)}`
}

export const FRESHNESS_TEXT: Record<Freshness, { label: string; note: string }> = {
    current: { label: 'Aktuellt', note: 'Senaste bokslutet är det nyaste som enligt lag borde finnas.' },
    aging: { label: 'Äldre bokslut', note: 'Ett nyare bokslut borde ha lämnats in men finns inte i källan.' },
    stale: { label: 'Inaktuellt', note: 'Senaste bokslutet är mer än 31 månader gammalt. Siffrorna speglar inte nuläget.' },
    none: { label: 'Inget bokslut', note: 'Det finns inget inlämnat bokslut i källan.' },
}

export const STATUS_TEXT: Record<string, string> = {
    active: 'Aktivt',
    liquidation: 'I likvidation',
    bankruptcy: 'Konkurs',
    reconstruction: 'Företagsrekonstruktion',
    deregistered: 'Avregistrerat',
    unknown: 'Okänd status',
}

export const LEGAL_FORM_TEXT: Record<string, string> = {
    AB: 'Aktiebolag',
    PUBL: 'Publikt aktiebolag',
    HB: 'Handelsbolag',
    KB: 'Kommanditbolag',
    EF: 'Enskild näringsidkare',
    EK: 'Ekonomisk förening',
    BRF: 'Bostadsrättsförening',
    IF: 'Ideell förening',
    ST: 'Stiftelse',
    FL: 'Filial',
    OTHER: 'Övrig företagsform',
}

export const SOURCE_TEXT: Record<string, string> = {
    'bolagsverket-foretagsinformation': 'Bolagsverket, företagsinformation',
    'bolagsverket-arsredovisning': 'Bolagsverket, digital årsredovisning',
    'scb-foretagsregister': 'SCB, företagsregistret',
    'valuatum-credit-model': 'Valuatum, kreditriskmodell',
    'valuatum-rest': 'Valuatum, bokslutsdatabas',
    synthetic: 'Syntetiska testdata',
}

/** "Umeå kommun", "Göteborgs kommun", "Västerås kommun". */
export function kommunName(name: string): string {
    return /[aeiouyåäös]$/i.test(name) ? `${name} kommun` : `${name}s kommun`
}
