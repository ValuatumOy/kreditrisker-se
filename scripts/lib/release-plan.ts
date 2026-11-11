import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { readPlan, sha256, stageCandidate, verifyCandidate } from './candidate.ts'

type File = { sha256: string; bytes: number }
export type Inventory = Record<string, File>
export type Capture = {
    version: 1
    capturedAt: string
    complete: true
    site: { bucket: string; versioning: 'Enabled'; objects: Record<string, File & { versionId: string; head: Record<string, unknown> }> }
    state: { uri: string; versioning: 'Enabled'; versionId: string; sha256: string; head: Record<string, unknown> }
    policy: { uri: string; versionId: string | null; sha256: string | null; head: Record<string, unknown> | null }
    search: { function: string; imageUri: string; revisionId: string; indexSha256: string | null }
    distributionId: string
}
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n'
const canonicalIndex = (text: string) => text.split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.stringify(JSON.parse(l)) + '\n').join('')
const digest = (v: unknown) => sha256(json(v))
const inventoryDigest = (v: Inventory) => digest(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)))
function checkHead(head: Record<string, unknown> | null, version: string, bytes: number, key: string) {
    assert(head && typeof head === 'object' && !Array.isArray(head) && head.VersionId === version && head.ContentLength === bytes && typeof head.ContentType === 'string' && head.ContentType.length > 0, `Missing or inconsistent restore metadata: ${key}`)
}
function retainedCompanyPages(rows: any[], selected: Set<string>, site: Inventory) {
    return rows.filter((r) => !selected.has(r.o)).map((r) => {
        assert(/^\d{10}$/.test(r.o) && typeof r.p === 'string' && new RegExp(`^/foretag/${r.o}/[a-z0-9-]+/$`).test(r.p) && Array.isArray(r.rf) && r.rf.every((p: unknown) => typeof p === 'string' && new RegExp(`^/foretag/${r.o}/[a-z0-9-]+/$`).test(p)), `Invalid retained company paths: ${r.o}`)
        const canonical = r.p.slice(1) + 'index.html'
        const redirects = [`foretag/${r.o}/index.html`, ...r.rf.map((p: string) => p.slice(1) + 'index.html')]
        for (const key of [canonical, ...redirects]) assert(Object.hasOwn(site, key), `Missing retained company HTML or redirect: ${key}`)
        return { orgnr: r.o as string, canonical, redirects }
    })
}
const hashFile = (file: string): File => {
    const h = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r')
    let bytes = 0
    try { for (let n: number; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { h.update(buffer.subarray(0, n)); bytes += n } }
    finally { fs.closeSync(fd) }
    return { sha256: h.digest('hex'), bytes }
}
const validKey = (key: string) => /^[a-zA-Z0-9_./-]+$/.test(key) && key.split('/').every((s) => s && s !== '.' && s !== '..')
const validBucket = (bucket: unknown): bucket is string => typeof bucket === 'string' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) && !/\.\.|\.-|-\.|^\d+\.\d+\.\d+\.\d+$/.test(bucket)
function stateLocation(uri: unknown) {
    const parts = typeof uri === 'string' ? /^s3:\/\/([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\/(.+)$/.exec(uri) : null
    assert(parts && validBucket(parts[1]) && validKey(parts[2]), 'Invalid S3 state or policy URI')
    return { bucket: parts[1], key: parts[2] }
}

/** Inventory regular local files only; never follows junctions or symlinks. */
export function inventory(directory: string): Inventory {
    assert(fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(), 'Inventory root must be a regular directory')
    const files: Inventory = Object.create(null), folded = new Set<string>()
    const visit = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
            const file = path.join(dir, entry.name), key = path.relative(directory, file).replaceAll('\\', '/')
            assert(validKey(key) && !folded.has(key.toLowerCase()), `Unsafe or case-colliding snapshot key: ${key}`)
            folded.add(key.toLowerCase())
            assert(!entry.isSymbolicLink(), `Symlink in release input: ${key}`)
            if (entry.isDirectory()) visit(file)
            else { assert(entry.isFile(), `Nonregular release input: ${key}`); files[key] = hashFile(file) }
        }
    }
    visit(directory)
    return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1))
}

