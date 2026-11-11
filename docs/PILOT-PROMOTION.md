# Pilot promotion preparation — offline only

The 16,000-company pilot is **not authorized to run**. Do not fetch, render, publish, invoke Jenkins or deploy while preparing this change. The commands below describe later, separately authorized work. No command in `scripts/release-plan.ts` accesses AWS, the company API, Jenkins or a network service. It reads local files and writes a new local directory only.

**There is no production promotion controller. `promotionAllowed` is always `false`.** A generated package is review material, not approval to upload it. Do not pass it to the legacy Jenkins deployment, and never use `sync --delete` with its incremental overlay.

## What preparation verifies

After generation has been separately approved and the candidate completed, the tool can prepare a reviewable release against a separately captured complete production snapshot. It:

- Revalidates every candidate checkpoint and restages it with the existing HTML, canonical, robots, redirects and exact selected-only sitemap guards. The supplied stage must equal that verified restage byte for byte.
- Requires the captured index to match the frozen candidate seed. JSONL serialization and line endings are normalized for this comparison; the exact original captured index bytes are also pinned for drift detection and rollback. A completed candidate cannot be rebased onto newer live state.
- Requires a complete versioned site inventory, matching local bytes for every key, full raw object metadata, the versioned index, the current sitemap-policy object or its confirmed absence, resolved search image digest and Lambda revision, and CloudFront distribution identity.
- Preserves every nonselected `foretag/` key, including redirects. Candidate renders include directory-wide orgnr redirects: those nonselected files are explicitly excluded from the prepared overlay. All existing asset keys are retained; overwriting an existing asset with different bytes is refused.
- Retires old numbered company sitemap parts absent from the candidate by replacing them with an empty valid sitemap. They remain discoverable independently of `sitemap-index.xml`, so merely removing them from the index is insufficient.
- Copies and rehashes the entire site capture, index, metadata and existing policy into a local backup. Records forward phases, every overwritten and new key, the old index version and search digest, and the exact selected-only policy proposed for normal builds.

These are local consistency checks. A hand-edited capture is not signed provenance or proof of current production. Search digest pinning proves which image was captured; it does not establish its database contents. A missing verified search/index binding is an explicit additional blocker.

## Offline capture contract

Capture production only after separate authorization. Do not create a pretend capture from an index list or from the candidate's `dist`. The source must contain **all** live site objects, including historical HTML, old slugs, redirects, fonts, images and assets. Obtain a stable versioned object listing while all production writers are excluded. Retrieve exact object versions and raw `HeadObject` metadata; preserve tags/ACL/encryption/retention details where applicable. Exclude S3 delete markers from the live inventory but retain their history in the external backup. Listing and metadata must be complete and paginated. No capture/acquisition command is provided or run by this tool.

Required directory:

```text
capture/
  capture.json
  index.jsonl                 exact current production index bytes
  sitemap-policy.json        only when a policy object already exists
  site/                      every current site key as a regular local file
```

`capture.json` has the following shape. The sample names and hashes are placeholders, not actual resources:

```json
{
  "version": 1,
  "capturedAt": "2026-11-11T12:00:00.000Z",
  "complete": true,
  "site": {
    "bucket": "example-site",
    "versioning": "Enabled",
    "objects": {
      "index.html": {
        "sha256": "<sha256 of exact bytes>",
        "bytes": 123,
        "versionId": "<immutable S3 VersionId>",
        "head": { "ContentType": "text/html", "CacheControl": "<captured value>" }
      }
    }
  },
  "state": {
    "uri": "s3://example-state/index.jsonl",
    "versioning": "Enabled",
    "versionId": "<immutable S3 VersionId>",
    "sha256": "<sha256 of exact index.jsonl bytes>",
    "head": { "ContentType": "application/x-ndjson" }
  },
  "policy": {
    "uri": "s3://example-state/sitemap-policy.json",
    "versionId": null,
    "sha256": null
  },
  "search": {
    "function": "example-search",
    "imageUri": "example.invalid/search@sha256:<64 hex digits>",
    "revisionId": "<Lambda RevisionId>",
    "indexSha256": null
  },
  "distributionId": "EXAMPLE"
}
```

Use the complete raw HeadObject response rather than just the sample fields. If a sitemap policy exists, supply its exact bytes plus version and SHA-256. Null policy version/hash asserts that no policy object currently exists and must be rechecked under the release lock. `search.indexSha256` may be set only after independently verifying the captured image's database against the exact captured index. Current search images have no automatic index binding; use null until this is proven. Local files must have unambiguous ASCII website keys; symlinks, junctions, nonregular entries and case collisions are rejected. The tool intentionally refuses unversioned site/index snapshots; enabling versioning later does not version pre-existing null-version objects, so those must receive separately verified immutable backups first.

## Prepare and verify locally

Use a clean dedicated checkout at the same revision and exact Node version as the candidate plan. All directories must be outside the repository. The destination must be new, disjoint from the inputs, and have an existing parent. These commands do not fetch or render company data; restaging only copies existing validated output:

