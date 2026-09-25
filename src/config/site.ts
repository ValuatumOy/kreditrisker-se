// All brand, domain, indexing and launch switches live here and are driven by
// environment variables so the name and domain can change without code edits.
// Defaults are the safe pre-launch state: nothing indexable, nothing for sale.

const env = (k: string): string | undefined => {
    const v = process.env[k]
    return v === undefined || v === '' ? undefined : v
}
const flag = (k: string, dflt = false): boolean => {
    const v = env(k)
    return v === undefined ? dflt : v === '1' || v.toLowerCase() === 'true'
}

export const SITE = {
    /** Product name shown in the UI. Pending decision, see docs/DOMAIN.md. */
    name: env('SE_SITE_NAME') ?? 'Kreditrisker',
    /** Canonical origin without trailing slash. */
    origin: (env('SE_SITE_ORIGIN') ?? 'https://www.kreditrisker.se').replace(/\/$/, ''),
    locale: 'sv-SE',
    provider: {
        name: 'Valuatum Oy',
        // Finnish business ID, as published on luottoriskit.fi.
        businessId: '1612398-8',
        country: 'Finland',
        url: 'https://www.valuatum.com/',
        /** Swedish support address; not decided yet. */
        email: env('SE_CONTACT_EMAIL'),
    },
    /** Data as-of date for freshness. Fixed in tests; build date otherwise. */
    asOf: env('SE_DATA_AS_OF') ?? new Date().toISOString().slice(0, 10),
} as const

export const FLAGS = {
    /**
     * Master switch for search engines. Off = every page noindex and robots.txt
     * disallows everything. Turn on only after the launch gates in
     * docs/LAUNCH-GATES.md are signed off and the data is real.
     */
    indexing: flag('SE_INDEXING'),
    /** Generate pages for enskilda näringsidkare (personnummer). Legal gate. */
    publishSoleTraders: flag('SE_PUBLISH_SOLE_TRADERS'),
    /** Show validated Swedish credit-model output on profiles. Legal gate. */
    publicModelOutput: flag('SE_PUBLIC_MODEL_OUTPUT'),
    /** Report products. Each can show 'unavailable', 'sample' or go live. */
    reports: {
        basic: (env('SE_REPORT_BASIC') ?? 'unavailable') as ReportMode,
        ai: (env('SE_REPORT_AI') ?? 'unavailable') as ReportMode,
    },
    /** Real checkout. Requires the gates in docs/LAUNCH-GATES.md. */
    checkout: flag('SE_CHECKOUT'),
    /** Report backend adapter: 'disabled' | 'mock' (dev/preview only) | 'http'. */
    reportAdapter: (env('PUBLIC_SE_REPORT_ADAPTER') ?? 'disabled') as 'disabled' | 'mock' | 'http',
    reportApiBase: env('PUBLIC_SE_REPORT_API'),
    /** Build is a staging preview: forces noindex and shows a banner. */
    preview: flag('SE_PREVIEW'),
} as const

export type ReportMode = 'unavailable' | 'sample' | 'live'

/**
 * Verified prices, filled in only when pricing is decided and tested end to
 * end. Empty = the UI never shows a price.
 */
export const VERIFIED_PRICES: Partial<Record<'basic' | 'ai', { amountSek: number; vatIncluded: boolean; verifiedAt: string }>> = {}

/** Site is allowed to be indexed at all. */
export const siteIndexable = FLAGS.indexing && !FLAGS.preview

if (FLAGS.checkout && (FLAGS.reportAdapter !== 'http' || !FLAGS.reportApiBase))
    throw new Error('SE_CHECKOUT requires PUBLIC_SE_REPORT_ADAPTER=http and PUBLIC_SE_REPORT_API')
if (FLAGS.reportAdapter === 'mock' && siteIndexable)
    throw new Error('The mock report adapter may only be used in non-indexed preview builds')
for (const p of ['basic', 'ai'] as const)
    if (FLAGS.checkout && FLAGS.reports[p] === 'live' && !VERIFIED_PRICES[p])
        throw new Error(`SE_REPORT_${p.toUpperCase()}=live with checkout needs a verified price in VERIFIED_PRICES`)
