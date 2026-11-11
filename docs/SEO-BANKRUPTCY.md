# Bankruptcy pages and crawlable directories

Reference inspected on 2026-11-11: [Finnish bankruptcy overview](https://luottoriskit.fi/fi/konkurssit/), [Finnish explanation](https://luottoriskit.fi/fi/artikkelit/yrityksen-konkurssi/), and [Finnish municipality context](https://luottoriskit.fi/fi/paikkakunnat/seinajoki/yritykset/).

The Swedish `/konkurser/` overview provides a monthly start-date breakdown, industry and municipality groups, the known employee-size subset, and company links. `/konkurser/foretag/` lists all currently recorded bankruptcy statuses. `/konkurser/branscher/` and `/konkurser/kommuner/` list all groups, with links to their company lists. The overview is limited to ten groups per kind; lists use 100 rows per page. `/konkurser/om-konkurs/` explains the data and links to Swedish primary sources.

## Data limits

Only `status.code === 'bankruptcy'` selects a case. Names, financial figures, deregistration and reconstruction never imply bankruptcy. These pages describe a directory snapshot, not all Swedish bankruptcies or a historical event register. Source retrieval dates and procedure start dates are separate facts.

The monthly view covers twelve calendar months including the partial current month. Only currently recorded cases with valid non-future start dates enter those buckets. Older starts and absent/unusable dates are shown separately. A later status change can remove a case from the view; year-over-year changes and national incidence rates cannot be calculated from this source. Group shares use all profiles within the same directory group as their denominator, across all start dates. Missing industry/municipality data is not inferred. Employee figures describe the latest non-stale statement for the dated subset, not jobs lost or employment at bankruptcy.

`IndexRow.ss` preserves `status.since`; `sr` preserves its `SourceRef`. Both fields are optional for compatibility with previous index state. Old rows remain listable by status but appear as undated until refreshed; `im`, `up` and financial dates are never substituted. Normal incremental fetching gradually fills these fields. A full status refresh and a complete historical bankruptcy feed would be needed for national/event statistics. No paid fetch or full-register run is part of this change.

## SEO and deployment

The existing `SE_INDEXING` master switch, preview veto and synthetic-data veto are unchanged. Bankruptcy list pages require at least three real bankruptcy-status rows on that page before they can be indexable; their profile financial-quality threshold is independent. Sitemap inclusion mirrors rendered robots decisions. Thin lists remain navigable with `noindex,follow`.

Industry and municipality directories now expose all companies in pages of 200 instead of truncating at 200. Original first-page URLs are preserved. Later pages use `/2/`, `/3/`, etc., ordinary anchor links and self-canonicals, following [Google's pagination guidance](https://developers.google.com/search/docs/specialty/ecommerce/pagination-and-incremental-page-loading). Subsequent directory pages need three indexable profiles on that page to enter the sitemap. All group/list pages must be rebuilt together with hubs and sitemaps when this code is eventually deployed; existing incremental profile-only uploads cannot publish new directory routes by themselves.

Missing SNI alone no longer disqualifies an otherwise useful profile. Five nonzero reported core figures, known status, a non-stale statement and the existing publication/synthetic/global rules still apply. Existing index rows keep their stored quality decision until the corresponding profile is rebuilt, so no stale index row is promoted by changing a flag.

Sorted bankruptcy views and group summaries are cached by immutable build-array identity and as-of date using WeakMaps; cached lists retain row references rather than copies. Hub-wide financial statistics and cross-links are calculated and displayed on the first page only. Pagination controls do not allocate an array of all page numbers for every page. A local 20,000-row synthetic benchmark (10,000 bankruptcy statuses, one municipality) took 78.45 ms for initial case/group preparation, 0.60 ms for 1,000 cached lookups, and approximately 11.33 MiB of heap growth including fixture rows and site construction. These figures describe the local benchmark, not a full-register performance guarantee.

## Verification

`npm test` covers status-only selection, date boundaries, unknown/invalid dates, staff subsets, legacy rows, missing-SNI quality, sitemap thresholds and global indexing safety. `npm run test:bankruptcy:build` makes an isolated temporary project using 203 synthetic companies, builds the actual paginated routes, and checks self-canonicals, ordinary navigation links, profile links and the synthetic indexing veto. It leaves the temporary HTML output for inspection and never calls the company API or deploys anything.