export function validateCapture(capture: Capture, site: Inventory, index: string): void {
    assert(capture.version === 1 && capture.complete === true && /^\d{4}-\d{2}-\d{2}T/.test(capture.capturedAt) && Number.isFinite(Date.parse(capture.capturedAt)), 'Incomplete or invalid offline capture')
    assert(capture.site?.versioning === 'Enabled' && validBucket(capture.site.bucket), 'Capture requires a versioned site bucket')
    const state = stateLocation(capture.state?.uri), policy = stateLocation(capture.policy?.uri)
    assert(state.bucket === policy.bucket && state.bucket !== capture.site.bucket && state.key !== policy.key, 'State and policy must use distinct keys in one separate state bucket')
    assert(typeof capture.site.objects === 'object' && capture.site.objects !== null, 'Capture lacks object versions')
    const described: Inventory = Object.create(null)
    for (const [key, object] of Object.entries(capture.site.objects)) {
        assert(validKey(key) && typeof object.versionId === 'string' && object.versionId.length > 0 && object.versionId !== 'null' && object.head && typeof object.head === 'object' && !Array.isArray(object.head), `Missing version or HeadObject metadata: ${key}`)
        described[key] = { sha256: object.sha256, bytes: object.bytes }
        checkHead(object.head, object.versionId, object.bytes, key)
    }
    assert(Object.keys(site).length > 0 && isDeepStrictEqual(Object.fromEntries(Object.entries(described)), site), 'Complete site capture inventory differs from local bytes')
    assert(/^s3:\/\/[a-z0-9.-]+\/[^\s]+$/.test(capture.state?.uri) && capture.state.versioning === 'Enabled' && typeof capture.state.versionId === 'string' && capture.state.versionId.length > 0 && capture.state.versionId !== 'null' && capture.state.head && typeof capture.state.head === 'object', 'Capture requires a versioned index state with metadata')
    assert(capture.state.sha256 === sha256(index), 'Captured index bytes changed')
    checkHead(capture.state.head, capture.state.versionId, Buffer.byteLength(index), 'index state')
    assert(/^s3:\/\/[a-z0-9.-]+\/[^\s]+$/.test(capture.policy?.uri) && capture.policy.uri !== capture.state.uri && ((capture.policy.versionId === null && capture.policy.sha256 === null) || (typeof capture.policy.versionId === 'string' && capture.policy.versionId.length > 0 && capture.policy.versionId !== 'null' && typeof capture.policy.sha256 === 'string' && /^[a-f0-9]{64}$/.test(capture.policy.sha256))), 'Capture must record the existing sitemap policy or its verified absence')
    if (capture.policy.versionId === null) assert(capture.policy.head === null, 'Absent sitemap policy must have null metadata')
    else {
        assert(Number.isInteger(capture.policy.head?.ContentLength) && Number(capture.policy.head?.ContentLength) > 0, 'Missing sitemap policy restore metadata')
        checkHead(capture.policy.head, capture.policy.versionId, Number(capture.policy.head?.ContentLength), 'sitemap policy')
    }
    assert(capture.search && typeof capture.search.function === 'string' && /^[A-Za-z0-9-_]+$/.test(capture.search.function) && /^\S+@sha256:[a-f0-9]{64}$/.test(capture.search.imageUri) && typeof capture.search.revisionId === 'string' && capture.search.revisionId.length > 0, 'Capture requires the resolved search image digest and Lambda revision')
    assert(capture.search.indexSha256 === null || capture.search.indexSha256 === capture.state.sha256, 'Search/index drift in offline capture')
    assert(typeof capture.distributionId === 'string' && /^[A-Z0-9]+$/.test(capture.distributionId), 'Missing CloudFront distribution identity')
}

