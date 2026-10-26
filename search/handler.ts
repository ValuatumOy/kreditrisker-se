// Search Lambda: GET /api/search?q=...&size=... (CloudFront -> Function URL) -> SearchHit[].
// The database ships next to the handler in the image (scripts/search-db.ts, search/Dockerfile).
// A scheduled { ping: true } keeps an instance warm and, the first time, reads the whole file
// so later queries never wait on the disk (a fresh instance answers its first search in
// ~0.3 s, the next ones in up to ~0.4 s, until their pages are cached; on a just-pushed image
// the first read is much slower, which the Jenkins ping after the update absorbs).

import fs from 'node:fs'
import { openSearchDb, searchDb } from '../src/lib/search-db.ts'

const started = Date.now()
const file = process.env.SEARCH_DB ?? `${import.meta.dirname}/search.sqlite`
const db = openSearchDb(file)
const initMs = Date.now() - started
let cold = true
let preread = false

function readWholeFile() {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(1 << 20)
    while (fs.readSync(fd, buf) > 0);
    fs.closeSync(fd)
}

interface Event {
    ping?: boolean
    queryStringParameters?: Record<string, string | undefined>
}

export async function handler(event: Event) {
    const wasCold = cold
    cold = false
    let prereadMs: number | undefined
    if (event.ping && !preread) {
        const t0 = performance.now()
        readWholeFile()
        preread = true
        prereadMs = Math.round(performance.now() - t0)
    }
    const t = performance.now()
    const p = event.queryStringParameters ?? {}
    const size = /^\d{1,2}$/.test(p.size ?? '') ? Number(p.size) : 8
    const hits = searchDb(db, event.ping ? 'ab volvo' : (p.q ?? '').slice(0, 100), size)
    const queryMs = Math.round(performance.now() - t)
    console.log(JSON.stringify({ ping: !!event.ping, cold: wasCold, initMs: wasCold ? initMs : undefined, prereadMs, queryMs, hits: hits.length }))
    if (event.ping) return { cold: wasCold, queryMs }
    return {
        statusCode: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300' },
        body: JSON.stringify(hits),
    }
}
