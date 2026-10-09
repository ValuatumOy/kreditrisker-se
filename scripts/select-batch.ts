// Writes the batch file of a build from the full directory list and the Jenkins job's COMPANIES
// parameter (see batchMode and selectBatch). Replaces the uploaded includeparams.txt of the Finnish job.
//
//   COMPANIES="556448-0282, 5565675906 123"  node scripts/select-batch.ts   only these companies
//   COMPANIES=""                             node scripts/select-batch.ts   changed (nightly)
//   COMPANIES=all                            node scripts/select-batch.ts   every company
//
// Reads BUILD_STATIC_PARAMS_FILE_ALL and, when COMPANIES is empty, the BUILD_STATIC_PARAMS_FILE that
// get_static_params wrote (absent when nothing changed); overwrites BUILD_STATIC_PARAMS_FILE.

import fs from 'node:fs'
import { batchMode, selectBatch } from '../src/lib/valuatum/params.ts'

const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [])
const allFile = process.env.BUILD_STATIC_PARAMS_FILE_ALL ?? 'staticparams.txt'
const batchFile = process.env.BUILD_STATIC_PARAMS_FILE ?? 'staticparams_batch.txt'
const companies = process.env.COMPANIES ?? ''
const mode = batchMode(companies)

const all = read(allFile)
if (!all.some((l) => l.trim())) throw new Error(`${allFile} is empty`)
const batch = selectBatch(all, read(batchFile), mode, companies)
fs.writeFileSync(batchFile, batch.map((l) => l + '\n').join(''))
console.log(`${mode}: ${batch.length} of ${all.filter((l) => l.trim()).length} directory rows in ${batchFile}`)
for (const l of batch.slice(0, 10)) console.log('  ' + l.split('\t').filter((_, i) => i !== 1).join('  '))
if (batch.length > 10) console.log(`  ... ${batch.length - 10} more`)
