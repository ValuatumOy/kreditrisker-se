# Report checkout backend

Ported from the Danish directory (creditreports.dk), where it runs in
production. The flow is unchanged; the Swedish differences are:

- products `se_ai_credit_risk`, `se_credit_risk` and their 3-report bundles, in SEK;
  a product is sold only when its Stripe product id is set (`STRIPE_PRODUCT_SE_*`),
  and prices always come from Stripe
- languages `sv` and `en`, Swedish email copy in the site's colours
- Swish instead of MobilePay for bundles (single reports need manual capture,
  which Swish does not support)
- `kreditrisker.se` origins, secret `kreditrisker-se-<env>`, no hardcoded promotion codes
- the order page prefills the buyer's email in Stripe Checkout

Deployment: docs/AWS-SETUP.md step 5. The rest of this file describes the
shared design, with Danish examples.

## Architecture

The website stays **fully static** (`output: 'static'`, S3 + CloudFront). Stripe
needs server code only in Lambdas; the static page reaches them with a
client-side `fetch()` to a same-origin `/api/*` path.

```

Package balances and their idempotent grant/reserve/consume ledger live in a
separate DynamoDB credits table. `POST /api/redeem` reserves an existing report
before Checkout is opened; a scheduled notification worker emails balance and
returned-credit updates from a transactional outbox.
                         ┌──────────── CloudFront ────────────┐
Browser ─┬─ /*                  → S3 (static Astro)
         └─ POST /api/create-checkout → API Gateway → create-checkout Lambda → Stripe
                                                                                  │
                          customer pays on Stripe-hosted Checkout                 │
                                                                                  ▼
Stripe ──→ POST /api/webhook  (DIRECT API Gateway URL, NOT via CloudFront) → webhook Lambda
                                              │ submit generation job, persist order, 200 fast
                                              ▼
                                        DynamoDB orders table
                                              ▲
EventBridge (~1 min) ──→ poller Lambda ───────┘  capture/cancel payment, email PDF
                                   │
                                   └─→ PDF report engine (SigV4, async job API)
```

Stripe must call the **direct** API Gateway URL (`…/api/webhook`), not the
CloudFront one, so the raw request body and `Stripe-Signature` header survive
intact for signature verification. The browser-facing `/api/*` route goes through
CloudFront so it is same-origin (no CORS).

> **Shared Stripe account.** This backend reuses the existing (FI) Stripe account
> and `STRIPE_SECRET_KEY`, but has its **own** webhook endpoint and therefore its
> **own** `STRIPE_WEBHOOK_SECRET`. The shared account means FI sessions also reach
> this webhook; they are ignored because their `reportType` isn't in this catalog.

| Lambda | Trigger | Responsibility |
| --- | --- | --- |
| `create-checkout` | `POST /api/create-checkout` | Look up the product **server-side** (price + label never trusted from the client), create a manual-capture Stripe Checkout session with `reportType` + `lang` + `reportLang` + company params in metadata, return `{ url }`. |
| `webhook` | `POST /api/webhook` (Stripe) | Verify signature. On `checkout.session.completed`: claim an order row (idempotent on `session.id`), submit the generation job, record `jobId`, return `200`. No polling/capture/email here. |
| `poller` | EventBridge schedule (~1 min) | For each `GENERATING` order, poll the engine job, then capture (DONE → email PDF) or cancel (FAILED/timeout → admin alert) the manual-capture PaymentIntent. |

## Two languages: `lang` vs `reportLang`

They are independent and must not be collapsed into one field.

| Field | Values | Controls |
| --- | --- | --- |
| `lang` | `da` \| `en` (default `da`) | The **buyer's** language: Stripe Checkout copy, the receipt, and the delivery email. Taken from the page the buyer was on. |
| `reportLang` | `da` \| `en` (default `en`) | The language of the **generated PDF**. Picked in the purchase modal, which preselects the page language but lets the buyer change it. |

So a Danish-UI buyer can order an English PDF: Stripe and the email stay Danish,
only the attachment is English. The chosen report language is **disclosed** beside
Stripe's payment button using Checkout `custom_text.submit`, and repeated in the
delivery email — always written in `lang`, naming `reportLang`. A missing
`reportLang` normalizes to `en`, so sessions created by page builds that predate
the selector still deliver what they advertised.

`reportLang` reaches both generators as `params.lang`
(`buildReportParams()` in `lib/products.js`), which is what the poller and the
report engine read. The REST endpoint's language code is mapped in
`REST_LANG_CODES` — identity today; change it in that one place if the endpoint
ever wants a different code than `da`.

## Pricing source

Single-report products are allowlisted by their stable Stripe Product IDs in
`lib/products.js`. For every Checkout Session, the backend retrieves the allowed
Product and uses its current active `default_price`. The browser sends only the
catalog `reportType`; it never sends or selects a Product ID, Price ID, or
amount.

