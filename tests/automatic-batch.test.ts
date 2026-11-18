import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { automaticBatch, selectIndustryMix, type Param } from '../src/lib/valuatum/params.ts'
import { writeJsonl } from '../src/lib/jsonl.ts'

const ROOT = path.join(import.meta.dirname, '..')
const params: Param[] = [
    { fid: '1', orgnr: '5564480282', name: 'Legacy' },
    { fid: '2', orgnr: '5565675906', name: 'Changed', updatedAt: '2026-11-18T00:00:00.000Z' },
    { fid: '3', orgnr: '5591844112', name: 'New' },
    { fid: '4', orgnr: '5560659475', name: 'Current', updatedAt: '2026-11-18T00:00:00.000Z' },
    { fid: '5', orgnr: '5569876542', name: 'Unknown rendered' },
]
const rows = [
    { o: params[0].orgnr! },
    { o: params[1].orgnr!, rv: '2026-11-17T00:00:00.000Z', up: params[1].updatedAt },
    { o: params[3].orgnr!, rv: params[3].updatedAt },
    { o: params[4].orgnr!, rv: null },
]

test('automatic selection mixes existing and unpublished, ignores global up, and renders legacy only once', () => {
    const picked = automaticBatch(params, rows, 2, 0)
    assert.deepEqual(picked.map((p) => p.fid), ['1', '3'])
    assert.deepEqual(automaticBatch(params, rows, 4, 0).map((p) => p.fid), ['1', '2', '3'])
    const rendered = rows.map((r) => ({ ...r, rv: params.find((p) => p.orgnr === r.o)!.updatedAt ?? null }))
    rendered.push({ o: params[2].orgnr!, rv: null })
    assert.deepEqual(automaticBatch(params, rendered, 3, 0), [])
    assert.deepEqual(automaticBatch(params.map((p) => p.fid === '5' ? { ...p, updatedAt: '2026-11-19T00:00:00.000Z' } : p), rendered, 3, 0).map((p) => p.fid), ['5'])
})

test('automatic selection fills spare quota and rotates rejected prefixes on later half-hour slots', () => {
    assert.equal(automaticBatch(params, [], 3, 0).length, 3)
    const old = params.map((p) => ({ o: p.orgnr! }))
    assert.equal(automaticBatch(params, old, 4, 0).length, 4)
    assert.notDeepEqual(automaticBatch(params, old, 2, 0), automaticBatch(params, old, 2, 1))
    assert.equal(automaticBatch([...params, params[0]], [], 10, 0).length, params.length)
})

test('NACE-sorted unknown prefix cannot hide known industries and both automatic cohorts keep their quotas', () => {
    const row = (i: number, sni: string): Param => ({ fid: String(i), orgnr: String(i).padStart(10, '0'), name: String(i), sni })
    const candidates = [
        ...Array.from({ length: 4_000 }, (_, i) => row(i, '0000')),
        ...['01110', '47190', '62010'].flatMap((sni, sector) => Array.from({ length: 1_000 }, (_, i) => row(4_000 + sector * 1_000 + i, sni))),
    ]
    for (const slot of [0, 1, 4, 35_000]) {
        const selected = selectIndustryMix(candidates, 3_000, slot)
        assert.equal(selected.filter((p) => p.sni !== '0000').length, 2_400)
        assert.equal(selected.filter((p) => p.sni === '0000').length, 600)
        assert.equal(new Set(selected.filter((p) => p.sni !== '0000').map((p) => p.sni!.slice(0, 2))).size, 3)
        assert.equal(new Set(selected.map((p) => p.orgnr)).size, 3_000)
        assert.deepEqual(selectIndustryMix([...candidates].reverse(), 3_000, slot), selected, 'source ordering does not change the stable selection')
    }
    const previous = candidates.filter((_, i) => i % 2 === 0).map((p) => ({ o: p.orgnr! }))
    const old = new Set(previous.map((r) => r.o))
    const selected = automaticBatch(candidates, previous, 3_000, 0)
    assert.equal(selected.filter((p) => old.has(p.orgnr!)).length, 1_500)
    assert.equal(selected.filter((p) => !old.has(p.orgnr!)).length, 1_500)
    assert.equal(selected.filter((p) => p.sni === '0000').length, 600)
})

