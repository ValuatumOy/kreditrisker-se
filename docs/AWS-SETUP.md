# AWS setup for kreditrisker.se

Everything is code in `aws-infra/` (CDK, account 892885731254, eu-west-1),
except the domain purchase and the first search image. Do the steps in this order. Nothing here sells reports
or makes the site indexable; those stay behind the launch gates.

## 1. Domain

Buy `kreditrisker.se` in Route 53 (Registered domains). Route 53 creates a
hosted zone; note its id (`Z...`).

## 2. Search

`/api/search` is a Lambda (`search/handler.ts`, Node 22, x86_64, 1 GB) run from
a container image that holds an SQLite database of the whole directory
(`src/lib/search-db.ts`, `search/Dockerfile`). CloudFront calls it through a
Function URL with origin access control, and a rule pings it every 5 minutes
to keep one instance warm. Jenkins rebuilds the image every run, pushes it to
the `KreditriskerSearchRepoStackProd` repository as `:latest` and points the
Lambda at its digest; the stack only names the tag, so deploying it again never
reverts the image. x86_64 because the `sweden-build` agent is x86_64.

CloudFormation needs an image before it can create the Lambda, so the first
time (repository stack, then one image, then the site stack; index state from a
Jenkins run):

```bash
cd aws-infra && npx cdk deploy -e KreditriskerSearchRepoStackProd && cd ..
repo=<SearchRepositoryUri, i.e. 892885731254.dkr.ecr.eu-west-1.amazonaws.com/<repository>>
aws s3 cp s3://<state bucket>/index.jsonl data/build/index.jsonl
node scripts/search-db.ts
aws ecr get-login-password | docker login --username AWS --password-stdin "${repo%%/*}"
docker build --platform linux/amd64 -t "$repo:latest" -f search/Dockerfile data/build/search
docker push "$repo:latest"
```

Limits: Lambda images can be up to 10 GB, so the database size is bounded by
memory rather than packaging (all ~825k aktiebolag come to ~180 MB and use
~250 MB of the 1 GB; ~1.18M companies, 290 MB, use ~350 MB). Raise
`memorySize` before the database nears ~700 MB.

Timing (measured 2026-10-26, 180 MB database): after an image update the
function is ready in ~10 s and the first ping, which reads the whole database
while Lambda's image cache is still cold, takes 5-11 s (the Jenkins stage
does it, hence the 60 s timeout). Later instances read it in 0.3-1.3 s and
answer a first search in ~0.3 s. After the read, searches take 1-140 ms.

Roll back with `aws lambda update-function-code --image-uri <repo>@<older digest>`
(the repository keeps the last 5 images: `aws ecr describe-images`).

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
`SearchFunctionName` (SEARCH_FUNCTION, Prod only) and `SearchRepositoryUri`
(SEARCH_REPOSITORY, Prod only). The
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
`kreditrisker-se-api-token`. Use an explicit small company batch for tests. A
`COMPANIES=all` run needs approval and a cost estimate first. Every run
rebuilds the search from the whole directory.

## Isolated checkout testing

The shared report-engine TEST environment runs other work and must not be
replaced for Swedish testing. The Swedish test checkout has no engine access by
default. Enabling it requires `siteUrlTest` plus `testReportEngineUrl` and
`testReportEngineArn` for a separate engine; the shared TEST and PROD engines
are rejected. Verify that the supplied function, queues, storage, credentials
and worker are isolated before using it. This configuration does not itself
provision that engine.

Use a dedicated Stripe sandbox for live integration tests. The existing test
key belongs to an account with other checkout webhooks; completing a test
payment there can trigger unrelated systems. Swedish test products and prices
must be created in the isolated sandbox before connecting it.

An enabled test checkout requires its own Secrets Manager name, passed as
`testSecretName=kreditrisker-se-isolated-...`; do not overwrite the existing
`kreditrisker-se-test` secret. For a simulator-only test, set
`reportAdminEmailTest=success@simulator.amazonses.com`,
`isolatedFixtureTest=1` and `suppressTestAlertSubscription=1` to avoid emailing the normal operations
address. The alarms still exist but have no email subscriber in this mode;
inspect logs and alarm states directly. Never use this setting for a real
customer environment. Fixture mode permits only company `0020001012`, the
Basic product and the SES success simulator recipient in Checkout and webhook
events; package redemption is disabled. The production stack always retains
its subscription.

