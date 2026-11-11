import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import fs from 'node:fs'
import { createPriceMeasurement, loadWhenNearViewport, observePriceExposure, sanitizePriceAnalytics } from '../src/lib/price-analytics.ts'

const slots = { analyticsExperiment: 'e1', analyticsVariant: 'v2' }
const impression = { name: 'price_impression', experiment: 'e1', variant: 'v2', surface: 'order' }

test('sender and isolated frame allow only fixed slots and strip every extra field', () => {
    const frameSanitize = vm.runInNewContext(`(${sanitizePriceAnalytics.toString()})`)
    for (const sanitize of [sanitizePriceAnalytics, frameSanitize]) {
        const input = { ...impression, orgnr: '5560369208', company: 'Private company', email: 'buyer@example.test',
            quote: 'signed-secret', url: 'https://example.test/private', price: '29 kr' }
        assert.deepEqual(JSON.parse(JSON.stringify(sanitize(input))), impression)
        for (const change of [{ experiment: 'private-company' }, { experiment: 'e9' }, { variant: 'v5' },
            { variant: '5560369208' }, { surface: '/foretag/private/' }, { name: 'purchase' },
            { name: 'price_checkout_attempt', surface: 'company' }]) assert.equal(sanitize({ ...input, ...change }), null)
        for (const invalid of [undefined, null, [], 'e1', 1]) assert.equal(sanitize(invalid), null)
    }
})

test('a price visible before consent is counted only once when consent is later granted', () => {
    let consent = false
    let visible = true
    const sent: unknown[] = []
    const measurement = createPriceMeasurement({ surface: 'order', consent: () => consent, visible: () => visible, fresh: () => true, send: value => sent.push(value) })
    measurement.setOffer(slots)
    measurement.attempt()
    assert.equal(sent.length, 0)
    consent = true
    measurement.refresh()
    measurement.refresh()
    measurement.setOffer(slots)
    assert.deepEqual(sent, [impression])
    visible = false
    measurement.refresh()
    visible = true
    measurement.refresh()
    measurement.attempt()
    measurement.attempt()
    assert.deepEqual(sent, [impression, { ...impression, name: 'price_checkout_attempt' }])
})

test('hidden/expired prices and rejected consent never enroll in the attempted-order cohort', () => {
    let consent = false, visible = false, fresh = true
    const sent: unknown[] = []
    const measurement = createPriceMeasurement({ surface: 'order', consent: () => consent, visible: () => visible, fresh: () => fresh, send: value => sent.push(value) })
    measurement.setOffer(slots)
    consent = true
    measurement.refresh()
    measurement.attempt()
    visible = true; fresh = false
    measurement.refresh()
    measurement.attempt()
    assert.equal(sent.length, 0)
    fresh = true
    measurement.refresh()
    consent = false
    measurement.attempt()
    assert.deepEqual(sent, [impression])
})

test('company and order surfaces remain separate and generic/baseline prices have no experiment events', () => {
    const sent: unknown[] = []
    const measurement = createPriceMeasurement({ surface: 'company', consent: () => true, visible: () => true, fresh: () => true, send: value => sent.push(value) })
    measurement.setOffer()
    measurement.setOffer({})
    measurement.attempt()
    assert.equal(sent.length, 0)
    measurement.setOffer(slots)
    measurement.attempt()
    measurement.setOffer({ ...slots, analyticsVariant: 'v3' })
    assert.deepEqual(sent, [{ ...impression, surface: 'company' }, { ...impression, surface: 'company', variant: 'v3' }])
})

test('offscreen panels make no offer request until near the viewport, then load once', () => {
    const element = {} as Element
    let callback: IntersectionObserverCallback
    let options: IntersectionObserverInit | undefined
    let loads = 0, disconnects = 0
    const observer = { observe(target: Element) { assert.equal(target, element) }, disconnect() { disconnects++ } } as unknown as IntersectionObserver
    loadWhenNearViewport(element, () => loads++, (value, settings) => { callback = value; options = settings; return observer })
    assert.equal(loads, 0)
    assert.equal(options?.rootMargin, '400px')
    const enter = (isIntersecting: boolean) => callback!([{ target: element, isIntersecting } as IntersectionObserverEntry], observer)
    enter(false)
    assert.equal(loads, 0)
    enter(true)
    enter(true)
    assert.equal(loads, 1)
    assert.equal(disconnects, 1)
})

test('missing IntersectionObserver falls back to fetching the current price', () => {
    let loads = 0
    const stop = loadWhenNearViewport({} as Element, () => loads++)
    assert.equal(loads, 1)
    stop()
})

