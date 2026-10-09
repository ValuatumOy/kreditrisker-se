// Valuatum REST bundle -> contract record, and the fetch stage that turns a
// batch list into pages plus a merged directory index. The fixture has the
// shape of a real /rest/modeldata + /rest/company response (values in millions).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { mapBundle } from '../src/lib/valuatum/map.ts'
import { batchMode, readParams, selectBatch } from '../src/lib/valuatum/params.ts'
import { validateRecord } from '../src/lib/contract/validate.ts'
import type { Bundle } from '../src/lib/valuatum/api.ts'

const ROOT = path.join(import.meta.dirname, '..')
const bundle = (): Bundle => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures-api-bundle.json'), 'utf8'))
const opts = { batchId: 't', importedAt: '2026-10-02T00:00:00Z' }

test('maps a REST bundle to a valid record', () => {
    const res = mapBundle(bundle(), opts)
    assert.ok(res.ok)
    const r = res.record
    assert.deepEqual(validateRecord(r).errors, [])
    assert.equal(r.orgnr, '5569876542')
    assert.equal(r.legalForm, 'AB')
    assert.equal(r.status.code, 'active')
    assert.deepEqual(r.municipality, { code: '2480', name: 'Umeå', county: 'Västerbottens län' })
    assert.deepEqual(r.sni[0], { version: 'SNI2025', code: '47789', label: 'Övrig specialiserad detaljhandel' })
    assert.deepEqual(r.periods.map((p) => p.end), ['2025-12-31', '2024-12-31', '2023-12-31', '2022-12-31', '2021-12-31', '2020-12-31'])
    const p24 = r.periods[1]
    assert.deepEqual(p24.income.netSales, { status: 'reported', value: 5_902_461_000, source: r.status.source })
    assert.ok(p24.income.personnelCosts.status === 'reported' && p24.income.personnelCosts.value > 0, 'costs are stored as positive amounts')
    assert.deepEqual(p24.balance.untaxedReserves, { status: 'missing', reason: 'not_in_source' }, 'absent items are missing, never 0')
    assert.equal(p24.months, 12)
})

test('rejects bundles that are not Swedish companies', () => {
    const b = bundle()
    b.companies[0].companyCode = '13590400'
    assert.equal(mapBundle(b, opts).ok, false)
    const c = bundle()
    c.modeldata.currency = 'DKK'
    assert.equal(mapBundle(c, opts).ok, false)
})

test('static params: orgnr parsed, group-account K codes skipped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-params-'))
    const f = path.join(dir, 'p.txt')
    fs.writeFileSync(f, '900001\ttestbolaget\tTestbolaget Norrland AB\t47599\t556987-6542\n900002\ttestbolaget\tTestbolaget Norrland AB\t47599\t5569876542K\n')
    assert.deepEqual(readParams(f), [{ fid: '900001', name: 'Testbolaget Norrland AB', orgnr: '5569876542' }])
})

test('fetch stage: batch pages, merged index, removed companies dropped, renames redirect', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-fetch-'))
    const cache = path.join(dir, 'cache')
    fs.mkdirSync(cache)
    fs.writeFileSync(path.join(cache, '900001.json'), JSON.stringify(bundle()))
    fs.writeFileSync(path.join(dir, 'batch.txt'), '900001\tx\tTestbolaget Norrland AB\t47599\t5569876542\n900404\tx\tSaknas AB\t47599\t5560000001\n')
    fs.writeFileSync(path.join(dir, 'all.txt'), '900001\tx\tTestbolaget Norrland AB\t47599\t5569876542\n')
    const prev = path.join(dir, 'prev.jsonl')
    const old = { o: '5569876542', n: 'Gamla Namnet AB', p: '/foretag/5569876542/gamla-namnet-ab/', rf: [], st: 'active', fr: 'current', ix: false, q: false, syn: false, im: '2026-01-01' }
    const gone = { ...old, o: '5560000019', n: 'Borttaget AB', p: '/foretag/5560000019/borttaget-ab/' }
    fs.writeFileSync(prev, [old, gone].map((x) => JSON.stringify(x)).join('\n') + '\n')
    const env = { ...process.env, BUILD_STATIC_PARAMS_FILE: path.join(dir, 'batch.txt'), BUILD_STATIC_PARAMS_FILE_ALL: path.join(dir, 'all.txt'), SE_INDEX_IN: prev, SE_API_CACHE_DIR: cache, PUBLIC_VALUATUM_API_BASE_URL: '', SECRET_VALUATUM_API_TOKEN: '' }
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch.ts')], { cwd: dir, env, stdio: 'pipe' })
    const read = (f: string) => fs.readFileSync(path.join(dir, 'data', 'build', f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const pages = read('pages.jsonl')
    const rows = read('index.jsonl')
    assert.equal(pages.length, 1)
    assert.deepEqual(rows.map((r) => r.o), ['5569876542'], 'company absent from the full list is dropped')
    assert.equal(rows[0].p, '/foretag/5569876542/testbolaget-norrland-ab/')
    assert.deepEqual(rows[0].rf, ['/foretag/5569876542/gamla-namnet-ab/'], 'old slug redirects')
    assert.equal(rows[0].ns, 6_518_822_000, 'newest year in kronor')
    assert.equal(read('rejected.jsonl')[0].fid, '900404', 'uncached company without API access is rejected, not fatal')
    assert.equal(fs.readFileSync(path.join(dir, 'data', 'build', 'removed.txt'), 'utf8'), 'foretag/5560000019/\n', 'deploy deletes pages of removed companies')
})

test('batch selection: modes, orgnr with or without hyphen, fids, group rows, unknown companies', () => {
    const all = [
        '1\ta\tAlfa AB\t62100\t5564480282',
        '2\ta\tAlfa AB\t62100\t5564480282K',
        '3\tb\tBeta AB\t47789\t5565675906',
        '4\tc\tGamma AB\t41000\t5591844112',
    ]
    assert.deepEqual(selectBatch(all, [], 'all', ''), all)
    assert.deepEqual(selectBatch(all, [], 'listed', '556448-0282'), all.slice(0, 2), 'orgnr selects the group row too')
    assert.deepEqual(selectBatch(all, [], 'listed', '5565675906,\n4'), all.slice(2), 'orgnr and fid, any separator')
    assert.deepEqual(selectBatch(all, [all[3]], 'changed', ''), [all[3]])
    assert.deepEqual(selectBatch(all, [all[3]], 'changed', '3'), all.slice(2), 'changed plus listed, directory order')
    assert.throws(() => selectBatch(all, [], 'listed', '5560659475 99'), /5560659475, 99/)
    assert.equal(batchMode(' \n'), 'changed', 'empty COMPANIES is the nightly run')
    assert.equal(batchMode(' ALL '), 'all')
    assert.equal(batchMode('556448-0282'), 'listed')
})
