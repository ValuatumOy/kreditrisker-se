// Only these fixed values may cross the analytics frame boundary.
export const ANALYTICS_PAGES = {
    home: { path: '/', title: 'Startsida' },
    search: { path: '/sok/', title: 'Företagssökning' },
    company: { path: '/foretag/', title: 'Företagsprofil' },
    checkout: { path: '/bestall/', title: 'Beställ rapport' },
    reports: { path: '/rapporter/', title: 'Rapporter' },
    guides: { path: '/guider/', title: 'Guider' },
    directory: { path: '/katalog/', title: 'Företagskatalog' },
    other: { path: '/ovrigt/', title: 'Övrig sida' },
} as const

export type AnalyticsPage = keyof typeof ANALYTICS_PAGES

export function analyticsPage(path: string): AnalyticsPage {
    if (path === '/') return 'home'
    if (/^\/sok\/?$/.test(path)) return 'search'
    if (/^\/foretag(?:\/|$)/.test(path)) return 'company'
    if (/^\/bestall\/?$/.test(path)) return 'checkout'
    if (/^\/rapporter(?:\/|$)/.test(path)) return 'reports'
    if (/^\/guider(?:\/|$)/.test(path)) return 'guides'
    if (/^\/(?:branscher|kommuner|topplistor|senast-uppdaterade)(?:\/|$)/.test(path)) return 'directory'
    return 'other'
}

export const ANALYTICS_REFERRERS = {
    google: 'https://www.google.com/',
    bing: 'https://www.bing.com/',
    duckduckgo: 'https://duckduckgo.com/',
    chatgpt: 'https://chatgpt.com/',
    perplexity: 'https://www.perplexity.ai/',
    claude: 'https://claude.ai/',
    gemini: 'https://gemini.google.com/',
    copilot: 'https://copilot.microsoft.com/',
} as const

export function analyticsReferrer(referrer: string): keyof typeof ANALYTICS_REFERRERS | '' {
    try {
        const host = new URL(referrer).hostname.toLowerCase()
        if (['google.com', 'www.google.com', 'google.se', 'www.google.se'].includes(host)) return 'google'
        if (['bing.com', 'www.bing.com'].includes(host)) return 'bing'
        if (host === 'duckduckgo.com') return 'duckduckgo'
        if (['chatgpt.com', 'chat.openai.com'].includes(host)) return 'chatgpt'
        if (['perplexity.ai', 'www.perplexity.ai'].includes(host)) return 'perplexity'
        if (host === 'claude.ai') return 'claude'
        if (host === 'gemini.google.com') return 'gemini'
        if (host === 'copilot.microsoft.com') return 'copilot'
    } catch {}
    return ''
}

export const ANALYTICS_EVENTS = ['search_started', 'checkout_submitted', 'checkout_failed', 'checkout_returned'] as const
export type AnalyticsEvent = (typeof ANALYTICS_EVENTS)[number]
