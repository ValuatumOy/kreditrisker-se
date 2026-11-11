# Private 16,000-company pilot preparation

This is a separate, local candidate workflow. It does not invoke Jenkins, AWS, search deployment, production state writes or publication. **Do not start the pilot until the user authorizes generation.** The commands below are an operator runbook for that later decision, not a request to execute them now.

The existing Jenkins job remains a production job with `DEPLOY=true` by default. Do not use it for this pilot. Its 10,000-row limit remains unchanged. This workflow splits a frozen selected snapshot into parts of at most 10,000 TSV rows, retaining parent/group rows together. The default is a conservative, adjustable 1,000 rows per part (16 parts for 16,000 base companies without groups), still requiring resource observation before scaling up. The 10,000 maximum is a guardrail, not a demonstrated safe render size. An explicitly requested 10,000-row split would mathematically be 10,000 + 6,000; group rows consume capacity and can require more parts. Group accounts are retained in the input but, as in the existing fetcher, do not receive separate pages.

## Inputs and plan (no API calls or page rendering)

Use a clean dedicated checkout at the reviewed commit, the same Node version throughout, and installed lockfile dependencies. Keep the plan, input snapshots and staged output outside the repository. The parent directories must already exist. No local `.env` files are accepted; pass environment variables explicitly. `public/` must contain exactly its tracked regular files; symlinks and ignored extras (including credential files) are rejected before plan/fetch/build/verify/stage. Verify and stage also require the clean current git revision to match the plan, without needing API credentials.

The following standalone command produces the list only, on the Linux `sweden-build` host with network access to the Swedish MySQL database. **Do not execute it as part of this preparation.** The output directory must already exist and be private and empty. Pick the committed binary matching the host CPU (amd64 below, arm64 when applicable):

```sh
./build/bin/get_static_params_amd64 --output-dir /private/se-snapshot --properties /private/local_server.properties --accounts 'Bolagsverket data import'
```

The properties file needs `database.server`, `database.userid`, `database.password`, and `database.sid`, with read access to the Swedish data. The existing production configuration is `s3://valu-produ/sweden/config/local_server.properties`; using that URI instead of a local file additionally requires the host's AWS credentials/role to read it. No REST API token is needed to export this list. This command queries source SQL and writes `/private/se-snapshot/staticparams.txt`; it does not call `scripts/fetch.ts`, Astro, Jenkins, or deployment. Do not chain it with those commands. Leave out `--include-updated-since` and `--fids` to obtain the full available account selection. Use this file as `--full-snapshot`; do not truncate it to the pilot size. The separate selection command below freezes the pilot subset.

Obtain and inspect that static-params TSV separately. Keep that export as the **full official snapshot**, including any of the earlier 701 rejections still present in the source. Freeze a separate selected subset for the pilot; the full list remains the basis for directory coverage. Do not derive the selection from the existing successful index: that would silently omit rejected companies. Columns are fid, slug, name, SNI, orgnr, optional save timestamp. Missing/invalid legal-person orgnr, duplicate fids, multiple base models per orgnr and orphan group models stop planning. Sole-trader and synthetic orgnrs are deliberately unsupported by this candidate planner.

Supply the full existing slim index as `--seed-index`, captured separately from the current production state. The full official list and seed must agree on directory membership; duplicate, unknown, malformed or synthetic seed rows stop preparation. Every nonselected official company must have a valid seed row, so global hubs, rankings, related links and future search state retain those companies. Missing seed rows are allowed only for companies selected for fresh fetching. No seed company is silently deleted. Resolve legitimate source deletions separately and create an explicitly reviewed new snapshot/seed rather than forcing this pilot through.

Select exactly 16,000 base companies deterministically without API calls or builds:

```sh
node scripts/candidate.ts select --full-snapshot /private/se-snapshot/staticparams.txt --seed-index /private/full-seed-index.jsonl --count 16000 --out /private/selected-staticparams.txt
```

Selection first includes **every official company missing from the seed**, including historic rejections still in the official list, then fills from indexed companies in orgnr order. It retains every parent/group TSV row belonging to each selected company; 16,000 companies can therefore mean more than 16,000 TSV rows. It rejects a requested count larger than the available companies or smaller than the number missing from the seed. This is a deterministic coverage selection, not random sampling. The selected TSV must exactly match rows in the frozen full snapshot; changed, outside or omitted parent/group rows stop planning.

In a shell with the intended production build settings explicitly set, freeze the plan:

```sh
node scripts/candidate.ts plan --full-snapshot /private/se-snapshot/staticparams.txt --snapshot /private/selected-staticparams.txt --seed-index /private/full-seed-index.jsonl --out /private/pilot-plan --batch-size 1000
```

Omit `--seed-index` only when every official company is selected and no prior slug history is needed. Planning writes the normalized full and selected snapshots, full seed, bounded batch files and checksummed manifest. Review `plan.json` company/row counts and every selected identifier against the source selection before generation. It pins git revision, exact Node version, build configuration and freshness date. Credentials are not stored. Indexing, HTML-final and preview settings are captured as supplied; this tool does not open or close launch controls. For an approved indexable pilot use the approved `SE_INDEXING=1`, `SE_PREVIEW=0`, `SE_COMPANY_SITEMAP=1` settings from the launch decision, with the approved report/checkout configuration. An indexable candidate plan refuses a missing/closed `SE_COMPANY_SITEMAP`; explicitly set it to 1 for the private full-site candidate so the temporary production setting 0 is not inherited. Keep the same settings on later commands. The API base URL defaults to the approved `https://sweden.valuatum.com`, is normalized and pinned, and must be an HTTPS origin without paths or credentials. API credentials must be supplied separately for fetching. Fetch concurrency is validated as an integer from 1 to 16 (default 8) before any API call. API model fid, base/group identity, model/register orgnr and selected orgnr must agree before figures are accepted.