Turning off `checkoutEnabledTest` also removes test-engine access, including
for ongoing test orders. Finish test orders first: an order with a job ID
cannot be polled or time out while its engine is disconnected, and may need
manual cleanup or reconnection to the same engine. In production the switch
still stops only new sessions so existing orders can finish.

For a no-network checkout flow test, run `npm test` in `backend/`. The
`isolated-checkout-flow.test.js` test uses in-memory Stripe, engine, order and
email substitutes and blocks network transports. It does not establish real
Stripe, AWS or report-generation behavior.

## 5. Report checkout (only when reports are launched)

Complete the legal, privacy, report-content, payment, delivery and consumer-terms
launch gates first. Swedish reports use the Finnish credit-risk model; verify its
outputs for Swedish companies as part of the report review before opening sales.

1. The live Stripe basic product `prod_VXJrnLn4qkC2Nv` has a SEK 29.00,
   one-time, VAT-exclusive default price and tax code `txcd_10000000`. It is not
   yet connected to checkout. A live, explicitly internal, unpaid Checkout preview
   on 30 October 2026 with Sweden as the billing country showed 25.5% VAT and a
   total of SEK 36.40; the preview session was then expired without a payment.
   This does not test report generation or delivery. The AI product has not been
   created; its agreed net price is SEK 69.00. The backend checks amounts and tax
   treatment against `backend/src/lib/report-price-targets.json`. Confirm the
   company's tax registration and treatment for each customer before launch.
   The `kreditrisker-se-prod` secret already exists. On a new environment, create
   its secret out of band; for an existing one, update the necessary fields instead:
   ```bash
   aws secretsmanager create-secret --name kreditrisker-se-prod \
     --secret-string '{"STRIPE_SECRET_KEY":"sk_...","STRIPE_WEBHOOK_SECRET":"whsec_...","VALUATUM_REST_URL":"https://...","VALUATUM_REST_TOKEN":"..."}'
   ```
2. Add to the context: `contactEmail` (Valuatum's public support address is
   `contact25@valuatum.com`), and for a basic-only launch
   `stripeProductsProd` = `{"STRIPE_PRODUCT_SE_BASIC":"prod_VXJrnLn4qkC2Nv"}`.
   A product without an id is never sold.
3. `cd backend && npm ci && cd ../aws-infra && npx cdk deploy KreditriskerCheckoutStackProd`
4. Put the stack's `ReportCheckoutApiDomain` output in `checkoutApiProd` and
   redeploy `KreditriskerSiteStackProd` so `/api/*` reaches it.
5. In Stripe, point a webhook at the direct `…/api/webhook` URL (not through
   CloudFront) and store its signing secret in the secret above.
6. Deploy the reviewed report-engine version and verify a generated Swedish
   sample of each product before enabling that product. For Basic, verify its
   credit-model outputs and confirm fraud analysis is absent. For AI, also verify
   its fraud-analysis outputs and complete the separate fraud privacy gate.
7. Once content, payment, delivery and legal checks pass, set CDK context
   `checkoutEnabledProd=1` and `termsVersionProd` to the approved terms version,
   then deploy the checkout stack. Without this switch
   the API refuses new sessions even if Stripe product IDs are configured;
   existing orders can still be fulfilled.
8. Build with `PUBLIC_SE_REPORT_ADAPTER=http`, `PUBLIC_SE_REPORT_API=/api/`,
   `SE_CHECKOUT=1`, `SE_TERMS_VERSION` matching `termsVersionProd`, and the products
   set to `live`, with `VERIFIED_PRICES` in
   `src/config/site.ts` set to the verified VAT-inclusive customer prices.
   The preview above establishes the current Swedish consumer example, not
   every buyer's tax treatment. Check country-specific and business-customer
   differences before setting and displaying a verified price.

## Analytics

Set `PUBLIC_GA_TRACKING_ID` in the Jenkins job when a Swedish GA4 property
exists. The consent banner appears only then, and nothing loads before consent.
