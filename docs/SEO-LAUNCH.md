# Search and measurement before launch

## Opening indexing while existing profiles are refreshed

The production indexing decision has been made. `SE_INDEXING=1` opens robots.txt
and gives eligible pages `index,follow`. The CloudFront production indexing
context removes the site-wide `X-Robots-Tag`; the analytics frame remains
`noindex`. Pages with an individual quality or privacy exclusion remain noindex.

Existing company HTML was built with the old noindex setting and does not change
when these switches are flipped. The production job uses
`SE_COMPANY_SITEMAP=verified`: old rows without `sm: true` stay outside the
company sitemap. Each normal batch clears eligibility for selected companies,
including failed fetches. After building, `scripts/company-sitemaps.ts` checks
distinct company rows and each rendered profile's actual canonical and robots
meta, then grants eligibility only to verified `index,follow` HTML. Untouched
eligible rows stay eligible across runs; noindex pages and removals are excluded.

Deployment first withdraws affected URLs (including obsolete sitemap shards),
waits for the sitemap cache invalidation, and saves a conservative checkpoint
of the previous index with those eligibility flags cleared. It then uploads
targets and deletes removals, waits for the HTML cache invalidation, publishes
the final sitemap segments before the sitemap index, and saves the final state.
A failure can temporarily reduce sitemap coverage; the next run cannot restore
eligibility for HTML that was not verified and uploaded. `SE_COMPANY_SITEMAP=0`
still disables company sitemaps completely. Unset/default mode retains the full
release behavior for local and complete-release builds.
Changing the settings alone does not cause Google to crawl or index a page.

This checklist complements `LAUNCH-GATES.md`; it does not approve indexing, a
credit model, payments or production deployment. Run it against a complete
build, not an incremental `SE_BUILD_ONLY` build.

## Verify a build

For the normal synthetic or pre-launch build:

```sh
npm run build
npm run seo:audit -- --mode blocked
npm run seo:audit:test
npm run test:schema
```

After the launch gates are cleared and a complete real-data candidate has been
built with the approved settings, check that candidate without deploying it:

```sh
npm run seo:audit -- --dir dist --mode indexable
```

Add `--origin https://example.se` if the build uses a different canonical origin.
The audit checks built HTML, metadata, canonical and Open Graph URLs, JSON-LD,
internal links, robots.txt and sitemap locations. It also checks that every
listed sitemap URL is a built, indexable canonical page. Blocked builds must
have `noindex` pages and empty sitemaps. It does not test HTTP status codes,
JavaScript execution, deployed redirects or Google indexing.

Before the indexing switch, also check:

- Run `npm run data:status`; verify the release and review stale, incomplete,
  removed and redirected companies. Confirm the full build uses that release.
- Check the live apex and `www` redirects, HTTPS, trailing slashes, canonical
  host, 404s and old company slugs. The HTML redirect fallback is not an HTTP
  301: verify the edge actually consumes `redirects.json`.
- Check live robots and sitemaps after deployment. A URL blocked in robots.txt
  cannot be crawled to read its `noindex` tag; a blocked URL can still appear
  in search without a snippet. Review the `/sok/` and `/bestall/` tradeoff
  deliberately when indexing is enabled.
- Verify Google Search Console and Bing Webmaster Tools ownership for the
  canonical domain; submit the sitemap only after the indexing decision.
  Search Console's generative AI report and Bing's AI Performance report may
  help monitor visibility when enough data is available. Neither measures
  revenue or guarantees mentions.

## Mass build before the indexing decision

A company page is rebuilt only when that company is in a batch, so whatever its
HTML says at the mass build stays until the next rebuild. With `SE_INDEXING=0`
alone every page is written with `noindex`, and opening the site later would mean
building every company again. `SE_HTML_FINAL=1` avoids that: each page carries
its own verdict (`index,follow` if it passes the quality threshold), while
robots.txt stays `Disallow: /` and the sitemaps stay empty.

Order, each step needing the same approval as any indexing change:

1. Deploy `KreditriskerSiteStackProd` without the `indexing` context. CloudFront
   then adds `X-Robots-Tag: noindex, nofollow` to every response. Check it with
   `curl -sI https://www.kreditrisker.se/ | grep -i x-robots-tag`.
