// Search Lambda package for the company search, from the fetch stage's output:
// every company in data/build/index.jsonl goes into a fresh SQLite database,
// bundled with search/handler.ts into data/build/search/search.zip. The Jenkins
// job uploads the zip to the state bucket and points the Lambda at it.
// Zip written here (stored, no compression needed) so the agent needs no zip tool.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { build } from 'esbuild'
import { buildSearchDb } from '../src/lib/search-db.ts'
import { toSearchHit } from '../src/lib/search.ts'
import type { IndexRow } from '../src/lib/publish.ts'

const BUILD_DIR = path.join(process.cwd(), 'data', 'build')
const OUT = path.join(BUILD_DIR, 'search')
/** Lambda's limit for unzipped code is 250 MB. */
const MAX_UNZIPPED = 245_000_000

const readJsonl = <T>(f: string): T[] => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [])

/** 1980-01-01, the earliest valid zip date (entries carry no real timestamps). */
const DOS_DATE = (1 << 5) | 1

/** A zip of the given files, stored uncompressed (Lambda unpacks it once per instance). */
export function zipStored(files: { name: string; data: Buffer }[]): Buffer {
    const parts: Buffer[] = []
    const central: Buffer[] = []
    let offset = 0
    for (const { name, data } of files) {
        const n = Buffer.from(name)
        const crc = zlib.crc32(data)
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0)
        local.writeUInt16LE(20, 4)
        local.writeUInt16LE(DOS_DATE, 12)
        local.writeUInt32LE(crc, 14)
        local.writeUInt32LE(data.length, 18)
        local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(n.length, 26)
        const dir = Buffer.alloc(46)
        dir.writeUInt32LE(0x02014b50, 0)
        dir.writeUInt16LE(0x0314, 4) // made by unix, so the mode below counts
        dir.writeUInt16LE(20, 6)
        dir.writeUInt16LE(DOS_DATE, 14)
        dir.writeUInt32LE(crc, 16)
        dir.writeUInt32LE(data.length, 20)
        dir.writeUInt32LE(data.length, 24)
        dir.writeUInt16LE(n.length, 28)
        dir.writeUInt32LE((0o100644 << 16) >>> 0, 38)
        dir.writeUInt32LE(offset, 42)
        parts.push(local, n, data)
        central.push(dir, n)
        offset += local.length + n.length + data.length
    }
    const size = central.reduce((a, b) => a + b.length, 0)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(files.length, 8)
    end.writeUInt16LE(files.length, 10)
    end.writeUInt32LE(size, 12)
    end.writeUInt32LE(offset, 16)
    return Buffer.concat([...parts, ...central, end])
}

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
    const files = [
        { name: 'handler.mjs', data: Buffer.from(handler.outputFiles[0].contents) },
        { name: 'search.sqlite', data: fs.readFileSync(db) },
    ]
    const unzipped = files.reduce((a, f) => a + f.data.length, 0)
    if (unzipped > MAX_UNZIPPED) throw new Error(`search package is ${(unzipped / 1e6).toFixed(0)} MB, over Lambda's 250 MB limit`)
    fs.writeFileSync(path.join(OUT, 'search.zip'), zipStored(files))
    console.log(`search: ${n} companies, ${(unzipped / 1e6).toFixed(1)} MB (data/build/search/search.zip)`)
}

if (process.argv[1]?.endsWith('search-db.ts')) await main()
