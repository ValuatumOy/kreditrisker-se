// CloudSearch document batches for the company search, from the fetch stage's
// output. Default: add/update the companies built in this run and delete the
// ones that left the directory. --full: every company in the index (first load).
// Writes data/build/search/batch-N.json (under CloudSearch's 5 MB limit); the
// Jenkins job uploads them with `aws cloudsearchdomain upload-documents`.

import fs from 'node:fs'
import path from 'node:path'
import { periodLabel } from '../src/lib/format.ts'
import type { IndexRow } from '../src/lib/publish.ts'

const BUILD_DIR = path.join(process.cwd(), 'data', 'build')
const OUT = path.join(BUILD_DIR, 'search')
const MAX_BYTES = 4_500_000

const readJsonl = <T>(f: string): T[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])

export function searchDoc(r: IndexRow) {
    const fields: Record<string, string | number> = { orgnr: r.o, name: r.n, path: r.p, status: r.st, fresh: r.fr }
    if (r.f) fields.former = r.f
    if (r.k) fields.kommun = r.k.name
    if (r.s) fields.sni = r.s.label
    if (r.per) fields.year = periodLabel(r.per)
    if (r.ns !== undefined) fields.sales = Math.max(0, Math.round(r.ns / 1000)) // tkr; for ranking ties only
    return { type: 'add' as const, id: r.o, fields }
}

function main() {
    const full = process.argv.includes('--full')
    const rows = readJsonl<IndexRow>(path.join(BUILD_DIR, 'index.jsonl'))
    const changed = full ? null : new Set(readJsonl<{ record: { orgnr: string } }>(path.join(BUILD_DIR, 'pages.jsonl')).map((p) => p.record.orgnr))
    const docs: object[] = rows.filter((r) => !r.syn && (!changed || changed.has(r.o))).map(searchDoc)
    const removedFile = path.join(BUILD_DIR, 'removed.txt')
    if (!full && fs.existsSync(removedFile))
        for (const line of fs.readFileSync(removedFile, 'utf8').split('\n').filter(Boolean)) docs.push({ type: 'delete', id: line.split('/')[1] })

    fs.rmSync(OUT, { recursive: true, force: true })
    fs.mkdirSync(OUT, { recursive: true })
    let batch: string[] = []
    let size = 2
    let n = 0
    const flush = () => {
        if (!batch.length) return
        fs.writeFileSync(path.join(OUT, `batch-${++n}.json`), `[${batch.join(',')}]`)
        batch = []
        size = 2
    }
    for (const d of docs) {
        const s = JSON.stringify(d)
        if (size + Buffer.byteLength(s) + 1 > MAX_BYTES) flush()
        batch.push(s)
        size += Buffer.byteLength(s) + 1
    }
    flush()
    console.log(`search: ${docs.length} documents in ${n} batch file(s) (data/build/search/)`)
}

if (process.argv[1]?.endsWith('search-docs.ts')) main()
