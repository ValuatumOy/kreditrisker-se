// Turns a release into everything the pages need: canonical paths, redirects,
// quality verdicts, hubs and rankings. Pure; no IO.

import { FLAGS, SITE } from '../config/site.ts'
import type { CompanyRecord, CompanyStatusCode, Freshness, Municipality, PublishedCompany, SniCode } from './contract/types.ts'
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

/**
 * One slim line per company in the whole directory. Hubs, rankings, sitemaps,
 * search and related links are built from these, so a partial build (only the
 * companies that changed, as on the Finnish and Danish sites) still lists every
 * company. Full records are needed only for the pages being built.
 */
export interface IndexRow {
    /** orgnr */
    o: string
    /** name, former names */
    n: string
    f?: string
    /** canonical path, and old paths that redirect to it */
    p: string
    rf: string[]
    st: CompanyStatusCode
    k?: Municipality
    s?: SniCode
    fr: Freshness
    /** indexable, meets content threshold, synthetic */
    ix: boolean
    q: boolean
    syn: boolean
    /** newest period */
    per?: { start: string; end: string; months: number; filedAt?: string }
    /** newest-period figures: net sales (and prior year), employees */
    ns?: number
    nsp?: number
    emp?: number
    /** metrics: operating margin, equity ratio, revenue growth (fractions) */
    om?: number
    er?: number
    rg?: number
    /** import date, for sitemap lastmod */
    im: string
}

export function toRow(c: PublishedCompany): IndexRow {
    const r = c.record
    const [p, prior] = r.periods
    const row: IndexRow = { o: r.orgnr, n: r.name, p: c.path, rf: c.redirectsFrom, st: r.status.code, fr: c.freshness, ix: c.quality.indexable, q: c.quality.meetsThreshold, syn: r.synthetic, im: r.provenance.importedAt.slice(0, 10) }
    if (r.formerNames.length) row.f = r.formerNames.map((x) => x.name).join(' ')
    if (r.municipality) row.k = r.municipality
    if (r.sni[0]) row.s = r.sni[0]
    if (p) {
        const m = computeMetrics(p, prior)
        row.per = { start: p.start, end: p.end, months: p.months, ...(p.filedAt ? { filedAt: p.filedAt } : {}) }
        row.ns = numeric(p.income.netSales)
        row.nsp = numeric(prior?.income.netSales)
        row.emp = numeric(p.employees)
        row.om = numeric(m.operatingMargin)
        row.er = numeric(m.equityRatio)
        row.rg = numeric(m.revenueGrowth)
    }
    return JSON.parse(JSON.stringify(row)) // drop undefined keys
}

export interface Hub {
    kind: 'bransch' | 'kommun'
    slug: string
    name: string
    code: string
    detail?: string
    /** Every company in the hub, largest net sales first. */
    companies: IndexRow[]
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
    entries: { company: IndexRow; value: number; periodEnd: string }[]
}

export interface Site {
    /** Companies whose pages are built in this run. */
    companies: PublishedCompany[]
    byOrgnr: Map<string, PublishedCompany>
    /** The whole directory. */
    rows: IndexRow[]
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

function hubs(kind: Hub['kind'], rows: IndexRow[]): Hub[] {
    const groups = new Map<string, Hub>()
    for (const c of rows) {
        const key = kind === 'bransch' ? c.s && { code: c.s.code, name: c.s.label, detail: c.s.version } : c.k && { code: c.k.code, name: c.k.name, detail: c.k.county }
        if (!key) continue
        const slug = kind === 'bransch' ? `${key.code}-${slugify(key.name)}` : slugify(key.name)
        const hub = groups.get(slug) ?? { kind, slug, name: key.name, code: key.code, detail: key.detail, companies: [], indexable: false, substantial: false }
        hub.companies.push(c)
        groups.set(slug, hub)
    }
    for (const h of groups.values()) {
        h.companies.sort((a, b) => (b.ns ?? -1) - (a.ns ?? -1) || a.n.localeCompare(b.n, 'sv'))
        h.indexable = h.companies.filter((c) => c.ix).length >= MIN_HUB_COMPANIES
        h.substantial = h.companies.filter((c) => c.q).length >= MIN_HUB_COMPANIES
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

const RANK_FIELD = { netSales: 'ns', revenueGrowth: 'rg', equityRatio: 'er', operatingMargin: 'om' } as const

function rankings(rows: IndexRow[]): Ranking[] {
    const eligible = rows.filter((c) => c.q && c.fr === 'current' && c.per?.months === 12)
    return RANKINGS.map((def) => {
        const floor = def.metric === 'revenueGrowth' ? 'nsp' : def.metric === 'netSales' ? null : 'ns'
        const entries = eligible
            .map((company) => {
                if (floor && (company[floor] ?? 0) < 5_000_000) return null
                const value = company[RANK_FIELD[def.metric as keyof typeof RANK_FIELD]]
                return value === undefined ? null : { company, value, periodEnd: company.per!.end }
            })
            .filter((e): e is NonNullable<typeof e> => e !== null)
            .sort((a, b) => b.value - a.value)
            .slice(0, 50)
        return { ...def, entries }
    })
}

/** Publishable companies of a release, sorted by name. */
export function publishAll(release: Release, asOf: string = SITE.asOf): PublishedCompany[] {
    return release.companies
        .map((r) => publishCompany(r, release.slugHistory[r.orgnr], asOf))
        .filter((c) => c.quality.publishable)
        .sort((a, b) => a.record.name.localeCompare(b.record.name, 'sv'))
}

export function buildSite(pages: PublishedCompany[], rows: IndexRow[], releaseId: string): Site {
    rows = [...rows].sort((a, b) => a.n.localeCompare(b.n, 'sv'))
    return {
        companies: pages,
        byOrgnr: new Map(pages.map((c) => [c.record.orgnr as string, c])),
        rows,
        redirects: rows.flatMap((c) => [...c.rf.map((from) => ({ from, to: c.p })), { from: `/foretag/${c.o}/`, to: c.p }]),
        industries: hubs('bransch', rows),
        municipalities: hubs('kommun', rows),
        rankings: rankings(rows),
        releaseId,
        synthetic: rows.some((c) => c.syn),
    }
}

/** Companies in the same industry, then same municipality, for internal links. */
export function relatedCompanies(site: Site, c: PublishedCompany, limit = 6): IndexRow[] {
    const r = c.record
    const ind = r.sni[0] && site.industries.find((h) => h.code === r.sni[0].code)
    const kom = r.municipality && site.municipalities.find((h) => h.code === r.municipality!.code)
    const seen = new Set<string>([r.orgnr])
    const out: IndexRow[] = []
    for (const x of [...(ind?.companies ?? []), ...(kom?.companies ?? [])]) {
        if (out.length >= limit) break
        if (!seen.has(x.o)) {
            out.push(x)
            seen.add(x.o)
        }
    }
    return out
}

/** A full build from one release: every company is both a page and an index row. */
export function siteFromRelease(release: Release, asOf: string = SITE.asOf): Site {
    const pages = publishAll(release, asOf)
    return buildSite(pages, pages.map(toRow), release.manifest.releaseId)
}
