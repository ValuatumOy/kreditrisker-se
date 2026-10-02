// Batch import -> staging -> publish -> incremental update -> rollback,
// against a throwaway data directory.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { publishRelease, stageBatch, emptyRelease } from '../src/lib/pipeline.ts'
import { siteFromRelease } from '../src/lib/publish.ts'
import { currentReleaseId, readCurrentRelease, readRelease, readStaged, setCurrent, writeRelease, writeStaged } from '../src/lib/releaseio.ts'
import { AS_OF, FIXTURES, batch1, batch2, byName } from './helpers.ts'

let dir: string
before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-data-'))
    process.env.SE_DATA_DIR = dir
})
after(() => fs.rmSync(dir, { recursive: true, force: true }))

test('first batch: all valid fixtures staged and published', () => {
    const staged = stageBatch(batch1(), { batchId: 'b1', importedAt: '2026-09-01T00:00:00Z', current: readCurrentRelease() })
    assert.equal(staged.rejected.length, 0)
    assert.equal(staged.diff.added.length, batch1().length)
    writeStaged(staged)
    const rel = publishRelease(readStaged('b1'), readCurrentRelease(), { releaseId: 'r1', createdAt: '2026-09-01T00:00:00Z' })
    writeRelease(rel)
    setCurrent('r1')
    assert.equal(currentReleaseId(), 'r1')
    assert.equal(readCurrentRelease().companies.length, batch1().length)
    assert.equal(rel.manifest.changed.length, batch1().length)
    assert.throws(() => writeRelease(rel), /immutable/)
})

test('update batch: dedupe, reject invalid, detect rename and no-op rows', () => {
    const staged = stageBatch(batch2(), { batchId: 'b2', importedAt: '2026-09-20T00:00:00Z', current: readCurrentRelease() })
    const kinds = staged.rejected.map((r) => `${r.kind}:${r.name}`)
    assert.deepEqual(kinds.sort(), [
        'duplicate:Exempel Mekaniska Västerås AB',
        'invalid:Exempel Felaktigt Orgnr AB',
        'invalid:Exempel Nolla Istället AB',
    ])
    const dup = staged.rejected.find((r) => r.kind === 'duplicate')!
    assert.equal(dup.index, 2, 'the row with older statements loses')
    const kept = staged.accepted.find((r) => r.name === 'Exempel Mekaniska Västerås AB')!
    assert.equal(kept.periods.length, 2)

    assert.equal(staged.diff.added.length, 1)
    assert.equal(staged.diff.updated.length, 2)
    assert.equal(staged.diff.unchanged.length, 1, 'hyphenated orgnr normalises to an identical record')
    assert.deepEqual(staged.diff.renamed.map((r) => r.to), ['Exempel Elteknik Syd AB'])

    writeStaged(staged)
    const lines = fs.readFileSync(path.join(dir, 'staging', 'b2', 'rejected.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
    assert.ok(JSON.parse(lines[0]).errors.length > 0)
})

test('publish update: incremental change list, redirects for the renamed company', () => {
    const before = readCurrentRelease()
    const rel = publishRelease(readStaged('b2'), before, { releaseId: 'r2', createdAt: '2026-09-20T00:00:00Z' })
    writeRelease(rel)
    setCurrent('r2')
    assert.equal(rel.manifest.parent, 'r1')
    assert.equal(rel.manifest.changed.length, 3)
    assert.equal(rel.companies.length, before.companies.length + 1)

    const site = siteFromRelease(rel, AS_OF)
    const el = site.companies.find((c) => c.record.name === 'Exempel Elteknik Syd AB')!
    assert.equal(el.path, `/foretag/${el.record.orgnr}/exempel-elteknik-syd-ab/`)
    assert.ok(site.redirects.some((r) => r.from === `/foretag/${el.record.orgnr}/exempel-elinstallation-syd-ab/` && r.to === el.path))
    assert.ok(site.redirects.some((r) => r.from === `/foretag/${el.record.orgnr}/` && r.to === el.path))
    // Redirect sources never collide with a canonical page.
    const canon = new Set(site.companies.map((c) => c.path))
    assert.ok(site.redirects.every((r) => !canon.has(r.from)))
    const bygg = site.companies.find((c) => c.record.name.startsWith('Exempel Byggnads'))!
    assert.equal(bygg.record.status.code, 'reconstruction')
})

test('rollback moves CURRENT back; releases stay intact', () => {
    setCurrent(readRelease('r2').manifest.parent!)
    assert.equal(currentReleaseId(), 'r1')
    assert.equal(readCurrentRelease().companies.find((c) => c.name === 'Exempel Elinstallation Syd AB')?.formerNames.length, 0)
    assert.equal(readRelease('r2').companies.length, batch1().length + 1)
    setCurrent('r2')
})

test('removal and slug history survive later releases', () => {
    const tand = byName(batch1(), 'Exempel Tandvård')
    const staged = stageBatch([], { batchId: 'b3', importedAt: '2026-09-21T00:00:00Z', current: readCurrentRelease() })
    const rel = publishRelease(staged, readCurrentRelease(), { releaseId: 'r3', createdAt: '2026-09-21T00:00:00Z', remove: [tand.orgnr] })
    assert.deepEqual(rel.manifest.removed, [tand.orgnr])
    assert.equal(rel.companies.some((c) => c.orgnr === tand.orgnr), false)
    const el = rel.companies.find((c) => c.name === 'Exempel Elteknik Syd AB')!
    assert.deepEqual(rel.slugHistory[el.orgnr], ['exempel-elinstallation-syd-ab', 'exempel-elteknik-syd-ab'])
})

test('a release cannot mix synthetic and real records', () => {
    const real = { ...byName(batch1(), 'Exempel Mjukvara'), synthetic: false }
    const staged = { batchId: 'mix', importedAt: '', accepted: [real, byName(batch1(), 'Exempel Holding')], rejected: [], diff: { added: [], updated: [], unchanged: [], renamed: [] } }
    assert.throws(() => publishRelease(staged, emptyRelease(), { releaseId: 'x', createdAt: '' }), /mix synthetic/)
})

test('CLI: import, publish, rollback, status', () => {
    const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-cli-'))
    const run = (...args: string[]) =>
        spawnSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'data.ts'), ...args], {
            encoding: 'utf8',
            env: { ...process.env, SE_DATA_DIR: cliDir, SE_DATA_AS_OF: AS_OF },
        })
    try {
        let r = run('import', path.join(FIXTURES, 'synthetic-batch-001.jsonl'), '--batch', 'cli1')
        assert.equal(r.status, 0, r.stderr)
        assert.match(r.stdout, /accepted 18: 18 new/)
        r = run('publish', 'cli1')
        assert.equal(r.status, 0, r.stderr)
        r = run('import', path.join(FIXTURES, 'synthetic-batch-002-update.jsonl'), '--batch', 'cli2')
        assert.match(r.stdout, /rejected 3/)
        r = run('publish', 'cli2')
        assert.equal(r.status, 0, r.stderr)
        r = run('rollback')
        assert.equal(r.status, 0, r.stderr)
        assert.match(r.stdout, /CURRENT: r-.* -> r-/)
        r = run('status')
        assert.equal(r.status, 0, r.stderr)
        assert.match(r.stdout, /0 pass the index threshold/)
        assert.match(r.stdout, /noindex .*Exempel Fastigheter.*för få nyckelposter/)
    } finally {
        fs.rmSync(cliDir, { recursive: true, force: true })
    }
})
