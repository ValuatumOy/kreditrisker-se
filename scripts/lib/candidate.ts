import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { isDeepStrictEqual } from 'node:util'
import { staticUrls, hubUrls } from '../../src/lib/sitemap.ts'
import { buildSite, toRow, type IndexRow } from '../../src/lib/publish.ts'
import { readParams } from '../../src/lib/valuatum/params.ts'
import { parseOrgnr } from '../../src/lib/orgnr.ts'
import { assertBatchSize, fetchConcurrency } from '../../src/lib/valuatum/batch-limit.ts'

const VERSION = 3
const CONFIG_KEYS = ['SE_COMPANY_SITEMAP', 'SE_FETCH_CONCURRENCY', 'SE_INDEXING', 'SE_HTML_FINAL', 'SE_PREVIEW', 'SE_PREVIEW_FIXTURE', 'SE_SITE_NAME', 'SE_SITE_ORIGIN', 'SE_CONTACT_EMAIL', 'SE_PUBLISH_SOLE_TRADERS', 'SE_PUBLIC_MODEL_OUTPUT', 'SE_REPORT_BASIC', 'SE_REPORT_AI', 'SE_CHECKOUT', 'SE_TERMS_VERSION', 'PUBLIC_SE_REPORT_ADAPTER', 'PUBLIC_SE_REPORT_API', 'PUBLIC_SE_SEARCH_ENDPOINT', 'PUBLIC_GA_TRACKING_ID', 'PUBLIC_GA_FRAME_ORIGIN', 'PUBLIC_VALUATUM_API_BASE_URL']
export type Context = { revision: string; config: Record<string, string> }
type Row = { line: string; fid: string; orgnr: string; group: boolean }
type Batch = { file: string; sha256: string; rows: number; companies: number }
export type Plan = Context & { version: number; nodeVersion: string; snapshotSha256: string; fullSnapshotSha256: string; seedSha256: string; rows: number; companies: number; directoryCompanies: number; batchSize: number; batches: Batch[] }
type PagePath = { orgnr: string; path: string }
export type BuildSteps = { fetch(env: NodeJS.ProcessEnv): void; build(env: NodeJS.ProcessEnv): void }

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const fileHash = (file: string): string => {
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(1024 * 1024)
    const fd = fs.openSync(file, 'r')
    try { for (let n: number; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)) }
    finally { fs.closeSync(fd) }
    return hash.digest('hex')
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
const batchName = (i: number) => String(i).padStart(5, '0')

export function candidateConfig(env: NodeJS.ProcessEnv, asOf = env.SE_DATA_AS_OF || new Date().toISOString().slice(0, 10)): Record<string, string> {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(asOf) && !Number.isNaN(Date.parse(asOf)) && new Date(asOf).toISOString().slice(0, 10) === asOf, 'Candidate freshness date must be an ISO date')
    if (env.SE_INDEXING === '1' || env.SE_INDEXING?.toLowerCase() === 'true') assert(env.SE_COMPANY_SITEMAP === '1' || env.SE_COMPANY_SITEMAP?.toLowerCase() === 'true', 'Indexable candidate requires explicit SE_COMPANY_SITEMAP=1; do not inherit the temporary production sitemap restriction')
    const origin = (env.SE_SITE_ORIGIN || 'https://www.kreditrisker.se').replace(/\/$/, '')
    const url = new URL(origin)
    assert(['https:', 'http:'].includes(url.protocol) && url.origin === origin && !url.username && !url.password, 'SE_SITE_ORIGIN must be a valid HTTP(S) origin without a path or credentials')
    return Object.fromEntries([...CONFIG_KEYS.map((key) => [key, env[key] ?? '']), ['SE_SITE_ORIGIN', origin], ['SE_FETCH_CONCURRENCY', String(fetchConcurrency(env.SE_FETCH_CONCURRENCY))], ['SE_DATA_AS_OF', asOf]])
}

