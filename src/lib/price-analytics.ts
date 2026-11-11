import { offerRemainingMs, type ReportOffer } from './reports/offers.ts'

// Self-contained so the identical allowlist also runs inside the isolated frame.
export function sanitizePriceAnalytics(value: unknown) {
    if (!value || typeof value !== 'object') return null
    const input = value as Record<string, unknown>
    if (!['price_impression', 'price_checkout_attempt'].includes(input.name as string) ||
        !['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8'].includes(input.experiment as string) ||
        !['v1', 'v2', 'v3', 'v4'].includes(input.variant as string) ||
        !['company', 'order'].includes(input.surface as string) ||
        (input.name === 'price_checkout_attempt' && input.surface !== 'order')) return null
    return { name: input.name as string, experiment: input.experiment as string,
        variant: input.variant as string, surface: input.surface as string }
}

export type PriceAnalyticsEvent = NonNullable<ReturnType<typeof sanitizePriceAnalytics>>

export function createPriceMeasurement(options: {
    surface: 'company' | 'order'
    consent: () => boolean
    visible: () => boolean
    fresh: () => boolean
    send: (value: PriceAnalyticsEvent) => void
}) {
    let slots: PriceAnalyticsEvent | null = null
    const impressions = new Set<string>()
    const attempts = new Set<string>()
    const key = () => slots && `${slots.experiment}:${slots.variant}:${slots.surface}`
    function refresh() {
        const id = key()
        if (!slots || !id || !options.consent() || !options.visible() || !options.fresh() || impressions.has(id)) return
        impressions.add(id)
        options.send(slots)
    }
    return {
        setOffer(offer?: Pick<ReportOffer, 'analyticsExperiment' | 'analyticsVariant'>) {
            slots = sanitizePriceAnalytics({ name: 'price_impression', experiment: offer?.analyticsExperiment,
                variant: offer?.analyticsVariant, surface: options.surface })
            refresh()
        },
        refresh,
        attempt() {
            refresh()
            const id = key()
            if (!slots || !id || options.surface !== 'order' || !options.consent() || !options.fresh() || !impressions.has(id) || attempts.has(id)) return
            attempts.add(id)
            options.send({ ...slots, name: 'price_checkout_attempt' })
        },
    }
}

export function observePriceExposure(element: HTMLElement, surface: 'company' | 'order') {
    let offer: ReportOffer | undefined
    let intersects = false
    const measurement = createPriceMeasurement({
        surface,
        consent: () => {
            try { return document.documentElement.dataset.priceAnalyticsReady === 'true' && localStorage.getItem('kreditrisker_consent') === 'granted' } catch { return false }
        },
        visible: () => intersects && document.visibilityState === 'visible' &&
            !element.closest('[hidden]') && typeof element.checkVisibility === 'function' && element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
        fresh: () => Boolean(offer && offerRemainingMs(offer) > 0),
        send: value => window.dispatchEvent(new CustomEvent('kreditrisker:analytics', { detail: value })),
    })
    if (typeof IntersectionObserver !== 'undefined') {
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.target === element) {
                intersects = entry.isIntersecting && entry.intersectionRatio >= 0.5
                measurement.refresh()
            }
        }, { threshold: [0, 0.5] })
        observer.observe(element)
    }
    document.addEventListener('visibilitychange', measurement.refresh)
    window.addEventListener('kreditrisker:consent', measurement.refresh)
    return {
        setOffer(value?: ReportOffer) { offer = value; measurement.setOffer(value) },
        attempt: measurement.attempt,
    }
}

export function loadWhenNearViewport(element: Element, load: () => void,
    makeObserver?: (callback: IntersectionObserverCallback, options: IntersectionObserverInit) => IntersectionObserver) {
    if (!makeObserver && typeof IntersectionObserver === 'undefined') {
        load()
        return () => {}
    }
    let loaded = false
    const observer = (makeObserver ?? ((callback, options) => new IntersectionObserver(callback, options)))(entries => {
        if (loaded || !entries.some(entry => entry.target === element && entry.isIntersecting)) return
        loaded = true
        observer.disconnect()
        load()
    }, { rootMargin: '400px', threshold: 0 })
    observer.observe(element)
    return () => observer.disconnect()
}
