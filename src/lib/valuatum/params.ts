// Static-params TSV, as written by build/get_static_params (same format as
// the Danish site): fid, slug, name, sni, orgnr. One company per line.

import fs from 'node:fs'
import { parseOrgnr } from '../orgnr.ts'

export interface Param {
    fid: string
    name: string
    orgnr?: string
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
            return { fid: c[0], name: c[2] ?? '', orgnr: o && o.ok ? (o.orgnr as string) : undefined }
        })
}

export type BatchMode = 'changed' | 'listed' | 'all'

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
    const picked = new Set(mode === 'changed' ? changedLines.filter((l) => l.trim()) : [])
    const missing: string[] = []
    for (const token of companies.split(/[\s,;]+/).filter(Boolean)) {
        const o = parseOrgnr(token.replace(/K$/i, ''))
        const hits = o.ok
            ? rows.filter((l) => l.split('\t')[4]?.replace(/\D/g, '') === o.orgnr)
            : rows.filter((l) => l.split('\t')[0] === token)
        if (!hits.length) missing.push(token)
        hits.forEach((l) => picked.add(l))
    }
    if (missing.length) throw new Error(`not in the directory (staticparams.txt): ${missing.join(', ')}`)
    return rows.filter((l) => picked.has(l))
}
