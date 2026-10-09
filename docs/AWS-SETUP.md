# AWS setup for kreditrisker.se

Everything is code in `aws-infra/` (CDK, account 892885731254, eu-west-1),
except the two things CloudFormation cannot create: the domain purchase and
the CloudSearch domain. Do the steps in this order. Nothing here sells reports
or makes the site indexable; those stay behind the launch gates.

## 1. Domain

Buy `kreditrisker.se` in Route 53 (Registered domains). Route 53 creates a
hosted zone; note its id (`Z...`).

## 2. Search

```bash
./scripts/create-cloudsearch-domain.sh sweden-companies-test
./scripts/create-cloudsearch-domain.sh sweden-companies-prod
```

The script prints each domain's search and document endpoints.

## 3. Site, certificate and DNS

Put the values in `aws-infra/cdk.json` under `context` (or pass `-c`):

```json
"hostedZoneId": "Z...",
"searchEndpointTest": "search-sweden-companies-test-....eu-west-1.cloudsearch.amazonaws.com",
"searchEndpointProd": "search-sweden-companies-prod-....eu-west-1.cloudsearch.amazonaws.com"
```

```bash
cd aws-infra && npm ci
npx cdk deploy KreditriskerCertStack KreditriskerSiteStackTest KreditriskerSiteStackProd
```

The outputs give the Jenkins values: `SiteBucketName` (BUILD_BUCKET),
`DistributionId` (CLOUDFRONT_DISTRIBUTION_ID) and `StateUri` (STATE_URI). The
Test site runs on its `*.cloudfront.net` domain and always sends
`X-Robots-Tag: noindex`.

## 4. Jenkins

Use the Swedish job `SweCompanyDirectory-ProdUpdate` as "Pipeline script from
SCM": `git@bitbucket.org:valuatum/kreditrisker-se.git`, branch `*/main`, script
path `jenkins/kreditrisker-se.groovy`, the existing Jenkins Bitbucket SSH
credential (username `git`). Nothing in the Jenkinsfile needs editing: bucket,
distribution, state URI and site origin are read from the
`KreditriskerSiteStackProd` outputs at run time, the agent is `sweden-build`
(it reaches sweden-db) and the API token is the Secret text credential
`kreditrisker-se-api-token`. Set `CLOUDSEARCH_DOC_ENDPOINT` in the Jenkinsfile
once the CloudSearch domain exists; until then the search stage is skipped.
First load: `COMPANIES=all` (with `SEARCH_FULL=true` once search exists), or
nightly runs with `BUILD_UNBUILT=20000` until every company has a page.

## 5. Report checkout (only when reports are launched)

Launch gates 4 to 7 first: validated Swedish model, report content, prices, terms.

1. Create the Stripe products (SEK, VAT-inclusive default price) and the secret:
   ```bash
   aws secretsmanager create-secret --name kreditrisker-se-prod \
     --secret-string '{"STRIPE_SECRET_KEY":"sk_...","STRIPE_WEBHOOK_SECRET":"whsec_...","VALUATUM_REST_URL":"https://...","VALUATUM_REST_TOKEN":"..."}'
   ```
2. Add to the context: `contactEmail`, and
   `stripeProductsProd` = `{"STRIPE_PRODUCT_SE_AI":"prod_...","STRIPE_PRODUCT_SE_BASIC":"prod_..."}`.
   A product without an id is never sold.
3. `cd backend && npm ci && cd ../aws-infra && npx cdk deploy KreditriskerCheckoutStackProd`
4. Put the stack's `ReportCheckoutApiDomain` output in `checkoutApiProd` and
   redeploy `KreditriskerSiteStackProd` so `/api/*` reaches it.
5. In Stripe, point a webhook at the direct `…/api/webhook` URL (not through
   CloudFront) and store its signing secret in the secret above.
6. Build with `PUBLIC_SE_REPORT_ADAPTER=http`, `PUBLIC_SE_REPORT_API=/api/`,
   `SE_CHECKOUT=1` and the products set to `live`, with `VERIFIED_PRICES` in
   `src/config/site.ts` matching Stripe.

## Analytics

Set `PUBLIC_GA_TRACKING_ID` in the Jenkins job when a Swedish GA4 property
exists. The consent banner appears only then, and nothing loads before consent.
