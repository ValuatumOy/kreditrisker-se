#!/usr/bin/env node
// Kreditrisker.se AWS stacks. Values that exist only after something is
// created outside CDK are passed as context (cdk.json or -c key=value):
//
//   hostedZoneId          Route 53 zone of kreditrisker.se (created when the domain is bought)
//   checkoutApiTest       CheckoutStack API host, once report sales are switched on
//   checkoutApiProd
//   siteUrlTest           the Test site's origin (its CloudFront domain), for Stripe redirects
//   contactEmail          support address in delivery emails (launch gate 8)
//   stripeProductsTest    JSON: {"STRIPE_PRODUCT_SE_AI":"prod_...", ...}; products without an id are not sold
//   stripeProductsProd
//   checkoutEnabledTest   1 to allow new test checkout sessions
//   testReportEngineUrl   isolated Lambda Function URL for test reports
//   testReportEngineArn   its Lambda function ARN (never the shared TEST/PROD engine)
//   testSecretName        dedicated kreditrisker-se-isolated-* Stripe secret for test
//   reportAdminEmailTest  test-only operational email recipient
//   reportAdminEmailProd  production operational email recipient
//   suppressTestAlertSubscription  1 for isolated simulator-only testing
//   isolatedFixtureTest   1 to restrict the test API to one synthetic company and SES simulator
//   checkoutEnabledProd   1 to allow new live checkout sessions after launch checks
//   termsVersionTest/Prod version identifier for the approved purchase terms
//
// Without hostedZoneId the sites run on their *.cloudfront.net domains.

import * as cdk from 'aws-cdk-lib'
import { CertStack, SearchRepoStack, SiteStack } from '../lib/site-stack'
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
    checkoutApiDomain: ctx('checkoutApiTest'),
})

// Jenkins agent sweden-build (profinder-environment jenkins/new-environment.sh): the role that can reach sweden-db
const buildRoleName = 'sweden-process-role'
const searchRepo = new SearchRepoStack(app, 'KreditriskerSearchRepoStackProd', {
    env,
    description: 'Prod - kreditrisker.se search Lambda images (Jenkins pushes one every night)',
    buildRoleName,
})

new SiteStack(app, 'KreditriskerSiteStackProd', {
    env,
    crossRegionReferences: true,
    description: 'Prod - kreditrisker.se static site',
    environmentName: 'Prod',
    domain: cert ? DOMAIN : undefined,
    hostedZoneId,
    certificate: cert?.certificate,
    searchRepository: searchRepo.repository,
    checkoutApiDomain: ctx('checkoutApiProd'),
    buildRoleName,
})

const testReportEngineUrl = ctx('testReportEngineUrl')
const testReportEngineArn = ctx('testReportEngineArn')
for (const environmentName of ['Test', 'Prod'] as const) {
    new CheckoutStack(app, `KreditriskerCheckoutStack${environmentName}`, {
        env,
        description: `${environmentName} - kreditrisker.se report checkout backend`,
        environmentName,
        siteUrl: ctx(`siteUrl${environmentName}`) ?? `https://www.${DOMAIN}`,
        reportFromEmail: 'noreply@valuatum.com',
        reportAdminEmail: ctx(`reportAdminEmail${environmentName}`) ?? 'luottoriskiraportti202605@valuatum.com',
        contactEmail: ctx('contactEmail'),
        stripeProducts: JSON.parse(ctx(`stripeProducts${environmentName}`) ?? '{}'),
        checkoutEnabled: ctx(`checkoutEnabled${environmentName}`) === '1',
        ...(environmentName === 'Test' && (testReportEngineUrl || testReportEngineArn)
            ? { testReportEngine: { url: testReportEngineUrl ?? '', arn: testReportEngineArn ?? '' } }
            : {}),
        ...(environmentName === 'Test' ? { testSecretName: ctx('testSecretName'), suppressTestAlertSubscription: ctx('suppressTestAlertSubscription') === '1', isolatedFixtureTest: ctx('isolatedFixtureTest') === '1' } : {}),
        termsVersion: ctx(`termsVersion${environmentName}`),
    })
}
