import path from 'node:path'
import { readBatchFile } from '../src/lib/releaseio.ts'
import type { CompanyRecord } from '../src/lib/contract/types.ts'

export const FIXTURES = path.join(import.meta.dirname, '..', 'data', 'fixtures')
export const batch1 = () => readBatchFile(path.join(FIXTURES, 'synthetic-batch-001.jsonl')) as CompanyRecord[]
export const batch2 = () => readBatchFile(path.join(FIXTURES, 'synthetic-batch-002-update.jsonl')) as CompanyRecord[]
export const byName = (rows: CompanyRecord[], prefix: string) => {
    const r = rows.find((x) => x.name.startsWith(prefix))
    if (!r) throw new Error(`fixture ${prefix} not found`)
    return structuredClone(r)
}
export const AS_OF = '2026-09-25'
