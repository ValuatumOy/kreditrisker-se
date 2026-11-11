import { SITE, htmlIndexable, siteIndexable } from '../config/site.ts'
import type { CompanyStatusCode, PublishedCompany } from './contract/types.ts'
import { LEGAL_FORM_TEXT } from './format.ts'
import { formatOrgnr } from './orgnr.ts'

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

// An ongoing procedure goes into the title. A hypothesis from the Finnish site's Search Console
// (Aug-Nov 2026), where "name + konkurssi" is a frequent modifier and "name + liikevaihto" gets many
// impressions but few clicks with a title that does not say it. The title is only as current as the
// page: the nightly batch must rebuild a company when its status changes.
const PROCEDURE: Partial<Record<CompanyStatusCode, string>> = { bankruptcy: 'konkurs', liquidation: 'likvidation', reconstruction: 'rekonstruktion' }

/** Search title of a company profile: name and organisation number first, then what the page holds. */
export function companyTitle(c: PublishedCompany): string {
    const r = c.record
    const procedure = PROCEDURE[r.status.code]
    return `${r.name} (${formatOrgnr(r.orgnr)}) – ${procedure ? `${procedure}, ` : ''}${r.periods[0] ? 'omsättning, bokslut och nyckeltal' : 'företagsuppgifter'}`
}

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
    taxID: SITE.provider.businessId,
    address: { '@type': 'PostalAddress', ...SITE.provider.postalAddress },
    telephone: SITE.provider.phone,
    ...(SITE.provider.email ? { email: SITE.provider.email } : {}),
})

/** Escape HTML-significant input while retaining valid JSON-LD. */
export const serializeJsonLd = (data: object) => JSON.stringify(data).replace(/</g, '\\u003c')

/** Whether the site is open: robots.txt, sitemaps. Global flag, real data, and the page's own verdict. */
export const isIndexable = (pageNoindex: boolean, syntheticData: boolean) => siteIndexable && !syntheticData && !pageNoindex

/** The robots meta in the HTML. Same rule, except that SE_HTML_FINAL lets a page state its verdict before the site opens. */
export const pageIndexable = (pageNoindex: boolean, syntheticData: boolean) => htmlIndexable && !syntheticData && !pageNoindex
