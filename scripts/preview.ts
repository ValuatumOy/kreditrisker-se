// Local preview of specific companies, without Jenkins:
//   npm run preview:companies -- 556987-6542 900123 ...
// Arguments are orgnrs (looked up in BUILD_STATIC_PARAMS_FILE_ALL, default
// data/params/staticparams.txt) or fids. Fetches them from the API (or the
// cache), then starts the dev server on the result and prints their URLs.
// Earlier fetched companies stay in data/build/index.jsonl, so hubs fill up.

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { parseOrgnr } from '../src/lib/orgnr.ts'
import { readParams } from '../src/lib/valuatum/params.ts'

const args = process.argv.slice(2)
if (!args.length) {
    console.error('usage: npm run preview:companies -- <orgnr|fid> [...]')
    process.exit(1)
}
const allFile = process.env.BUILD_STATIC_PARAMS_FILE_ALL ?? path.join('data', 'params', 'staticparams.txt')
const all = fs.existsSync(allFile) ? readParams(allFile) : []
const fids = args.map((a) => {
    const o = parseOrgnr(a)
    if (!o.ok) return a
    const hit = all.find((p) => p.orgnr === o.orgnr)
    if (!hit) throw new Error(`${a}: not in ${allFile}; pass its fid instead`)
    return hit.fid
})

const dir = path.join('data', 'build')
fs.mkdirSync(dir, { recursive: true })
const batch = path.join(dir, 'preview-batch.txt')
fs.writeFileSync(batch, fids.map((f) => `${f}\t\t\t\t`).join('\n') + '\n')
const env = { ...process.env, BUILD_STATIC_PARAMS_FILE: batch, BUILD_STATIC_PARAMS_FILE_ALL: '' }
const fetched = spawnSync(process.execPath, [path.join('scripts', 'fetch.ts')], { env, stdio: 'inherit' })
if (fetched.status !== 0) process.exit(fetched.status ?? 1)

const port = process.env.PORT ?? '4321'
for (const line of fs.readFileSync(path.join(dir, 'pages.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const { path: p, record } = JSON.parse(line)
    console.log(`  ${record.name}: http://localhost:${port}${p}`)
}
spawn(`npx astro dev --port ${port}`, { env: { ...process.env, SE_DATA_SOURCE: 'build' }, stdio: 'inherit', shell: true })
