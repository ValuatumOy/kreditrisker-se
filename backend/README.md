# Report checkout backend

Ported from the Danish directory (creditreports.dk). The Swedish flow includes
separate purchase confirmation and withdrawal handling. Its main settings are:

- products `se_ai_credit_risk`, `se_credit_risk` and their 3-report bundles, in SEK;
  a product is sold only when its Stripe product id is set (`STRIPE_PRODUCT_SE_*`),
  and prices always come from Stripe
- languages `sv` and `en`, Swedish email copy in the site's colours
- Swish instead of MobilePay for bundles (single reports need manual capture,
  which Swish does not support)
- `kreditrisker.se` origins, secret `kreditrisker-se-<env>`, no hardcoded promotion codes
- the order page prefills the buyer's email in Stripe Checkout

Deployment: `../docs/AWS-SETUP.md` step 5.

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
                                              │ persist order, return 200
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
| `webhook` | `POST /api/webhook` (Stripe) | Verify signature and claim an order row idempotently. Basic orders wait for confirmation before the poller submits the job. |
| `poller` | EventBridge schedule (~1 min) | Send Basic order confirmation, submit and poll the job, then capture and email on success or cancel the authorization on failure. |

## Two languages: `lang` vs `reportLang`

They are independent and must not be collapsed into one field.

| Field | Values | Controls |
| --- | --- | --- |
| `lang` | `sv` \| `en` (default `sv`) | The buyer's language for Stripe Checkout and emails. |
| `reportLang` | `sv` \| `en` (default `sv`) | The language of the generated PDF. The current Swedish site sends `sv`. |

The chosen report language is disclosed beside Stripe's payment button and in
the delivery email, written in `lang`. A missing `reportLang` normalizes to `sv`.

`reportLang` reaches both generators as `params.lang`
(`buildReportParams()` in `lib/products.js`), which is what the poller and the
report engine read. The REST endpoint's language code is mapped in
`REST_LANG_CODES` — identity today; change it in that one place if the endpoint
ever wants a different code than `sv`.

## Pricing source

Single-report products are allowlisted by their stable Stripe Product IDs in
`lib/products.js`. For every Checkout Session, the backend retrieves the allowed
Product and uses its current active `default_price`. The browser sends only the
catalog `reportType`; it never sends or selects a Product ID, Price ID, or
amount.

The approved single-report prices are 29 / 69 SEK excluding VAT. They are stored
in `src/lib/report-price-targets.json` and must match the active one-time default
Prices on the respective Stripe Products. The site displays a separately verified
VAT-inclusive customer price. If prices change, update both the site and these
targets alongside Stripe. An inactive Product, missing or inactive default Price,
wrong currency, recurring Price, incompatible tax behavior, non-fixed amount, or
an amount that differs from the target fails closed before Checkout is created.

The two optional Swedish bundle products also resolve their default Prices from
Stripe; their prices have not been decided or prepared for launch.

## Payment policy — manual capture

`payment_intent_data: { capture_method: 'manual' }` is set at checkout, so the
customer **authorizes but is not charged** at payment time.

- Generation `DONE` → **capture** the PaymentIntent (then email the PDF).
- Generation `FAILED` or timed out → the poller requests cancellation of the
  PaymentIntent and sends an admin alert once cancellation is confirmed. If the
  payment state is uncertain, operations must investigate it.
- A report-engine submission can succeed even if its response is lost. In that
  case the order claim is retained so webhook retries do not submit another job.
  If no job id is recorded, the poller eventually cancels the authorization (or
  releases the reserved bundle credit) and alerts an admin. The original job
  might still be running; check the engine before a manual retry.
- The poller is limited to one concurrent Lambda execution. This prevents
  overlapping scheduled runs, but an email accepted by SES immediately before
  a crash can still be sent again on retry; delivery is not exactly once.
- A successful generation is charged before SES accepts the email. If sending
  fails, the order stays `GENERATING` and the poller retries without charging it
  again. Per-order and poller-runtime errors also raise CloudWatch alarms to the
  SES-failure SNS topic; its email subscription must be confirmed and monitored.
  There is no automatic refund or retry limit for a persistent sending failure.
  SES acceptance also does not prove final delivery; later bounces and complaints
  require monitoring and manual follow-up. These are release requirements, not a
  guarantee that every failure is automatically refunded.

Before opening sales, assign an owner to the SNS alerts and agree the delivery
and refund procedure. For an order-error alarm, find `poller: order error` in
the poller logs around the alarm time and inspect every affected session ID.
An alarm that remains in ALARM does not send a new notice for each later error.
For a runtime-error alarm, inspect the poller logs; there may be no session ID.
SES bounce notifications carry the session ID in `mail.tags.sessionId`.

Use the session ID to inspect the order, report job, SES events and Stripe
PaymentIntent. If payment was captured but delivery failed or is uncertain,
arrange redelivery or a Stripe refund after checking what happened. A captured
payment cannot be released by canceling its authorization; SES timeouts can
also leave delivery uncertain. Do not submit a new report job just to retry an
email.

### Closing a withdrawal after a manual refund