test('one-company batches eventually advance every sector and unknown row, including both automatic cohorts', () => {
    const candidates = Array.from({ length: 11 }, (_, i) => ({ fid: String(i), orgnr: String(i).padStart(10, '0'), name: String(i), sni: i < 5 ? '0000' : ['01110', '47190', '62010'][i % 3] }))
    const picked = new Set(Array.from({ length: 60 }, (_, slot) => selectIndustryMix(candidates, 1, slot)[0].fid))
    assert.equal(picked.size, candidates.length)
    const previous = candidates.filter((_, i) => i % 2 === 0).map((p) => ({ o: p.orgnr }))
    const automatic = new Set(Array.from({ length: 120 }, (_, slot) => automaticBatch(candidates, previous, 1, slot)[0].fid))
    assert.equal(automatic.size, candidates.length)
    assert.notDeepEqual(selectIndustryMix(candidates, 5, 0), selectIndustryMix(candidates, 5, 1), 'rejections do not keep selecting the same prefix')
    assert.equal(selectIndustryMix(candidates.filter((p) => p.sni === '0000'), 20, 0).length, 5, 'unknown-only cohorts fill the batch')
})

test('manual new:N spreads across sectors despite NACE ordering while exact and changed modes retain unknowns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-industry-select-'))
    try {
        const all = path.join(dir, 'all.txt')
        const batch = path.join(dir, 'batch.txt')
        const prev = path.join(dir, 'prev.jsonl')
        const codes = ['0000', '00000', '01110', '47190', '62010']
        const lines = params.map((p, i) => `${p.fid}\ttest\t${p.name}\t${codes[i]}\t${p.orgnr}`)
        fs.writeFileSync(all, lines.join('\n') + '\n')
        writeJsonl(prev, [{ o: 'not-in-this-batch' }])
        const run = (companies: string) => {
            fs.writeFileSync(batch, lines[0] + '\n')
            const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/select-batch.ts')], { cwd: dir, encoding: 'utf8', env: { ...process.env, COMPANIES: companies, SE_AUTO_BATCH: '0', BUILD_STATIC_PARAMS_FILE: batch, BUILD_STATIC_PARAMS_FILE_ALL: all, SE_INDEX_IN: prev } })
            assert.equal(result.status, 0, result.stderr)
            return fs.readFileSync(batch, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')[3])
        }
        const chosen = run('new:4')
        assert.equal(chosen.length, 4)
        for (const code of codes.slice(2)) assert.ok(chosen.includes(code))
        assert.deepEqual(run(params[0].orgnr!), ['0000'])
        assert.deepEqual(run(''), ['0000'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('selector CLI preserves manual new/listed/changed modes and writes an empty automatic batch when current', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-auto-select-'))
    try {
        const all = path.join(dir, 'all.txt')
        const batch = path.join(dir, 'batch.txt')
        const prev = path.join(dir, 'prev.jsonl')
        const lines = params.map((p) => `${p.fid}\ttest\t${p.name}\t1\t${p.orgnr}${p.updatedAt ? `\t${Date.parse(p.updatedAt)}` : ''}`)
        fs.writeFileSync(all, lines.join('\n') + '\n')
        writeJsonl(prev, rows)
        const run = (companies: string, automatic = false) => {
            fs.writeFileSync(batch, lines[3] + '\n')
            const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/select-batch.ts')], { cwd: dir, encoding: 'utf8', env: { ...process.env, COMPANIES: companies, SE_AUTO_BATCH: automatic ? '1' : '0', BUILD_STATIC_PARAMS_FILE: batch, BUILD_STATIC_PARAMS_FILE_ALL: all, SE_INDEX_IN: prev } })
            assert.equal(result.status, 0, result.stderr)
            return fs.readFileSync(batch, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('\t')[0])
        }
        assert.deepEqual(run('new:1'), ['3'])
        assert.deepEqual(run('5564480282'), ['1'])
        assert.deepEqual(run(''), ['4'])
        assert.deepEqual(run('', true), ['1', '2', '3'])
        assert.deepEqual(run('auto'), ['1', '2', '3'])
        writeJsonl(prev, params.map((p) => ({ o: p.orgnr, rv: p.updatedAt ?? null })))
        assert.deepEqual(run('', true), [])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
