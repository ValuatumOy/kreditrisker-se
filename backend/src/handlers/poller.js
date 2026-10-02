'use strict';

// Poller — triggered by an EventBridge schedule (~every 1 min). For each order
// still GENERATING, checks the report-engine job and resolves the manual-capture
// PaymentIntent:
//   DONE         → download PDF, CAPTURE the PaymentIntent, email the PDF, mark FULFILLED
//   FAILED       → CANCEL the PaymentIntent (release the hold, no charge),
//                  alert admin, mark FAILED
//   PENDING/RUN  → leave it; fail + cancel past MAX_GENERATION minutes so a stuck
//                  job can't drift toward Stripe's 7-day capture window
//
// Every step is safe to re-run: the poller may revisit an order before a write
// lands. Capture/cancel swallow "already done" errors; FULFILLED is only set
// after the email is sent, so a failed email is retried next tick.

const { stripeClient } = require('../lib/stripe');
const dynamo = require('../lib/dynamo');
const { listOrdersByStatus } = dynamo;
const credits = require('../lib/credits');
const { getJob, downloadPdf } = require('../lib/reportEngine');
const { generateValuatumReport } = require('../lib/valuatumReports');
const { getProduct, localizedField, DEFAULT_REPORT_LANG } = require('../lib/products');
const emailService = require('../lib/email');
const config = require('../lib/config');

function ageMinutes(order) {
  const created = Date.parse(order.createdAt || '');
  if (!Number.isFinite(created)) return Infinity;
  return (Date.now() - created) / 60000;
}

// Capture is idempotent for our purposes: a PaymentIntent already captured (or
// no longer capturable) shouldn't fail the tick.
async function capturePaymentIntent(stripe, paymentIntentId) {
  if (!paymentIntentId) {
    console.log('capturePaymentIntent: no paymentIntentId on order, nothing to capture');
    return;
  }
  try {
    await stripe.paymentIntents.capture(paymentIntentId);
  } catch (err) {
    const msg = err?.message || '';
    if (/already been captured|already captured|cannot be captured|succeeded/i.test(msg)) {
      console.log('capturePaymentIntent: already captured', {
        paymentIntentId,
      });
      return;
    }
    throw err;
  }
}

async function cancelPaymentIntent(stripe, paymentIntentId) {
  if (!paymentIntentId) {
    console.log('cancelPaymentIntent: no paymentIntentId on order, no hold to release');
    return;
  }
  try {
    await stripe.paymentIntents.cancel(paymentIntentId);
  } catch (err) {
    // Stripe rejects a cancel only when the PI is no longer cancelable — for a
    // manual-capture hold that means it's already `canceled` or `succeeded`,
    // both terminal. `payment_intent_unexpected_state` is the wording-stable
    // signal for that; keep the message regex as a fallback.
    const msg = err?.message || '';
    if (
      err?.code === 'payment_intent_unexpected_state' ||
      /already canceled|already been canceled|cannot (be )?cancel|status of canceled|succeeded/i.test(
        msg
      )
    ) {
      console.log('cancelPaymentIntent: already settled', {
        paymentIntentId,
      });
      return;
    }
    throw err;
  }
}

function packageSettlementInput(order, orderAttrs, occurredAt) {
  const email = order.creditKey?.email;
  const reportType = order.creditKey?.reportType;
  if (!email || !reportType) {
    throw new Error('Package-funded order is missing its creditKey');
  }
  return {
    email,
    reportType,
    sessionId: order.sessionId,
    companyName: order.companyName,
    occurredAt,
    orderAttrs,
  };
}

async function settleFunding(order, attrs = {}, occurredAt = new Date().toISOString()) {
  const orderAttrs = { ...attrs, status: 'FULFILLED' };
  if (order.funding === 'package') {
    return credits.consume(packageSettlementInput(order, orderAttrs, occurredAt));
  }
  return dynamo.updateOrder(order.sessionId, orderAttrs);
}

async function releaseFunding(order, reason, occurredAt = new Date().toISOString()) {
  const orderAttrs = { status: 'FAILED', error: reason };
  if (order.funding === 'package') {
    return credits.release(packageSettlementInput(order, orderAttrs, occurredAt));
  }
  return dynamo.updateOrder(order.sessionId, orderAttrs);
}

async function unspentAfterDelivery(order) {
  if (order.funding !== 'package') return undefined;
  try {
    const balance = await credits.getBalance(order.creditKey.email, order.creditKey.reportType);
    return Math.max(0, credits.unspentReports(balance) - 1);
  } catch (err) {
    console.error('poller: balance read failed; omitting remaining report count', {
      sessionId: order.sessionId,
      error: err.message,
    });
    return undefined;
  }
}

