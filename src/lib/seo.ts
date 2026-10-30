import { SITE, siteIndexable } from '../config/site.ts'
import type { PublishedCompany } from './contract/types.ts'
import { LEGAL_FORM_TEXT } from './format.ts'

export type Crumb = { href?: string; label: string }

export const crumbsJsonLd = (list: Crumb[]) => ({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [{ href: '/', label: 'Start' }, ...list].map((c, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: c.label,
        ...(c.href ? { item: SITE.origin + c.href } : {}),
    })),
})

/** Organization markup with registry facts only (no ratings, no reviews). */
export const companyJsonLd = (c: PublishedCompany) => ({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': SITE.origin + c.path + '#company',
    name: c.record.name,
    mainEntityOfPage: SITE.origin + c.path,
    identifier: { '@type': 'PropertyValue', propertyID: 'organisationsnummer', value: c.record.orgnr },
    description: `${LEGAL_FORM_TEXT[c.record.legalForm]}${c.record.municipality ? `, ${c.record.municipality.name}` : ''}`,
})

/** The service provider described on /om/. */
export const providerJsonLd = () => ({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE.origin}/om/#provider`,
    name: SITE.provider.name,
    url: SITE.provider.url,
    identifier: { '@type': 'PropertyValue', propertyID: 'FO-nummer', value: SITE.provider.businessId },
    ...(SITE.provider.email ? { email: SITE.provider.email } : {}),
})

/** Escape HTML-significant input while retaining valid JSON-LD. */
export const serializeJsonLd = (data: object) => JSON.stringify(data).replace(/</g, '\\u003c')

/** The single rule for index/noindex: global flag, real data, and the page's own verdict. */
export const isIndexable = (pageNoindex: boolean, syntheticData: boolean) => siteIndexable && !syntheticData && !pageNoindex
