# Report backend adapter

The client lives in `src/lib/reports/adapter.ts`. It's selected by `PUBLIC_SE_REPORT_ADAPTER`:

- `disabled` (default): every product is unavailable.
- `mock`: preview builds only. It simulates the lifecycle: an e-mail containing "fail" leads to failure. `/bestall/?orgnr=…&produkt=ai&demo=<state>` renders any single state.
- `http`: the Swedish backend at `PUBLIC_SE_REPORT_API`.

Basic (`basic`) and AI (`ai`) are independent products, each with its own flag `SE_REPORT_BASIC` / `SE_REPORT_AI`, set to `unavailable | sample | live`.

## Endpoints the Swedish backend must implement (JSON)

| Method | Path | Returns |
|---|---|---|
| GET | `se/reports/{product}/availability?orgnr=` | `ReportState` |
| POST | `se/reports/{product}/orders` with body `{orgnr, product, email, acceptedTermsVersion}` | `ReportState` (normally `processing`, or a checkout redirect to be added with the payment provider) |
| GET | `se/reports/{product}/orders/{orderId}` | `ReportState` |

`ReportState.kind` is one of `unavailable{reason}`, `sample{sampleHref}`, `available`, `processing{orderId, startedAt}`, `success{orderId, downloadHref (https only), expiresAt?}` or `failure{orderId?, code, retryable}`.

The client ignores any price sent by the backend. Prices come only from `VERIFIED_PRICES` in `src/config/site.ts`.

Still to design with the payment provider: a hosted checkout redirect and return URL, a webhook confirming payment before generation, idempotent order creation, and a refund path for failures. The Finnish Stripe backend in `/backend` is a reference only and is not wired to Sweden.
