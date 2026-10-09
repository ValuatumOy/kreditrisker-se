// Vercel build (test previews; production runs on AWS via Jenkins).
// Renders the committed sample in data/sample/ from its cached API responses,
// so previews need no API access. Without a sample, builds the synthetic fixtures.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const sample = path.join('data', 'sample', 'staticparams.txt')
const run = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ...env } })
    if (r.status !== 0) process.exit(r.status ?? 1)
}

if (fs.existsSync(sample) && fs.readFileSync(sample, 'utf8').trim()) {
    run([path.join('scripts', 'fetch.ts')], {
        BUILD_STATIC_PARAMS_FILE: sample,
        SE_API_CACHE_DIR: path.join('data', 'sample', 'api-cache'),
        SE_INDEX_IN: path.join('data', 'sample', 'none.jsonl'),
    })
    run([path.join('node_modules', 'astro', 'bin', 'astro.mjs'), 'build'], { SE_DATA_SOURCE: 'build' })
} else {
    run([path.join('node_modules', 'astro', 'bin', 'astro.mjs'), 'build'])
}
