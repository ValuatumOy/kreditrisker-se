import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SITE } from '../src/config/site.ts'
import { publishCompany } from '../src/lib/publish.ts'
import { companyJsonLd, crumbsJsonLd, providerJsonLd, serializeJsonLd } from '../src/lib/seo.ts'
import { AS_OF, batch1 } from './helpers.ts'

test('company markup identifies the directory page without inventing a website or founding date', () => {
    const company = publishCompany(batch1()[0], undefined, AS_OF)
    const data = companyJsonLd(company)
    const profile = SITE.origin + company.path

    assert.equal(data['@type'], 'Organization')
    assert.equal(data.name, company.record.name)
    assert.equal(data.identifier.value, company.record.orgnr)
    assert.equal(data['@id'], `${profile}#company`)
    assert.equal(data.mainEntityOfPage, profile)
    assert.equal('url' in data, false)
    assert.equal('foundingDate' in data, false)
    assert.equal('address' in data, false)
})

test('provider markup uses the provider details shown on the about page', () => {
    const data = providerJsonLd()
    assert.equal(data.name, SITE.provider.name)
    assert.equal(data.url, SITE.provider.url)
    assert.equal(data.identifier.value, SITE.provider.businessId)
})

test('breadcrumb markup includes absolute links to its visible ancestors', () => {
    const data = crumbsJsonLd([{ href: '/branscher/', label: 'Branscher' }, { label: 'Företag' }])
    assert.equal(data.itemListElement[0].item, `${SITE.origin}/`)
    assert.equal(data.itemListElement[1].item, `${SITE.origin}/branscher/`)
    assert.equal(data.itemListElement[2].name, 'Företag')
})

test('JSON-LD cannot close its script element through company names', () => {
    const original = { name: '</script><script>alert(1)</script>', note: 'Å & Ä' }
    const serialized = serializeJsonLd(original)
    assert.doesNotMatch(serialized, /<\/script/i)
    assert.deepEqual(JSON.parse(serialized), original)
})
