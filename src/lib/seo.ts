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
    name: c.record.name,
    url: SITE.origin + c.path,
    identifier: { '@type': 'PropertyValue', propertyID: 'organisationsnummer', value: c.record.orgnr },
    legalName: c.record.name,
    description: `${LEGAL_FORM_TEXT[c.record.legalForm]}${c.record.municipality ? `, ${c.record.municipality.name}` : ''}`,
    ...(c.record.registeredAt ? { foundingDate: c.record.registeredAt } : {}),
    ...(c.record.municipality ? { address: { '@type': 'PostalAddress', addressLocality: c.record.municipality.name, addressCountry: 'SE' } } : {}),
})

/** The single rule for index/noindex: global flag, real data, and the page's own verdict. */
export const isIndexable = (pageNoindex: boolean, syntheticData: boolean) => siteIndexable && !syntheticData && !pageNoindex