function rowsOf(text: string): Row[] {
    const fids = new Set<string>()
    const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const columns = line.split('\t')
        const code = columns[4]?.trim() ?? ''
        const group = /K$/i.test(code)
        const parsed = parseOrgnr(code.replace(/K$/i, ''))
        assert(/^[1-9]\d*$/.test(columns[0]) && !fids.has(columns[0]), `Missing, invalid or duplicate fid: ${columns[0]}`)
        assert(parsed.ok && parsed.kind === 'legal_person', `Candidate snapshot requires a valid legal-person orgnr: ${code}`)
        fids.add(columns[0])
        columns[4] = parsed.orgnr + (group ? 'K' : '')
        return { line: columns.join('\t'), fid: columns[0], orgnr: parsed.orgnr, group }
    })
    const bases = new Set<string>()
    for (const row of rows) if (!row.group) {
        assert(!bases.has(row.orgnr), `More than one base model for ${row.orgnr}`)
        bases.add(row.orgnr)
    }
    for (const row of rows) assert(bases.has(row.orgnr), `Group model has no base model: ${row.orgnr}`)
    return rows.sort((a, b) => a.orgnr < b.orgnr ? -1 : a.orgnr > b.orgnr ? 1 : Number(a.group) - Number(b.group) || (a.fid < b.fid ? -1 : a.fid > b.fid ? 1 : 0))
}

function* jsonLines(file: string): Generator<any> {
    const fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(1024 * 1024)
    const decoder = new StringDecoder('utf8')
    let rest = ''
    try {
        for (let n: number; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) {
            const lines = (rest + decoder.write(buffer.subarray(0, n))).split('\n')
            rest = lines.pop()!
            for (const line of lines) if (line.trim()) yield JSON.parse(line)
        }
        rest += decoder.end()
        if (rest.trim()) yield JSON.parse(rest)
    } finally { fs.closeSync(fd) }
}

export function createPlan(snapshot: string, seed: string, context: Context, batchSize = 1_000, fullSnapshot = snapshot): { plan: Plan; files: Map<string, string> } {
    assertBatchSize(batchSize)
    assert(batchSize > 0, 'Batch size must be positive')
    assert(/^[a-f0-9]{40}$/.test(context.revision), 'A full git revision is required')
    const rows = rowsOf(snapshot)
    assert(rows.length > 0, 'Snapshot is empty')
    const expected = new Set(rows.filter((r) => !r.group).map((r) => r.orgnr))
    const full = rowsOf(fullSnapshot)
    const directory = new Set(full.filter((r) => !r.group).map((r) => r.orgnr))
    const fullByFid = new Map(full.map((r) => [r.fid, r.line]))
    for (const row of rows) assert(fullByFid.get(row.fid) === row.line, `Selected row outside full snapshot or changed: ${row.fid}`)
    const selectedFids = new Set(rows.map((r) => r.fid))
    for (const row of full) if (expected.has(row.orgnr)) assert(selectedFids.has(row.fid), `Selection omitted a parent/group row: ${row.fid}`)
    const seedRows = seed.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l))
    const seen = new Set<string>()
    for (const row of seedRows) {
        assert(typeof row.o === 'string' && directory.has(row.o) && !seen.has(row.o), `Seed index has a duplicate or non-directory company: ${String(row.o)}`)
        assert(typeof row.p === 'string' && new RegExp(`^/foretag/${row.o}/[a-z0-9-]+/$`).test(row.p) && Array.isArray(row.rf) && row.rf.every((p: unknown) => typeof p === 'string' && new RegExp(`^/foretag/${row.o}/[a-z0-9-]+/$`).test(p)), `Seed index lacks valid canonical/redirect paths: ${row.o}`)
        assert(typeof row.n === 'string' && row.n.length > 0 && typeof row.ix === 'boolean' && typeof row.q === 'boolean' && row.syn === false && ['active', 'liquidation', 'bankruptcy', 'reconstruction', 'deregistered', 'unknown'].includes(row.st) && ['current', 'aging', 'stale', 'none'].includes(row.fr) && /^\d{4}-\d{2}-\d{2}$/.test(row.im), `Invalid seed index row: ${row.o}`)
        seen.add(row.o)
    }
    for (const orgnr of directory) assert(expected.has(orgnr) || seen.has(orgnr), `Nonselected company has no seed index record: ${orgnr}`)
    const chunks: Row[][] = []
    let chunk: Row[] = []
    for (let i = 0; i < rows.length;) {
        let end = i + 1
        while (end < rows.length && rows[end].orgnr === rows[i].orgnr) end++
        const group = rows.slice(i, end)
        assert(group.length <= batchSize, `Company ${rows[i].orgnr} exceeds the batch row limit`)
        if (chunk.length + group.length > batchSize) { chunks.push(chunk); chunk = [] }
        chunk.push(...group)
        i = end
    }
    if (chunk.length) chunks.push(chunk)
    const files = new Map<string, string>()
    const canonical = rows.map((r) => r.line + '\n').join('')
    const canonicalSeed = seedRows.map((r) => JSON.stringify(r) + '\n').join('')
    const canonicalFull = full.map((r) => r.line + '\n').join('')
    files.set('snapshot.txt', canonical)
    files.set('full-snapshot.txt', canonicalFull)
    files.set('seed-index.jsonl', canonicalSeed)
    const batches = chunks.map((chunk, i) => {
        const file = `batch-${batchName(i)}.txt`
        const text = chunk.map((r) => r.line + '\n').join('')
        files.set(file, text)
        return { file, sha256: sha256(text), rows: chunk.length, companies: chunk.filter((r) => !r.group).length }
    })
    return { plan: { version: VERSION, nodeVersion: process.versions.node, ...context, snapshotSha256: sha256(canonical), fullSnapshotSha256: sha256(canonicalFull), directoryCompanies: directory.size, seedSha256: sha256(canonicalSeed), rows: rows.length, companies: expected.size, batchSize, batches }, files }
}

