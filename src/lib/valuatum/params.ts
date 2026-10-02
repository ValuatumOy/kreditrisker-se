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
