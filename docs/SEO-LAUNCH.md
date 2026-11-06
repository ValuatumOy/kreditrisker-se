# Search and measurement before launch

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