export function writePlan(directory: string, prepared: ReturnType<typeof createPlan>): void {
    fs.mkdirSync(directory) // Existing plans are immutable; never overwrite one.
    for (const [file, contents] of prepared.files) fs.writeFileSync(path.join(directory, file), contents, { flag: 'wx' })
    const text = json(prepared.plan)
    fs.writeFileSync(path.join(directory, 'plan.json'), text, { flag: 'wx' })
    fs.writeFileSync(path.join(directory, 'plan.sha256'), sha256(text) + '\n', { flag: 'wx' })
}

export function readPlan(directory: string, context?: Context): { plan: Plan; hash: string } {
    const text = fs.readFileSync(path.join(directory, 'plan.json'), 'utf8')
    const hash = sha256(text)
    assert(fs.readFileSync(path.join(directory, 'plan.sha256'), 'utf8').trim() === hash, 'Plan checksum changed')
    const plan: Plan = JSON.parse(text)
    assert(plan.version === VERSION, 'Unknown candidate plan version')
    assert(plan.nodeVersion === process.versions.node, 'Node version differs from the frozen plan')
    if (context) {
        assert(plan.revision === context.revision, 'Git revision differs from the frozen plan')
        assert(JSON.stringify(plan.config) === JSON.stringify(context.config), 'Build configuration differs from the frozen plan')
    }
    const prepared = createPlan(fs.readFileSync(path.join(directory, 'snapshot.txt'), 'utf8'), fs.readFileSync(path.join(directory, 'seed-index.jsonl'), 'utf8'), { revision: plan.revision, config: plan.config }, plan.batchSize, fs.readFileSync(path.join(directory, 'full-snapshot.txt'), 'utf8'))
    assert(JSON.stringify(prepared.plan) === JSON.stringify(plan), 'Snapshot, seed index or batch manifest changed')
    for (const batch of plan.batches) assert(fileHash(path.join(directory, batch.file)) === batch.sha256, `Batch checksum changed: ${batch.file}`)
    return { plan, hash }
}

function treeHash(directory: string): string {
    const hash = createHash('sha256')
    const visit = (folder: string) => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const absolute = path.join(folder, entry.name)
            assert(!entry.isSymbolicLink(), `Symlink in candidate output: ${absolute}`)
            if (entry.isDirectory()) visit(absolute)
            else if (entry.isFile()) hash.update(path.relative(directory, absolute).replaceAll('\\', '/') + '\0' + fileHash(absolute) + '\n')
        }
    }
    visit(directory)
    return hash.digest('hex')
}