test('DOM wiring waits for bridge readiness, real intersection, foreground visibility and later consent', t => {
    let consent = 'denied'
    let intersect: IntersectionObserverCallback
    const windowEvents = new EventTarget()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden', documentElement: { dataset: { priceAnalyticsReady: 'false' } } })
    const sent: unknown[] = []
    windowEvents.addEventListener('kreditrisker:analytics', event => sent.push((event as CustomEvent).detail))
    const replacements = { document: doc, window: windowEvents, localStorage: { getItem: () => consent },
        IntersectionObserver: class { constructor(callback: IntersectionObserverCallback) { intersect = callback } observe() {} } }
    for (const [name, value] of Object.entries(replacements)) {
        const original = Object.getOwnPropertyDescriptor(globalThis, name)
        Object.defineProperty(globalThis, name, { configurable: true, value })
        t.after(() => { if (original) Object.defineProperty(globalThis, name, original); else Reflect.deleteProperty(globalThis, name) })
    }
    const element = { closest: () => null, checkVisibility: () => true } as unknown as HTMLElement
    const exposure = observePriceExposure(element, 'order')
    const enter = (visible: boolean) => intersect!([{ target: element, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver)
    exposure.setOffer({ ...slots, unitAmount: 2900, currency: 'sek', taxBehavior: 'inclusive', expiresAt: 0, remainingMs: 300000, validUntil: performance.now() + 300000 })
    enter(true)
    consent = 'granted'
    windowEvents.dispatchEvent(new Event('kreditrisker:consent'))
    assert.equal(sent.length, 0, 'hidden document/absent bridge must not count')
    doc.documentElement.dataset.priceAnalyticsReady = 'true'
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.deepEqual(sent, [impression])
    enter(false)
    consent = 'denied'
    exposure.attempt()
    assert.equal(sent.length, 1)
    consent = 'granted'
    windowEvents.dispatchEvent(new Event('kreditrisker:consent'))
    enter(true)
    exposure.attempt()
    exposure.attempt()
    assert.deepEqual(sent, [impression, { ...impression, name: 'price_checkout_attempt' }])
    Reflect.deleteProperty(element, 'checkVisibility')
    exposure.setOffer({ ...slots, analyticsVariant: 'v3', unitAmount: 2900, currency: 'sek', taxBehavior: 'inclusive', expiresAt: 0, remainingMs: 300000, validUntil: performance.now() + 300000 })
    enter(true)
    assert.equal(sent.length, 2, 'unsupported CSS visibility checking omits measurement without affecting price rendering')
})

test('actual built frame strips PII and rejects bad source, origin and slots without network', { skip: !process.env.PRICE_ANALYTICS_FRAME_HTML }, () => {
    const html = fs.readFileSync(process.env.PRICE_ANALYTICS_FRAME_HTML!, 'utf8')
    const source = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(value => value.includes('sanitizePriceAnalytics'))
    assert.ok(source)
    let receive: (event: unknown) => void
    const parent = {}
    const frameWindow = { dataLayer: [] as IArguments[] }
    vm.runInNewContext(source, { window: frameWindow, parent,
        document: { body: { dataset: { analyticsId: 'G-LOCALTEST' } }, head: { appendChild() {} }, createElement: () => ({}) },
        addEventListener: (name: string, callback: typeof receive) => { assert.equal(name, 'message'); receive = callback },
    })
    const message = (data: unknown, origin = 'https://www.kreditrisker.se', sender = parent) => receive!({ data, origin, source: sender })
    message({ type: 'init', page: 'company', referrer: 'google' })
    const count = frameWindow.dataLayer.length
    const payload = { type: 'price_event', ...impression, orgnr: '5560369208', email: 'private@example.test', url: 'https://example.test/private', quote: 'secret', amount: '29 kr' }
    message(payload, 'https://attacker.example.test')
    message(payload, undefined, {})
    message({ ...payload, variant: 'private@example.test' })
    message({ ...payload, experiment: 'e9' })
    assert.equal(frameWindow.dataLayer.length, count)
    message(payload)
    const emitted = Array.from(frameWindow.dataLayer.at(-1)!)
    assert.deepEqual(JSON.parse(JSON.stringify(emitted)), ['event', 'price_impression', { experiment_id: 'e1', variant_id: 'v2', price_surface: 'order' }])
    assert.equal(JSON.stringify(frameWindow.dataLayer).includes('private'), false)
})
