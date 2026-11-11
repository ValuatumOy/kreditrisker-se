# Runtime report pricing

This is readiness for a future decision, not an active experiment. No experiment, test price, Stripe Price, cookie, or analytics event is created by this change. The default backend continues selling the approved basic report for **29 SEK, VAT included**, using its existing approved Stripe Product default price. AI and package pricing are unchanged.

## Rollout prerequisite

Deploy the backend and frontend while `REPORT_PRICING_ENABLED` is absent or `0`. The new basic-report company panels fetch the approved price at runtime. Product and comparison pages fetch the server-verified generic price: currently 29 SEK including VAT, or `Från X kr inkl. moms` during a multi-variant experiment, with X equal to the minimum of all configured, Stripe-verified prices. A summary never assigns a company or authorizes a purchase. Without JavaScript the HTML honestly says that the current price appears after selecting a company and ordering; the order screen explains that JavaScript is needed to fetch a price and order.

**One initial replacement of existing company HTML is necessary before advertising variant prices.** Existing published pages contain a numeric `29 kr`; new JavaScript cannot change their no-JavaScript HTML. Replace those pages with the neutral price markup and invalidate the HTML cache before activating an experiment. Check stored/offline copies, any service worker, company profiles, the product detail page, the comparison page, and `/bestall/`. Do not treat setting `storefrontVersion` as evidence that this migration happened. This change does not perform a site generation, cache invalidation, or deployment.

After that initial migration, subsequent offer/price/weight/version changes require only backend configuration deployment, never company-page regeneration. An old browser cache can still contain the old HTML: requests from old checkout code without a signed quote fail with HTTP 409 when pricing is active. The new order screen always loads and shows the actual offer before accepting payment. A cached advertised price can only be eliminated by retiring that old HTML, not by the checkout API.

## Central controls

Only `se_credit_risk` is configurable. `REPORT_PRICING_ENABLED=1` enables the server-side config in `REPORT_PRICING_CONFIG`; missing, malformed, or unsafe config makes this product unavailable rather than falling back to another price. CDK exposes corresponding `reportPricingEnabledTest/Prod` and `reportPricingConfigTest/Prod` context keys, forwarded to the Lambda environment. Their defaults are off/empty. Configuration is a small JSON object with these fields:

| Field | Required value/meaning |
| --- | --- |
| `storefrontVersion` | `runtime-offers-v1`, acknowledging the completed HTML migration above |
| `version` | Operator-defined revision; lowercase label beginning with a letter, at most 40 characters; increment for any change |
| `experimentId` | Approved experiment identifier using the same label syntax; also salts allocation |
| `allocationUnit` | Explicitly `company`; other units are rejected |
| `variants` | One to four approved offer records |
| `variants[].id` | Unique approved variant label using the same syntax |
| `variants[].weight` | Positive integer from 1 to 10,000; relative allocation weight |
| `variants[].unitAmount` | Approved positive integer price in öre (SEK minor units) |
| `variants[].stripePriceId` | Explicit approved Stripe `price_…` belonging to the existing allowed basic-report Product |

No runnable experiment configuration or future price is supplied here. A single variant can make an approved universal price change; multiple variants require a separately approved test design. Use short operational labels, never company names, organisation numbers, emails, or other personal data.

Add a separate randomly generated signing secret of at least 32 bytes as `REPORT_PRICING_SIGNING_KEY` in the existing application Secrets Manager bundle (`APP_SECRETS_ARN`). Local isolated tests may supply it as an environment variable. Do not put the secret in CDK context or public frontend variables. The existing Secrets Manager read grant suffices. Keep the key stable during an experiment; rotating it also changes allocation and invalidates outstanding quotes. Secrets are cached per warm Lambda as before, so rotate through a coordinated backend release.

For each approved Price the server verifies active Product, exact allowed Product membership, exact Price ID, active fixed one-time per-unit billing, SEK, VAT-inclusive tax treatment, no quantity transformation or custom amount, and exact approved minor-unit amount. The Stripe default Price is not used to select variants. Automatic Tax and manual capture remain enabled. Active offers disable promotions to avoid changing the assigned price; default checkout retains its existing promotion behavior.

Active sessions explicitly request SEK, including for a Price with other currency options. Manual capture also excludes Stripe Adaptive Pricing under Stripe's documented restrictions. The pinned existing Stripe API version is unchanged.

## Quote and failure contract

`GET /api/create-checkout?reportType=se_credit_risk&offer=1&businessId=…` validates the Swedish legal-person organisation number, chooses its offer, verifies the actual Stripe Price, and returns the amount/currency/tax behavior, a five-minute expiry, and (when active) a signed quote plus version/experiment/variant. It sets `Cache-Control: private, no-store, max-age=0`. The browser also uses `cache: no-store`; existing CloudFront `/api/*` has caching disabled and forwards query strings. Never add CDN caching to this route. There is no assignment cookie, local-storage identifier, or dependency on analytics consent.

