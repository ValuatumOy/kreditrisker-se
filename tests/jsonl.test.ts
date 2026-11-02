import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readJsonl, writeJsonl } from '../src/lib/jsonl.ts'

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-')), 'f.jsonl')

test('round-trips records across read chunks, multibyte text included', () => {
    const f = tmp()
    const pad = 'åäö'.repeat(3_000_000) // ~18 MB line: crosses the 16 MB read buffer mid-character
    const recs = [{ i: 0 }, { i: 1, pad }, { i: 2, name: 'Ångström AB' }]
    writeJsonl(f, recs)
    assert.deepEqual(readJsonl(f), recs)
})

test('missing, empty and blank-line files', () => {
    const f = tmp()
    assert.deepEqual(readJsonl(f), [])
    writeJsonl(f, [])
    assert.equal(fs.statSync(f).size, 0)
    assert.deepEqual(readJsonl(f), [])
    fs.writeFileSync(f, '{"a":1}\n\n{"a":2}')
    assert.deepEqual(readJsonl(f), [{ a: 1 }, { a: 2 }])
})
