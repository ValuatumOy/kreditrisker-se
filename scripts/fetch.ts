// Fetch stage for API builds, the Finnish/Danish model: build pages only for
// the batch, list every company in hubs, rankings and sitemaps.
//
//   BUILD_STATIC_PARAMS_FILE      batch TSV: companies whose pages are built now
//   BUILD_STATIC_PARAMS_FILE_ALL  TSV of every company in the directory (optional;
//                                 companies missing from it are dropped)
//   SE_INDEX_IN                   index state from the previous build (optional,
//                                 defaults to data/build/index.jsonl)
//
// TSV columns, as written by build/get_static_params: fid, slug, name, sni, orgnr.
// Writes data/build/pages.jsonl, index.jsonl (also the next build's state),
// rejected.jsonl and removed.txt, then `SE_DATA_SOURCE=build astro build` renders them.

import fs from 'node:fs'
import path from 'node:path'
import { SITE } from '../src/config/site.ts'
import { validateRecord } from '../src/lib/contract/validate.ts'
import type { PublishedCompany } from '../src/lib/contract/types.ts'
import { publishCompany, toRow, type IndexRow } from '../src/lib/publish.ts'
import { fetchBundle, mapLimit } from '../src/lib/valuatum/api.ts'
import { mapBundle } from '../src/lib/valuatum/map.ts'
import { readParams } from '../src/lib/valuatum/params.ts'

const BUILD_DIR = path.join(process.cwd(), 'data', 'build')

const readJsonl = <T>(file: string): T[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])
const slugOf = (p: string) => p.split('/')[3]

async function main() {
    const batchFile = process.env.BUILD_STATIC_PARAMS_FILE
    if (!batchFile) throw new Error('BUILD_STATIC_PARAMS_FILE is not set')
    const batch = readParams(batchFile)
    const allFile = process.env.BUILD_STATIC_PARAMS_FILE_ALL
    const all = allFile ? readParams(allFile) : null
    const keep = all && new Set(all.flatMap((p) => (p.orgnr ? [p.orgnr] : [])))
    const indexIn = process.env.SE_INDEX_IN ?? path.join(BUILD_DIR, 'index.jsonl')
    const rows = new Map(readJsonl<IndexRow>(indexIn).map((r) => [r.o, r]))
    const importedAt = new Date().toISOString()
    const batchId = `api-${importedAt.slice(0, 10)}`

    const pages: PublishedCompany[] = []
    const rejected: { fid: string; name: string; reason: string }[] = []
    let done = 0
    await mapLimit(batch, Number(process.env.SE_FETCH_CONCURRENCY ?? 8), async (param) => {
        try {
            const bundle = await fetchBundle(param.fid)
            if (!bundle) return void rejected.push({ ...param, reason: 'no financial statements in the model' })
            const mapped = mapBundle(bundle, { batchId, importedAt })
            if (!mapped.ok) return void rejected.push({ ...param, reason: mapped.reason })
            const valid = validateRecord(mapped.record)
            if (!valid.ok) return void rejected.push({ ...param, reason: valid.errors.join('; ') })
            const prev = rows.get(mapped.record.orgnr)
            const history = prev ? [...prev.rf.map(slugOf), slugOf(prev.p)] : undefined
            const page = publishCompany(mapped.record, history, SITE.asOf)
            if (!page.quality.publishable) return void rejected.push({ ...param, reason: 'not publishable (sole trader)' })
            pages.push(page)
            rows.set(page.record.orgnr, toRow(page))
        } catch (e) {
            rejected.push({ ...param, reason: e instanceof Error ? e.message : String(e) })
        } finally {
            if (++done % 100 === 0) console.log(`fetched ${done}/${batch.length}`)
        }
    })

    const removed: string[] = []
    if (keep)
        for (const o of rows.keys())
            if (!keep.has(o)) {
                removed.push(`foretag/${o}/`)
                rows.delete(o)
            }
    fs.mkdirSync(BUILD_DIR, { recursive: true })
    const jsonl = (xs: unknown[]) => xs.map((x) => JSON.stringify(x)).join('\n') + (xs.length ? '\n' : '')
    fs.writeFileSync(path.join(BUILD_DIR, 'pages.jsonl'), jsonl(pages))
    fs.writeFileSync(path.join(BUILD_DIR, 'index.jsonl'), jsonl([...rows.values()]))
    fs.writeFileSync(path.join(BUILD_DIR, 'rejected.jsonl'), jsonl(rejected))
    // S3 prefixes of companies that left the directory, for the deploy step to delete.
    fs.writeFileSync(path.join(BUILD_DIR, 'removed.txt'), removed.map((r) => r + '\n').join(''))
    const indexable = [...rows.values()].filter((r) => r.ix).length
    console.log(`batch ${batch.length}: ${pages.length} pages, ${rejected.length} rejected (data/build/rejected.jsonl)`)
    console.log(`index: ${rows.size} companies, ${indexable} pass the index threshold`)
    if (batch.length && !pages.length) process.exitCode = 1
}

await main()