The withdrawal worker leaves a captured payment in `REVIEW_REQUIRED`; it does
not issue a refund. An operator must check the order and issue any required refund
in Stripe. After Stripe reports the full refund as succeeded, run the following
with AWS credentials authorized for the intended environment:

```powershell
$env:AWS_REGION = 'eu-west-1'
$env:ORDERS_TABLE = '<OrdersTableName from the intended checkout stack>'
$env:APP_SECRETS_ARN = '<ReportCheckoutSecretArn from the same stack>'
node scripts/close-withdrawal.js '<Checkout session ID>'
```

The command never creates a refund. It reads the specific order and verifies
that Stripe reports its entire captured amount refunded before conditionally
marking the review item `CLOSED`. It refuses incomplete, pending or mismatched
refunds and concurrent changes. Do not put a Stripe secret key in the command
line. The operator must monitor the alerts and investigate failures.

### Stripe Tax

The basic report costs SEK 29 including VAT, so its Stripe Price must use
`tax_behavior: 'inclusive'`. The planned AI report price is SEK 69 before VAT
and uses `tax_behavior: 'exclusive'`; it is not yet available. Checkout uses
`automatic_tax: { enabled: true }` and verifies the amount and tax behavior.

Valuatum is a Finnish company. The applicable VAT treatment depends on the
buyer, relevant EU sales thresholds, any OSS election and registrations. The
code does not establish which rules or registrations apply. Confirm them with
the accountant and check the live Stripe Tax registrations before enabling sales.

## Configuration

Non-secret config comes from Lambda environment variables (`lib/config.js`),
injected by the CDK in `../aws-infra/lib/checkout-stack.ts`:

| Env var | Purpose | Default |
| --- | --- | --- |
| `ORDERS_TABLE`, `ORDERS_STATUS_INDEX` | DynamoDB table + GSI names | `CreditReports-Orders`, `StatusIndex` |
| `SITE_URL` | Public origin for Stripe redirect URLs | `https://www.kreditrisker.se` |
| `FROM_EMAIL`, `ADMIN_EMAIL` | SES sender + failure-alert recipient | `noreply@valuatum.com`, `luottoriskiraportti202605@valuatum.com` |
| `SES_CONFIGURATION_SET` | SES configuration set applied to every send | — (injected by CDK) |
| `REPORT_ENGINE_URL`, `REPORT_ENGINE_REGION`, `REPORT_ENGINE_USERNAME` | PDF engine endpoint + caller id | — / `eu-west-1` / `kreditrisker.se` |
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

Both Swedish report products use the report engine; they do not use
`VALUATUM_REST_URL` or `VALUATUM_REST_TOKEN` directly. **Email needs no secret.**
SES authenticates through the Lambda execution roles.

## Deployment

Follow `../docs/AWS-SETUP.md` and the launch gates in `../docs/LAUNCH-GATES.md`.
Use a separate sandbox and synthetic engine for testing; never connect the test
checkout to the shared report engine.

## Email (Amazon SES)

Transactional mail goes through **SES v2** in account `892885731254`,
`eu-west-1` — the same region as this stack, so `AWS_REGION` is reused and there
is no `SES_REGION`.

- **Sender** — `noreply@valuatum.com`, an address on the **`valuatum.com` SES
  domain identity**. That identity, its DNS, and DKIM are provisioned **out of
  band** (shared with the FI report flow); this repo's CDK deliberately does not
  own them. Customer questions go to the configured `CONTACT_EMAIL`.
- **Auth** — the poller, withdrawal and credit-notification roles can send through
  the verified identity. `create-checkout` and `webhook` do not send mail.
- **SDK** — `@aws-sdk/client-sesv2`, **bundled** with the Lambda rather than
  taken from the Node 22 runtime's copy. The runtime's SDK version varies by
  runtime and region and may predate native `Content.Simple.Attachments`, which
  the report PDF depends on. CDK bundles the installed AWS SDK dependencies so
  the deployed code uses the same SES serializer as the tested code.

### Configuration set and adverse events

Every send is tagged with the configuration set
`kreditrisker-se-<env>-transactional`, which:

- **suppresses** hard bounces and complaints (account-level suppression list), so
  a known-bad address is not re-mailed — this protects the shared `valuatum.com`
  sending reputation;
- publishes **reputation metrics** to CloudWatch;
- publishes **`BOUNCE`, `COMPLAINT` and `REJECT`** events to an
  SNS topic subscribed by `luottoriskiraportti202605@valuatum.com`.

Each deployed stack owns its own configuration set and topic. The normal test
and production subscriptions must be confirmed; simulator-only fixture mode
intentionally has no email subscription. Find the names/ARNs in the
`EmailConfigurationSetName` and `EmailFailureTopicArn` stack outputs:

```bash
aws cloudformation describe-stacks --region eu-west-1 \
  --stack-name KreditriskerCheckoutStackProd \
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
webhooks to a locally-run `webhook` handler. Use Stripe's test card
`4242 4242 4242 4242` only in a verified sandbox. A real paid test needs the
user's authorization.

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
