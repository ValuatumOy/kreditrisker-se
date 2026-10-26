# AWS setup for kreditrisker.se

Everything is code in `aws-infra/` (CDK, account 892885731254, eu-west-1),
except the domain purchase and the first search package. Do the steps in this order. Nothing here sells reports
or makes the site indexable; those stay behind the launch gates.

## 1. Domain

Buy `kreditrisker.se` in Route 53 (Registered domains). Route 53 creates a
hosted zone; note its id (`Z...`).

## 2. Search

`/api/search` is a Lambda (`search/handler.ts`, Node 22, arm64, 1 GB) whose
package holds an SQLite database of the whole directory
(`src/lib/search-db.ts`). CloudFront calls it through a Function URL with
origin access control, and a rule pings it every 5 minutes to keep one
instance warm. Jenkins rebuilds the package every run and uploads it to the
state bucket at `search/search.zip`; the Lambda's code points at that fixed key,
so deploying the stack again never reverts it.

CloudFormation needs the package before it can create the Lambda, so the
first time (state bucket from an earlier deploy, index state from a Jenkins run):

```bash
aws s3 cp s3://<state bucket>/index.jsonl data/build/index.jsonl
node scripts/search-db.ts
aws s3 cp data/build/search/search.zip s3://<state bucket>/search/search.zip
```

Limits: the unzipped package must stay under Lambda's 250 MB (all ~825k
aktiebolag come to ~180 MB; `scripts/search-db.ts` stops above 245 MB).
Roll back with `aws lambda update-function-code --s3-object-version` of an
older `search/search.zip` (the bucket keeps them 30 days).

## 3. Site, certificate and DNS

Put the values in `aws-infra/cdk.json` under `context` (or pass `-c`):

```json
"hostedZoneId": "Z..."
```

```bash
cd aws-infra && npm ci
npx cdk deploy KreditriskerCertStack KreditriskerSiteStackTest KreditriskerSiteStackProd
```

The outputs give the Jenkins values: `SiteBucketName` (BUILD_BUCKET),
`DistributionId` (CLOUDFRONT_DISTRIBUTION_ID), `StateUri` (STATE_URI) and
`SearchFunctionName` (SEARCH_FUNCTION, Prod only). The
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
`kreditrisker-se-api-token`. First load: `COMPANIES=all`. Every run rebuilds
the search from the whole directory.

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
