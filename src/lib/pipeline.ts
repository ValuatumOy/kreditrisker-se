// Batch import and incremental publishing. Pure functions; file IO lives in
// scripts/data.ts and src/lib/store.ts.
//
//   raw batch --stageBatch--> staged (accepted + rejected log + diff)
//   staged + current release --publishRelease--> new immutable release
//   rollback = point CURRENT at an earlier release id

import { validateRecord } from './contract/validate.ts'
import type { CompanyRecord } from './contract/types.ts'
import { parseOrgnr } from './orgnr.ts'
import { slugify } from './slug.ts'

export interface Rejection {
    index: number
    orgnr?: string
    name?: string
    kind: 'invalid' | 'duplicate'
    errors: string[]
}

export interface BatchDiff {
    added: string[]
    updated: string[]
    unchanged: string[]
    renamed: { orgnr: string; from: string; to: string }[]
}

export interface StagedBatch {
    batchId: string
    importedAt: string
    accepted: CompanyRecord[]
    rejected: Rejection[]
    diff: BatchDiff
}

export interface ReleaseManifest {
    releaseId: string
    createdAt: string
    parent: string | null
    batchIds: string[]
    counts: { companies: number; synthetic: number }
    /** Orgnrs whose pages must be rebuilt in an incremental build. */
    changed: string[]
    removed: string[]
}

export interface Release {
    manifest: ReleaseManifest
    companies: CompanyRecord[]
    /** Every slug ever used per orgnr, newest last. Drives name-change redirects. */
    slugHistory: Record<string, string[]>
}

export const emptyRelease = (): Release => ({
    manifest: { releaseId: 'empty', createdAt: '1970-01-01T00:00:00Z', parent: null, batchIds: [], counts: { companies: 0, synthetic: 0 }, changed: [], removed: [] },
    companies: [],
    slugHistory: {},
})

function stableJson(v: unknown): string {
    return JSON.stringify(v, (_k, val) =>
        val && typeof val === 'object' && !Array.isArray(val)
            ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
            : val,
    )
}

/** Content equality ignoring provenance (a re-import of identical data is "unchanged"). */
function sameContent(a: CompanyRecord, b: CompanyRecord): boolean {
    const strip = (r: CompanyRecord) => ({ ...r, provenance: undefined })
    return stableJson(strip(a)) === stableJson(strip(b))
}

function newestEnd(r: CompanyRecord): string {
    return r.periods[0]?.end ?? ''
}

export function stageBatch(raw: unknown[], opts: { batchId: string; importedAt: string; current: Release }): StagedBatch {
    const rejected: Rejection[] = []
    const byOrgnr = new Map<string, { index: number; record: CompanyRecord }>()

    raw.forEach((input, index) => {
        const rec = (typeof input === 'object' && input !== null ? { ...(input as object) } : input) as Record<string, unknown>
        const name = typeof rec?.name === 'string' ? rec.name : undefined
        // Normalise the id before validating so "556677-8899" is accepted.
        if (rec && typeof rec.orgnr === 'string') {
            const p = parseOrgnr(rec.orgnr)
            if (p.ok) rec.orgnr = p.orgnr
        }
        if (rec && typeof rec === 'object') {
            const prov = (rec.provenance ?? {}) as Record<string, unknown>
            rec.provenance = { sources: [], ...prov, batchId: opts.batchId, importedAt: opts.importedAt }
        }
        const res = validateRecord(rec)
        const orgnr = typeof rec?.orgnr === 'string' ? rec.orgnr : undefined
        if (!res.ok) {
            rejected.push({ index, orgnr, name, kind: 'invalid', errors: res.errors })
            return
        }
        const record = rec as unknown as CompanyRecord
        const prev = byOrgnr.get(record.orgnr)
        if (!prev) {
            byOrgnr.set(record.orgnr, { index, record })
            return
        }
        // Duplicate orgnr in one batch: keep the record with the newer statements;
        // on a tie the later row wins (it was produced later by the exporter).
        const keepNew = newestEnd(record) >= newestEnd(prev.record)
        const loser = keepNew ? prev : { index, record }
        if (keepNew) byOrgnr.set(record.orgnr, { index, record })
        rejected.push({
            index: loser.index,
            orgnr: record.orgnr,
            name: loser.record.name,
            kind: 'duplicate',
            errors: [`duplicate orgnr in batch; kept row ${keepNew ? index : prev.index}`],
        })
    })

    const currentBy = new Map(opts.current.companies.map((c) => [c.orgnr, c]))
    const diff: BatchDiff = { added: [], updated: [], unchanged: [], renamed: [] }
    const accepted = [...byOrgnr.values()].sort((a, b) => a.index - b.index).map((x) => x.record)
    for (const r of accepted) {
        const old = currentBy.get(r.orgnr)
        if (!old) diff.added.push(r.orgnr)
        else if (sameContent(old, r)) diff.unchanged.push(r.orgnr)
        else {
            diff.updated.push(r.orgnr)
            if (slugify(old.name) !== slugify(r.name)) diff.renamed.push({ orgnr: r.orgnr, from: old.name, to: r.name })
        }
    }
    rejected.sort((a, b) => a.index - b.index)
    return { batchId: opts.batchId, importedAt: opts.importedAt, accepted, rejected, diff }
}

export function publishRelease(
    staged: StagedBatch,
    current: Release,
    opts: { releaseId: string; createdAt: string; remove?: string[] },
): Release {
    const remove = new Set(opts.remove ?? [])
    const map = new Map(current.companies.map((c) => [c.orgnr as string, c]))
    const changed: string[] = []
    for (const r of staged.accepted) {
        if (staged.diff.unchanged.includes(r.orgnr)) continue
        map.set(r.orgnr, r)
        changed.push(r.orgnr)
    }
    const removed: string[] = []
    for (const id of remove) if (map.delete(id)) removed.push(id)

    const slugHistory: Record<string, string[]> = structuredClone(current.slugHistory)
    for (const c of map.values()) {
        const hist = (slugHistory[c.orgnr] ??= [])
        for (const n of [...c.formerNames.map((f) => f.name), c.name]) {
            const s = slugify(n)
            const at = hist.indexOf(s)
            if (at !== -1) hist.splice(at, 1)
            hist.push(s)
        }
        // The current name's slug must be last (canonical).
        const canon = slugify(c.name)
        hist.splice(hist.indexOf(canon), 1)
        hist.push(canon)
    }
    for (const id of removed) delete slugHistory[id]

    const companies = [...map.values()].sort((a, b) => a.orgnr.localeCompare(b.orgnr))
    const synthetic = companies.filter((c) => c.synthetic).length
    if (synthetic > 0 && synthetic < companies.length)
        throw new Error('A release may not mix synthetic fixtures and real companies. Publish real data into a fresh release chain.')
    return {
        manifest: {
            releaseId: opts.releaseId,
            createdAt: opts.createdAt,
            parent: current.manifest.releaseId === 'empty' ? null : current.manifest.releaseId,
            batchIds: [...current.manifest.batchIds, staged.batchId],
            counts: { companies: companies.length, synthetic },
            changed: changed.sort(),
            removed: removed.sort(),
        },
        companies,
        slugHistory,
    }
}
