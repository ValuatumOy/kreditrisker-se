// JSON Lines files that may be larger than V8's maximum string length (~512 MB):
// a 16k-company batch writes ~1 GB of pages.jsonl (~64 KB per company), so neither
// side may hold the whole file as one string.

import fs from 'node:fs'

const NEWLINE = 0x0a

/** Writes one JSON record per line. */
export function writeJsonl(file: string, records: Iterable<unknown>): void {
    const fd = fs.openSync(file, 'w')
    try {
        for (const r of records) fs.writeSync(fd, JSON.stringify(r) + '\n')
    } finally {
        fs.closeSync(fd)
    }
}

/** Reads a file written by writeJsonl; a missing file reads as empty. Blank lines are skipped. */
export function readJsonl<T>(file: string): T[] {
    if (!fs.existsSync(file)) return []
    const out: T[] = []
    const buf = Buffer.alloc(16 * 1024 * 1024)
    let rest = Buffer.alloc(0)
    const fd = fs.openSync(file, 'r')
    try {
        for (let n: number; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) {
            const chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n)
            let start = 0
            for (let i: number; (i = chunk.indexOf(NEWLINE, start)) !== -1; start = i + 1) {
                const line = chunk.toString('utf8', start, i)
                if (line.trim()) out.push(JSON.parse(line) as T)
            }
            rest = Buffer.from(chunk.subarray(start)) // copy: buf is reused on the next read
        }
        const last = rest.toString('utf8')
        if (last.trim()) out.push(JSON.parse(last) as T)
    } finally {
        fs.closeSync(fd)
    }
    return out
}
