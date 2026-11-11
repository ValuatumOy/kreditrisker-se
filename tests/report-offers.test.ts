import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadReportOffer, offerLabel } from '../src/lib/reports/offers.ts'
import { httpBackend } from '../src/lib/reports/adapter.ts'

const offer = () => ({ reportType: 'se_credit_risk', unitAmount: 1100, currency: 'sek', taxBehavior: 'inclusive', expiresAt: Math.floor(Date.now() / 1000) + 300, quote: 'mock-signed-quote' })

test('runtime availability gets uncached, company-specific offer and sends its quote to checkout', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const backend = httpBackend('/api/', async (url, init) => {
        calls.push({ url: String(url), init })
        return init?.method === 'POST' ? Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_test_mock' }) : Response.json(offer())
    }, 'https://www.kreditrisker.se')
    const state = await backend.availability('5560369208', 'basic')
    assert.equal(state.kind, 'available')
    assert.equal(new URL(calls[0].url).searchParams.get('businessId'), '556036-9208')
    assert.equal(calls[0].init?.cache, 'no-store')
    if (state.kind !== 'available' || !state.offer) throw new Error('Missing offer')
    assert.equal(state.price?.amountSek, 11)
    assert.equal(offerLabel(state.offer), '11 kr inkl. moms för konsument i Sverige')
    const result = await backend.createOrder({ orgnr: '5560369208', product: 'basic', email: 'buyer@example.test', acceptedTermsVersion: 'test-v1', priceQuote: state.offer.quote })
    assert.equal(result.kind, 'redirect')
    const body = JSON.parse(String(calls[1].init?.body))
    assert.equal(body.priceQuote, 'mock-signed-quote')
    assert.equal('unitAmount' in body, false)
})

test('unavailable, expired and invalid offers leave HTTP availability closed', async () => {
    for (const value of [{ ...offer(), expiresAt: 0 }, { ...offer(), unitAmount: 1.5 }, { ...offer(), taxBehavior: 'exclusive' }, { ...offer(), currency: 'usd' }, { ...offer(), quote: 123 }]) {
        const backend = httpBackend('/api/', async () => Response.json(value), 'https://www.kreditrisker.se')
        assert.deepEqual(await backend.availability('5560369208', 'basic'), { kind: 'unavailable', reason: 'backend_unreachable' })
    }
    const backend = httpBackend('/api/', async () => new Response('', { status: 503 }), 'https://www.kreditrisker.se')
    assert.equal((await backend.availability('5560369208', 'basic')).kind, 'unavailable')
    assert.equal((await backend.availability('5560369208', 'ai')).kind, 'available')
})

test('generic pages show verified baseline or from-price without assigning a company offer', async () => {
    for (const from of [false, true]) {
        const value = await loadReportOffer('/api/', undefined, async (url, init) => {
            const parsed = new URL(url.toString())
            assert.equal(parsed.searchParams.get('offer'), 'summary')
            assert.equal(parsed.searchParams.has('businessId'), false)
            assert.equal(init?.cache, 'no-store')
            return Response.json({ ...offer(), quote: undefined, from })
        }, 'https://www.kreditrisker.se')
        assert.equal(offerLabel(value), `${from ? 'Från ' : ''}11 kr inkl. moms för konsument i Sverige`)
    }
    await assert.rejects(loadReportOffer('/api/', '5560369208', async () => Response.json({ ...offer(), from: true }), 'https://www.kreditrisker.se'))
})

test('version conflicts remain errors for the UI to reload and reconfirm, with no silent retry', async () => {
    let count = 0
    const backend = httpBackend('/api/', async () => { count++; return new Response('', { status: 409 }) }, 'https://www.kreditrisker.se')
    assert.deepEqual(await backend.createOrder({ orgnr: '5560369208', product: 'basic', email: 'buyer@example.test', acceptedTermsVersion: 'v', priceQuote: 'stale' }), { kind: 'failure', code: 'http_409', retryable: false })
    assert.equal(count, 1)
})
