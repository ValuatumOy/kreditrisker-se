# Build, test and deploy

The Swedish site builds company pages the same way as the Finnish and Danish
directories: a list of every company, a batch of companies whose data changed,
pages built only for the batch, and the result copied on top of an S3 bucket
behind CloudFront. What is different is testing, which no longer goes through
Jenkins.

## Data flow

```
get_static_params (Go, DB)      staticparams.txt        every company: fid, slug, name, SNI, orgnr
                                staticparams_batch.txt  companies updated since SINCE (+ includeparams.txt)
        │
scripts/fetch.ts                for each batch fid: POST /rest/modeldata + GET /rest/company/:id
        │                       → map (src/lib/valuatum/map.ts) → validate → publish
        │                       merges with the previous index state, drops companies not in staticparams.txt
        ▼
data/build/pages.jsonl          full records, only the batch
data/build/index.jsonl          one slim row per company in the directory (also the next run's state)
data/build/rejected.jsonl       batch companies that failed mapping or validation, with reasons
data/build/removed.txt          S3 prefixes of companies that left the directory
        │
SE_DATA_SOURCE=build astro build
        ▼
dist/                           batch company pages + every hub, ranking, sitemap
```

Hubs, rankings, sitemaps, related links and redirects use the index rows, so a
batch of 50 companies still produces complete hub pages and sitemaps. API
responses are cached per fid in `data/api-cache/` (only the variables the mapper
reads, without board members), so rebuilds do not call the API again.

## 1. Local preview, seconds

```bash
export PUBLIC_VALUATUM_API_BASE_URL=https://<swedish-backend>   # or put both in .env
export SECRET_VALUATUM_API_TOKEN=...
npm run preview:companies -- 556987-6542 900123
```

Arguments are orgnrs (looked up in `data/params/staticparams.txt`, a copy of the
full list) or fids. The command fetches them, starts the dev server and prints
each company's URL. Template changes reload instantly; no rebuild needed. To
ask an AI agent for a preview, ask it to run this and screenshot the pages.

## 2. Shared test link, about a minute (Vercel)

Every push to GitHub builds a Vercel preview with its own URL (`vercel.json` runs
`npm run build:vercel`). It renders the committed sample:

- `data/sample/staticparams.txt`: the sample batch (about 200 companies chosen
  to cover edge cases: sparse, stale, negative equity, bankrupt, K2/K3,
  broken fiscal years, long names, group accounts)
- `data/sample/api-cache/<fid>.json`: their cached API responses

so previews need no API access. To refresh the sample: run `npm run fetch`
with `BUILD_STATIC_PARAMS_FILE=data/sample/staticparams.txt
SE_API_CACHE_DIR=data/sample/api-cache SE_API_REFRESH=1` and commit. Until the
sample exists, previews show the synthetic fixtures.

Previews are always `noindex` (SE_INDEXING is off). Turn on Vercel
Authentication for preview *and* production deployments before real company
data is committed; the Vercel site is a test environment, not the public site.

## 3. Production (Jenkins → S3 + CloudFront)

`jenkins/kreditrisker-se.groovy`, nightly like the Danish job:

1. Get static params (Go tool, `--accounts XBRLSweden`)
2. Fetch (restores the index state from `STATE_URI`, a private S3 key)
3. Build (`SE_DATA_SOURCE=build`)
4. Deploy: `aws s3 cp` on top of the bucket, delete `removed.txt` prefixes,
   save the new index state, invalidate CloudFront

The first full build: run with `BUILD_UNBUILT=20000` nightly (or larger) until
every company has a page; each run adds that many unbuilt companies to the batch.

Search: the static `/sok/index.json` is emitted only up to 50,000 companies. For
the full directory set `PUBLIC_SE_SEARCH_ENDPOINT` to a search API returning
`SearchHit[]` (CloudSearch as on the Finnish site; not built yet).

## Variable mapping (to confirm against the Swedish backend)

`src/lib/valuatum/map.ts` maps REST variables to the contract. Amounts arrive in
millions and are stored in kronor. Absent variables become `missing`
(`not_in_source`), never 0. Names follow the Danish backend:

| Contract | Variable(s) |
|---|---|
| netSales | `ns` |
| operatingProfit | `ebit` |
| financialNet | `fundu_financial_income_and_expenses` |
| profitAfterFinancialItems | `pre_tax_profit` |
| netProfit | `cr_net_earnings`, `net_earnings` |
| personnelCosts | `cr_employee_benefit_expenses` (sign flipped) |
| totalAssets | `bs_total_assets` |
| equity | `cr_shareholders_equity` |
| untaxedReserves | `cr_untaxed_reserves` |
| inventories | `cr_inventory`, `inventories` |
| cash | `cr_cash_and_cash_eq_total`, `cr_cash_and_bank_deposits` |
| currentAssets / currentLiabilities | `cr_current_assets_total` / `cr_current_liabilities_total` |
| longTermLiabilities | `cr_non_current_liabilities_total` |
| employees | `cr_employees` |
| period length | `cr_fiscal_period_length` |

Open questions for the Swedish backend team:

1. **Untaxed reserves (obeskattade reserver).** Soliditet needs it. The Danish
   backend has no such variable, so soliditet shows "saknas" for every company.
   Ask for `cr_untaxed_reserves`, reported as 0 when the annual report has none.
2. **Fiscal period end date.** Positions are years only. Broken fiscal years
   (brutet räkenskapsår) are common in Sweden; without an end date the mapper
   assumes December. Ask for `text_fiscal_period_end` (YYYY-MM-DD).
3. **Resultat efter finansiella poster.** Is `pre_tax_profit` before or after
   bokslutsdispositioner (appropriations)? The Swedish line is before.
4. **Current assets.** In the Danish data `cr_current_assets_total` sometimes
   equals inventories while receivables are larger, which gives kassalikviditet 0 %.
   Check the Swedish mapping.
5. **Company register fields.** Status values (Danish: `NORMAL`), legal form
   text, municipality (name or kommunkod; both are handled), SNI code with a
   Swedish label, and former names.
6. **Accounting framework (K2/K3/IFRS) and filing date.** Needed for the
   comparability rules and sitemap `lastmod`.
7. **Account nicknames** for the Swedish followed models (`--accounts`).