`GET /api/create-checkout?reportType=se_credit_risk&offer=summary` returns the verified baseline or minimum allowed active price plus a `from` flag and expiry. In active mode it verifies every configured Price before advertising their minimum; an invalid price makes the summary unavailable. It returns no quote or assignment. Both generic and company numeric displays revert to neutral text when expired or unavailable. The isolated fixture mode allows the established synthetic company instead of real organisation numbers, retaining its separate checkout restrictions.

`POST /api/create-checkout` accepts `priceQuote`, never an arbitrary amount or Stripe ID. Active quotes are HMAC signed, bound to a keyed company digest and the entire configuration fingerprint, and checked again immediately before creating Checkout. Missing, tampered, wrong-company, expired, or changed quotes receive 409 with no Stripe Checkout creation. Stripe mismatches and missing pricing configuration/signing key fail closed. Rolling pricing back to disabled rejects old experimental quotes instead of substituting the baseline price.

The order screen fetches the offer before enabling its purchase form. It replaces the displayed price when a quote expires. Clicking with an expired quote or receiving a 409 fetches the current offer, clears acceptance of terms, and requires the buyer to review it and submit again; it never silently retries payment at a new price. Unavailable pricing shows an unavailable state with a retry control. Detail/comparison pages use the generic summary instead of a compiled numeric promise. Company panels stop showing the numeric runtime amount after its expiry.

Quote expiry limits **creation** of a Checkout Session. A session already created retains that exact Stripe Price under Stripe's existing session lifetime; changing configuration does not change an existing session or payment reservation. Emergency stopping of already-created sessions is a separate operational action. HTTP 409 on old clients blocks silent variant purchase, but cannot retroactively remove a price embedded in old HTML.

## Allocation and measurement

Company allocation is implemented as readiness because that was the previously preferred sample unit, but it is inactive until explicitly configured. A keyed deterministic hash of experiment ID and normalized organisation number selects a weighted variant. The same company receives the same variant across devices and visitors without tracking a visitor. A version-only revision keeps allocation stable if IDs, ordering, weights, and signing key stay unchanged. Changing weights, ordering, experiment ID, or key can reassign companies; decide and freeze those before starting. There is no exposure-based enrollment ledger or guarantee of a balanced sample at low traffic.

Company-level randomization has clustered observations: one buyer can see several price groups across different companies, popular companies contribute many visits, and repeated visits are not independent samples. Analyze by the declared company assignment unit and account for clusters/repeat buyers. Visitor-level assignment is deliberately not implemented; it would need a separate decision on stickiness, storage/consent, and cross-device behavior. Do not infer a winning price from unadjusted per-session conversion counts.

Authoritative attribution is attached to **Stripe Checkout Session and PaymentIntent metadata**, and the signed webhook copies it to the durable order's `pricing` field: version, experiment, variant, allocation unit, quoted amount/currency/tax behavior. Use the order's actual `amountTotal`, final fulfillment/refund state, and Stripe capture information for revenue. The quoted amount is a pre-discount/tax-treatment offer, not proof of captured revenue. A return URL is not proof of payment.

No new Google Analytics parameters or events are sent. In particular, no organisation number, company name, quote, company digest, session ID, email, or buyer identifier crosses the existing analytics frame boundary. Purchases work after analytics rejection and with blocked analytics storage. The existing consent gate remains unchanged. If consented funnel analytics is later needed, approve bounded experiment/variant fields at the frame boundary separately; Google documents `experiment_id` and `variant_id` for custom experiments. Stripe/order data already retain the purchase attribution independently of GA.

## Verification before any future activation

1. Approve prices, allocation unit, weights, population, duration, exposure metric, analysis method, promotion policy, and stopping/rollback rules.
2. Complete the neutral-HTML rollout above while pricing remains disabled. Confirm runtime baseline is still 29 SEK with Swedish VAT and the actual Stripe default Price still passes the approved catalog checks.
3. Create and verify the explicitly approved Prices in an isolated Stripe test account first, using the established checkout test restrictions. Supply the signing secret and backend config. This implementation's automated tests use only mocks, block network transports, and do not create Stripe objects or payments.
4. Verify real browser display → order → Checkout amount, company consistency, wrong company/token, expiry, configuration edits, rollback, outage, old HTML, no JavaScript, rejected analytics consent, and cache headers. Review metadata and signed-webhook attribution. Do not use a real payment/report job merely to check configuration.
5. Only then explicitly enable the separately approved live experiment through a backend release. Monitor unavailable/409 responses and actual captured/refunded revenue. Disabling pricing resumes baseline for newly loaded offers; outstanding experimental quotes must be reloaded and existing Checkout Sessions retain their prior offer.

Official references: [Stripe Price object](https://docs.stripe.com/api/prices/object), [Checkout line items and session creation](https://docs.stripe.com/api/checkout/sessions/create), [Stripe metadata propagation](https://docs.stripe.com/metadata), [inclusive and exclusive tax behavior](https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior), [Adaptive Pricing restrictions](https://docs.stripe.com/payments/currencies/localize-prices/adaptive-pricing?payment-ui=stripe-hosted#restrictions), [Google custom experiments](https://developers.google.com/analytics/devguides/collection/ga4/integration#in-house_and_custom_experiments).
