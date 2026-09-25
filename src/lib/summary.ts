// Factual profile summary built only from values that exist. It describes;
// it never judges (no "healthy", "risky", "strong").

import type { PublishedCompany } from './contract/types.ts'
import { compactSek, count, kommunName, LEGAL_FORM_TEXT, percent, periodLabel, STATUS_TEXT } from './format.ts'
import { computeMetrics } from './metrics.ts'

export function summarize(c: PublishedCompany): string[] {
    const r = c.record
    const out: string[] = []
    const form = LEGAL_FORM_TEXT[r.legalForm].toLowerCase()
    const where = r.municipality ? ` i ${kommunName(r.municipality.name)}` : ''
    const what = r.sni[0] ? ` med verksamhet inom ${r.sni[0].label.toLowerCase()} (SNI ${r.sni[0].code})` : ''
    out.push(`${r.name} är ${form === 'aktiebolag' || form === 'handelsbolag' || form === 'kommanditbolag' ? 'ett' : 'en'} ${form}${where}${what}.`)
    if (r.status.code !== 'active' && r.status.code !== 'unknown') out.push(`Registrerad status: ${STATUS_TEXT[r.status.code].toLowerCase()}.`)

    const [p, prior] = r.periods
    if (!p) {
        out.push('Företaget har inget inlämnat bokslut i källan ännu.')
        return out
    }
    const m = computeMetrics(p, prior)
    const year = periodLabel(p)
    const sales = compactSek(p.income.netSales)
    const ebit = compactSek(p.income.operatingProfit)
    const parts: string[] = []
    if (sales.state !== 'missing' && sales.state !== 'not_applicable') {
        let s = `nettoomsättningen ${sales.text}`
        const g = percent(m.revenueGrowth)
        if (g.state === 'positive') s += `, en ökning med ${g.text} från året innan`
        else if (g.state === 'negative') s += `, en minskning med ${g.text.replace('−', '')} från året innan`
        parts.push(s)
    }
    if (ebit.state !== 'missing' && ebit.state !== 'not_applicable') parts.push(`rörelseresultatet ${ebit.text}`)
    const lead = p.months === 12 ? `Räkenskapsåret ${year}` : `Räkenskapsåret ${year} (${p.months} månader)`
    if (parts.length) out.push(`${lead} var ${parts.join(' och ')}.`)
    const eq = percent(m.equityRatio)
    if (eq.state === 'positive' || eq.state === 'negative' || eq.state === 'zero') out.push(`Soliditeten var ${eq.text}.`)
    const emp = count(p.employees)
    if (emp.state === 'positive') out.push(`Medelantalet anställda var ${emp.text}.`)
    if (c.freshness === 'stale' || c.freshness === 'aging')
        out.push(`Det senaste bokslutet i källan avser ${year}; nyare siffror finns inte.`)
    return out
}
