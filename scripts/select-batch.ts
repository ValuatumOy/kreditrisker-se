// Writes the batch file of a build from the full directory list and the Jenkins job's COMPANIES
// parameter (see batchMode and selectBatch). Replaces the uploaded includeparams.txt of the Finnish job.
//
//   COMPANIES="556448-0282, 5565675906 123"  node scripts/select-batch.ts   only these companies
//   COMPANIES=""                             node scripts/select-batch.ts   changed (nightly)
//   COMPANIES=all                            node scripts/select-batch.ts   every company
//   COMPANIES=auto                           node scripts/select-batch.ts   bounded automatic selection
//
// Reads BUILD_STATIC_PARAMS_FILE_ALL and, when COMPANIES is empty, the BUILD_STATIC_PARAMS_FILE that
// get_static_params wrote (absent when nothing changed); overwrites BUILD_STATIC_PARAMS_FILE.

import fs from 'node:fs'
import { readJsonl } from '../src/lib/jsonl.ts'
import type { IndexRow } from '../src/lib/publish.ts'
import { assertBatchSize } from '../src/lib/valuatum/batch-limit.ts'
import { automaticBatch, batchMode, readParams, selectBatch, selectIndustryMix, type Param } from '../src/lib/valuatum/params.ts'

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [])
const allFile = process.env.BUILD_STATIC_PARAMS_FILE_ALL ?? 'staticparams.txt'
const batchFile = process.env.BUILD_STATIC_PARAMS_FILE ?? 'staticparams_batch.txt'
const companies = process.env.COMPANIES ?? ''
const newCompanies = /^new:(\d+)$/i.exec(companies.trim())
const mode = batchMode(companies)
const automatic = process.env.SE_AUTO_BATCH === '1' || companies.trim().toLowerCase() === 'auto'

const all = read(allFile)
if (!all.some((l) => l.trim())) throw new Error(`${allFile} is empty`)
let selection = companies
if (newCompanies || automatic) {
    const limit = newCompanies ? Number(newCompanies[1]) : undefined
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('new:N requires a positive batch size')
    if (limit !== undefined) assertBatchSize(limit)
    const previous = process.env.SE_INDEX_IN
    if (!previous) throw new Error('Bounded selection requires a previous production index')
    const rows = readJsonl<IndexRow>(previous)
    if (!rows.length) throw new Error('Bounded selection requires a nonempty production index')
    if (automatic) {
        selection = automaticBatch(readParams(allFile), rows).map((p) => p.fid).join(',')
    } else {
        const seen = new Set(rows.map((row) => row.o))
        const selected: Param[] = []
        for (const param of readParams(allFile)) {
            if (!param.orgnr || seen.has(param.orgnr)) continue
            seen.add(param.orgnr)
            selected.push(param)
        }
        selection = selectIndustryMix(selected, limit!).map((p) => p.fid).join(',')
    }
}
const batch = selectBatch(all, read(batchFile), automatic ? 'listed' : mode, selection)
assertBatchSize(batch.length)
fs.writeFileSync(batchFile, batch.map((l) => l + '\n').join(''))
console.log(`${automatic ? 'automatic' : newCompanies ? 'new profiles' : mode}: ${batch.length} of ${all.filter((l) => l.trim()).length} directory rows in ${batchFile}`)
if (automatic || newCompanies) {
    const codes = batch.map((line) => line.split('\t')[3]).filter((code) => /^\d{5}$/.test(code) && code !== '00000')
    const divisions = new Set(codes.map((code) => code.slice(0, 2)))
    console.log(`industry coverage: ${codes.length} assigned codes across ${divisions.size} SNI divisions`)
}
for (const l of batch.slice(0, 10)) console.log('  ' + l.split('\t').filter((_, i) => i !== 1).join('  '))
if (batch.length > 10) console.log(`  ... ${batch.length - 10} more`)
