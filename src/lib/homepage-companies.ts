import { bankruptcyRows, procedureDate } from './bankruptcy.ts'
import { CURRENT_MONTHS, monthsBetween } from './freshness.ts'
import type { IndexRow } from './publish.ts'

const GROUP_SIZE = 12

export function homepageCompanies(rows: IndexRow[], asOf: string) {
    // During incremental builds, only rows with sm have verified, published canonical HTML.
    const published = rows.filter((row) => row.sm && row.ix && !row.syn)
    const bankruptcies = bankruptcyRows(published, asOf)
        .flatMap((row) => {
            const date = procedureDate(row, asOf)
            return date && monthsBetween(date, asOf) <= 3 ? [{ row, date }] : []
        })
        .slice(0, GROUP_SIZE)
    const financials = published
        .flatMap((row) => {
            const period = row.per
            const industry = row.s
            if (
                row.st !== 'active' || !period || !industry || !industry.label ||
                !/^(?!00000)\d{5}$/.test(industry.code) ||
                period.end > asOf || !(monthsBetween(period.end, asOf) <= CURRENT_MONTHS)
            ) return []
            return [{ row, period, industry }]
        })
        .sort((a, b) =>
            b.period.end.localeCompare(a.period.end) ||
            (b.row.ns ?? 0) - (a.row.ns ?? 0) ||
            a.row.o.localeCompare(b.row.o)
        )
        .slice(0, GROUP_SIZE)

    return { bankruptcies, financials }
}
