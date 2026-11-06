# GA4 privacy and funnel measurement

The Swedish site uses GA4 property `kreditrisker.se` (measurement ID
`G-10WF1WRH4W`), separate from the Finnish site. The Google tag loads only after
the visitor accepts statistics cookies. Rejection or withdrawal removes the
frame, clears its analytics cookies and stops further measurement.

The tag runs in an isolated frame at `https://kreditrisker.se/analytics-frame/`,
while the site is on `https://www.kreditrisker.se`. Keep those origins different
but on the same site: the separation prevents the tag reading the page, and
the shared site permits first-party analytics storage. The frame has no referrer
and accepts only fixed page and event categories from the canonical site.
The CloudFront frame exception applies only to that path; normal pages retain
their existing frame protection.

Page locations and titles sent to GA4 are generic categories. Referrers are
limited to known search and AI services, with no path or query. The measured
events are `page_view`, `search_started`, `checkout_submitted`,
`checkout_failed` and `checkout_returned`. The last event records a return
through the success URL, not a verified payment. Sales and revenue should be
checked in Stripe or the backend. Do not send search terms, company details,
email addresses, order identifiers or payment information to GA4.

Keep enhanced measurement, user-provided data collection and Google signals
off. The Google tag's destination setting `send_page_view` must remain
`false` so that Google does not generate an extra automatic page view; the
frame sends the safe page view itself. GA4 email and query parameter redaction
is enabled as a backstop, not a substitute for filtering. Do not add other tags
to the frame or turn on automatic form, search or URL-based collection.

Production builds set `PUBLIC_GA_TRACKING_ID` and `PUBLIC_GA_FRAME_ORIGIN` in
Jenkins. After changes to the site, tag, property or CloudFront, test in a
browser with synthetic search and order values: inspect Google network requests
for URLs, titles, referrers and events; test both consent and withdrawal; and
check that search terms and order values are absent. Also confirm that only one
page view is sent. Local tests can use different ports on the same localhost
host. No real payment or report needs to be created for these checks.
