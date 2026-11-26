# Swedish AI checkout candidate, 2026-11-26

Local candidate based on `origin/main` at `d2be720`, replaying only feature
commit `8428f68`. The bankruptcy evaluation commit `b32c81e` is excluded.
AI's verified customer price is 86.25 SEK including VAT, matching the backend's
8,625-öre target and inclusive Stripe-price validation. The Swedish Jenkins
build enables `SE_REPORT_AI=live`; default builds remain unavailable.

The existing `/villkor/` and `/leverans/` cover a single PDF purchase, applicable
VAT in the final checkout total, authorization followed by capture after PDF
generation, delivery and withdrawal. Their version stays `2026-10-30`.
The example page's “cannot yet be ordered” sentence follows the AI launch flag.

No Stripe product ID or fraud-enabling context is added. The checked-in
`stripeProductsProd` still contains only Basic, so the backend refuses AI sales
until an actual allowed AI product with its verified price is configured.
`fraudAddonEnabledProd` remains absent and the generated environment defaults
to `SE_AI_FRAUD_ADDON=0`. New single-AI sessions always persist versioned
`includeFraud=false`, zero add-on charge and one base line item when that flag
is off. Historical unversioned sessions and already stored order parameters
retain their previous replay behavior.

## Narrow Jenkins run

The existing Swedish job reads `jenkins/kreditrisker-se.groovy` from `main`.
It cannot consume this private local branch until the reviewed change is made
available to that SCM configuration. Keep the candidate in TEST until Esa
explicitly approves this specific tested change for production.

For a bounded build, use **Build with Parameters**:

- `COMPANIES=556036-9208` (Älvsjö Konditori; the job stops if it is absent from
  the current full directory list).
- `UPDATE_SEARCH=false`.
- `DEPLOY=false` to fetch, build and verify without publishing.
- After the required specific production approval, the same selected-company
  request with `DEPLOY=true` publishes the website; it does not deploy the
  checkout backend or create/configure a Stripe product.

Do not use empty `COMPANIES`, `auto`, `new:N` or `all` for this narrow run.
The named-company deletion guard stops deployment if unrelated company
removals appear in the fetched directory state.

Every run rebuilds the common pages, including `/bestall/`, `/rapporter/` and
the product/example pages. Only the selected company profile is refreshed.
Deployment copies generated non-sitemap files to the site bucket behind
CloudFront; common list directories are synchronized, while untouched company
HTML and hashed assets remain. It withdraws affected sitemap URLs first,
uploads targets, waits for the `/*` CloudFront invalidation, then publishes the
final sitemap and state. Thus `/bestall/?orgnr=...&produkt=ai` uses the refreshed
shared order page for any company, but AI buttons on other existing company
profiles remain as previously rendered until those profiles are rebuilt.

## Local validation

- Website suite: 130 passed, one existing browser/frame test skipped.
- Backend suite: 109 passed; focused checkout/session replay rerun: 14 passed.
- CDK suite: 13 passed, including default-disabled fraud environment assertions
  for both Test and Prod templates. No cloud deployment was run.
- Synthetic Astro build with the candidate's live-AI/HTTP-checkout settings:
  91 pages built. HTML checks confirmed the 86.25 SEK inclusive price, live AI
  data, hidden optional fraud control, and consistent example availability copy.
- The checked-in production context still has only the existing Basic Stripe
  product mapping and no fraud-enable context. No evaluation files are present.