To change a single-report Checkout price without rebuilding the site, add a new
one-time Price to the existing Product in Stripe Dashboard and set it as the
Product's default. Stripe Price amounts are immutable, so don't edit the old
Price amount. The company-page modal reads the same current amount through
`GET /api/create-checkout?reportType=...`. An inactive Product, missing default
Price, inactive default Price, wrong currency, recurring Price, incompatible tax
behavior, or non-fixed unit amount fails closed before Checkout is created.

The two bundle products (`dk_credit_risk_bundle`, `dk_ai_credit_risk_bundle`)
now have stable Product IDs too, and are resolved the same way — every
product in the catalog prices from its Stripe default Price, with no
hardcoded amount left in `lib/products.js`.

## Payment policy — manual capture

`payment_intent_data: { capture_method: 'manual' }` is set at checkout, so the
customer **authorizes but is not charged** at payment time.

- Generation `DONE` → **capture** the PaymentIntent (then email the PDF).
- Generation `FAILED` or timed out → **cancel** the PaymentIntent, releasing the
  hold — **no charge is ever made**. An admin alert is emailed; there is no
  customer-facing failure email.

### Stripe Tax

The advertised single-report price is VAT-inclusive, so the Product's default
Price must use `tax_behavior: 'inclusive'`. With
`automatic_tax: { enabled: true }`, Checkout collects the customer's location
and breaks the applicable VAT out of that total per jurisdiction.

This is a **Finnish (Valuatum) company selling electronically-supplied services
internationally**, so VAT is handled through the existing Stripe Tax setup — NOT
a Denmark-specific registration:

- **EU B2C** → VAT is due in the customer's country; declared via the EU **OSS**
  (One-Stop-Shop) scheme from Finland. No per-country (e.g. Danish) registration
  is needed — add the OSS/EU registration in Stripe Tax, which then applies the
  correct destination rate (DK 25 %, etc.).
- **EU B2B** with a valid VAT ID → reverse charge (no VAT collected).
- **Outside the EU** → generally outside EU VAT scope.

The code is registration-agnostic; which registrations exist in the Stripe
dashboard is a tax decision (confirm with your accountant + Stripe Tax's
threshold monitoring), not a code change.

## Configuration

Non-secret config comes from Lambda environment variables (`lib/config.js`),
injected by the CDK in `../aws-infra/lib/dk-report-checkout-stack.ts`:

| Env var | Purpose | Default |
| --- | --- | --- |
| `ORDERS_TABLE`, `ORDERS_STATUS_INDEX` | DynamoDB table + GSI names | `CreditReports-Orders`, `StatusIndex` |
| `SITE_URL` | Public origin for Stripe redirect URLs | `https://creditreports.dk` |
| `FROM_EMAIL`, `ADMIN_EMAIL` | SES sender + failure-alert recipient | `noreply@valuatum.com`, `luottoriskiraportti202605@valuatum.com` |
| `SES_CONFIGURATION_SET` | SES configuration set applied to every send | — (injected by CDK) |
| `REPORT_ENGINE_URL`, `REPORT_ENGINE_REGION`, `REPORT_ENGINE_USERNAME` | PDF engine endpoint + caller id | — / `eu-west-1` / `creditreports.dk` |
| `CLAIM_GRACE_MINUTES`, `MAX_GENERATION_MINUTES` | Poller timing guards | `2`, `30` |
| `APP_SECRETS_ARN` | Secrets Manager bundle ARN | — |

Secrets live in **one** Secrets Manager JSON secret (`lib/secrets.js`):

```json
{
  "STRIPE_SECRET_KEY": "sk_…",
  "STRIPE_WEBHOOK_SECRET": "whsec_…",
  "VALUATUM_REST_URL": "https://…",
  "VALUATUM_REST_TOKEN": "…"
}
```

`VALUATUM_REST_URL` + `VALUATUM_REST_TOKEN` are the authenticated Valuatum REST
`/reports` endpoint the poller calls for the basic `dk_credit_risk` report (same
mechanism the FI directory uses). They must point at a Valuatum instance that
serves the Danish companies. **Email needs no secret.** SES authenticates through the poller's Lambda
execution role, which the CDK grants `ses:SendEmail` on the `valuatum.com`
identity — there is no API key to rotate or leak.

## Deployment

See `../aws-infra/README.md`. In short:

```bash
cd backend && npm install        # so esbuild can bundle the Lambdas
cd ../aws-infra && npm install
npx cdk deploy DkReportCheckoutStackProd
```

### Post-deploy setup

1. **CloudFront** — add an `/api/*` behavior to the **existing creditreports.dk
   distribution** pointing at the API Gateway origin (`ReportCheckoutApiUrl`
   output), caching disabled, all methods, forward query strings and all viewer
   headers except Host.