// Build the PDF filename from the company name: NFKD splits accented letters
// into base + combining mark (æ/ø/å and other diacritics), which we then strip,
// so Danish/diacritic characters fold to their plain ASCII form. Any remaining
// non-alphanumerics collapse to single hyphens.
//   "JYSK A/S" → "jysk-a-s.pdf"
function reportFileName(companyName) {
  const slug = (companyName || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'credit-risk-report'}.pdf`;
}

async function deliver(stripe, order, pdfBuffer) {
  if (order.paymentIntentId) {
    await capturePaymentIntent(stripe, order.paymentIntentId);
  }
  const product = getProduct(order.reportType);
  await emailService.sendReportEmail(order.email, {
    companyName: order.companyName,
    pdfBuffer,
    fileName: reportFileName(order.companyName),
    productName: localizedField(product?.name, order.lang),
    lang: order.lang,
    reportLang: order.reportLang || order.params?.lang,
    remainingReports: await unspentAfterDelivery(order),
    // Tags the send so an SES bounce/complaint event names the order.
    sessionId: order.sessionId,
  });
  await settleFunding(order);
}

async function fulfill(stripe, order, job) {
  // Re-mint the URL implicitly by using the just-fetched job's s3Url.
  const pdfBuffer = await downloadPdf(job.s3Url);
  await deliver(stripe, order, pdfBuffer);
  console.log('poller: fulfilled', {
    sessionId: order.sessionId,
    jobId: order.jobId,
  });
}

async function fail(stripe, order, reason) {
  await cancelPaymentIntent(stripe, order.paymentIntentId);
  const settlement = await releaseFunding(order, reason);
  // Best-effort: a failed admin alert (e.g. SES identity not verified) must
  // not keep the order GENERATING and re-loop the poller every tick. The hold
  // is already released above, so marking the order terminal is the priority.
  try {
    await emailService.sendAdminGenerationAlert(
      order,
      reason,
      localizedField(getProduct(order.reportType)?.name, 'en'),
      settlement?.status
    );
  } catch (err) {
    console.error('poller: admin alert failed (marking order FAILED anyway)', {
      sessionId: order.sessionId,
      error: err.message,
    });
  }
  console.warn('poller: failed', { sessionId: order.sessionId, reason });
}

// Synchronous-REST products (the basic se_credit_risk report): the webhook
// claimed the order without a job, so we generate the PDF here in one call via
// the authenticated Valuatum REST endpoint. A thrown error leaves the order
// GENERATING for the next tick; the age guard below releases the hold if it
// never succeeds within the budget.
async function processRestOrder(stripe, order, product) {
  if (ageMinutes(order) > config.maxGenerationMinutes) {
    await fail(
      stripe,
      order,
      `Report generation timed out after ${config.maxGenerationMinutes} min.`
    );
    return;
  }
  const pdfBuffer = await generateValuatumReport({
    reportName: order.params?.reportName || product.reportName,
    fid: order.params?.fid,
    // Report content language — the buyer's choice, written by
    // buildReportParams(). Never falls back to order.lang: that is the
    // Stripe/email language and is independent of the PDF's language.
    lang: order.params?.lang || DEFAULT_REPORT_LANG,
    currency: order.params?.currency || product.reportCurrency,
  });
  await deliver(stripe, order, pdfBuffer);
  console.log('poller: fulfilled (rest)', {
    sessionId: order.sessionId,
    reportType: order.reportType,
  });
}

async function processOrder(stripe, order) {
  const product = getProduct(order.reportType);
  if (product?.generator === 'valuatumRest') {
    await processRestOrder(stripe, order, product);
    return;
  }

  // Claimed by the webhook but no jobId recorded yet.
  if (!order.jobId) {
    if (ageMinutes(order) < config.claimGraceMinutes) return; // submit may be in flight
    await fail(stripe, order, 'Job submission did not complete (no jobId recorded).');
    return;
  }

  const job = await getJob(order.jobId);

  if (job.status === 'DONE') {
    if (!job.s3Url) throw new Error('job DONE but no s3Url');
    await fulfill(stripe, order, job);
  } else if (job.status === 'FAILED') {
    await fail(stripe, order, `Generation failed: ${job.error || 'unknown error'}`);
  } else if (ageMinutes(order) > config.maxGenerationMinutes) {
    await fail(
      stripe,
      order,
      `Generation timed out after ${config.maxGenerationMinutes} min (status ${job.status}).`
    );
  }
  // else PENDING/RUNNING within budget → leave for the next tick.
}

exports.handler = async () => {
  const stripe = await stripeClient();
  const orders = await listOrdersByStatus('GENERATING');
  console.log('poller: tick', { count: orders.length });

  for (const order of orders) {
    try {
      await processOrder(stripe, order);
    } catch (err) {
      console.error('poller: order error', {
        sessionId: order.sessionId,
        error: err.message,
      });
    }
  }

  return { ok: true, processed: orders.length };
};

exports.settleFunding = settleFunding;
exports.releaseFunding = releaseFunding;
exports.deliver = deliver;
exports.fail = fail;
