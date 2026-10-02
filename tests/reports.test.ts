import { test } from 'node:test'
import assert from 'node:assert/strict'
import { disabledBackend, httpBackend, mockBackend } from '../src/lib/reports/adapter.ts'
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

test('http adapter: Stripe redirect only to Stripe, errors become states', async () => {
    const req = { orgnr: '5569876542', product: 'basic' as const, email: 'a@b.se', acceptedTermsVersion: 'v', fid: '900001', returnPath: '/bestall/?orgnr=5569876542' }
    let sent: Record<string, unknown> = {}
    const ok = httpBackend('https://www.kreditrisker.se/api/', async (url, init) => {
        assert.equal(String(url), 'https://www.kreditrisker.se/api/create-checkout')
        sent = JSON.parse(String(init!.body))
        return Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
    })
    assert.deepEqual(await ok.createOrder(req), { kind: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_1' })
    assert.equal(sent.reportType, 'se_credit_risk')
    assert.equal(sent.businessId, '5569876542')
    assert.equal(sent.fid, '900001')
    assert.equal('price' in sent || 'amount' in sent, false, 'the client never sends a price')
    const evil = httpBackend('https://x/api/', async () => Response.json({ url: 'https://evil.example/pay' }))
    assert.equal((await evil.createOrder(req)).kind, 'failure')
    const down = httpBackend('https://x/api/', async () => {
        throw new Error('offline')
    })
    assert.deepEqual(await down.createOrder(req), { kind: 'unavailable', reason: 'backend_unreachable' })
    const err = httpBackend('https://x/api/', async () => new Response('', { status: 503 }))
    assert.deepEqual(await err.createOrder(req), { kind: 'failure', code: 'http_503', retryable: true })
})
