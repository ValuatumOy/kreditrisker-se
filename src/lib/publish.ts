// Turns a release into everything the pages need: canonical paths, redirects,
// quality verdicts, hubs and rankings. Pure; no IO.

import { FLAGS, SITE } from '../config/site.ts'
import type { CompanyRecord, PublishedCompany } from './contract/types.ts'
import { freshnessOf } from './freshness.ts'
import { computeMetrics, numeric, type MetricKey } from './metrics.ts'
import type { Release } from './pipeline.ts'
import { assessQuality } from './quality.ts'
import { slugify } from './slug.ts'

export const companyPath = (orgnr: string, slug: string) => `/foretag/${orgnr}/${slug}/`

/** A hub page is indexable only with at least this many indexable profiles. */
export const MIN_HUB_COMPANIES = 3
/** Rankings list only indexable profiles, and need at least this many entries. */
export const MIN_RANKING_ENTRIES = 3

export interface Hub {
    kind: 'bransch' | 'kommun'
    slug: string
    name: string
    code: string
    detail?: string
    companies: PublishedCompany[]
    indexable: boolean
    /** Enough threshold-passing profiles to be a useful page (ignores synthetic flag). */
    substantial: boolean
}

export interface Ranking {
    slug: string
    title: string
    metric: 'netSales' | MetricKey
    description: string
    rule: string
    entries: { company: PublishedCompany; value: number; periodEnd: string }[]
}

export interface Site {
    companies: PublishedCompany[]
    byOrgnr: Map<string, PublishedCompany>
    redirects: { from: string; to: string }[]
    industries: Hub[]
    municipalities: Hub[]
    rankings: Ranking[]
    releaseId: string
    synthetic: boolean
}

export function publishCompany(record: CompanyRecord, slugHistory: string[] | undefined, asOf: string): PublishedCompany {
    const slug = slugify(record.name)
    const path = companyPath(record.orgnr, slug)
    const old = new Set([...(slugHistory ?? []), ...record.formerNames.map((f) => slugify(f.name))])
    old.delete(slug)
    const freshness = freshnessOf(record, asOf)
    return {
        record,
        slug,
        path,
        redirectsFrom: [...old].map((s) => companyPath(record.orgnr, s)),
        freshness,
        quality: assessQuality(record, freshness, { publishSoleTraders: FLAGS.publishSoleTraders }),
    }
}

function hubs(kind: Hub['kind'], companies: PublishedCompany[]): Hub[] {
    const groups = new Map<string, Hub>()
    for (const c of companies) {
        const key =
            kind === 'bransch'
                ? c.record.sni[0] && { code: c.record.sni[0].code, name: c.record.sni[0].label, detail: c.record.sni[0].version }
                : c.record.municipality && { code: c.record.municipality.code, name: c.record.municipality.name, detail: c.record.municipality.county }
        if (!key) continue
        const slug = kind === 'bransch' ? `${key.code}-${slugify(key.name)}` : slugify(key.name)
        const hub = groups.get(slug) ?? { kind, slug, name: key.name, code: key.code, detail: key.detail, companies: [], indexable: false, substantial: false }
        hub.companies.push(c)
        groups.set(slug, hub)
    }
    for (const h of groups.values()) {
        h.companies.sort((a, b) => (numeric(b.record.periods[0]?.income.netSales) ?? -1) - (numeric(a.record.periods[0]?.income.netSales) ?? -1) || a.record.name.localeCompare(b.record.name, 'sv'))
        h.indexable = h.companies.filter((c) => c.quality.indexable).length >= MIN_HUB_COMPANIES
        h.substantial = h.companies.filter((c) => c.quality.meetsThreshold).length >= MIN_HUB_COMPANIES
    }
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'))
}

const RANKINGS: Omit<Ranking, 'entries'>[] = [
    {
        slug: 'storst-omsattning',
        title: 'Störst omsättning',
        metric: 'netSales',
        description: 'Företagen med högst nettoomsättning i sitt senaste bokslut.',
        rule: 'Senaste bokslut, 12 månader, inte äldre än 19 månader. Koncernbokslut räknas separat från moderbolag.',
    },
    {
        slug: 'snabbast-vaxande',
        title: 'Snabbast växande',
        metric: 'revenueGrowth',
        description: 'Högst omsättningstillväxt mellan de två senaste jämförbara räkenskapsåren.',
        rule: 'Kräver två på varandra följande 12-månadersår och minst 5 Mkr i omsättning det tidigare året.',
    },
    {
        slug: 'hogst-soliditet',
        title: 'Högst soliditet',
        metric: 'equityRatio',
        description: 'Störst andel justerat eget kapital av totala tillgångar.',
        rule: 'Senaste bokslut, minst 5 Mkr i nettoomsättning, så att vilande bolag inte dominerar listan.',
    },
    {
        slug: 'hogst-rorelsemarginal',
        title: 'Högst rörelsemarginal',
        metric: 'operatingMargin',
        description: 'Störst rörelseresultat i förhållande till nettoomsättningen.',
        rule: 'Senaste bokslut, 12 månader, minst 5 Mkr i nettoomsättning.',
    },
]

function rankings(companies: PublishedCompany[]): Ranking[] {
    const eligible = companies.filter((c) => c.quality.meetsThreshold && c.freshness === 'current' && c.record.periods[0]?.months === 12)
    return RANKINGS.map((def) => {
        const entries = eligible
            .map((company) => {
                const [p, prior] = company.record.periods
                const sales = numeric(p.income.netSales)
                if (def.metric === 'netSales') return sales === undefined ? null : { company, value: sales, periodEnd: p.end }
                if (def.metric === 'revenueGrowth' && (numeric(prior?.income.netSales) ?? 0) < 5_000_000) return null
                if (def.metric !== 'revenueGrowth' && (sales ?? 0) < 5_000_000) return null
                const value = numeric(computeMetrics(p, prior)[def.metric])
                return value === undefined ? null : { company, value, periodEnd: p.end }
            })
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .sort((a, b) => b.value - a.value)
            .slice(0, 50)
        return { ...def, entries }
    })
}

export function buildSite(release: Release, asOf: string = SITE.asOf): Site {
    const companies = release.companies
        .map((r) => publishCompany(r, release.slugHistory[r.orgnr], asOf))
        .filter((c) => c.quality.publishable)
        .sort((a, b) => a.record.name.localeCompare(b.record.name, 'sv'))
    const redirects = companies.flatMap((c) => [
        ...c.redirectsFrom.map((from) => ({ from, to: c.path })),
        { from: `/foretag/${c.record.orgnr}/`, to: c.path },
    ])
    return {
        companies,
        byOrgnr: new Map(companies.map((c) => [c.record.orgnr as string, c])),
        redirects,
        industries: hubs('bransch', companies),
        municipalities: hubs('kommun', companies),
        rankings: rankings(companies),
        releaseId: release.manifest.releaseId,
        synthetic: release.companies.some((c) => c.synthetic),
    }
}

/** Companies in the same industry, then same municipality, for internal links. */
export function relatedCompanies(site: Site, c: PublishedCompany, limit = 6): PublishedCompany[] {
    const sni = c.record.sni[0]?.code
    const kommun = c.record.municipality?.code
    const pick = (f: (x: PublishedCompany) => boolean) => site.companies.filter((x) => x !== c && f(x))
    const out = [...pick((x) => x.record.sni[0]?.code === sni), ...pick((x) => x.record.municipality?.code === kommun && x.record.sni[0]?.code !== sni)]
    return out.slice(0, limit)
}
