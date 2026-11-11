import type { Hub, IndexRow } from './publish.ts'

export const MIN_BANKRUPTCY_COMPANIES = 3
// Build-time arrays are immutable. Cache references only; the WeakMaps do not
// retain previous datasets, and a changed as-of date replaces the cached view.
const casesCache = new WeakMap<IndexRow[], { asOf: string; cases: IndexRow[] }>()

/** Dates describe the registered procedure, never an import or financial year. */
export function procedureDate(row: IndexRow, asOf: string): string | undefined {
    const s = row.ss
    if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s) || s > asOf) return undefined
    const d = new Date(`${s}T00:00:00Z`)
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : undefined
}

export function bankruptcyRows(rows: IndexRow[], asOf: string): IndexRow[] {
    const cached = casesCache.get(rows)
    if (cached?.asOf === asOf) return cached.cases
    const cases = rows.filter((r) => r.st === 'bankruptcy')
        .map((row) => ({ row, date: procedureDate(row, asOf) ?? '' }))
        .sort((a, b) => b.date.localeCompare(a.date) || a.row.n.localeCompare(b.row.n, 'sv') || a.row.o.localeCompare(b.row.o))
        .map(({ row }) => row)
    casesCache.set(rows, { asOf, cases })
    return cases
}

export function bankruptcyIndexable(rows: IndexRow[]): boolean {
    let count = 0
    for (const row of rows) if (row.st === 'bankruptcy' && !row.syn && ++count >= MIN_BANKRUPTCY_COMPANIES) return true
    return false
}

export function bankruptcySummary(rows: IndexRow[], asOf: string) {
    const cases = bankruptcyRows(rows, asOf)
    const [year, month] = asOf.split('-').map(Number)
    // Twelve calendar months including the partial current month.
    const months = Array.from({ length: 12 }, (_, i) => {
        const start = new Date(Date.UTC(year, month - 12 + i, 1)).toISOString().slice(0, 10)
        return { month: start.slice(0, 7), count: 0 }
    })
    let undated = 0
    let older = 0
    for (const r of cases) {
        const d = procedureDate(r, asOf)
        if (!d) undated++
        else {
            const bucket = months.find((m) => m.month === d.slice(0, 7))
            if (bucket) bucket.count++
            else older++
        }
    }
    const recent = cases.filter((r) => (procedureDate(r, asOf) ?? '') >= months[0].month + '-01')
    const withEmployees = recent.filter((r) => r.fr !== 'stale' && r.fr !== 'none' && r.emp !== undefined && r.emp >= 0)
    const sizes = [
        { label: 'Färre än 10 anställda', min: 0, max: 10 },
        { label: '10–49 anställda', min: 10, max: 50 },
        { label: '50–249 anställda', min: 50, max: 250 },
        { label: '250 anställda eller fler', min: 250, max: Infinity },
    ].map((s) => {
        const group = withEmployees.filter((r) => r.emp! >= s.min && r.emp! < s.max)
        return { label: s.label, count: group.length, employees: group.reduce((n, r) => n + r.emp!, 0) }
    })
    return { cases, months, undated, older, recent, withEmployees, sizes }
}

/** Only proportions within this directory snapshot, never Sweden's company population. */
type BankruptcyGroup = { hub: Hub; count: number; total: number }
const groupsCache = new WeakMap<Hub[], { asOf: string; groups: BankruptcyGroup[] }>()

export function bankruptcyGroups(hubs: Hub[], asOf: string): BankruptcyGroup[] {
    const cached = groupsCache.get(hubs)
    if (cached?.asOf === asOf) return cached.groups
    const groups = hubs.map((hub) => ({ hub, count: bankruptcyRows(hub.companies, asOf).length, total: hub.companies.length }))
        .filter((g) => g.count > 0)
        .sort((a, b) => b.count - a.count || a.hub.name.localeCompare(b.hub.name, 'sv'))
    groupsCache.set(hubs, { asOf, groups })
    return groups
}

export const bankruptcyHubPath = (hub: Hub) => `/konkurser/${hub.kind === 'bransch' ? 'branscher' : 'kommuner'}/${hub.slug}/`
