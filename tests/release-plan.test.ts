import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inventory, makeReleasePlan, validateCapture, type Capture, type Inventory } from '../scripts/lib/release-plan.ts'
import { sha256 } from '../scripts/lib/candidate.ts'

const file = (text: string) => ({ sha256: sha256(text), bytes: Buffer.byteLength(text) })
const index = '{"o":"5564480282","p":"/foretag/5564480282/new/"}\n'
const capture = (site: Inventory, state = index): Capture => ({
    version: 1, capturedAt: '2026-11-11T12:00:00.000Z', complete: true,
    site: { bucket: 'synthetic-site', versioning: 'Enabled', objects: Object.fromEntries(Object.entries(site).map(([key, value]) => [key, { ...value, versionId: 'synthetic-version', head: { ContentType: 'text/html' } }])) },
    state: { uri: 's3://synthetic-state/index.jsonl', versioning: 'Enabled', versionId: 'synthetic-state-version', sha256: sha256(state), head: {} },
    policy: { uri: 's3://synthetic-state/sitemap-policy.json', versionId: null, sha256: null },
    search: { function: 'synthetic-search', imageUri: 'example.invalid/search@sha256:' + 'a'.repeat(64), revisionId: 'synthetic-revision', indexSha256: sha256(state) },
    distributionId: 'SYNTHETIC',
})
const input = () => {
    const before = {
        '_astro/old.js': file('old asset'), 'images/shared.svg': file('shared asset'),
        'foretag/5564480282/old/index.html': file('selected old slug'),
        'foretag/5565675906/legacy/index.html': file('nonselected legacy noindex'),
        'foretag/5565675906/index.html': file('nonselected redirect'),
        'sitemap-companies-9.xml': file('old company sitemap'), 'sitemap-index.xml': file('old index'),
    }
    const overlay = {
        '_astro/new.js': file('new asset'),
        'foretag/5564480282/new/index.html': file('selected new page'),
        'foretag/5565675906/index.html': file('rebuilt nonselected redirect must be excluded'),
        'sitemap-companies-1.xml': file('selected new sitemap'), 'sitemap-index.xml': file('new index'),
    }
    return { before, overlay, capture: capture(before), seed: index, liveIndex: index, finalIndex: index, selected: ['5564480282'], candidateHash: 'a'.repeat(64), candidateRevision: 'b'.repeat(40) }
}

test('offline release preserves every nonselected HTML and old asset; covers rollback for overwritten and new keys', () => {
    const i = input(), plan = makeReleasePlan(i)
    assert.equal(plan.promotionAllowed, false)
    assert.equal(plan.offlineOnly, true)
    assert.equal(plan.preserved.companyKeys.length, 2)
    assert.deepEqual(plan.excludedNonselectedOverlayKeys, ['foretag/5565675906/index.html'])
    assert.deepEqual(plan.preserved.assetKeys, ['_astro/old.js', 'images/shared.svg'])
    assert.equal(plan.writes['foretag/5565675906/index.html'], undefined)
    assert.equal(plan.writes['foretag/5564480282/old/index.html'], undefined, 'old selected slugs remain unless explicitly overwritten')
    assert.match(plan.writes['sitemap-companies-9.xml'].generated!, /<urlset[^>]+><\/urlset>/, 'obsolete sitemap parts are emptied, not silently left advertising old profiles')
    assert.deepEqual(new Set([...plan.rollback.restore, ...plan.rollback.removeNew]), new Set(Object.keys(plan.writes)))
    assert(plan.rollback.restore.includes('sitemap-index.xml'))
    assert(plan.rollback.removeNew.includes('foretag/5564480282/new/index.html'))
    assert(plan.phases.indexOf('selected-pages') < plan.phases.indexOf('sitemap-parts'))
    assert(plan.phases.indexOf('index-and-search') < plan.phases.indexOf('sitemap-index'))
    assert.equal(plan.rollback.searchImageUri, i.capture.search.imageUri)
    assert.equal(plan.rollback.stateVersionId, i.capture.state.versionId)
})

test('offline seed/index/search drift fails closed and cannot silently rebase a completed candidate', () => {
    const i = input()
    assert.throws(() => makeReleasePlan({ ...i, seed: index.replace('new', 'old') }), /Frozen candidate seed differs/)
    assert.throws(() => makeReleasePlan({ ...i, liveIndex: index + '\n' }), /Captured index bytes changed/)
    const c = structuredClone(i.capture); c.search.indexSha256 = 'f'.repeat(64)
    assert.throws(() => makeReleasePlan({ ...i, capture: c }), /Search\/index drift/)
    c.search.indexSha256 = null
    assert(makeReleasePlan({ ...i, capture: c }).blockers.some((b) => b.includes('no verified index binding')))
    assert.equal(makeReleasePlan({ ...i, liveIndex: index.replace('\n', '\r\n'), capture: capture(i.before, index.replace('\n', '\r\n')) }).baseline.seedSha256, sha256(index), 'only line/JSON serialization is normalized for seed identity; exact live bytes remain pinned')
})

test('complete versioned backup claims must match all local keys and bytes', () => {
    const i = input()
    for (const modify of [
        (c: Capture) => { delete c.site.objects['_astro/old.js'] },
        (c: Capture) => { c.site.objects['_astro/old.js'].sha256 = 'f'.repeat(64) },
        (c: Capture) => { c.site.objects['_astro/old.js'].versionId = 'null' },
        (c: Capture) => { c.site.versioning = 'Suspended' as any },
        (c: Capture) => { c.state.versionId = 'null' },
        (c: Capture) => { c.search.imageUri = 'example.invalid/search:latest' },
        (c: Capture) => { c.complete = false as any },
    ]) {
        const c = structuredClone(i.capture); modify(c)
        assert.throws(() => validateCapture(c, i.before, index))
    }
    assert.throws(() => makeReleasePlan({ ...i, overlay: { ...i.overlay, '_astro/old.js': file('collision') } }), /Existing asset would be overwritten/)
    assert.throws(() => makeReleasePlan({ ...i, overlay: { ...i.overlay, 'images/shared.svg': file('collision') } }), /Existing asset would be overwritten/)
})

test('local inventory refuses junctions and ambiguous filesystem keys', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-release-inventory-'))
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'se-release-link-'))
    fs.symlinkSync(target, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => inventory(root), /Symlink/)
    const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'se-release-unsafe-'))
    fs.writeFileSync(path.join(bad, 'not a website key'), 'synthetic')
    assert.throws(() => inventory(bad), /Unsafe/)
})
