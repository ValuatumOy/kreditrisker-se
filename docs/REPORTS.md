# Report backend adapter

The client lives in `src/lib/reports/adapter.ts`. It's selected by `PUBLIC_SE_REPORT_ADAPTER`:

- `disabled` (default): every product is unavailable.
- `mock`: preview builds only. It simulates the lifecycle: an e-mail containing "fail" leads to failure. `/bestall/?orgnr=…&produkt=ai&demo=<state>` renders any single state.
- `http`: the Swedish backend at `PUBLIC_SE_REPORT_API`.

Basic (`basic`) and AI (`ai`) are independent products, each with its own flag `SE_REPORT_BASIC` / `SE_REPORT_AI`, set to `unavailable | sample | live`.

## Checkout endpoints (JSON)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/create-checkout` | Validate the order and return a Stripe Checkout URL. |
| POST | `/api/webhook` | Receive Stripe events on the direct API Gateway URL. |
| POST | `/api/withdrawal` | Record a customer's withdrawal request. |

The HTTP adapter redirects the buyer to Stripe. After a successful checkout,
the order is processed in the background and the PDF is sent by email; there is
no customer-facing status or download endpoint. The mock adapter uses local
simulated `processing` and `success` states for preview only.

The client ignores any price sent by the backend. Prices come only from `VERIFIED_PRICES` in `src/config/site.ts`.

The backend is implemented in `backend/`, but is not evidence of a deployed or
approved sales flow. Complete the end-to-end, consumer-terms, privacy and other
launch checks in `docs/LAUNCH-GATES.md` before enabling it.
