# Launch gates

Each gate needs a named owner and a written sign-off before its switch is turned on. Switches are environment variables read by `src/config/site.ts`. The build refuses a few unsafe combinations on its own.

| # | Gate | Evidence required | Unlocks |
|---|---|---|---|
| 1 | **Data licence and redistribution.** Bolagsverket's värdefulla datamängder API terms, any SCB data, and any purchased data allow public, per-company, indexable redistribution and commercial reports. | Signed terms or agreement; a list of permitted fields | loading real data (`data:import` of a real batch) |
| 2 | **Credit-information law (KuL).** IMY states that credit-information activity *normally requires a permit*. Legal review decides whether the free profiles and/or the paid reports are kreditupplysningsverksamhet, whether a permit is needed, or whether an exemption applies (e.g. utgivningsbevis). | Swedish counsel's memo; IMY permit if required | `SE_INDEXING=1`, report sales |
| 3 | **Privacy (GDPR).** Legal basis for publishing company data; handling of any personal data (board members, sole traders); DPIA if needed; privacy policy finalised. | Counsel sign-off; final `/integritet/` | `SE_INDEXING=1`; `SE_PUBLISH_SOLE_TRADERS=1` only with explicit approval |
| 4 | **Model validation.** Valuatum's credit model validated on Swedish data: scale, forecast horizon, calibration, limits, methodology page. No Finnish scores, horizons or classes reused. | Validation report and model owner's sign-off (the `model.validation` fields in the data) | `SE_PUBLIC_MODEL_OUTPUT=1`; ratings inside reports |
| 5 | **Report content and generation.** Swedish Basic and AI reports produced end to end from Swedish data; AI-text QA; sample PDFs produced. | Test reports reviewed | `SE_REPORT_BASIC=sample` / `SE_REPORT_AI=sample` (with real sample PDFs linked) |
| 6 | **Prices, payment and fulfilment.** Final SEK prices (VAT treatment decided); payment provider contract; delivery tested end to end, including failures and refunds; order backend implementing `docs/REPORTS.md`. | Test orders in production-like env | `VERIFIED_PRICES`, `PUBLIC_SE_REPORT_ADAPTER=http`, `PUBLIC_SE_REPORT_API`, `SE_REPORT_*=live`, `SE_CHECKOUT=1` |
| 7 | **Consumer and distance-selling terms.** Terms, ångerrätt for digital content, B2B vs consumer, marketing claims reviewed. | Final `/villkor/`, `/leverans/`; drafts marked "Utkast" removed | `SE_CHECKOUT=1` |
| 8 | **Domain, brand and contact.** Domain registered, trademark cleared (`docs/DOMAIN.md`), Swedish support e-mail. | — | `SE_SITE_ORIGIN`, `SE_SITE_NAME`, `SE_CONTACT_EMAIL` |
| 9 | **Search launch.** Real release published, quality threshold output reviewed (`npm run data:status`), Search Console property set up. | — | `SE_INDEXING=1` |

Safety already enforced in code:

- A dataset containing synthetic records is always `noindex`, whatever the flags say; robots.txt stays `Disallow: /` and the sitemaps are empty.
- A release can't mix synthetic and real records.
- `SE_CHECKOUT=1` fails the build without the `http` adapter and an API base, or without a verified price for a live product.
- The mock adapter fails the build if the site is indexable.
- Model output is shown only when `SE_PUBLIC_MODEL_OUTPUT=1`, the record carries `validation.validatedForSweden`, the record isn't synthetic, and the statements aren't stale.
- Prices are never read from the backend; only `VERIFIED_PRICES` can show a price.