function checkPaths(pagesFile: string, dist: string, expected: Set<string>, origin: string): PagePath[] {
    const paths: PagePath[] = []
    const seen = new Set<string>()
    for (const page of jsonLines(pagesFile)) {
        const orgnr = page.record?.orgnr
        assert(expected.has(orgnr) && !seen.has(orgnr), `Unexpected or duplicate page: ${String(orgnr)}`)
        assert(typeof page.path === 'string' && /^\/foretag\/\d{10}\/[a-z0-9-]+\/$/.test(page.path) && page.path.split('/')[2] === orgnr, `Invalid company path: ${String(page.path)}`)
        assert(fs.statSync(path.join(dist, page.path.slice(1), 'index.html'), { throwIfNoEntry: false })?.size, `Missing built company page: ${page.path}`)
        assert(fs.statSync(path.join(dist, 'foretag', orgnr, 'index.html'), { throwIfNoEntry: false })?.size, `Missing orgnr redirect: ${orgnr}`)
        const html = read(path.join(dist, page.path.slice(1), 'index.html'))
        assert(html.includes(`rel="canonical" href="${origin + page.path}"`), `Built page canonical differs: ${page.path}`)
        for (const route of [`/foretag/${orgnr}/`, ...(page.redirectsFrom ?? [])]) {
            const redirect = read(path.join(dist, route.slice(1), 'index.html'))
            assert(redirect.includes(`rel="canonical" href="${origin + page.path}"`) && redirect.includes(`http-equiv="refresh" content="0;url=${page.path}"`), `Invalid redirect destination: ${route}`)
        }
        seen.add(orgnr)
        paths.push({ orgnr, path: page.path })
    }
    assert(seen.size === expected.size, `Expected ${expected.size} pages, built ${seen.size}`)
    return paths.sort((a, b) => a.orgnr < b.orgnr ? -1 : 1)
}

function checkIndex(file: string, expected: Map<string, IndexRow>): void {
    const seen = new Set<string>()
    for (const row of jsonLines(file)) {
        assert(typeof row.o === 'string' && expected.has(row.o) && !seen.has(row.o) && isDeepStrictEqual(expected.get(row.o), row), `Candidate index has a missing, duplicate or mismatched page: ${String(row.o)}`)
        seen.add(row.o)
    }
    assert(seen.size === expected.size, `Candidate index coverage differs: ${seen.size}/${expected.size}`)
}


function expectedIndex(previous: string, pages: string, full: string): Map<string, IndexRow> {
    const rows = new Map<string, IndexRow>()
    for (const row of jsonLines(previous)) rows.set(row.o, row)
    for (const page of jsonLines(pages)) rows.set(page.record.orgnr, toRow(page))
    const saved = new Map(readParams(full).filter((p) => p.orgnr && p.updatedAt).map((p) => [p.orgnr!, p.updatedAt!]))
    for (const row of rows.values()) if (saved.has(row.o)) row.up = saved.get(row.o)
    return rows
}

type Checkpoint = { plan: string; previous: string | null; input: string; tree: string }
type Phase = 'fetched' | 'rendered'
const read = (file: string) => fs.readFileSync(file, 'utf8')
const batchCompanies = (directory: string, plan: Plan, i: number) => new Set(rowsOf(read(path.join(directory, plan.batches[i].file))).filter((r) => !r.group).map((r) => r.orgnr))

function pagePaths(file: string, expected: Set<string>): PagePath[] {
    const seen = new Set<string>()
    const paths: PagePath[] = []
    for (const page of jsonLines(file)) {
        const orgnr = page.record?.orgnr
        assert(expected.has(orgnr) && !seen.has(orgnr), `Unexpected or duplicate page: ${String(orgnr)}`)
        assert(typeof page.path === 'string' && /^\/foretag\/\d{10}\/[a-z0-9-]+\/$/.test(page.path) && page.path.split('/')[2] === orgnr, `Invalid company path: ${String(page.path)}`)
        seen.add(orgnr)
        paths.push({ orgnr, path: page.path })
    }
    assert(seen.size === expected.size, `Expected ${expected.size} pages, fetched ${seen.size}`)
    return paths
}

