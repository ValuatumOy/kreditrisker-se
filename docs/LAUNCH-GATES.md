# Launch gates

Valuatum's owners decide how these checks apply to each launch. Switches are environment variables read by `src/config/site.ts`; the build refuses a few unsafe combinations on its own.

2026-10-30: the owner requested launch of the basic report while the IMY question remains open. The Finnish risk model is used without a Swedish predictive validation. AI-report sales and search indexing remain disabled. Verify the first real paid order and delivery after launch.

| # | Gate | Evidence required | Unlocks |
|---|---|---|---|
| 1 | **Data licence and redistribution.** Check the actual source of each published field and any purchased data. [Bolagsverket says its high-value datasets can be reused commercially without an agreement](https://bolagsverket.se/apierochoppnadata/hamtaforetagsinformation/vardefulladatamangder.5294.html), subject to applicable privacy, confidentiality and dataset-specific terms. This does not resolve those other requirements or establish the terms of other sources. | Source-specific terms or agreements and a list of permitted fields | loading real data (`data:import` of a real batch) |
| 2 | **Credit-information law (KuL).** IMY states that credit-information activity *normally requires a permit*. Legal review decides whether the free profiles and/or the paid reports are kreditupplysningsverksamhet, whether a permit is needed, or whether an exemption applies (e.g. utgivningsbevis). | Swedish counsel's memo; IMY permit if required | `SE_INDEXING=1`, report sales |
| 3 | **Privacy (GDPR).** Legal basis for publishing company data and for all stages of AI fraud research, including personal data and any external AI provider; DPIA if needed; privacy policy finalised. The prototype prompts searches for charges, convictions and judgments about company representatives. Assess the applicable law and any separate IMY consent before enabling this feature; omitting a finding from the final PDF does not by itself settle whether intermediate processing is permitted. | Counsel sign-off; IMY consent if required; final `/integritet/` | `SE_INDEXING=1`; AI fraud analysis; `SE_PUBLISH_SOLE_TRADERS=1` only with explicit approval |
| 4 | **Credit model.** Swedish reports use the Finnish model. Review its results on Swedish company data before selling reports; a later comparison against the Danish model can use Swedish bankruptcy outcomes if available. The separate public company-page switch still requires its existing validation fields. | Reviewed sample reports; for company pages, validation report and model owner's sign-off (`model.validation`) | Report sales; `SE_PUBLIC_MODEL_OUTPUT=1` on company pages |
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