/** A reviewable offline change set. This is deliberately not an executable release controller. */
export function makeReleasePlan(input: {
    before: Inventory; overlay: Inventory; capture: Capture; seed: string; liveIndex: string; finalIndex: string
    selected: string[]; candidateHash: string; candidateRevision: string
}) {
    const { before, overlay, capture, seed, liveIndex, finalIndex } = input
    validateCapture(capture, before, liveIndex)
    assert(canonicalIndex(liveIndex) === seed, 'Frozen candidate seed differs from captured live index; replan and refetch, never rebase a completed candidate')
    const selected = new Set(input.selected)
    assert(selected.size > 0 && selected.size === input.selected.length && [...selected].every((o) => /^\d{10}$/.test(o)), 'Invalid or duplicate selected companies')
    const excluded: string[] = [], writes: Record<string, { before: File | null; after: File; phase: string; generated?: string }> = Object.create(null)
    const previous = (key: string): File | null => Object.hasOwn(before, key) ? before[key] : null
    const isAsset = (key: string) => key.startsWith('_astro/') || (!key.endsWith('.html') && !/^sitemap-[a-z0-9-]+\.xml$/.test(key) && !['robots.txt', 'redirects.json', 'sok/index.json'].includes(key))
    for (const [key, after] of Object.entries(overlay)) {
        const company = /^foretag\/([^/]+)\//.exec(key)
        if (company && !selected.has(company[1])) { excluded.push(key); continue }
        if (isAsset(key) && previous(key)) assert(isDeepStrictEqual(previous(key), after), `Existing asset would be overwritten: ${key}`)
        if (isDeepStrictEqual(previous(key), after)) continue
        const phase = key.startsWith('_astro/') ? 'assets' : company ? 'selected-pages' : key.startsWith('sitemap-') && key.endsWith('.xml') ? (key === 'sitemap-index.xml' ? 'sitemap-index' : 'sitemap-parts') : 'global-pages'
        writes[key] = { before: previous(key), after, phase }
    }
    // Previously advertised sitemap parts remain discoverable independently of the new index.
    // Retire them by overwriting with an empty document; no forward deletion is needed.
    for (const key of Object.keys(before)) if (/^sitemap-companies-\d+\.xml$/.test(key) && !overlay[key]) {
        const generated = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n'
        writes[key] = { before: before[key], after: { sha256: sha256(generated), bytes: Buffer.byteLength(generated) }, phase: 'sitemap-parts', generated }
    }
    const after = { ...before, ...Object.fromEntries(Object.entries(writes).map(([key, w]) => [key, w.after])) }
    const preservedCompanies = Object.keys(before).filter((key) => /^foretag\//.test(key) && !selected.has(key.split('/')[1]))
    for (const key of preservedCompanies) assert(isDeepStrictEqual(after[key], before[key]), `Nonselected HTML changed: ${key}`)
    const preservedAssets = Object.keys(before).filter(isAsset)
    const finalRows = finalIndex.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    const indexedCompanies = retainedCompanyPages(finalRows, selected, after)
    const policy = {
        version: 1, mode: 'selected-only', candidateHash: input.candidateHash,
        selectedOrgnrs: [...selected].sort(), finalIndexSha256: sha256(finalIndex),
        // A normal job may add/update eligible paths only for this allowlist, after publishing their HTML.
        canonicalPaths: Object.fromEntries(finalRows.filter((r) => selected.has(r.o)).map((r) => [r.o, r.p]).sort(([a], [b]) => a < b ? -1 : 1)),
    }
    assert(Object.keys(policy.canonicalPaths).length === selected.size, 'Final index lacks selected company paths')
    return {
        version: 1, offlineOnly: true, promotionAllowed: false,
        blockers: [
            'Offline capture is not proof of current production; reacquire and compare every object version, exact index bytes, search revision/digest and release policy under the release lock immediately before publication.',
            'Capture completeness, restore metadata beyond VersionId/ContentLength/ContentType, and approved stack destinations require external verification; local validation cannot detect omitted headers, tags, ACL or retention/encryption settings.',
            'No shared release lock exists between this preparation tool and Jenkins; disableConcurrentBuilds alone is insufficient.',
            'Jenkins does not consume a durable selected-only sitemap policy and would currently replace the pilot sitemap with an empty one.',
            'No tested live publication/resume/rollback controller exists; this package must never be passed to legacy Jenkins or sync --delete.',
            ...(capture.search.indexSha256 === null ? ['Captured search has no verified index binding; inspect the deployed database against the captured index before approval.'] : []),
        ],
        candidate: { sha256: input.candidateHash, revision: input.candidateRevision, stageInventorySha256: inventoryDigest(overlay) },
        baseline: { captureSha256: digest(capture), backupInventorySha256: null as string | null, siteInventorySha256: inventoryDigest(before), exactIndexSha256: sha256(liveIndex), seedSha256: sha256(seed), search: capture.search, policy: capture.policy },
        result: { siteInventorySha256: inventoryDigest(after), finalIndexSha256: sha256(finalIndex), policySha256: digest(policy), policyBytesSha256: sha256(json(policy)) },
        preserved: { companyKeys: preservedCompanies, assetKeys: preservedAssets, indexedCompanies },
        excludedNonselectedOverlayKeys: excluded,
        writes,
        phases: ['assets', 'selected-pages', 'global-pages', 'index-and-search', 'sitemap-parts', 'sitemap-index', 'cloudfront-invalidation-and-verification'],
        rollback: {
            restore: Object.keys(writes).filter((key) => writes[key].before !== null),
            removeNew: Object.keys(writes).filter((key) => writes[key].before === null),
            stateVersionId: capture.state.versionId, searchImageUri: capture.search.imageUri, policyVersionId: capture.policy.versionId,
            order: ['hide-company-sitemaps-and-invalidate', 'restore-site-object-versions-and-delete-release-created-keys', 'restore-index-search-and-policy', 'restore-original-sitemaps', 'invalidate-all-and-wait-verify'],
        },
        policy,
    }
}

const assertDisjoint = (destination: string, sources: string[]) => {
    assert(!fs.existsSync(destination), 'Release output already exists')
    const out = path.join(fs.realpathSync(path.dirname(destination)), path.basename(destination))
    for (const source of sources) {
        const resolved = fs.realpathSync(source), relative = path.relative(resolved, out), inverse = path.relative(out, resolved)
        const inside = (s: string) => !s || (!s.startsWith('..' + path.sep) && !path.isAbsolute(s))
        assert(!inside(relative) && !inside(inverse), 'Release output and inputs must be disjoint')
    }
}

export function prepareRelease(candidateDirectory: string, stageDirectory: string, captureDirectory: string, destination: string) {
    assertDisjoint(destination, [candidateDirectory, stageDirectory, captureDirectory])
    const { plan, hash } = readPlan(candidateDirectory), verified = verifyCandidate(candidateDirectory)
    const overlay = inventory(stageDirectory), before = inventory(path.join(captureDirectory, 'site'))
    const captureFiles = inventory(captureDirectory)
    assert(Object.keys(captureFiles).every((key) => key.startsWith('site/') || ['capture.json', 'index.jsonl', 'sitemap-policy.json'].includes(key)), 'Unexpected file in offline capture')
    const capture: Capture = JSON.parse(fs.readFileSync(path.join(captureDirectory, 'capture.json'), 'utf8'))
    const liveIndex = fs.readFileSync(path.join(captureDirectory, 'index.jsonl'), 'utf8')
    const previousPolicyFile = path.join(captureDirectory, 'sitemap-policy.json')
    if (capture.policy?.sha256 === null) assert(!fs.existsSync(previousPolicyFile), 'Capture claims absent policy but contains policy bytes')
    else { const policyFile = hashFile(previousPolicyFile); assert(policyFile.sha256 === capture.policy?.sha256 && policyFile.bytes === capture.policy?.head?.ContentLength, 'Captured policy bytes changed') }
    const seed = fs.readFileSync(path.join(candidateDirectory, 'seed-index.jsonl'), 'utf8')
    const finalIndex = fs.readFileSync(verified.indexFile, 'utf8')
    const selected = [...new Set(fs.readFileSync(path.join(candidateDirectory, 'snapshot.txt'), 'utf8').trim().split('\n').map((l) => l.split('\t')[4].replace(/K$/, '')))]
    const release = makeReleasePlan({ before, overlay, capture, liveIndex, seed, finalIndex, selected, candidateHash: hash, candidateRevision: plan.revision })
    release.baseline.backupInventorySha256 = inventoryDigest(captureFiles)
    // Restaging verifies all sitemap/HTML/redirect guards and proves the supplied overlay is exact.
    // It makes local copies only. An arbitrary edited stage cannot pass this comparison.
    const temp = fs.mkdtempSync(path.join(path.dirname(destination), '.se-release-'))
    const rebuilt = path.join(temp, 'restaged')
    try {
        stageCandidate(candidateDirectory, rebuilt)
        assert(isDeepStrictEqual(inventory(rebuilt), overlay), 'Stage differs from verified candidate output')
        const backup = path.join(temp, 'backup')
        fs.mkdirSync(backup)
        fs.cpSync(path.join(captureDirectory, 'site'), path.join(backup, 'site'), { recursive: true })
        fs.copyFileSync(path.join(captureDirectory, 'capture.json'), path.join(backup, 'capture.json'))
        fs.copyFileSync(path.join(captureDirectory, 'index.jsonl'), path.join(backup, 'index.jsonl'))
        if (fs.existsSync(previousPolicyFile)) fs.copyFileSync(previousPolicyFile, path.join(backup, 'sitemap-policy.json'))
        assert(isDeepStrictEqual(inventory(backup), captureFiles), 'Backup verification failed')
        const publication = path.join(temp, 'overlay')
        fs.mkdirSync(publication)
        for (const [key, write] of Object.entries(release.writes)) {
            const target = path.join(publication, key)
            fs.mkdirSync(path.dirname(target), { recursive: true })
            if (write.generated !== undefined) fs.writeFileSync(target, write.generated, { flag: 'wx' })
            else fs.copyFileSync(path.join(rebuilt, key), target)
        }
        const expected = Object.fromEntries(Object.entries(release.writes).map(([key, write]) => [key, write.after]))
        assert(isDeepStrictEqual(inventory(publication), expected), 'Prepared overlay verification failed')
        fs.writeFileSync(path.join(temp, 'next-index.jsonl'), finalIndex, { flag: 'wx' })
        fs.writeFileSync(path.join(temp, 'next-sitemap-policy.json'), json(release.policy), { flag: 'wx' })
        fs.writeFileSync(path.join(temp, 'release.json'), json(release), { flag: 'wx' })
        fs.writeFileSync(path.join(temp, 'release.sha256'), digest(release) + '\n', { flag: 'wx' })
        // Detect input changes during copying; this is not a substitute for a production lock.
        assert(isDeepStrictEqual(inventory(stageDirectory), overlay) && isDeepStrictEqual(inventory(captureDirectory), captureFiles), 'Release inputs changed while preparing')
        assert(fs.readFileSync(path.join(captureDirectory, 'index.jsonl'), 'utf8') === liveIndex && digest(JSON.parse(fs.readFileSync(path.join(captureDirectory, 'capture.json'), 'utf8'))) === digest(capture), 'Capture state changed while preparing')
        assert(readPlan(candidateDirectory).hash === hash && fs.readFileSync(verifyCandidate(candidateDirectory).indexFile, 'utf8') === finalIndex, 'Candidate changed while preparing')
        // Keep the exact verified restage for review. No source or live object is removed.
        fs.renameSync(temp, destination)
        return { output: destination, sha256: digest(release), promotionAllowed: false, blockers: release.blockers }
    } catch (error) {
        throw new Error(`Offline release preparation failed; private diagnostic files retained at ${temp}`, { cause: error })
    }
}

/** Verify the complete local package again without consulting production or the candidate. */
export function verifyRelease(directory: string) {
    const packageFiles = inventory(directory) // Reject links/nonregular entries anywhere before reading.
    assert(Object.keys(packageFiles).every((key) => /^(backup|restaged|overlay)\//.test(key) || ['release.json', 'release.sha256', 'next-index.jsonl', 'next-sitemap-policy.json'].includes(key)), 'Unexpected file in release package')
    const text = fs.readFileSync(path.join(directory, 'release.json'), 'utf8')
    assert(fs.readFileSync(path.join(directory, 'release.sha256'), 'utf8').trim() === sha256(text), 'Release manifest checksum changed')
    const release: ReturnType<typeof makeReleasePlan> = JSON.parse(text)
    assert(release.version === 1 && release.offlineOnly === true && release.promotionAllowed === false && release.blockers.length >= 4, 'Unknown or executable release manifest')
    const before = inventory(path.join(directory, 'backup', 'site'))
    const backupFiles = inventory(path.join(directory, 'backup'))
    assert(Object.keys(backupFiles).every((key) => key.startsWith('site/') || ['capture.json', 'index.jsonl', 'sitemap-policy.json'].includes(key)), 'Unexpected file in release backup')
    assert(inventoryDigest(backupFiles) === release.baseline.backupInventorySha256, 'Backup inventory changed')
    const capture = JSON.parse(fs.readFileSync(path.join(directory, 'backup', 'capture.json'), 'utf8')) as Capture
    const index = fs.readFileSync(path.join(directory, 'backup', 'index.jsonl'), 'utf8')
    validateCapture(capture, before, index)
    assert(digest(capture) === release.baseline.captureSha256 && inventoryDigest(before) === release.baseline.siteInventorySha256 && sha256(index) === release.baseline.exactIndexSha256, 'Backup differs from release baseline')
    const policyFile = path.join(directory, 'backup', 'sitemap-policy.json')
    assert(capture.policy.sha256 === null ? !fs.existsSync(policyFile) : hashFile(policyFile).sha256 === capture.policy.sha256 && hashFile(policyFile).bytes === capture.policy.head?.ContentLength, 'Backup sitemap policy changed')
    assert(inventoryDigest(inventory(path.join(directory, 'restaged'))) === release.candidate.stageInventorySha256, 'Verified restage changed')
    const expected = Object.fromEntries(Object.entries(release.writes).map(([key, write]) => [key, write.after]))
    assert(isDeepStrictEqual(inventory(path.join(directory, 'overlay')), expected), 'Prepared overlay differs from release manifest')
    const finalIndex = fs.readFileSync(path.join(directory, 'next-index.jsonl'), 'utf8')
    const policyBytes = fs.readFileSync(path.join(directory, 'next-sitemap-policy.json'), 'utf8'), policy = JSON.parse(policyBytes)
    assert(sha256(finalIndex) === release.result.finalIndexSha256 && sha256(policyBytes) === release.result.policyBytesSha256 && digest(policy) === release.result.policySha256 && isDeepStrictEqual(policy, release.policy), 'Prepared index or sitemap policy changed')
    const after = { ...before, ...expected }
    assert(inventoryDigest(after) === release.result.siteInventorySha256, 'Result inventory differs')
    assert(isDeepStrictEqual(retainedCompanyPages(finalIndex.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)), new Set(policy.selectedOrgnrs), after), release.preserved.indexedCompanies), 'Retained indexed-company coverage differs')
    for (const [key, write] of Object.entries(release.writes)) assert(isDeepStrictEqual(write.before, Object.hasOwn(before, key) ? before[key] : null), `Rollback baseline differs: ${key}`)
    assert(isDeepStrictEqual(release.rollback.restore, Object.keys(release.writes).filter((key) => release.writes[key].before !== null)) && isDeepStrictEqual(release.rollback.removeNew, Object.keys(release.writes).filter((key) => release.writes[key].before === null)), 'Rollback does not cover every changed key')
    for (const key of [...release.preserved.companyKeys, ...release.preserved.assetKeys]) assert(isDeepStrictEqual(before[key], after[key]), `Preserved key changed: ${key}`)
    return { sha256: sha256(text), promotionAllowed: false, changedKeys: Object.keys(release.writes).length, preservedCompanyKeys: release.preserved.companyKeys.length, blockers: release.blockers }
}