// A checkpoint is committed by a directory rename only after every validation succeeds.
function checkpoints(directory: string, plan: Plan, hash: string, phase: Phase, inputs?: string[]) {
    let previous: string | null = null
    let lastIndex = path.join(directory, 'seed-index.jsonl')
    const hashes: string[] = []
    const paths = new Map<string, string>()
    for (let i = 0; i < plan.batches.length; i++) {
        const folder = path.join(directory, phase, batchName(i))
        if (!fs.existsSync(folder)) {
            for (let j = i + 1; j < plan.batches.length; j++) assert(!fs.existsSync(path.join(directory, phase, batchName(j))), `Gap in ${phase} checkpoints`)
            break
        }
        const receiptFile = path.join(folder, 'receipt.json')
        const receipt: Checkpoint = JSON.parse(read(receiptFile))
        assert(receipt.plan === hash && receipt.previous === previous, `Invalid ${phase} checkpoint chain: ${i}`)
        const input = phase === 'fetched' ? fileHash(lastIndex) : inputs![i]
        assert(receipt.input === input, `Changed ${phase} checkpoint input: ${i}`)
        assert(receipt.tree === treeHash(path.join(folder, 'output')), `Changed ${phase} checkpoint output: ${i}`)
        if (phase === 'fetched') {
            const output = path.join(folder, 'output')
            assert(read(path.join(output, 'rejected.jsonl')).trim() === '', 'Checkpoint contains rejected companies')
            assert(read(path.join(output, 'removed.txt')).trim() === '', 'Checkpoint contains removed companies')
            for (const page of pagePaths(path.join(output, 'pages.jsonl'), batchCompanies(directory, plan, i))) {
                assert(!paths.has(page.orgnr), `Company fetched twice: ${page.orgnr}`)
                paths.set(page.orgnr, page.path)
            }
            const expected = expectedIndex(lastIndex, path.join(output, 'pages.jsonl'), path.join(directory, 'full-snapshot.txt'))
            lastIndex = path.join(output, 'index.jsonl')
            checkIndex(lastIndex, expected)
        } else {
            const pages = path.join(directory, 'fetched', batchName(i), 'output', 'pages.jsonl')
            checkPaths(pages, path.join(folder, 'output'), batchCompanies(directory, plan, i), plan.config.SE_SITE_ORIGIN)
        }
        previous = fileHash(receiptFile)
        hashes.push(previous)
    }
    return { count: hashes.length, previous, hashes, lastIndex, paths }
}

const renderInputs = (state: ReturnType<typeof checkpoints>) => state.hashes.map((own) => sha256(own + '\n' + state.previous + '\n' + fileHash(state.lastIndex)))

