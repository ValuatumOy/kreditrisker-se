// Static-params TSV, as written by build/get_static_params: fid, slug, name, sni, orgnr
// (as on the Danish site), then the model's last save time (epoch ms). One company per line.

import fs from 'node:fs'
import { parseOrgnr } from '../orgnr.ts'
import type { IndexRow } from '../publish.ts'

export interface Param {
    fid: string
    name: string
    orgnr?: string
    /** Raw industry code from the directory TSV; unknown/unallocated codes remain selectable. */
    sni?: string
    /** When the model was last saved in Valuatum (ISO), absent in files without the column. */
    updatedAt?: string
}

export const AUTOMATIC_BATCH_SIZE = 3_000

/** Reserve 80% for five-digit nonzero SNI codes, spread across two-digit divisions. */
export function selectIndustryMix(params: Param[], limit: number, slot = Math.floor(Date.now() / 1_800_000)): Param[] {
    const known = params.filter((p) => /^\d{5}$/.test(p.sni ?? '') && !/^0+$/.test(p.sni!))
    const knownIds = new Set(known.map((p) => p.fid))
    const unknown = params.filter((p) => !knownIds.has(p.fid)).sort((a, b) => a.orgnr!.localeCompare(b.orgnr!))
    const quota = (phase: number) => {
        const reserved = Math.floor((phase + 1) * limit / 5) - Math.floor(phase * limit / 5)
        let k = Math.min(known.length, limit - reserved)
        const u = Math.min(unknown.length, limit - k)
        k = Math.min(known.length, limit - u)
        return [k, u]
    }
    const quotas = Array.from({ length: 5 }, (_, phase) => quota(phase))
    const phase = slot % 5
    const before = (kind: number) => Math.floor(slot / 5) * quotas.reduce((sum, q) => sum + q[kind], 0)
        + quotas.slice(0, phase).reduce((sum, q) => sum + q[kind], 0)
    const [knownCount, unknownCount] = quotas[phase]
    const sectors = new Map<string, Param[]>()
    for (const param of known) {
        const sector = param.sni!.slice(0, 2)
        const group = sectors.get(sector) ?? []
        group.push(param)
        sectors.set(sector, group)
    }
    const groups = [...sectors].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group.sort((a, b) => a.orgnr!.localeCompare(b.orgnr!)))
    const selected: Param[] = []
    const used = groups.map(() => 0)
    const start = before(0)
    for (let request = start; selected.length < knownCount; request++) {
        const sector = request % groups.length
        const group = groups[sector]
        if (used[sector] >= group.length) continue
        selected.push(group[Math.floor(request / groups.length) % group.length])
        used[sector]++
    }
    const unknownStart = before(1)
    for (let i = 0; i < unknownCount; i++) selected.push(unknown[(unknownStart + i) % unknown.length])
    return selected
}

/** Half existing legacy/changed profiles, half unpublished; use spare capacity for either backlog. */
export function automaticBatch(params: Param[], rows: Pick<IndexRow, 'o' | 'rv'>[], limit = AUTOMATIC_BATCH_SIZE, slot = Math.floor(Date.now() / 1_800_000)): Param[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Automatic batch size must be positive')
    const previous = new Map(rows.map((r) => [r.o, r]))
    const seen = new Set<string>()
    const existing: Param[] = []
    const unpublished: Param[] = []
    for (const param of params) {
        if (!param.orgnr || seen.has(param.orgnr)) continue
        seen.add(param.orgnr)
        const row = previous.get(param.orgnr)
        if (!row) unpublished.push(param)
        else if (row.rv === undefined || row.rv !== (param.updatedAt ?? null)) existing.push(param)
    }
    const singleMixed = limit === 1 && existing.length > 0 && unpublished.length > 0
    let existingCount = Math.min(existing.length, singleMixed ? 1 - slot % 2 : Math.ceil(limit / 2))
    const newCount = Math.min(unpublished.length, limit - existingCount)
    existingCount = Math.min(existing.length, limit - newCount)
    // Each one-company cohort gets its own consecutive turns, including unknown-code turns.
    const turn = singleMixed ? Math.floor(slot / 2) : slot
    return [...selectIndustryMix(existing, existingCount, turn), ...selectIndustryMix(unpublished, newCount, turn)]
}

export function readParams(file: string): Param[] {
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.split('\t'))
        .filter((c) => !c[4]?.trim().endsWith('K')) // group accounts ("K" codes) are not separate pages, as on the Finnish site
        .map((c) => {
            const o = c[4] && parseOrgnr(c[4])
            const ms = Number(c[5])
            const p: Param = { fid: c[0], name: c[2] ?? '', orgnr: o && o.ok ? (o.orgnr as string) : undefined }
            if (c[3]?.trim()) p.sni = c[3].trim()
            if (ms > 0) p.updatedAt = new Date(ms).toISOString()
            return p
        })
}

export type BatchMode = 'changed' | 'listed' | 'all'

/**
 * The batch mode the Jenkins job's single COMPANIES field asks for: empty is the nightly run
 * (changed), the word `all` rebuilds every company, anything else builds only the listed ones.
 */
export function batchMode(companies: string): BatchMode {
    const c = companies.trim()
    if (!c) return 'changed'
    return c.toLowerCase() === 'all' ? 'all' : 'listed'
}

/**
 * The batch lines (static-params TSV rows) for a build, chosen from the full directory list:
 *   changed  the companies get_static_params found updated (its batch file) plus `companies`
 *   listed   only `companies`
 *   all      every company
 * `companies` is free text, as typed into the Jenkins job: organisationsnummer with or without the
 * hyphen, or followed-model ids (fid), separated by commas, spaces or new lines. An orgnr also
 * selects the company's group-account row (K), as the Finnish job pairs parent and group.
 * Throws when a requested company is not in the directory, rather than silently building less.
 */
export function selectBatch(allLines: string[], changedLines: string[], mode: BatchMode, companies: string): string[] {
    const rows = allLines.filter((l) => l.trim())
    if (mode === 'all') return rows
    // By fid, not by line: the save-time column can differ between the two queries.
    const fid = (l: string) => l.split('\t')[0]
    const picked = new Set(mode === 'changed' ? changedLines.filter((l) => l.trim()).map(fid) : [])
    const missing: string[] = []
    const byOrgnr = new Map<string, string[]>()
    const byFid = new Set<string>()
    for (const row of rows) {
        const columns = row.split('\t')
        const id = columns[0]
        byFid.add(id)
        const orgnr = columns[4]?.replace(/\D/g, '')
        if (orgnr) {
            const ids = byOrgnr.get(orgnr) ?? []
            ids.push(id)
            byOrgnr.set(orgnr, ids)
        }
    }
    for (const token of companies.split(/[\s,;]+/).filter(Boolean)) {
        const o = parseOrgnr(token.replace(/K$/i, ''))
        const hits = o.ok
            ? (byOrgnr.get(o.orgnr) ?? [])
            : (byFid.has(token) ? [token] : [])
        if (!hits.length) missing.push(token)
        hits.forEach((id) => picked.add(id))
    }
    if (missing.length) throw new Error(`not in the directory (staticparams.txt): ${missing.join(', ')}`)
    return rows.filter((l) => picked.has(fid(l)))
}
