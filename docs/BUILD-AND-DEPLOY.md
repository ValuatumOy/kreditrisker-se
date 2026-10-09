# Build, test and deploy

The Swedish site builds company pages the same way as the Finnish and Danish
directories: a list of every company, a batch of companies whose data changed,
pages built only for the batch, and the result copied on top of an S3 bucket
behind CloudFront. What is different is testing, which no longer goes through
Jenkins.

## Data flow

```
get_static_params (Go, DB)      staticparams.txt        every company: fid, slug, name, SNI, orgnr
                                staticparams_batch.txt  the batch: the companies in COMPANIES; if empty, those updated
                                                        since SINCE; COMPANIES=all: every company (scripts/select-batch.ts)
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

Bitbucket is the primary repository as of 2026-10-09:
`git@bitbucket.org:valuatum/kreditrisker-se.git`, branch `main`. Both GitHub
branches and their complete Git history were copied; pull-request discussions
remain on GitHub.

Vercel is connected to the GitHub copy. The full sync chain was verified on
2026-10-09: commit `5c0f514` was pushed only to Bitbucket, pipeline
[#1](https://bitbucket.org/valuatum/kreditrisker-se/pipelines/results/1) succeeded
in 11 seconds, GitHub matched the commit, and Vercel showed it as Ready. The project is
on the Hobby plan: Vercel's [private-repository rules](https://vercel.com/docs/git#using-hobby-teams)
require Pro for direct deployment from a private Bitbucket workspace repository.
`bitbucket-pipelines.yml` runs one-way synchronization from Bitbucket to
GitHub: each branch push updates the same GitHub branch, and tag pushes copy the
same tag. GitHub then triggers Vercel as before. Branch/tag deletions are not
mirrored, and force-pushes are not used. Make code changes in Bitbucket; if GitHub
has diverged, the sync fails instead of overwriting those commits.

Pipelines was enabled on 2026-10-09. Its SSH key is managed in Bitbucket's
Pipelines > SSH Keys settings; the public key is registered only on
`ValuatumOy/kreditrisker-se` as the read/write deploy key
`Bitbucket kreditrisker-se mirror`. Bitbucket manages the SSH host fingerprint
for `github.com`; the displayed RSA fingerprint was checked against GitHub's
published fingerprint. The private key stays in Bitbucket. Normal updates need only:

```bash
git push origin main
```

Check the Bitbucket pipeline result if GitHub or Vercel does not update. If the
sync fails, the last successful Vercel deployment stays available. The existing
local checkout retains a `github` remote for recovery; direct GitHub pushes are
not part of the normal workflow.

Every push to the GitHub copy builds a Vercel preview with its own URL
(`vercel.json` runs `npm run build:vercel`). It renders the committed sample:

- `data/sample/staticparams.txt`: currently one real company, S M Entreprenad
  Aktiebolag. Expand the sample to cover sparse data, stale data, negative equity,
  bankruptcy, K2/K3, broken fiscal years, long names and group accounts.
- `data/sample/api-cache/<fid>.json`: their cached API responses

so previews need no API access. To refresh the sample: run `npm run fetch`
with `BUILD_STATIC_PARAMS_FILE=data/sample/staticparams.txt
SE_API_CACHE_DIR=data/sample/api-cache SE_API_REFRESH=1` and commit. Until the
sample exists, previews show the synthetic fixtures.

Previews are always `noindex` (SE_INDEXING is off). Turn on Vercel
Authentication for preview *and* production deployments before real company
data is committed; the Vercel site is a test environment, not the public site.

## 3. Production (Jenkins → S3 + CloudFront)

`jenkins/kreditrisker-se.groovy`, nightly like the Danish job. To publish pages,
open the job, type the organisationsnummer into COMPANIES and press Build; every
other parameter already defaults to a production run.

Setup, once (nothing in the Jenkinsfile needs editing):

- AWS: `cd aws-infra && npx cdk deploy KreditriskerSiteStackProd --exclusively`
  (deployed 2026-10-09; site on its CloudFront domain until kreditrisker.se is
  in Route 53). The job reads bucket, distribution, state URI and site origin
  from the stack outputs; the stack grants the agent role `sweden-process-role`
  access to them.
- Jenkins job: Pipeline script from SCM, the Bitbucket repo, branch `*/main`,
  script path `jenkins/kreditrisker-se.groovy`, the same Bitbucket credential
  as the other Valuatum jobs.
- Jenkins credential `kreditrisker-se-api-token` (Secret text): the
  sweden.valuatum.com API token.
- Agent label `sweden-build` (profinder-environment `jenkins/new-environment.sh`):
  it reaches sweden-db. The job installs Node 22 in its workspace if the agent
  has none.


1. Get static params (Go tool `build/bin/get_static_params_arm64`, `--accounts "Bolagsverket data import"`),
   then `scripts/select-batch.ts` picks the batch from `COMPANIES` (no file upload; empty = changed, `all` = every company)
2. Fetch (restores the index state from `STATE_URI`, a private S3 key)
3. Build (`SE_DATA_SOURCE=build`)
4. Deploy: `aws s3 cp` on top of the bucket, delete `removed.txt` prefixes,
   save the new index state, invalidate CloudFront

The first full build, and any full rebuild: `COMPANIES=all`. It also re-uploads
every company to search.

Search: the static `/sok/index.json` is emitted only up to 50,000 companies. For
the full directory set `PUBLIC_SE_SEARCH_ENDPOINT` to a search API returning
`SearchHit[]` (CloudSearch as on the Finnish site; not built yet).

## Variable mapping (checked against sweden.valuatum.com, 2026-10-08)

`src/lib/valuatum/map.ts` maps REST variables to the contract. Amounts arrive in
millions and are stored in kronor. Absent variables become `missing`
(`not_in_source`), never 0.

| Contract | Variable(s) |
|---|---|
| netSales | `ns` |
| operatingProfit | `ebit` |
| financialNet | `fundu_financial_income_and_expenses` |
| profitAfterFinancialItems | `cr_pre_tax_profit` only (`pre_tax_profit` is after bokslutsdispositioner and group contributions, so it is not a fallback) |
| netProfit | `cr_net_earnings`, `net_earnings` |
| personnelCosts | `fundu_personnel_expenses`, `cr_employee_expenses` (sign flipped) |
| totalAssets | `bs_total_assets` |
| equity | `cr_shareholders_equity` |
| untaxedReserves | `cr_appropriations_total` |
| inventories | `cr_inventory`, `inventories` |
| cash | `cr_cash_and_cash_eq_total`, `cr_cash_and_bank_deposits` |
| currentAssets / currentLiabilities | `cr_ifrs_current_assets_total` (`cr_current_assets_total` leaves the receivables out) / `cr_current_liabilities_total` |
| longTermLiabilities | `cr_non_current_liabilities_total` |
| employees | `cr_employees` |
| period length / end | `cr_fiscal_period_length` / `cr_fiscal_year_end` (e.g. 20250430, so broken fiscal years are right) |

Register data (`/rest/company`) comes from the Bolagsverket import
(profinder-environment `parsing-worker-lambda`) under the Finnish COMPANYDATA keys:
`YHTIOMUOTO` (form code, AB …), `PERUSTETTU` (DD-MM-YYYY), `TILAKOODI` (1 / L),
`MENETTELY` + `MENETTELY_PVM` (ongoing konkurs, likvidation, rekonstruktion),
`LOPETTAMISSYY` + `LOPETTAMIS_PVM` (deregistration), and `KOTIPAIKKA` (kommun of the
registered seat in the annual report; about 80 % of companies have one). The industry
is the SNI 2025 code (`industryCode`, 5 digits; `0000` = not allocated) with its
Swedish name in `industryTree.name.sv`.

Still open:

1. **Accounting framework (K2/K3/IFRS) and filing date.** Needed for the
   comparability rules and sitemap `lastmod`.
2. **Kommun for the companies whose annual report names no seat**, or a town
   instead of a kommun. SCB's company register (kommunSate) would cover all, but
   needs an API key.

Missing municipality data does not block company indexing or rankings. The company
is simply absent from municipality hubs. SNI `0000` is left unclassified; those
profiles are generated but remain below the current index threshold.

Missing API values stay `saknas`: an absent variable does not prove that the
annual report reported zero or omitted the item. Growth and year-over-year KPI
changes are shown only between consecutive fiscal periods.

When updating an existing production dataset to these quality/calculation rules,
run a full rebuild (`COMPANIES=all`): an incremental batch retains old index rows and
profile HTML for companies outside the batch.

## First sample review (2026-10-09)

The committed `data/sample/api-cache/52.json` maps S M Entreprenad Aktiebolag
(556193-9215) to the fiscal period 2025-07-01–2026-06-30. The source has
net sales SEK 427,568,195, operating profit SEK 43,049,755 and 52 employees.
Computed growth is 20.9 %, soliditet 48.1 % and kassalikviditet 176 %.
These agree with the preview; this checks the API-to-page mapping, not the
original annual report.

Follow-up data checks:

- Inspect the other imported companies, including missing municipality,
  SNI `0000`, bankruptcy and deregistration, sparse data and broken fiscal years.
- Confirm nonempty `MENETTELY_PVM` and `LOPETTAMIS_PVM` formats with real responses.
  The mapper accepts ISO dates. Deregistration currently takes precedence over an
  ongoing procedure; `LOPETTAMISSYY` is not displayed on the profile.
- The unsupported 2017 taxonomy must be handled in the upstream importer. Do not
  treat a missing imported year as zero or compare across that gap as annual growth.
- Confirm whether an absent balance-sheet line is a reported zero before changing
  its display. Missing long-term liabilities in this sample are still `saknas`.
- Accounting framework and filing date remain unavailable. Fiscal-period dates,
  Swedish SNI labels, registration date, legal form and active status are mapped.

The backend's inherited ASP `DEFAULTID` and `calculate_adjusted_credit_score`
setting concern the Swedish backend, not this site's static page mapper.