export function runNext(repo: string, directory: string, context: Context, phase: Phase, steps: BuildSteps, env: NodeJS.ProcessEnv): { batch: number; total: number; phase: Phase } {
    const { plan, hash } = readPlan(directory, context)
    const lock = path.join(directory, '.lock')
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
    try {
        const fetched = checkpoints(directory, plan, hash, 'fetched')
        if (phase === 'fetched' && fs.existsSync(path.join(directory, 'rendered')) && fs.readdirSync(path.join(directory, 'rendered')).length) assert(fetched.count === plan.batches.length, 'Cannot refetch beneath an existing render lineage; create a new plan')
        if (phase === 'rendered') assert(fetched.count === plan.batches.length, 'Fetch every batch before rendering: the full slim index must be frozen')
        const state = phase === 'fetched' ? fetched : checkpoints(directory, plan, hash, 'rendered', renderInputs(fetched))
        assert(state.count < plan.batches.length, `All ${phase} batches are complete`)
        const i = state.count
        const attempts = path.join(directory, 'attempts')
        fs.mkdirSync(attempts, { recursive: true })
        const attempt = fs.mkdtempSync(path.join(attempts, `${phase}-${batchName(i)}-`))
        const output = path.join(attempt, 'output')
        const input = phase === 'fetched' ? fileHash(fetched.lastIndex) : renderInputs(fetched)[i]
        const buildEnv = { ...env, ...plan.config, BUILD_STATIC_PARAMS_FILE: path.join(directory, plan.batches[i].file), BUILD_STATIC_PARAMS_FILE_ALL: path.join(directory, 'full-snapshot.txt'), SE_COMPANY_SITEMAP_FILE: path.join(directory, 'snapshot.txt'), SE_INDEX_IN: fetched.lastIndex, SE_OUT_DIR: output, SE_API_REFRESH: '1', SE_API_CACHE_DIR: path.join(attempt, 'api-cache'), SE_FETCH_CONCURRENCY: plan.config.SE_FETCH_CONCURRENCY || '8', SE_DATA_SOURCE: 'build', SE_BUILD_ONLY: '', NODE_OPTIONS: '--max-old-space-size=8192' }
        if (phase === 'fetched') {
            fs.mkdirSync(output)
            steps.fetch({ ...buildEnv, SE_BUILD_DIR: output })
            assert(read(path.join(output, 'rejected.jsonl')).trim() === '', 'Batch contains rejected companies; inspect the attempt; no checkpoint advanced')
            assert(read(path.join(output, 'removed.txt')).trim() === '', 'Unexpected removals in private candidate')
            pagePaths(path.join(output, 'pages.jsonl'), batchCompanies(directory, plan, i))
            checkIndex(path.join(output, 'index.jsonl'), expectedIndex(fetched.lastIndex, path.join(output, 'pages.jsonl'), path.join(directory, 'full-snapshot.txt')))
        } else {
            // Copy only this batch's large page file; every render uses the same final slim index.
            const data = path.join(attempt, 'data')
            fs.mkdirSync(data)
            fs.copyFileSync(path.join(directory, 'fetched', batchName(i), 'output', 'pages.jsonl'), path.join(data, 'pages.jsonl'))
            fs.copyFileSync(fetched.lastIndex, path.join(data, 'index.jsonl'))
            steps.build({ ...buildEnv, SE_BUILD_DIR: data })
            checkPaths(path.join(data, 'pages.jsonl'), output, batchCompanies(directory, plan, i), plan.config.SE_SITE_ORIGIN)
            for (const prefix of ['branscher', 'kommuner', 'konkurser']) assert(fs.statSync(path.join(output, prefix, 'index.html'), { throwIfNoEntry: false })?.size, `Missing complete ${prefix} output`)
            assert(fileHash(path.join(data, 'index.jsonl')) === fileHash(fetched.lastIndex), 'Build changed frozen index')
            assert(fileHash(path.join(data, 'pages.jsonl')) === fileHash(path.join(directory, 'fetched', batchName(i), 'output', 'pages.jsonl')), 'Build changed fetched pages')
        }
        fs.writeFileSync(path.join(attempt, 'receipt.json'), json({ plan: hash, previous: state.previous, input, tree: treeHash(output) } satisfies Checkpoint), { flag: 'wx' })
        fs.mkdirSync(path.join(directory, phase), { recursive: true })
        fs.renameSync(attempt, path.join(directory, phase, batchName(i)))
        return { batch: i, total: plan.batches.length, phase }
    } finally { fs.unlinkSync(lock) }
}

export function verifyCandidate(directory: string): { batches: number; companies: number; indexFile: string } {
    const { plan, hash } = readPlan(directory)
    const fetched = checkpoints(directory, plan, hash, 'fetched')
    assert(fetched.count === plan.batches.length, `Candidate fetch incomplete: ${fetched.count}/${plan.batches.length}`)
    const built = checkpoints(directory, plan, hash, 'rendered', renderInputs(fetched))
    assert(built.count === plan.batches.length, `Candidate rendering incomplete: ${built.count}/${plan.batches.length}`)
    assert([...jsonLines(fetched.lastIndex)].length === plan.directoryCompanies, 'Final full-directory index coverage differs')
    assert(fetched.paths.size === plan.companies, 'Final page coverage differs from plan')
    return { batches: plan.batches.length, companies: plan.companies, indexFile: fetched.lastIndex }
}