## After generation is separately authorized

First fetch **one part per invocation**:

```sh
node scripts/candidate.ts fetch-next --plan /private/pilot-plan
```

Repeat manually until every planned part is fetched. This command calls the real company API; it is not a dry run. Each attempt stores its own pages, slim index, rejection/warning reports, removal report and API cache privately. A rejection, missing/duplicate/unexpected company, API orgnr mismatch, dropped index row or unexpected removal stops the part without advancing its checkpoint. No rejection can be silently skipped: resolve it and retry the same part, or explicitly agree a changed selection and create a new plan. A company intentionally outside a revised selection is not automatically removed from production by this workflow.

Only after all fetch checkpoints succeed does the final slim index become the input for **every** company render. Earlier pages are retained on disk; they are not re-fetched during rendering. The API itself is not a transactional database snapshot: source records can change between fetches, and a failed fetch retry may retrieve newer data. The frozen index represents the validated records actually fetched, with a fixed freshness evaluation date and each attempt's actual API import timestamp. Successful page records and their real import times are retained for all render retries. Fetch retries may have newer actual timestamps; the plan date never masquerades as retrieval time. A delayed run should replan with a current freshness evaluation date when the earlier date would be misleading.

Then render **one part per invocation**:

```sh
node scripts/candidate.ts build-next --plan /private/pilot-plan
```

Rendering before all fetches finish is refused. Each render receives only that part's full company records and the same final slim index, so related companies, hubs, rankings, redirects and sitemaps use full official directory coverage, preserving all nonselected seed fields except `up` when supplied by the frozen full snapshot. Output remains private. Each rendered checkpoint binds its own fetched pages, the terminal fetch receipt and final full-index checksum. Lost fetch checkpoints cannot be refetched beneath an existing render lineage; create a new plan instead. A failed render is retried from stored fetched pages without making API calls. Successful checkpoints are validated and skipped on later invocations. Changing code, Node, pinned settings or frozen files requires a new plan. Changed checkpoint data/output or a gap in the checkpoint chain stops resumption.

## Verify and stage locally

```sh
node scripts/candidate.ts verify --plan /private/pilot-plan
node scripts/candidate.ts stage --plan /private/pilot-plan --out /private/pilot-ready
```

`verify` rehashes every checkpoint/output and checks exact company/index/page coverage, canonical company paths, orgnr redirects and every selected profile's robots verdict against frozen indexing/HTML-final/preview settings and its fetched quality/synthetic verdict, including profiles intentionally outside sitemaps. `stage` verifies again, combines each selected part's company folder with the last render's global output, retains earlier content-hashed assets, and refuses conflicting asset contents. It requires the expected robots policy, exact static/hub sitemap route sets derived from the frozen full index and freshness date, and a complete `redirects.json` matching every frozen orgnr/old-slug redirect with status 301. It validates actual orgnr/old-slug redirect destinations and company canonicals, and checks every sitemap URL resolves to built HTML with `index,follow` and the matching canonical, and that company sitemap coverage exactly matches freshly built eligible **selected** rows. The private `SE_COMPANY_SITEMAP_FILE` is always set to the frozen selected TSV; retained nonselected companies remain in global index/links but cannot enter this candidate company sitemap, even if their seed `ix` is true. Thus company URLs missing HTML, legacy noindex company HTML and omitted eligible company URLs prevent a ready stage. The staged directory is an **incremental overlay**, not a complete standalone site: nonselected canonical company HTML remains only in the existing production site. Never use `sync --delete` with this overlay. Below-threshold selected profiles remain built but intentionally excluded from company sitemaps. With indexing closed, company sitemaps must remain empty. The stage command prints the final output tree SHA-256; retain this result alongside the plan for review.

The stage destination must be new and outside both the checkout and plan. A failed stage retains its private temporary directory for diagnosis and creates no ready destination. Failed fetch/render attempts also remain under `attempts/`; never treat them as checkpoints. Files can be large: keep enough space for cached records, page data copies, multiple HTML outputs and the combined stage. The 8 GB Node heap allowance is not a tested capacity guarantee. No 16,000-company real rendering, timings, disk requirement or 500,000-company capacity has been established by the synthetic tests.

A process crash may leave `plan/.lock`. Verify no candidate process is still running before manually removing that exact lock. Completed checkpoint directories must never be edited to force progress. Checksums detect accidental changes; they are not signed provenance against deliberate rewriting of manifests and receipts.

## Publication remains a separate decision

There is no publish command. This overlay is **private and not yet approved/safe to promote**: preservation of the existing nonselected HTML/assets and a complete production release/rollback procedure still require separate verification and approval. Production S3 overwrite is not atomic, and neither rollback nor an atomic release pointer is implemented here. Do not upload part outputs or use the legacy production Jenkins path to promote this candidate. Keep the temporary launch sitemap that excludes legacy company URLs until the complete staged candidate is reviewed and a separately approved promotion process can publish matching selected company HTML, the selected-only company sitemap, full directory index/search state and required launch controls. Publishing only the sitemap ahead of matching verified company HTML would expose legacy noindex pages. A staged candidate does not prove production indexing, CloudFront behavior, search deployment or public-site correctness.

## Synthetic checks used during preparation

`node --test tests/candidate.test.ts` exercises a synthetic 16,000-company plan, bounded splitting, parent/group pairing, immutable inputs, checkpoints, interrupted/rejected attempts, exact identity/coverage, full-index-before-render behavior, local staging and sitemap/noindex failures. The actual fetch script is checked with committed synthetic cached API fixtures and empty API credentials. These tests do not start a real company fetch or Astro company build.
