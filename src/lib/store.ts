// Build-time data access. Chooses the dataset from SE_DATA_SOURCE:
//   (unset)              CURRENT release, or the synthetic fixtures if none
//   fixtures             data/fixtures/synthetic-batch-001.jsonl
//   release:<id>         a specific release
//   staging:<batchId>    CURRENT + a staged batch (preview builds)
//   build                data/build/ written by scripts/fetch.ts: pages for the
//                        batch, index rows for the whole directory (API builds)

import fs from 'node:fs'
import path from 'node:path'
import { publishRelease, stageBatch, emptyRelease, type Release } from './pipeline.ts'
import { currentReleaseId, readBatchFile, readCurrentRelease, readRelease, readStaged } from './releaseio.ts'
import { buildSite, siteFromRelease, type IndexRow, type Site } from './publish.ts'
import type { PublishedCompany } from './contract/types.ts'

export const BUILD_DIR = path.join(process.cwd(), 'data', 'build')

export function fixtureRelease(): Release {
    const raw = readBatchFile(path.join(process.cwd(), 'data', 'fixtures', 'synthetic-batch-001.jsonl'))
    const staged = stageBatch(raw, { batchId: 'fixtures', importedAt: '2026-09-01T00:00:00Z', current: emptyRelease() })
    return publishRelease(staged, emptyRelease(), { releaseId: 'fixtures', createdAt: '2026-09-01T00:00:00Z' })
}

export function loadRelease(source = process.env.SE_DATA_SOURCE): Release {
    if (source === 'fixtures') return fixtureRelease()
    if (source?.startsWith('release:')) return readRelease(source.slice(8))
    if (source?.startsWith('staging:')) {
        const current = readCurrentRelease()
        return publishRelease(readStaged(source.slice(8)), current, { releaseId: `preview-${source.slice(8)}`, createdAt: new Date().toISOString() })
    }
    return currentReleaseId() ? readCurrentRelease() : fixtureRelease()
}

export const readJsonl = <T>(file: string): T[] =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : []

function buildFromFetch(): Site {
    const pages = readJsonl<PublishedCompany>(path.join(BUILD_DIR, 'pages.jsonl'))
    const rows = readJsonl<IndexRow>(path.join(BUILD_DIR, 'index.jsonl'))
    if (!rows.length) throw new Error('SE_DATA_SOURCE=build but data/build/index.jsonl is empty; run scripts/fetch.ts first')
    return buildSite(pages, rows, 'build')
}

let cached: Site | undefined
export function getSite(): Site {
    return (cached ??= process.env.SE_DATA_SOURCE === 'build' ? buildFromFetch() : siteFromRelease(loadRelease()))
}

/** Synthetic fixtures for demonstrations (home preview, sample reports), whatever the live dataset is. */
let demo: Site | undefined
export function getDemoSite(): Site {
    return (demo ??= siteFromRelease(fixtureRelease()))
}
