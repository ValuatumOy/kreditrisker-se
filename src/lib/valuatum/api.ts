// Build-time client for the Swedish Valuatum REST API (same API as the
// Danish directory, own backend and token):
//   POST /rest/modeldata          yearly figures for a followed model (fid)
//   GET  /rest/company/:id        register data for the company
// Each response pair is trimmed to the variables the mapper reads and cached
// as data/api-cache/<fid>.json. With a warm cache no API access is needed,
// which is how Vercel previews build the committed sample.

import fs from 'node:fs'
import path from 'node:path'
import { USED_VARS } from './map.ts'

export interface ModelData {
    followedModelId: number
    companyName: string
    companyId: number | string
    companyCode: string
    currency: string
    dataMap: Record<string, Record<string, number | string>>
}

export interface ApiCompany {
    companyId: number | string
    companyName: string
    companyCode: string
    industryCode?: string
    industryText?: string
    industryTree?: { nace: string; name: Record<string, string> }
    models: { followedModelId: number | string; analystName: string }[]
    companyData?: Record<string, string | undefined>
}

export interface Bundle {
    fid: string
    retrievedAt: string
    modeldata: ModelData
    companies: ApiCompany[]
}

export const cacheDir = () => process.env.SE_API_CACHE_DIR ?? path.join(process.cwd(), 'data', 'api-cache')

async function call<T>(urlPath: string, init: RequestInit = {}): Promise<T> {
    const base = process.env.PUBLIC_VALUATUM_API_BASE_URL
    const token = process.env.SECRET_VALUATUM_API_TOKEN
    if (!base || !token) throw new Error('PUBLIC_VALUATUM_API_BASE_URL and SECRET_VALUATUM_API_TOKEN must be set to fetch uncached companies')
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(base.replace(/\/$/, '') + urlPath, {
                ...init,
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                signal: AbortSignal.timeout(60_000),
            })
            if (res.ok) return (await res.json()) as T
            const body = (await res.text()).slice(0, 300)
            if (res.status < 500 || attempt >= 4) throw new Error(`${init.method ?? 'GET'} ${urlPath}: HTTP ${res.status} ${body}`)
        } catch (e) {
            if (attempt >= 4 || (e instanceof Error && e.message.includes('HTTP 4'))) throw e
        }
        await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
}

function trim(md: ModelData): ModelData {
    const dataMap: ModelData['dataMap'] = {}
    for (const [pos, row] of Object.entries(md.dataMap)) {
        if (!/^\d{4}$/.test(pos)) continue // full years only; quarters and the terminal year "0" are not shown
        dataMap[pos] = Object.fromEntries(Object.entries(row).filter(([k]) => USED_VARS.has(k)))
    }
    return { followedModelId: md.followedModelId, companyName: md.companyName, companyId: md.companyId, companyCode: md.companyCode, currency: md.currency, dataMap }
}

/** Returns null when the model has no financial statements. */
export async function fetchBundle(fid: string): Promise<Bundle | null> {
    const file = path.join(cacheDir(), `${fid}.json`)
    if (process.env.SE_API_REFRESH !== '1' && fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
    const res = await call<Record<string, ModelData>>('/rest/modeldata', {
        method: 'POST',
        body: JSON.stringify({ fids: [Number(fid)], varPoses: [], includeHistoryData: true, includeEstimates: false }),
    })
    const md = res[fid]
    if (!md || !Object.keys(md.dataMap ?? {}).length) return null
    const companies = await call<ApiCompany[]>(`/rest/company/${md.companyId}?includecorresponding=true`)
    const bundle: Bundle = {
        fid,
        retrievedAt: new Date().toISOString().slice(0, 10),
        modeldata: trim(md),
        // Board members are personal data and not published (launch gate 3); only the industry name is kept.
        companies: companies.map(({ industryTree, ...c }) => ({
            ...c,
            industryTree: industryTree && { nace: industryTree.nace, name: industryTree.name },
            companyData: { ...c.companyData, participants: undefined },
        })),
    }
    fs.mkdirSync(cacheDir(), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(bundle))
    return bundle
}

/** Runs f over items with at most n in flight, keeping order. */
export async function mapLimit<T, R>(items: T[], n: number, f: (t: T) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length)
    let next = 0
    await Promise.all(
        Array.from({ length: Math.min(n, items.length) }, async () => {
            while (next < items.length) {
                const i = next++
                out[i] = await f(items[i])
            }
        }),
    )
    return out
}
