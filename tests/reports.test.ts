import { test } from 'node:test'
import assert from 'node:assert/strict'
import { disabledBackend, httpBackend, mockBackend, parseState } from '../src/lib/reports/adapter.ts'
import { staticReportState } from '../src/lib/reports/availability.ts'

test('default build: both products unavailable, no price', () => {
    for (const p of ['basic', 'ai'] as const) assert.deepEqual(staticReportState(p, null), { kind: 'unavailable', reason: 'not_launched' })
})

test('products are independent: basic sample while AI stays unavailable', () => {
    assert.equal(staticReportState('basic', null, 'sample').kind, 'sample')
    assert.equal(staticReportState('ai', null, 'unavailable').kind, 'unavailable')
})

test('"live" without checkout is still unavailable; with checkout, no unverified price', () => {
    assert.equal(staticReportState('ai', null, 'live', false).kind, 'unavailable')
    const s = staticReportState('ai', null, 'live', true)
    assert.equal(s.kind, 'available')
    assert.equal(s.kind === 'available' && s.price, undefined)
})

test('disabled backend never offers a report', async () => {
    assert.equal((await disabledBackend.availability('x', 'basic')).kind, 'unavailable')
    assert.equal((await disabledBackend.createOrder({ orgnr: 'x', product: 'ai', email: 'a@b.se', acceptedTermsVersion: '0' })).kind, 'unavailable')
})

test('mock backend walks processing -> success and processing -> failure', async () => {
    let t = 0
    const b = mockBackend(1000, () => t)
    const ok = await b.createOrder({ orgnr: 'x', product: 'basic', email: 'a@b.se', acceptedTermsVersion: '0' })
    const bad = await b.createOrder({ orgnr: 'x', product: 'ai', email: 'fail@b.se', acceptedTermsVersion: '0' })
    assert.equal(ok.kind, 'processing')
    assert.equal((await b.orderStatus((ok as { orderId: string }).orderId, 'basic')).kind, 'processing')
    t = 1500
    assert.equal((await b.orderStatus((ok as { orderId: string }).orderId, 'basic')).kind, 'success')
    const f = await b.orderStatus((bad as { orderId: string }).orderId, 'ai')
    assert.deepEqual(f, { kind: 'failure', orderId: 'mock-ai-2', code: 'generation_failed', retryable: true })
})

test('http adapter: malformed or unsafe responses become failures, prices are ignored', async () => {
    assert.equal(parseState({ kind: 'success', orderId: '1', downloadHref: 'javascript:alert(1)' }).kind, 'failure')
    assert.deepEqual(parseState({ kind: 'available', price: { amountSek: 1 } }), { kind: 'available' })
    assert.equal(parseState(null).kind, 'failure')
    const down = httpBackend('https://api.invalid/', async () => {
        throw new Error('offline')
    })
    assert.deepEqual(await down.availability('x', 'basic'), { kind: 'unavailable', reason: 'backend_unreachable' })
    const err = httpBackend('https://api.invalid/', async () => new Response('', { status: 503 }))
    assert.deepEqual(await err.orderStatus('1', 'ai'), { kind: 'failure', code: 'http_503', retryable: true })
})
