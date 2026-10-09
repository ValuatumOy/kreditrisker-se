#!/usr/bin/env node
// Kreditrisker.se AWS stacks. Values that exist only after something is
// created outside CDK are passed as context (cdk.json or -c key=value):
//
//   hostedZoneId          Route 53 zone of kreditrisker.se (created when the domain is bought)
//   searchEndpointTest    CloudSearch search host (scripts/create-cloudsearch-domain.sh)
//   searchEndpointProd
//   checkoutApiTest       CheckoutStack API host, once report sales are switched on
//   checkoutApiProd
//   siteUrlTest           the Test site's origin (its CloudFront domain), for Stripe redirects
//   contactEmail          support address in delivery emails (launch gate 8)
//   stripeProductsTest    JSON: {"STRIPE_PRODUCT_SE_AI":"prod_...", ...}; products without an id are not sold
//   stripeProductsProd
//
// Without hostedZoneId the sites run on their *.cloudfront.net domains.

import * as cdk from 'aws-cdk-lib'
import { CertStack, SiteStack } from '../lib/site-stack'
import { CheckoutStack } from '../lib/checkout-stack'

const env = { account: '892885731254', region: 'eu-west-1' }
const DOMAIN = 'kreditrisker.se'

const app = new cdk.App()
const ctx = (k: string): string | undefined => app.node.tryGetContext(k) || undefined
const hostedZoneId = ctx('hostedZoneId')

const cert = hostedZoneId
    ? new CertStack(app, 'KreditriskerCertStack', { env: { account: env.account, region: 'us-east-1' }, crossRegionReferences: true, domain: DOMAIN, hostedZoneId })
    : undefined

new SiteStack(app, 'KreditriskerSiteStackTest', {
    env,
    crossRegionReferences: true,
    description: 'Test - kreditrisker.se static site (CloudFront domain only)',
    environmentName: 'Test',
    searchEndpoint: ctx('searchEndpointTest'),
    checkoutApiDomain: ctx('checkoutApiTest'),
})

new SiteStack(app, 'KreditriskerSiteStackProd', {
    env,
    crossRegionReferences: true,
    description: 'Prod - kreditrisker.se static site',
    environmentName: 'Prod',
    domain: cert ? DOMAIN : undefined,
    hostedZoneId,
    certificate: cert?.certificate,
    searchEndpoint: ctx('searchEndpointProd'),
    checkoutApiDomain: ctx('checkoutApiProd'),
    // Jenkins agent sweden-build (profinder-environment jenkins/new-environment.sh): the role that can reach sweden-db
    buildRoleName: 'sweden-process-role',
})

for (const environmentName of ['Test', 'Prod'] as const) {
    new CheckoutStack(app, `KreditriskerCheckoutStack${environmentName}`, {
        env,
        description: `${environmentName} - kreditrisker.se report checkout backend`,
        environmentName,
        siteUrl: ctx(`siteUrl${environmentName}`) ?? `https://www.${DOMAIN}`,
        reportFromEmail: 'noreply@valuatum.com',
        reportAdminEmail: 'luottoriskiraportti202605@valuatum.com',
        contactEmail: ctx('contactEmail'),
        stripeProducts: JSON.parse(ctx(`stripeProducts${environmentName}`) ?? '{}'),
    })
}
