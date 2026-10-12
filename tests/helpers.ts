import path from 'node:path'
import { readBatchFile } from '../src/lib/releaseio.ts'
import type { CompanyRecord, FiscalPeriod } from '../src/lib/contract/types.ts'
import { BALANCE_ROWS, INCOME_ROWS } from '../src/config/statement.ts'
import { numeric } from '../src/lib/metrics.ts'

export const FIXTURES = path.join(import.meta.dirname, '..', 'data', 'fixtures')
export const batch1 = () => readBatchFile(path.join(FIXTURES, 'synthetic-batch-001.jsonl')) as CompanyRecord[]
export const batch2 = () => readBatchFile(path.join(FIXTURES, 'synthetic-batch-002-update.jsonl')) as CompanyRecord[]
export const byName = (rows: CompanyRecord[], prefix: string) => {
    const r = rows.find((x) => x.name.startsWith(prefix))
    if (!r) throw new Error(`fixture ${prefix} not found`)
    return structuredClone(r)
}
export const AS_OF = '2026-09-25'

// The rows must add up to their subtotals as src/config/statement.ts describes, so a reader can follow the table.
export function statementGaps(p: FiscalPeriod): string[] {
    const out: string[] = []
    const check = (got: number, want: number, what: string) => Math.abs(got - want) > 2 && out.push(`${p.end} ${what}: ${got} vs ${want}`)
    const inc = (k: string) => numeric((p.income as unknown as Record<string, never>)[k]) ?? 0
    const bal = (k: string) => numeric((p.balance as unknown as Record<string, never>)[k]) ?? 0
    let chain = 0
    for (const r of INCOME_ROWS) {
        if (r.key === 'netSales') chain = inc(r.key)
        else if (r.ifItAddsUp) continue // checked by addsUp, and hidden where it does not
        else if (r.sum) {
            check(chain, inc(r.key), r.key)
            chain = inc(r.key)
        } else chain += inc(r.key)
    }
    let items = 0
    let section = 0
    for (const r of BALANCE_ROWS) {
        if (r.total) {
            check(section, bal(r.key), r.key)
            section = 0
        } else if (r.sum) {
            if (items) check(items, bal(r.key), r.key)
            section += bal(r.key)
            items = 0
        } else if (r.standalone) section += bal(r.key)
        else items += bal(r.key)
    }
    return out
}
