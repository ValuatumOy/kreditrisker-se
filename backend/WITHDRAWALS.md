# Basic-report withdrawal handling

This flow covers single `se_credit_risk` orders. AI reports and bundles are not
covered and must remain unavailable until they have their own reviewed flow.
It preserves the consumer's withdrawal right; it does not claim that delivering
a PDF removes that right. The purchase terms and their durable confirmation
still need legal/product review before launch.

## Order reference

The verified Stripe webhook creates a Basic order as `CONFIRMING`. The poller
sends the buyer the order reference, actual Stripe total and currency, reservation
wording, seller contact, accepted terms version and withdrawal link. Only after
SES accepts that email and the acceptance is recorded does a conditional write
claim `GENERATING`. A crash or unknown generation-submission result never causes
an automatic second job: a jobless claim is released by the existing timeout
path. This favors an uncharged failed order over duplicate paid generation.

The report email also displays the reference. New Basic Checkout success URLs
and withdrawal links carry no order/session reference; the buyer copies it from
the email into the form. The return page directs the buyer to that email. If the confirmation cannot be accepted
before the generation deadline, generation does not start and the authorization
is released. SES acceptance is not proof of inbox delivery; adverse-event alerts
still require a confirmed, monitored SNS subscription.

The order email includes a copyable/printable withdrawal form with seller name,
postal address and email prefilled, the purchased product and order reference,
and fields for purchase/receipt dates, buyer names/addresses, optional contact,
paper signatures and date. Its fields follow the [Konsumentverket model](https://publikationer.konsumentverket.se/mallar-och-blanketter/angerblankett).
This does not approve the remaining purchase terms or determine a delivery promise.

These new confirmations, receipts and the copyable withdrawal form identify the
report by `params.companyCode`, the same organisation number passed to the report
engine. They do not present the browser-supplied company name as verified. The
older report-attachment email still uses that display name; resolving it against
an authoritative name source remains separate work.

## Payment data validation

Single-report webhooks require a nonnegative integer Stripe total and a valid
PaymentIntent reference. Only a zero total together with Stripe's explicit
`no_payment_required` status may omit that reference. The status is stored on the
order. Invalid facts return HTTP 503 before any order claim or generation, so
Stripe can retry; `WebhookPaymentReviewAlarm` notifies the existing SNS topic.
The alert subscription must be confirmed and monitored before launch.

The same validation runs before Basic submission, processing, delivery and
failure settlement. Capture must be confirmed as `succeeded`, cancellation as
`canceled`; an ambiguous response is reconciled from Stripe. A persisted order
with missing payment facts stays in its existing `CONFIRMING`/`GENERATING` queue
and emits `poller: order error` every tick, activating the existing alarm. It is
not marked failed or authorization-released and it does not start or deliver a
report. An operator must reconcile the signed Checkout session and PaymentIntent
in Stripe and repair the verified facts; never invent a missing total or treat
an absent reference as proof of a free payment. Historical zero-total orders
without stored `paymentStatus` also require that verification. Withdrawals with
incomplete payment facts stay `PENDING` and retain their error until reconciled.

New Basic redirects do not expose the session reference in the original HTTP
request, browser history or referrer URL. Legacy URLs and the unchanged AI/package
flows may still contain `session_id`; the page removes that query before Analytics
runs, but cannot undo an earlier HTTP request or a log already written. The CDK
site source does not enable standard CloudFront access logging, and sets
`strict-origin-when-cross-origin`; the deployed or externally configured logging
was not checked here. Keep operational order logs and mailbox access restricted:
references are intentionally retained internally to trace payment/delivery issues.

## Request and payment races

`/angra-kop/` asks for the reference and the checkout email, then asks the buyer
to explicitly confirm withdrawal and email as the receipt medium. The selected
medium is saved with the request. `POST /api/withdrawal` verifies both against
the stored Basic order. Its high-entropy Stripe reference is a bearer credential;
do not put it in analytics, public screenshots or public support posts. The route
has an API-wide rate limit of 2 requests/second, burst 4; this is not a per-IP limit.

The order's first request ID, server reception time and `withdrawalState=PENDING`
are written atomically. Repeats return the same reference and time. The main
fulfillment status is not removed from its queue. A dedicated `WithdrawalIndex`
keeps the request visible even after the order becomes `WITHDRAWN`, `FULFILLED`
or `FAILED`.

Before capturing a Basic payment, the poller conditionally claims delivery only
when no withdrawal exists. If the request wins, there is no capture. If delivery
wins, a request may arrive while Stripe is capturing or email is sending; neither
DynamoDB nor the report engine can make that external operation atomic. The
request is retained, and the worker reads Stripe's actual state:

- `canceled`: authorization released.
- `succeeded`: `REFUND_REQUIRED`; no automatic refund is claimed or attempted.
- another state or an unknown response: keep `PENDING`, record the error and retry.

A lost cancellation response is reconciled by retrieving the PaymentIntent.
An error never becomes an assumed successful cancellation. The final fulfillment
write cannot overwrite a withdrawal request. The report engine has no cancellation
API, so a report already submitted may finish after withdrawal; payment handling
remains independent.

## Receipts and operations

The request endpoint attempts a customer receipt immediately after durable
storage. If sending fails, the browser still gets the saved request reference and
time, and the scheduled worker retries. Customer and internal receipts have
separate attempted/accepted/error fields. SES acceptance immediately before a
crash can cause a duplicate receipt with the same request reference.

After payment state and both receipt acceptances are recorded, the request is:

- `CLOSED` when the hold was released or the total was zero;
- `REVIEW_REQUIRED` when an already charged payment needs a human refund review.

Before sales open, assign an owner for the internal mailbox and CloudWatch/SNS
alerts. The owner must query `WithdrawalIndex` for `REVIEW_REQUIRED` requests,
check the real Stripe payment and existing refunds, and issue the required refund
within the applicable consumer deadline. Do not refund twice after an ambiguous
Stripe response. Record the confirmed refund ID, resolution time and operator on
the order, then change `withdrawalState` to `RESOLVED`; retain the request history.
The poller emits the manual-refund metric every tick while a `REVIEW_REQUIRED`
row remains, so its alarm remains active. This code does not make or verify that
manual refund, and the flow is not operationally complete without that owner.

`withdrawal: processing error` and `withdrawal: manual refund required` have SNS
alarms. A later bounce or complaint remains covered by the existing SES adverse
event topic with the order reference in message tags.

## Local verification

`npm test` in `backend/` includes network-blocked flow tests for confirmation,
duplicate webhooks, withdrawal before generation and before capture, capture
winning the race, lost/failed Stripe cancellation responses, and independent
receipt retries. Dynamo tests check the conditional writes and persistent queue.
The CDK test checks the route, index, rate limit and manual-refund alarm. These
tests do not establish real Stripe/AWS delivery, actual IAM behavior, legal
completeness of the purchase terms, or an operator's refund response time.