2. Add `SE_HTML_FINAL = '1'` to the Jenkins job and run the mass build. Check a
   complete candidate with `npm run seo:audit -- --mode gated`.
3. At launch, in this order:
   1. Set `"indexing": "1"` in `aws-infra/cdk.json` and deploy the stack. Confirm
      with the same `curl` that the header is gone. robots.txt is still closed,
      so nothing is crawled yet.
   2. Set `SE_INDEXING = '1'` in the Jenkins job and run it with an ordinary
      nightly batch. That run rewrites robots.txt and the sitemaps; no company
      page outside the batch is rebuilt.

   The header must be gone before robots.txt opens, or the first crawl reads
   `noindex` on every page. A local check on 2026-11-11 built the same data
   gated and open, and the `foretag/` trees were identical.

What else is frozen into a company page until its next rebuild: title and
description, the navigation and footer links, the price in the report panel, the
related-company links, the industry comparison (it states its calculation date),
breadcrumbs and hub links (hub slugs include the SNI name), and the hashed CSS
and script file names, so old files under `/_astro/` must never be deleted from
the bucket. Decide these before the mass build. Related links and the industry
comparison are computed from the directory index: build the index for the whole
directory before rendering the first page, or early batches compare against a
partial directory.

## Privacy and conversion measurement

See `GA4-PRIVACY.md` for the isolated, consent-based measurement setup and its
maintenance checks. It reports fixed page categories and funnel steps, never
company queries, email addresses, organisation numbers or order references.
`checkout_returned` is an unverified return, not evidence of a paid order.
Verify sales in Stripe or the backend; no transaction identifiers or revenue
are sent to GA4.

Test the Basic funnel in an isolated mock or test environment: search, company
profile, report contents and exclusions, checkout validation, payment return,
failure and cancellation. Verify mobile and keyboard use. Never create a real
report merely to test the funnel.

## Editorial priorities

Use Search Console queries and actual sales questions to validate demand; the
following are topic hypotheses, not measured search volumes:

1. Company profiles: company name, organisation number, current filings and
   clear data dates. Publish only profiles that pass the existing quality gate.
2. Report page: what the Basic report contains and omits, model and comparison
   limitations, verified price and delivery, and a direct example-to-order path.
3. Guides: checking a customer before invoicing, financial statements,
   soliditet, kassalikviditet and negative equity. Link to primary Swedish
   sources and distinguish general guidance from the site's own formulas.

Do not create bulk city, industry or keyword variants without distinct useful
content. FAQ markup, `llms.txt`, a fixed word count and AI-bot access are not
guarantees of Google or AI visibility.

## Structured data

The home page identifies the `WebSite`; the about page identifies Valuatum as
the provider using its published contact details. Guides identify the same
publisher and show their actual modification dates. Guide dates are stored only
to day precision; the Article `dateModified` is omitted until a real timestamp
with timezone is known, as Google's test flags date-only values. Breadcrumbs
follow the visible navigation. Company profiles describe available registry
facts without claiming that the profile URL is the company's own website.

Google no longer shows FAQ rich results. The existing FAQ markup remains as a
description of the visible questions and answers, not a rich-result promise.
Google `ProfilePage` is for people or organizations affiliated with the site,
so it is not used for independent companies in the directory. Do not invent
author names, publication dates, product reviews, availability or prices.
The generated report is a service; Google Shopping has separate restrictions
on services, so its eligibility should not be assumed from `Product` markup.

`test:schema` compares rendered markup with visible page content and canonical
URLs. After deployment and indexing are approved, use Google's Rich Results
Test and Search Console URL Inspection on representative live pages. Local
checks do not guarantee eligibility or a rich result.

Google references: [site names](https://developers.google.com/search/docs/appearance/site-names),
[organization](https://developers.google.com/search/docs/appearance/structured-data/organization),
[articles](https://developers.google.com/search/docs/appearance/structured-data/article),
[breadcrumbs](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb),
[profile pages](https://developers.google.com/search/docs/appearance/structured-data/profile-page),
[Search updates](https://developers.google.com/search/updates) and
[Shopping restrictions](https://support.google.com/merchants/answer/6150006).
