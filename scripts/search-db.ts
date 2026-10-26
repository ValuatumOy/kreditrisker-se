// Search Lambda image contents for the company search, from the fetch stage's output:
// every company in data/build/index.jsonl goes into a fresh SQLite database, written
// with the bundled search/handler.ts to data/build/search/. The Jenkins job builds
// search/Dockerfile from that folder, pushes the image and points the Lambda at it.

import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'
import { buildSearchDb } from '../src/lib/search-db.ts'
import { toSearchHit } from '../src/lib/search.ts'
import type { IndexRow } from '../src/lib/publish.ts'

const BUILD_DIR = path.join(process.cwd(), 'data', 'build')
const OUT = path.join(BUILD_DIR, 'search')

const readJsonl = <T>(f: string): T[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])

async function main() {
    const rows = readJsonl<IndexRow>(path.join(BUILD_DIR, 'index.jsonl')).filter((r) => !r.syn)
    if (!rows.length) throw new Error('data/build/index.jsonl is empty; run scripts/fetch.ts first')
    fs.rmSync(OUT, { recursive: true, force: true })
    fs.mkdirSync(OUT, { recursive: true })

    const db = path.join(OUT, 'search.sqlite')
    const n = buildSearchDb(db, rows.map((r) => ({ hit: toSearchHit(r), sales: r.ns })))
    const handler = await build({
        entryPoints: [path.join(process.cwd(), 'search', 'handler.ts')],
        bundle: true,
        platform: 'node',
        target: 'node22',
        format: 'esm',
        write: false,
        logLevel: 'warning',
    })
    fs.writeFileSync(path.join(OUT, 'handler.mjs'), handler.outputFiles[0].contents)
    console.log(`search: ${n} companies, ${(fs.statSync(db).size / 1e6).toFixed(1)} MB (data/build/search/)`)
}

if (process.argv[1]?.endsWith('search-db.ts')) await main()
