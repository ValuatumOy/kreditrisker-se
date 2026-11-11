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
// rejected.jsonl, warnings.jsonl and removed.txt, then `SE_DATA_SOURCE=build astro build` renders them.

import fs from 'node:fs'
import path from 'node:path'
import { SITE } from '../src/config/site.ts'
import { validateRecord } from '../src/lib/contract/validate.ts'
import type { PublishedCompany } from '../src/lib/contract/types.ts'
import { readJsonl, writeJsonl } from '../src/lib/jsonl.ts'
import { publishCompany, toRow, type IndexRow } from '../src/lib/publish.ts'
import { fetchBundle, mapLimit } from '../src/lib/valuatum/api.ts'
import { assertBatchSize } from '../src/lib/valuatum/batch-limit.ts'
import { mapBundle } from '../src/lib/valuatum/map.ts'
import { readParams } from '../src/lib/valuatum/params.ts'

const BUILD_DIR = path.join(process.cwd(), 'data', 'build')

const slugOf = (p: string) => p.split('/')[3]

async function main() {
    const batchFile = process.env.BUILD_STATIC_PARAMS_FILE
    if (!batchFile) throw new Error('BUILD_STATIC_PARAMS_FILE is not set')
    const batch = readParams(batchFile)
    assertBatchSize(batch.length)
    const allFile = process.env.BUILD_STATIC_PARAMS_FILE_ALL
    const all = allFile ? readParams(allFile) : null
    const keep = all && new Set(all.flatMap((p) => (p.orgnr ? [p.orgnr] : [])))
    const indexIn = process.env.SE_INDEX_IN ?? path.join(BUILD_DIR, 'index.jsonl')
    const rows = new Map(readJsonl<IndexRow>(indexIn).map((r) => [r.o, r]))
    const importedAt = new Date().toISOString()
    const batchId = `api-${importedAt.slice(0, 10)}`

    const rejected: { fid: string; name: string; reason: string }[] = []
    const warnings: { fid: string; orgnr: string; name: string; periods: string[]; warnings: string[] }[] = []
    let done = 0
    let pageCount = 0
    let writeError: unknown
    fs.mkdirSync(BUILD_DIR, { recursive: true })
    const pagesTemp = path.join(BUILD_DIR, 'pages.jsonl.tmp')
    const pageFd = fs.openSync(pagesTemp, 'w')
    try {
        await mapLimit(batch, Number(process.env.SE_FETCH_CONCURRENCY ?? 8), async (param) => {
            if (writeError) return
            let page: PublishedCompany
            let review: string[]
            try {
                const bundle = await fetchBundle(param.fid)
                if (!bundle) return void rejected.push({ ...param, reason: 'no financial statements in the model' })
                const mapped = mapBundle(bundle, { batchId, importedAt })
                if (!mapped.ok) return void rejected.push({ ...param, reason: mapped.reason })
                const valid = validateRecord(mapped.record)
                if (!valid.ok) return void rejected.push({ ...param, reason: valid.errors.join('; ') })
                const prev = rows.get(mapped.record.orgnr)
                const history = prev ? [...prev.rf.map(slugOf), slugOf(prev.p)] : undefined
                page = publishCompany(mapped.record, history, SITE.asOf)
                if (!page.quality.publishable) return void rejected.push({ ...param, reason: 'not publishable (sole trader)' })
                review = valid.warnings
            } catch (e) {
                rejected.push({ ...param, reason: e instanceof Error ? e.message : String(e) })
                return
            } finally {
                if (++done % 100 === 0) console.log(`fetched ${done}/${batch.length}`)
            }
            try {
                fs.writeFileSync(pageFd, JSON.stringify(page) + '\n')
            } catch (e) {
                writeError = e instanceof Error ? e : new Error(String(e))
                return
            }
            pageCount++
            rows.set(page.record.orgnr, toRow(page))
            if (review.length) warnings.push({ fid: param.fid, orgnr: page.record.orgnr, name: page.record.name, periods: page.record.periods.map((p) => p.end), warnings: review })
        })
        if (writeError) throw writeError
    } finally {
        fs.closeSync(pageFd)
    }
    fs.renameSync(pagesTemp, path.join(BUILD_DIR, 'pages.jsonl'))

    // Last save time for every company in the directory, not just the batch (the
    // "Senast uppdaterade" page sorts the whole index by it).
    if (all) {
        const saved = new Map(all.flatMap((p) => (p.orgnr && p.updatedAt ? [[p.orgnr, p.updatedAt] as const] : [])))
        for (const r of rows.values()) {
            const up = saved.get(r.o)
            if (up) r.up = up
        }
    }

    const removed: string[] = []
    if (keep)
        for (const o of rows.keys())
            if (!keep.has(o)) {
                removed.push(`foretag/${o}/`)
                rows.delete(o)
            }
    writeJsonl(path.join(BUILD_DIR, 'index.jsonl'), rows.values())
    writeJsonl(path.join(BUILD_DIR, 'rejected.jsonl'), rejected)
    writeJsonl(path.join(BUILD_DIR, 'warnings.jsonl'), warnings)
    // S3 prefixes of companies that left the directory, for the deploy step to delete.
    fs.writeFileSync(path.join(BUILD_DIR, 'removed.txt'), removed.map((r) => r + '\n').join(''))
    const indexable = [...rows.values()].filter((r) => r.ix).length
    console.log(`batch ${batch.length}: ${pageCount} pages, ${rejected.length} rejected (data/build/rejected.jsonl), ${warnings.length} with warnings (data/build/warnings.jsonl)`)
    console.log(`index: ${rows.size} companies, ${indexable} pass the index threshold`)
    if (batch.length && !pageCount) process.exitCode = 1
}

await main()