2. **Stripe webhook** — create an endpoint at the **direct** API Gateway URL
   (`ReportCheckoutApiUrl`) + `/api/webhook`, listening for
   `checkout.session.completed`. Copy its signing secret (`whsec_…`).
3. **Populate the secret** — `dk-company-dir-<env>`, created with placeholders:
   ```bash
   aws secretsmanager put-secret-value --region eu-west-1 \
     --secret-id dk-company-dir-prod \
     --secret-string '{"STRIPE_SECRET_KEY":"sk_…","STRIPE_WEBHOOK_SECRET":"whsec_…","VALUATUM_REST_URL":"https://…","VALUATUM_REST_TOKEN":"…"}'
   ```
   (Warm Lambdas cache secrets — wait ~1 min or redeploy to pick up changes.)
4. **Stripe Tax** — already set up for the Finnish entity. EU B2C VAT is handled
   via the OSS registration (no Denmark-specific registration needed); see the
   "Stripe Tax" section above.
5. **SES** — see "Email (Amazon SES)" below. Confirm the SNS subscription mailed
   to `luottoriskiraportti202605@valuatum.com` after **each** stack deploy.

## Email (Amazon SES)

Transactional mail goes through **SES v2** in account `892885731254`,
`eu-west-1` — the same region as this stack, so `AWS_REGION` is reused and there
is no `SES_REGION`.

- **Sender** — `noreply@valuatum.com`, an address on the **`valuatum.com` SES
  domain identity**. That identity, its DNS, and DKIM are provisioned **out of
  band** (shared with the FI report flow); this repo's CDK deliberately does not
  own them. `creditreports.dk` is not a sender — customer questions are routed to
  `contact@creditreports.dk` by a `mailto:` link in the footer, which needs no
  SES setup.
- **Auth** — the poller's execution role, granted `ses:SendEmail` scoped to that
  one identity. `create-checkout` and `webhook` get no SES permission; they never
  send mail.
- **SDK** — `@aws-sdk/client-sesv2`, **bundled** with the Lambda rather than
  taken from the Node 22 runtime's copy. The runtime's SDK version varies by
  runtime and region and may predate native `Content.Simple.Attachments`, which
  the report PDF depends on. Keep `@aws-sdk/client-sesv2` out of the CDK's
  `externalModules` list.

### Configuration set and adverse events

Every send is tagged with the configuration set
`dk-company-dir-<env>-transactional`, which:

- **suppresses** hard bounces and complaints (account-level suppression list), so
  a known-bad address is not re-mailed — this protects the shared `valuatum.com`
  sending reputation;
- publishes **reputation metrics** to CloudWatch;
- publishes **`BOUNCE`, `COMPLAINT` and `REJECT`** events to an
  SNS topic subscribed by `luottoriskiraportti202605@valuatum.com`.

Each deployed stack owns its own configuration set and topic, so **test and prod
each mail their own subscription confirmation** — both must be accepted, and an
unconfirmed subscription silently delivers nothing. Find the names/ARNs in the
`EmailConfigurationSetName` and `EmailFailureTopicArn` stack outputs:

```bash
aws cloudformation describe-stacks --region eu-west-1 \
  --stack-name DkReportCheckoutStackProd \
  --query 'Stacks[0].Outputs[?starts_with(OutputKey, `Email`)]'
```

These SNS events are **operational alerts only** — nothing consumes them in code
and no order state depends on them. Every send carries a `sessionId` SES message
tag (the Stripe checkout session id, and nothing personal), which SES echoes into
the event's `mail.tags` — that is what lets you trace a bounce back to a
DynamoDB order row by hand.

> **SES accepting a message is not delivery.** A successful `SendEmail` means SES
> took the message for processing; the order is marked `FULFILLED` at that point.
> Whether the recipient's server accepted it is only visible through the SNS
> events above.

## Local development

`lib/secrets.js` falls back to `process.env` (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `VALUATUM_REST_URL`, `VALUATUM_REST_TOKEN`) when
`APP_SECRETS_ARN` is unset, and `AWS_ENDPOINT_URL`
points DynamoDB/Secrets Manager/SES at LocalStack. Use `stripe listen` to forward
webhooks to a locally-run `webhook` handler. Test with card
`4242 4242 4242 4242`, then do one real €3 smoke purchase + refund in prod.

Email needs no local key, but SES sending does need credentials that can
`ses:SendEmail` — point `AWS_ENDPOINT_URL` at LocalStack, or leave
`SES_CONFIGURATION_SET` unset and use real credentials (the adapter omits
`ConfigurationSetName` when it is empty).

## Adding a new report type

1. Add an entry to `PRODUCTS` in `src/lib/products.js` (price, localized label,
   tax code, `generator`, and the generator's wiring — `templateName`/`aspQueryKey`
   for `reportEngine`). Extend `buildReportParams` if its params differ.
2. Have the frontend post the new `reportType` to `/api/create-checkout`.

No changes to the webhook, poller, table, or infra are needed.