// Staging creates a new local directory. No AWS, Jenkins or publication command exists here.
export function stageCandidate(directory: string, destination: string): ReturnType<typeof verifyCandidate> & { output: string; sha256: string } {
    const lock = path.join(directory, '.lock')
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
    try {
        const verified = verifyCandidate(directory)
        assert(!fs.existsSync(destination), 'Stage destination already exists; refusing to overwrite')
        const { plan } = readPlan(directory)
        const parent = path.dirname(destination)
        const temp = fs.mkdtempSync(path.join(parent, '.se-stage-'))
        try {
            // Global routes and assets come from the final render of the frozen index.
            const last = path.join(directory, 'rendered', batchName(plan.batches.length - 1), 'output')
            fs.cpSync(last, temp, { recursive: true })
            for (let i = 0; i < plan.batches.length; i++) {
                const output = path.join(directory, 'rendered', batchName(i), 'output')
                for (const orgnr of batchCompanies(directory, plan, i)) fs.cpSync(path.join(output, 'foretag', orgnr), path.join(temp, 'foretag', orgnr), { recursive: true })
                // Earlier company pages may refer to additional content-hashed assets.
                const assets = path.join(output, '_astro')
                if (fs.existsSync(assets)) for (const name of fs.readdirSync(assets)) {
                    const target = path.join(temp, '_astro', name)
                    if (fs.existsSync(target)) assert(fileHash(target) === fileHash(path.join(assets, name)), `Asset collision: ${name}`)
                    else fs.copyFileSync(path.join(assets, name), target)
                }
                checkPaths(path.join(directory, 'fetched', batchName(i), 'output', 'pages.jsonl'), temp, batchCompanies(directory, plan, i), plan.config.SE_SITE_ORIGIN)
            }
            checkSitemaps(temp, verified.indexFile, plan.config, new Set(rowsOf(read(path.join(directory, 'snapshot.txt'))).filter((r) => !r.group).map((r) => r.orgnr)))
            const result = { ...verified, output: destination, sha256: treeHash(temp) }
            fs.renameSync(temp, destination)
            return result
        } catch (e) {
            // Failed stage remains private for diagnosis, with no ready destination.
            throw new Error(`Staging failed; partial output retained at ${temp}`, { cause: e })
        }
    } finally { fs.unlinkSync(lock) }
}

