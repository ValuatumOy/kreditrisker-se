# Swedish company-data contract (schema v1)

The source of truth is `src/lib/contract/types.ts`, validated by `src/lib/contract/validate.ts`. The import accepts one JSON object per company (JSON Lines or a JSON array), keyed by `orgnr`.

## Identity

- `orgnr`: 10 digits, no hyphen (the importer normalises `556677-8899` and `16556677-8899`), Luhn-valid.
  - Group digit `0` is reserved for synthetic fixtures (it isn't used in the register) and requires `synthetic: true`. Real records may not use it.
  - A personnummer-shaped number (third digit 0–1) is allowed only for `legalForm: "EF"`. With default flags, EF profiles are never published.
- `synthetic`: must agree with every `source` (`"synthetic"`) and with the orgnr group.
- `name`, `formerNames[]` (drive redirects), `legalForm`, `status {code, since?, source}`, `registeredAt?`, `municipality? {code: 4-digit kommunkod, name, county?}`, `sni[] {version: SNI2007|SNI2025, code: 5 digits, label}` (primary first), `businessDescription?`.

## Financial statements

`periods[]`, newest first, no duplicates. Each period has `start`, `end`, `months` (1–18), `currency`, `consolidated`, `framework` (K2/K3/IFRS/unknown), `filedAt?`, `source`, `income{…}`, `balance{…}` and `employees`. Amounts are in kronor.

Every item is a `Value`. An omitted field or a raw number is **rejected**.

| status | meaning | display |
|---|---|---|
| `reported` | value + source | number; `0` shown as 0, negatives with − and in red |
| `missing` | `reason`: not_filed, not_in_source, not_digitised, parse_failed, withheld | "saknas" + reason tooltip |
| `not_applicable` | `note` | "ej tillämpligt" |
| `incomparable` | `reason` | "ej jämförbar" |
| `derived` | computed at build time only; rejected on import | number + formula id |

Import rule: if a *complete* balance sheet (its totals reconcile) has no untaxed-reserves line, the importer emits `reported 0`. An abridged or unparsable sheet emits `missing`.

Assets, inventories, cash, current assets and liabilities may not be negative. Operating result, net profit and equity may be.

## Derived metrics (`src/lib/metrics.ts`)

These are versioned formula ids (`soliditet.v1` …). A missing input makes the metric missing. A denominator of zero or less makes it `incomparable`. Growth requires two consecutive 12-month periods with the same consolidation and framework.

## Freshness (`src/lib/freshness.ts`)

The newest period's end is compared with `SE_DATA_AS_OF` (defaults to the build date):
- **current**: 19 months or less (7-month filing deadline plus 12 months)
- **aging**: up to 31 months
- **stale**: more than 31 months (warning shown, no index, no model output)
- **none**: no periods

## Credit-model output (optional `model`)

`modelId`, `modelVersion`, `generatedAt`, `inputsPeriodEnd`, `horizonMonths`, `score`, `scale {min, max, higherIsBetter}`, `riskClass?`, `probabilityOfDefault?`, `validation? {validatedForSweden, approvedBy, approvedAt, methodologyUrl}` and `source`. Nothing is displayed without `validation` and the flag (see LAUNCH-GATES #4).

## Index threshold (`src/lib/quality.ts`)

A profile is indexed only if all of these hold:
- it's not synthetic
- its status is known
- it has a municipality and a primary SNI
- it has at least one period that isn't stale
- the newest period reports at least **5 of 7** core items: net sales, operating result, net profit, total assets, equity, current liabilities, employees
- the global switch is on

Everything else is `noindex,follow` and left out of the sitemaps. The reasons are listed by `npm run data:status`.

## Publishing workflow

```
npm run data:import  -- export.jsonl --batch 2026-10-01   # validate, normalise, dedupe -> data/staging/<batch>/
                                                          #   records.json, rejected.jsonl (every error per row), report.json (diff)
npm run data:preview -- 2026-10-01                        # noindex build of CURRENT + batch into dist-preview/
npm run data:publish -- 2026-10-01 [--remove orgnr,...]   # new immutable release data/releases/r-<ts>/, CURRENT moves
npm run data:rollback [-- r-<ts>]                         # CURRENT back to parent (or a given release)
npm run data:status                                       # releases, CURRENT, threshold result per profile
```

- **Dedupe:** the same orgnr twice in a batch keeps the row with the newest statements; ties go to the later row. The loser is logged as `duplicate`.
- **Diff:** `added`, `updated`, `unchanged` (content-equal, provenance ignored) and `renamed`.
- **Incremental builds:** the manifest's `changed[]` lists the orgnrs to rebuild. `SE_BUILD_ONLY=orgnr,orgnr` limits profile generation, for pipelines that sync only changed pages. Hubs and sitemaps should be rebuilt in full.
- **Redirects:** `slug-history.json` keeps every slug an orgnr has had. Old slugs and `/foretag/<orgnr>/` produce static redirect pages plus `/redirects.json` (301 list for the edge).
- **Scale:** releases are single JSON files. Before loading the full register (several hundred thousand aktiebolag), shard `companies.json` by orgnr prefix and set `PUBLIC_SE_SEARCH_ENDPOINT` to a search API. The static `/sok/index.json` is meant for small datasets.
