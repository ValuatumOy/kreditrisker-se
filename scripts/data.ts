// Data publishing CLI.
//
//   npm run data:import  -- <file.jsonl|json> [--batch <id>]   validate, dedupe, stage, log rejects
//   npm run data:preview -- <batchId>                          noindex build of CURRENT + batch into dist-preview/
//   npm run data:publish -- <batchId> [--remove <orgnr,...>]   new immutable release, move CURRENT
//   npm run data:rollback [-- <releaseId>]                     move CURRENT to parent (or given id)
//   npm run data:status                                        releases, CURRENT, index eligibility

import { spawnSync } from 'node:child_process'
import { publishRelease, stageBatch } from '../src/lib/pipeline.ts'
import {
    currentReleaseId,
    listReleases,
    readBatchFile,
    readCurrentRelease,
    readRelease,
    readStaged,
    setCurrent,
    writeRelease,
    writeStaged,
} from '../src/lib/releaseio.ts'
import { buildSite } from '../src/lib/publish.ts'

const [cmd, ...args] = process.argv.slice(2)
const opt = (name: string) => {
    const i = args.indexOf(`--${name}`)
    return i === -1 ? undefined : args[i + 1]
}
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.(\d+)Z$/, '$1')

function fail(msg: string): never {
    console.error(`error: ${msg}`)
    process.exit(1)
}

switch (cmd) {
    case 'import': {
        const file = positional[0] ?? fail('give a batch file')
        const batchId = opt('batch') ?? `batch-${stamp()}`
        const staged = stageBatch(readBatchFile(file), { batchId, importedAt: new Date().toISOString(), current: readCurrentRelease() })
        const dir = writeStaged(staged)
        const d = staged.diff
        console.log(`staged ${batchId} -> ${dir}`)
        console.log(`  accepted ${staged.accepted.length}: ${d.added.length} new, ${d.updated.length} updated, ${d.unchanged.length} unchanged, ${d.renamed.length} renamed`)
        console.log(`  rejected ${staged.rejected.length} (see rejected.jsonl)`)
        for (const r of staged.rejected) console.log(`    row ${r.index} ${r.orgnr ?? '?'} [${r.kind}] ${r.errors[0]}${r.errors.length > 1 ? ` (+${r.errors.length - 1})` : ''}`)
        break
    }
    case 'publish': {
        const batchId = positional[0] ?? fail('give a staged batch id')
        const current = readCurrentRelease()
        const release = publishRelease(readStaged(batchId), current, {
            releaseId: `r-${stamp()}`,
            createdAt: new Date().toISOString(),
            remove: opt('remove')?.split(',').filter(Boolean),
        })
        writeRelease(release)
        setCurrent(release.manifest.releaseId)
        const m = release.manifest
        console.log(`published ${m.releaseId} (parent ${m.parent ?? 'none'}): ${m.counts.companies} companies, ${m.changed.length} changed, ${m.removed.length} removed`)
        break
    }
    case 'rollback': {
        const cur = currentReleaseId() ?? fail('no CURRENT release')
        const target = positional[0] ?? readRelease(cur).manifest.parent ?? fail(`${cur} has no parent release`)
        setCurrent(target)
        console.log(`CURRENT: ${cur} -> ${target}`)
        break
    }
    case 'status': {
        const cur = currentReleaseId()
        console.log(`CURRENT: ${cur ?? '(none; builds use data/fixtures)'}`)
        for (const id of listReleases()) {
            const m = readRelease(id).manifest
            console.log(`${id === cur ? '*' : ' '} ${id}  parent=${m.parent ?? '-'}  companies=${m.counts.companies}  synthetic=${m.counts.synthetic}  changed=${m.changed.length}`)
        }
        const site = buildSite(readCurrentRelease())
        const idx = site.companies.filter((c) => c.quality.indexable).length
        console.log(`profiles: ${site.companies.length} publishable, ${idx} pass the index threshold`)
        for (const c of site.companies.filter((c) => !c.quality.indexable))
            console.log(`  noindex ${c.record.orgnr} ${c.record.name}: ${c.quality.reasons.join('; ')}`)
        break
    }
    case 'preview': {
        const batchId = positional[0] ?? fail('give a staged batch id')
        readStaged(batchId)
        const res = spawnSync('npx', ['astro', 'build'], {
            stdio: 'inherit',
            shell: true,
            env: { ...process.env, SE_DATA_SOURCE: `staging:${batchId}`, SE_PREVIEW: '1', SE_INDEXING: '0', SE_OUT_DIR: 'dist-preview' },
        })
        if (res.status === 0) console.log('preview built in dist-preview/ (noindex). Serve with: SE_OUT_DIR=dist-preview npx astro preview')
        process.exit(res.status ?? 1)
    }
    default:
        fail('usage: data.ts import|preview|publish|rollback|status')
}
