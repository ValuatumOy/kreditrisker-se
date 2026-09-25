# Swedish company directory (Kreditrisker, working name)

This is a standalone Astro 7 static site for Swedish company profiles and, later, Basic and AI credit-risk reports from Valuatum. It is isolated from the Finnish site in `../../src`: it has its own `package.json`, config, data, tests and output. The Finnish build and Jenkins job don't touch it. The only root change is `sites` in the root `tsconfig.json` exclude.

**Status:** the foundation is complete. It runs on **synthetic fixtures only**, is noindex everywhere, and nothing is for sale.

## Run

```bash
cd sites/se
npm install
npm test                      # 37 tests: contract, metrics, freshness/threshold, pipeline + CLI, reports, sitemaps
npm run dev                   # http://localhost:4331
npm run build                 # dist/ (static)
```

Node 22.12 or newer is required; tested on Node 24. The tests use `node --test` with native TypeScript, so there are no test dependencies.

Regenerate the fixtures with `node scripts/make-fixtures.ts`. Publishing commands are in [docs/DATA-CONTRACT.md](docs/DATA-CONTRACT.md#publishing-workflow).

To preview the report states (not indexable):

```bash
SE_OUT_DIR=dist-mock SE_PREVIEW=1 PUBLIC_SE_REPORT_ADAPTER=mock SE_REPORT_AI=live npm run build
```

Then open `/bestall/?orgnr=0020001012&produkt=ai`. An e-mail containing "fail" shows the failure state, and `&demo=<state>` shows any single state.

## Architecture

```
src/config/site.ts        name, origin, flags (env-driven), verified prices; refuses unsafe combos
src/lib/contract/         typed data contract + runtime validator (orgnr-keyed)
src/lib/metrics.ts        versioned nyckeltal formulas; missing/zero/negative/incomparable handling
src/lib/freshness.ts      current / aging / stale / none
src/lib/quality.ts        documented index threshold
src/lib/pipeline.ts       stage (validate, dedupe, diff) -> publish immutable release; rollback
src/lib/releaseio.ts      data/releases/<id>/, CURRENT pointer, data/staging/<batch>/
src/lib/publish.ts        release -> canonical paths, redirects, hubs, rankings
src/lib/store.ts          chooses dataset (SE_DATA_SOURCE); falls back to fixtures
src/lib/reports/          product states, labels, adapter (disabled | mock | http)
src/lib/sitemap.ts        segmented sitemaps from indexable canonical URLs only
scripts/data.ts           import | preview | publish | rollback | status
```

Routes (Swedish):

| Page | Path |
|---|---|
| Home and search | `/` |
| Search results, including empty, no-hit and bad-orgnr states | `/sok/` |
| Company profile | `/foretag/{orgnr}/{slug}/`; `/foretag/{orgnr}/` and old slugs redirect here |
| Industry hubs | `/branscher/`, `/branscher/{sni}-{name}/` |
| Municipality hubs | `/kommuner/`, `/kommuner/{name}/` |
| Rankings | `/topplistor/`, `/topplistor/{list}/` |
| Reports: explanation, comparison, samples | `/rapporter/`, `/rapporter/bas/`, `/rapporter/ai/`, `/rapporter/exempel/` |
| Order flow (flagged) | `/bestall/` |
| Methodology, sources, FAQ, guides | `/metod/`, `/kallor/`, `/fragor/`, `/guider/…` |
| Provider and contact | `/om/` |
| Legal pages (drafts marked "Utkast") | `/integritet/`, `/villkor/`, `/leverans/` |
| Crawl files | `robots.txt`, `sitemap-index.xml`, `sitemap-{pages,hubs,companies-N}.xml`, `redirects.json` (301s for the edge) |

## Flags (all off by default)

| Variable | Default | Effect |
|---|---|---|
| `SE_SITE_NAME` / `SE_SITE_ORIGIN` / `SE_CONTACT_EMAIL` | Kreditrisker / https://www.kreditrisker.se / – | brand, canonical origin, contact |
| `SE_INDEXING` | off | global index switch (synthetic data stays noindex regardless) |
| `SE_REPORT_BASIC`, `SE_REPORT_AI` | `unavailable` | `unavailable` \| `sample` \| `live`, per product |
| `SE_CHECKOUT` | off | real ordering; needs the http adapter, API base and verified prices |
| `PUBLIC_SE_REPORT_ADAPTER`, `PUBLIC_SE_REPORT_API` | `disabled` | report backend ([docs/REPORTS.md](docs/REPORTS.md)) |
| `SE_PUBLIC_MODEL_OUTPUT` | off | show validated Swedish model output |
| `SE_PUBLISH_SOLE_TRADERS` | off | generate pages for enskild firma (personnummer) |
| `SE_PREVIEW`, `SE_DATA_SOURCE`, `SE_DATA_DIR`, `SE_DATA_AS_OF`, `SE_BUILD_ONLY`, `SE_OUT_DIR` | – | staging, dataset choice, reproducible freshness, incremental builds |
| `PUBLIC_SE_SEARCH_ENDPOINT` | – | search API instead of the static index (needed at national scale) |

## Deployment

Deployment is not set up; it deliberately doesn't reuse the Finnish Jenkins job. The simplest path is a separate S3 bucket and CloudFront distribution, like the Finnish and Danish sites:

- Build with `npm ci && npm test && npm run build`, then sync `dist/`.
- Use `dist/redirects.json` to generate CloudFront Function 301s.
- Keep the staging distribution behind `SE_PREVIEW=1`.

## Launch

Before launch, read [docs/LAUNCH-GATES.md](docs/LAUNCH-GATES.md) (inputs and sign-offs) and [docs/DOMAIN.md](docs/DOMAIN.md) (domain recommendation). The design direction is recorded in `PRODUCT.md` and `DESIGN.md`.