export function checkSitemaps(output: string, index: string, config: Record<string, string>, selected?: Set<string>): void {
    const flag = (key: string) => config[key] === '1' || config[key]?.toLowerCase() === 'true'
    const rows = [...jsonLines(index)]
    const open = flag('SE_INDEXING') && !flag('SE_PREVIEW') && !rows.some((r) => r.syn)
    const expected = new Set<string>(open ? rows.filter((r) => r.ix && (!selected || selected.has(r.o))).map((r) => r.p) : [])
    const origin = (config.SE_SITE_ORIGIN || 'https://www.kreditrisker.se').replace(/\/$/, '')
    const robots = read(path.join(output, 'robots.txt')).replaceAll('\r\n', '\n')
    const expectedRobots = open ? `User-agent: *\nDisallow: /bestall/\nDisallow: /sok/\n\nSitemap: ${origin}/sitemap-index.xml\n` : '# Pre-launch or staging: nothing may be indexed.\nUser-agent: *\nDisallow: /\n'
    assert(robots === expectedRobots, 'robots.txt differs from the frozen indexing policy')
    const sitemapIndex = read(path.join(output, 'sitemap-index.xml'))
    const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<'))
    const sitemapFiles = locs(sitemapIndex)
    for (const file of ['sitemap-pages.xml', 'sitemap-hubs.xml']) assert(sitemapFiles.includes(origin + '/' + file), `Missing required sitemap: ${file}`)
    assert(new Set(sitemapFiles).size === sitemapFiles.length, 'Duplicate sitemap files')
    const site = buildSite([], rows, 'candidate-check')
    const redirects = JSON.parse(read(path.join(output, 'redirects.json')))
    const ordered = (list: {from: string; to: string; status: number}[]) => [...list].sort((a, b) => (a.from + '\0' + a.to).localeCompare(b.from + '\0' + b.to))
    assert(Array.isArray(redirects) && isDeepStrictEqual(ordered(redirects), ordered(site.redirects.map((r) => ({...r, status: 301})))), 'Redirect manifest differs from the full frozen directory')
    const segments = new Map([['sitemap-pages.xml', new Set(staticUrls(site, open).map((u) => u.path))], ['sitemap-hubs.xml', new Set(hubUrls(site, config.SE_DATA_AS_OF, open).map((u) => u.path))]])
    const found = new Set<string>()
    for (const url of locs(sitemapIndex)) {
        assert(url.startsWith(origin + '/'), `Unexpected sitemap origin: ${url}`)
        const file = url.slice(origin.length + 1)
        assert(/^sitemap-[a-z0-9-]+\.xml$/.test(file), `Invalid sitemap path: ${file}`)
        const segment = segments.get(file)
        const segmentFound = new Set<string>()
        for (const loc of locs(read(path.join(output, file)))) {
            assert(loc.startsWith(origin + '/'), `Unexpected sitemap URL: ${loc}`)
            const route = loc.slice(origin.length)
            assert(/^\/(?:[a-z0-9-]+\/)*$/.test(route), `Invalid sitemap route: ${route}`)
            if (segment) {
                assert(segment.has(route) && !segmentFound.has(route), `Unexpected or duplicate ${file} URL: ${route}`)
                segmentFound.add(route)
            }
            const html = read(path.join(output, route.slice(1), 'index.html'))
            assert(/<meta\b[^>]*name=["']robots["'][^>]*content=["']index,follow["']/i.test(html), `Sitemap page is not indexable: ${route}`)
            assert(html.includes(`rel="canonical" href="${loc}"`), `Sitemap canonical differs: ${route}`)
            if (route.startsWith('/foretag/')) {
                assert(expected.has(route) && !found.has(route), `Unexpected or duplicate company sitemap URL: ${route}`)
                found.add(route)
            }
        }
        if (segment) assert(segmentFound.size === segment.size, `${file} coverage differs: ${segmentFound.size}/${segment.size}`)
    }
    assert(found.size === expected.size, `Company sitemap coverage differs: ${found.size}/${expected.size}`)
}


/** Missing index companies come first, then orgnr order; retain every row of each chosen company. */
export function selectCompanies(fullSnapshot: string, seed: string, count: number): string {
    const full = rowsOf(fullSnapshot)
    const bases = full.filter((r) => !r.group)
    assert(Number.isInteger(count) && count > 0 && count <= bases.length, `Selection count must be between 1 and ${bases.length}`)
    // Validate complete seed membership and paths without excluding any official company.
    createPlan(fullSnapshot, seed, { revision: '0'.repeat(40), config: {} })
    const indexed = new Set(seed.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l).o))
    const missing = bases.filter((r) => !indexed.has(r.orgnr))
    assert(missing.length <= count, `Selection count ${count} cannot cover ${missing.length} companies missing from the seed`)
    const chosen = new Set([...missing, ...bases.filter((r) => indexed.has(r.orgnr))].slice(0, count).map((r) => r.orgnr))
    return full.filter((r) => chosen.has(r.orgnr)).map((r) => r.line + '\n').join('')
}



export function assertPublicFiles(repo: string, tracked: string[]): void {
    const expected = new Set(tracked)
    const found = new Set<string>()
    const visit = (folder: string) => {
        for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
            const absolute = path.join(folder, entry.name)
            const relative = path.relative(repo, absolute).replaceAll('\\', '/')
            assert(!entry.isSymbolicLink(), `Symlink in public files: ${relative}`)
            if (entry.isDirectory()) visit(absolute)
            else {
                assert(entry.isFile() && expected.has(relative) && !/^\.env($|\.)/.test(entry.name), `Unexpected or unsafe public file: ${relative}`)
                found.add(relative)
            }
        }
    }
    const publicDir = path.join(repo, 'public')
    if (fs.existsSync(publicDir)) {
        assert(!fs.lstatSync(publicDir).isSymbolicLink(), 'Public directory must not be a symlink')
        visit(publicDir)
    }
    assert(found.size === expected.size, 'Missing tracked public files')
}
