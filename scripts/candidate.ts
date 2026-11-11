import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { candidateConfig, createPlan, readPlan, runNext, stageCandidate, verifyCandidate, writePlan } from './lib/candidate.ts'

const repo = path.resolve(import.meta.dirname, '..')
const [command, ...args] = process.argv.slice(2)
const options = new Map<string, string>()
for (let i = 0; i < args.length; i += 2) {
    if (!['--snapshot', '--out', '--seed-index', '--batch-size', '--plan'].includes(args[i]) || !args[i + 1]) throw new Error('Use --snapshot file --out directory [--seed-index file] [--batch-size number], or --plan directory')
    if (options.has(args[i])) throw new Error(`Duplicate option: ${args[i]}`)
    options.set(args[i], args[i + 1])
}
const required = (key: string): string => {
    const value = options.get(key)
    if (!value) throw new Error(`${key} is required`)
    return path.resolve(value)
}
const revision = () => {
    if (fs.readdirSync(repo).some((name) => /^\.env($|\.)/.test(name) && !/\.(example|sample)$/.test(name))) throw new Error('Candidate builds require environment variables, not unpinned local .env files')
    if (execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim()) throw new Error('Use a clean, dedicated git checkout for a candidate build')
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}
const outsideRepo = (directory: string) => {
    const resolved = fs.existsSync(directory) ? fs.realpathSync(directory) : path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory))
    const relative = path.relative(fs.realpathSync(repo), resolved)
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('Candidate output must be outside the repository and its public/build directories')
}

if (command === 'plan') {
    const out = required('--out')
    outsideRepo(out)
    const prepared = createPlan(
        fs.readFileSync(required('--snapshot'), 'utf8'),
        options.has('--seed-index') ? fs.readFileSync(required('--seed-index'), 'utf8') : '',
        { revision: revision(), config: candidateConfig(process.env) },
        options.has('--batch-size') ? Number(options.get('--batch-size')) : undefined,
    )
    writePlan(out, prepared)
    console.log(`Frozen ${prepared.plan.companies} companies / ${prepared.plan.rows} rows into ${prepared.plan.batches.length} batches. No data fetched or pages generated. Plan: ${out}`)
} else if (command === 'fetch-next' || command === 'build-next') {
    const directory = required('--plan')
    outsideRepo(directory)
    const { plan } = readPlan(directory)
    const context = { revision: revision(), config: candidateConfig(process.env, process.env.SE_DATA_AS_OF || plan.config.SE_DATA_AS_OF) }
    const run = (file: string, env: NodeJS.ProcessEnv) => execFileSync(process.execPath, [file], { cwd: repo, env, stdio: 'inherit' })
    const result = runNext(repo, directory, context, command === 'fetch-next' ? 'fetched' : 'rendered', {
        fetch: (env) => run(path.join(repo, 'scripts', 'fetch.ts'), env),
        build: (env) => execFileSync(process.execPath, [path.join(repo, 'node_modules', 'astro', 'bin', 'astro.mjs'), 'build'], { cwd: repo, env, stdio: 'inherit' }),
    }, process.env)
    console.log(`Private candidate batch ${result.batch + 1}/${result.total} complete. Nothing deployed. Each invocation handles one batch only.`)
} else if (command === 'stage') {
    const directory = required('--plan')
    const out = required('--out')
    outsideRepo(directory)
    outsideRepo(out)
    const relative = path.relative(directory, out)
    if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw new Error('Stage output must be outside the plan directory')
    console.log(JSON.stringify(stageCandidate(directory, out), null, 2))
} else if (command === 'verify') {
    const directory = required('--plan')
    outsideRepo(directory)
    console.log(JSON.stringify(verifyCandidate(directory), null, 2))
    console.log('All planned company pages and index entries are present in the private batch outputs. This is not a production deployment or a 500,000-company capacity test.')
} else {
    throw new Error('Commands: plan --snapshot file --out directory [--seed-index file] [--batch-size 1000]; fetch-next --plan directory; build-next --plan directory; verify --plan directory; stage --plan directory --out new-directory. See docs/CANDIDATE-BUILDS.md.')
}