```sh
node scripts/release-plan.ts prepare --plan /private/pilot-plan --stage /private/pilot-ready --capture /private/production-capture --out /private/pilot-release-review
node scripts/release-plan.ts verify --release /private/pilot-release-review
```

The package contains `release.json` and its checksum, the full local `backup/`, the verified `restaged/` tree, a filtered `overlay/`, `next-index.jsonl` and `next-sitemap-policy.json`. Review the preserved key counts against the captured real company inventory (about 857 currently expected), excluded nonselected redirects, changed/new keys, retired sitemap parts and every blocker. Do not interpret a company-key count as a company count: a company may have multiple pages and redirects. Preparation needs disk for the complete backup, restage and overlay. On failure the private temporary directory is retained for diagnosis and no ready destination is created. Package checksums detect accidental changes; they do not prevent deliberate manifest rewriting.

## Required production implementation before approval

Actual publication remains blocked until all of the following have been implemented, deployed separately and exercised against synthetic infrastructure. The current normal Jenkins pipeline does not meet these conditions. Disabling its schedule alone is insufficient because manual builds can still write.

1. **One shared release lock and durable recovery journal.** Every writer, including normal Jenkins, must acquire the same distributed lock *before reading index/policy/site state* and retain exclusive ownership until search, sitemap, invalidation and verification finish. Persist a unique release identity, fencing/ownership token, baseline versions, every intended operation, resulting versions, old/new search digests and phase checkpoints. No time-based lock takeover may permit a paused older writer to continue. If fencing cannot be enforced at all storage/Lambda writes, use a nonexpiring lock and manual recovery with confirmed termination of the previous owner. A crash must leave the lock held and normal jobs blocked until the release is resumed or rolled back. Jenkins `disableConcurrentBuilds` does not serialize other jobs or external tools.
2. **Durable selected-only sitemap policy in normal Jenkins.** Read the versioned policy under that lock before fetching/building. Missing/malformed/unavailable policy after pilot activation must fail closed, with no site/index/search writes. Set `SE_COMPANY_SITEMAP=1` and build the sitemap allowlist file from persisted selected orgnrs; never fall back to all index `ix` rows or to `SE_COMPANY_SITEMAP=0`. Read/validate it again before publication. Normal batches may update a selected company's sitemap entry only after publishing and checking its corresponding new eligible HTML. Nonselected legacy profiles remain outside the sitemap even when seed `ix` is true. Policy/index updates must be journaled and recoverable together. Test empty batches, no selected changes, selected quality loss, source removals, failed fetches and interrupted deploys. Until this writer migration is complete, leave production's existing sitemap hold in force and do not promote the pilot.
3. **A real complete backup.** Under the lock recheck every current site version/key, exact index, policy and search digest/revision against the frozen baseline. Any added/deleted/changed object or changed search/index/policy aborts without publishing; create a new plan from a fresh source capture. Persist immutable backups outside the served site bucket/prefix for all site keys plus exact index/policy state and metadata, and verify bytes and restore access. Keep the old search digest from ECR lifecycle deletion for the entire rollback window; `:latest` is not a backup. The local copy does not make cloud backups or guarantee that old S3/ECR versions will remain available.
4. **Resumable publication in the recorded order.** Upload assets, then selected pages and redirects, then global pages. Verify resulting object bytes and selected HTML before writing index/search/policy. Deploy the prepared search image bound to the final index using the captured Lambda RevisionId for conflict detection; wait for completion and verify search health/data. Only then write sitemap parts (including retired empty parts), and publish `sitemap-index.xml` last. Persist each successful object VersionId and Lambda revision in the journal. Always revalidate read-after-write results; do not repeat an ambiguous write until its result is reconciled. No forward deletion or `sync --delete` is permitted. Do not use recursive legacy deployment, which has a different order and deletes hub prefixes.
5. **CloudFront and public verification.** Invalidate affected company paths, sitemap parts/index, globals and search (a full `/*` invalidation is acceptable for the pilot), record the invalidation id, wait for completion, and check public canonical/robots/sitemap/page coherence and representative search results. Do not mark complete or release the lock on invalidation/verification failure. Browser/CloudFront caches and object-by-object S3 publication mean there is no atomic public cutover; decide whether a maintenance/traffic gate or versioned origin release is required before accepting that transition window.
6. **Complete rollback and interruption tests.** While holding the same lock, first hide company sitemaps and invalidate/wait to reduce exposure while restoring. Restore every overwritten object from its immutable baseline version/backup; remove only keys recorded as newly created by this release after confirming their current version/hash belongs to this release. Restore exact index bytes/version metadata, the original search digest and prior policy (or its absence), then restore original sitemap parts/index and invalidate `/*`, wait and verify. A partial rollback stays locked and journaled. Test crashes before/after every write, an ambiguous write response, invalidation failure, search failure, externally changed keys, new keys, multiple overwritten versions and writer conflict. Restoring just `index.jsonl` or the old search image is insufficient.

The local tests demonstrate inventory preservation, seed/search drift refusal, exact stage verification, obsolete sitemap retirement, and a complete *planned* rollback of new and overwritten keys. They do not demonstrate an AWS backup, a distributed lock, a real S3/Lambda/CloudFront release, public indexing or 16,000-company production capacity.
