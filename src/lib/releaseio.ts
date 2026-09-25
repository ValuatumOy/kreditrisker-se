// Filesystem layout for releases and staged batches.
//
//   data/releases/CURRENT                 -> text file with the live release id
//   data/releases/<id>/manifest.json
//   data/releases/<id>/companies.json
//   data/releases/<id>/slug-history.json
//   data/staging/<batchId>/records.json   -> accepted records
//   data/staging/<batchId>/rejected.jsonl -> one rejection per line
//   data/staging/<batchId>/report.json    -> counts + diff
//
// Releases are immutable; rollback only moves CURRENT.

import fs from 'node:fs'
import path from 'node:path'
import { emptyRelease, type Release, type StagedBatch } from './pipeline.ts'

export function dataDir(): string {
    return path.resolve(process.env.SE_DATA_DIR ?? path.join(process.cwd(), 'data'))
}
const releasesDir = () => path.join(dataDir(), 'releases')
const stagingDir = () => path.join(dataDir(), 'staging')

const readJson = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T
const writeJson = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v, null, 1) + '\n')

export function currentReleaseId(): string | null {
    const p = path.join(releasesDir(), 'CURRENT')
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() || null : null
}

export function readRelease(id: string): Release {
    const dir = path.join(releasesDir(), id)
    if (!fs.existsSync(dir)) throw new Error(`release ${id} not found in ${releasesDir()}`)
    return {
        manifest: readJson(path.join(dir, 'manifest.json')),
        companies: readJson(path.join(dir, 'companies.json')),
        slugHistory: readJson(path.join(dir, 'slug-history.json')),
    }
}

export function readCurrentRelease(): Release {
    const id = currentReleaseId()
    return id ? readRelease(id) : emptyRelease()
}

export function writeRelease(r: Release): string {
    const dir = path.join(releasesDir(), r.manifest.releaseId)
    if (fs.existsSync(dir)) throw new Error(`release ${r.manifest.releaseId} already exists (releases are immutable)`)
    fs.mkdirSync(dir, { recursive: true })
    writeJson(path.join(dir, 'companies.json'), r.companies)
    writeJson(path.join(dir, 'slug-history.json'), r.slugHistory)
    writeJson(path.join(dir, 'manifest.json'), r.manifest)
    return dir
}

export function setCurrent(id: string) {
    readRelease(id) // must exist
    fs.mkdirSync(releasesDir(), { recursive: true })
    fs.writeFileSync(path.join(releasesDir(), 'CURRENT'), id + '\n')
}

export function listReleases(): string[] {
    if (!fs.existsSync(releasesDir())) return []
    return fs
        .readdirSync(releasesDir(), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
}

export function writeStaged(s: StagedBatch): string {
    const dir = path.join(stagingDir(), s.batchId)
    fs.mkdirSync(dir, { recursive: true })
    writeJson(path.join(dir, 'records.json'), s.accepted)
    fs.writeFileSync(path.join(dir, 'rejected.jsonl'), s.rejected.map((r) => JSON.stringify(r)).join('\n') + (s.rejected.length ? '\n' : ''))
    writeJson(path.join(dir, 'report.json'), {
        batchId: s.batchId,
        importedAt: s.importedAt,
        accepted: s.accepted.length,
        rejected: s.rejected.length,
        diff: s.diff,
    })
    return dir
}

export function readStaged(batchId: string): StagedBatch {
    const dir = path.join(stagingDir(), batchId)
    if (!fs.existsSync(dir)) throw new Error(`staged batch ${batchId} not found`)
    const report = readJson<{ importedAt: string; diff: StagedBatch['diff'] }>(path.join(dir, 'report.json'))
    const rejected = fs
        .readFileSync(path.join(dir, 'rejected.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    return { batchId, importedAt: report.importedAt, accepted: readJson(path.join(dir, 'records.json')), rejected, diff: report.diff }
}

/** Reads a batch file: JSON array or JSON Lines. */
export function readBatchFile(file: string): unknown[] {
    const text = fs.readFileSync(file, 'utf8').trim()
    if (text.startsWith('[')) return JSON.parse(text)
    return text
        .split('\n')
        .filter((l) => l.trim())
        .map((l, i) => {
            try {
                return JSON.parse(l)
            } catch {
                return { __parseError: `line ${i + 1}: invalid JSON` }
            }
        })
}
