'use strict';

// Transactional email via Amazon SES v2. Authentication is the Lambda execution
// role (no API key) — the role is granted `ses:SendEmail` on the verified
// valuatum.com identity by the CDK stack. Two messages:
//   - sendReportEmail: delivers the generated PDF to the customer as an
//     attachment, after the payment has been captured. Localized sv/en.
//   - sendAdminGenerationAlert: alerts the team when a generation job FAILED or
//     timed out (the PaymentIntent has been cancelled — no charge was made).
//
// Per the agreed scope, there is NO customer-facing failure email: on a failed
// generation we only alert the admin (the hold is released, so the customer was
// never charged).
//
// Sends carry a `sessionId` SES message tag, which SES echoes into the SNS
// adverse-event payload (`mail.tags`) — that is what lets an operator trace a
// bounce/complaint back to a DynamoDB order. SES accepting a message means it
// accepted it for processing, NOT that the recipient's server delivered it;
// delivery is observed through those SNS events, not through this return value.

const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const config = require('./config');
const { normalizeLang, reportLangName } = require('./products');

const FROM = config.fromEmail;
const ADMIN = config.adminEmail;

// Customer-facing copy, keyed by language. The site ships sv + en.
//
// `reportLanguage` names the language of the ATTACHED PDF.
const CUSTOMER_COPY = {
  sv: {
    fallbackCompany: 'ditt företag',
    fallbackLabel: 'Kreditriskrapport',
    fallbackFile: 'kreditriskrapport.pdf',
    subject: (label, company) => `${label} – ${company}`,
    heading: 'Din rapport är klar.',
    body: label =>
      `Den ${label.toLowerCase()} du beställde finns bifogad i det här mejlet som en PDF-fil. Tack för ditt köp!`,
    reportLanguage: languageName =>
      `Rapporten är skriven på ${languageName}, det språk du valde vid beställningen.`,
    remaining: count =>
      count === 1
        ? 'Du har 1 rapport kvar i paketet.'
        : `Du har ${count} rapporter kvar i paketet.`,
    reuse: 'Använd samma e-postadress nästa gång du beställer en rapport.',
    disclaimer:
      'Rapporten är avsedd för en första ekonomisk bedömning. Det slutliga kreditbeslutet och all ytterligare kontroll är alltid användarens ansvar.',
    contactPre: 'Frågor om din beställning? Skriv till',
    htmlLang: 'sv',
  },
  en: {
    fallbackCompany: 'your company',
    fallbackLabel: 'Credit risk report',
    fallbackFile: 'credit-risk-report.pdf',
    subject: (label, company) => `${label} — ${company}`,
    heading: 'Your report is ready.',
    body: label =>
      `The ${label.toLowerCase()} you ordered is attached to this email as a PDF file. Thank you for your purchase!`,
    reportLanguage: languageName =>
      `The report is written in ${languageName} — the language you selected when ordering.`,
    remaining: count =>
      count === 1
        ? 'You have 1 report left in your bundle.'
        : `You have ${count} reports left in your bundle.`,
    reuse: 'Use the same email address the next time you order a report.',
    disclaimer:
      'The report is intended for an initial financial assessment. The final credit decision and any further verification are always the user’s responsibility.',
    contactPre: 'Questions about your order? Write to',
    htmlLang: 'en',
  },
};

// Address the customer can send questions to (the sender is a no-reply address).
const CONTACT_EMAIL = config.contactEmail;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

// Summarize an AWS SDK error for the logs. Keeps the fields that identify the
// fault (error name, HTTP status, message, request id) and nothing else — the
// message body and PDF bytes must never reach CloudWatch.
function describeSesError(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  const fields = [
    error.name,
    error.$metadata?.httpStatusCode,
    error.message,
    error.$metadata?.requestId ? `requestId=${error.$metadata.requestId}` : null,
  ].filter(Boolean);
  if (fields.length) return fields.join(' ');
  try {
    return JSON.stringify(error);
  } catch (_) {
    return String(error);
  }
}

// One client per warm container. LocalStack support matches the other AWS
// clients in this backend (see dynamo.js / secrets.js).
let sesClient = null;
function client() {
  if (!sesClient) {
    const clientConfig = { region: config.region };
    if (config.awsEndpoint) clientConfig.endpoint = config.awsEndpoint;
    sesClient = new SESv2Client(clientConfig);
  }
  return sesClient;
}

// SES takes address arrays; our call sites pass a single address.
function addresses(value) {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : [value];
}

// Map the internal, provider-neutral message object onto an SES v2 SendEmail
// request. Pure — no client, no I/O — so the mapping is unit-testable.
function buildSesInput(message) {
  const attachments = (message.attachments || []).map(attachment => ({
    RawContent: attachment.content,
    FileName: attachment.filename,
    ContentType: attachment.contentType || 'application/pdf',
    ContentDisposition: 'ATTACHMENT',
    ContentTransferEncoding: 'BASE64',
  }));
  const bcc = addresses(message.bcc);

  return {
    FromEmailAddress: message.from,
    Destination: {
      ToAddresses: addresses(message.to),
      ...(bcc.length ? { BccAddresses: bcc } : {}),
    },
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: message.html, Charset: 'UTF-8' },
        },
        ...(attachments.length ? { Attachments: attachments } : {}),
      },
    },
    ...(config.sesConfigurationSet ? { ConfigurationSetName: config.sesConfigurationSet } : {}),
    // Correlates SNS bounce/complaint/reject events with the order. Only
    // the Stripe session id — never customer email, company name, or other
    // personal data, since tag values ride along in every event payload.
    ...(message.sessionId ? { EmailTags: [{ Name: 'sessionId', Value: message.sessionId }] } : {}),
  };
}

async function sendEmail(message, label) {
  let response;
  try {
    response = await client().send(new SendEmailCommand(buildSesInput(message)));
  } catch (err) {
    // Thrown, not swallowed: the poller relies on a synchronous send failure to
    // leave the order un-fulfilled and retry it on a later tick.
    throw new Error(`SES ${label} failed: ${describeSesError(err)}`);
  }

  console.log(`SES ${label} accepted`, {
    messageId: response?.MessageId || null,
    to: message.to,
  });
  return response;
}

// ── Customer: deliver the generated PDF ──────────────────────────────────────
async function sendReportEmail(
  toEmail,
  { companyName, pdfBuffer, fileName, productName, lang, reportLang, sessionId, remainingReports }
) {
  const language = normalizeLang(lang);
  const copy = CUSTOMER_COPY[language];
  const company = companyName || copy.fallbackCompany;
  const label = productName || copy.fallbackLabel;
  // Written in `language`, but names `reportLang`.
  const reportLanguageLine = copy.reportLanguage(reportLangName(reportLang, language));
  await sendEmail(
    {
      from: FROM,
      to: toEmail,
      sessionId,
      subject: copy.subject(label, company),
      attachments: [{ filename: fileName || copy.fallbackFile, content: pdfBuffer }],
      html: `<!DOCTYPE html>
<html lang="${copy.htmlLang}">
<body style="margin:0;padding:0;background:#0d1f18;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;">
        <tr><td style="background:#132a21;border-radius:12px 12px 0 0;padding:24px 32px;">
          <p style="color:#9fd4b0;font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;margin:0 0 4px;">kreditrisker.se</p>
          <p style="color:rgba(255,255,255,.45);font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin:0;">${escapeHtml(label)}</p>
        </td></tr>
        <tr><td style="background:#fff;border:1px solid #E2E9E5;border-top:none;border-radius:0 0 12px 12px;padding:36px 32px;">
          <h1 style="font-size:22px;font-weight:400;color:#1A2420;margin:0 0 6px;">${copy.heading}</h1>
          <p style="color:#8A9590;margin:0 0 24px;font-size:14px;">${escapeHtml(company)}</p>
          <p style="font-size:14px;color:#1A2420;line-height:1.7;margin:0 0 12px;">
            ${escapeHtml(copy.body(label))}
          </p>
          <p style="font-size:14px;color:#1A2420;line-height:1.7;margin:0 0 20px;">
            ${escapeHtml(reportLanguageLine)}
          </p>
          ${sessionId ? `<p style="font-size:12px;color:#40536a;">Order: ${escapeHtml(sessionId)}</p>` : ''}
          ${Number.isInteger(remainingReports) ? `<div style="background:#f2f8ff;border:1px solid #c8def3;border-radius:8px;padding:16px;margin:0 0 20px;"><strong>${copy.remaining(remainingReports)}</strong><br><span style="font-size:13px;color:#40536a;">${copy.reuse}</span></div>` : ''}
          <div style="border-top:1px solid #E2E9E5;padding-top:20px;">
            <p style="font-size:12px;color:#8A9590;line-height:1.65;margin:0 0 10px;">
              ${copy.contactPre} <a href="mailto:${escapeHtml(CONTACT_EMAIL)}" style="color:#0768d9;text-decoration:none;">${escapeHtml(CONTACT_EMAIL)}</a>.
            </p>
            <p style="font-size:12px;color:#8A9590;line-height:1.65;margin:0;">
              ${copy.disclaimer}
            </p>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`,
    },
    'report email'
  );
}

// ── Admin: generation failed / timed out (no charge made) ────────────────────
// Internal alert — kept in English for the team.
async function sendAdminGenerationAlert(order, errorMessage, productName) {
  const label = productName || 'Credit risk report';
  const fundingMessage = order?.paymentIntentId
    ? 'The payment authorization was canceled; the customer was not charged for this order.'
    : order?.funding === 'package'
      ? 'Check the package balance and returned credit.'
      : 'Check the payment status before contacting the customer.';
  await sendEmail(
    {
      from: FROM,
      to: ADMIN,
      sessionId: order?.sessionId,
      subject: `Report order failed (${label}): ${order?.companyName || order?.sessionId || 'unknown'}`,
      html: `
      <p><strong>${escapeHtml(label)} — report order failed.</strong></p>
      <table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
        <tr><td style="color:#666;">Company</td><td><strong>${escapeHtml(order?.companyName || '—')}</strong></td></tr>
        <tr><td style="color:#666;">Company code</td><td>${escapeHtml(order?.params?.companyCode || '—')}</td></tr>
        <tr><td style="color:#666;">Report type</td><td>${escapeHtml(order?.reportType || '—')}</td></tr>
        <tr><td style="color:#666;">Customer email</td><td>${escapeHtml(order?.email || '—')}</td></tr>
        <tr><td style="color:#666;">Language</td><td>${escapeHtml(order?.lang || '—')}</td></tr>
        <tr><td style="color:#666;">Report language</td><td>${escapeHtml(order?.reportLang || order?.params?.lang || '—')}</td></tr>
        <tr><td style="color:#666;">Stripe session</td><td>${escapeHtml(order?.sessionId || '—')}</td></tr>
        <tr><td style="color:#666;">PaymentIntent</td><td>${escapeHtml(order?.paymentIntentId || '—')}</td></tr>
        <tr><td style="color:#666;">Job id</td><td>${escapeHtml(order?.jobId || '—')}</td></tr>
        <tr><td style="color:#666;">Error</td><td>${escapeHtml(errorMessage || '—')}</td></tr>
      </table>
      <p style="margin-top:16px;">${escapeHtml(fundingMessage)}
      The customer receives no automatic notification — contact them manually if needed.</p>
    `,
    },
    'admin generation alert'
  );
}

function buildCreditEventEmail(toEmail, { kind, count = 1, remainingReports }) {
  const grant = kind === 'GRANT';
  const remaining = Number.isInteger(remainingReports) ? remainingReports : null;
  const svTitle = grant ? 'Ditt rapportpaket är klart' : 'Rapporten har lagts tillbaka i ditt paket';
  const enTitle = grant ? 'Your report bundle is ready' : 'The report was returned to your bundle';
  const svBody = grant
    ? `Paketet med ${count} rapporter är kopplat till den här e-postadressen. Använd samma adress när du beställer rapporter. Inget konto behövs.`
    : 'Rapporten kunde inte tas fram, så den reserverade rapporten har lagts tillbaka i ditt paket.';
  const enBody = grant
    ? `The bundle of ${count} reports is linked to this email address. Use the same address when ordering reports. No account is required.`
    : 'The report could not be generated, so the reserved report has been returned to your bundle.';
  const balance =
    remaining === null
      ? ''
      : `<div style="background:#f2f8ff;border:1px solid #c8def3;border-radius:8px;padding:16px;margin:20px 0;"><strong>${remaining} rapporter kvar / reports left</strong></div>`;

  return {
    from: FROM,
    to: toEmail,
    subject: `${svTitle} / ${enTitle}`,
    html: `<!DOCTYPE html><html lang="sv"><body style="margin:0;padding:32px 16px;background:#eceee9;font-family:Arial,sans-serif;"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;margin:auto;background:#fff;border-radius:10px;"><tr><td style="background:#1d3d31;color:#fff;padding:22px 28px;border-radius:10px 10px 0 0;"><strong>kreditrisker.se</strong></td></tr><tr><td style="padding:28px;color:#1a2b40;"><h1 style="font-size:21px;margin:0 0 12px;">${svTitle}</h1><p style="font-size:14px;line-height:1.65;">${escapeHtml(svBody)}</p>${balance}<hr style="border:0;border-top:1px solid #d8e7f5;margin:24px 0;"><h2 style="font-size:18px;margin:0 0 12px;">${enTitle}</h2><p style="font-size:14px;line-height:1.65;">${escapeHtml(enBody)}</p><p style="font-size:12px;color:#66768a;margin-top:24px;">Questions? <a href="mailto:${escapeHtml(CONTACT_EMAIL)}">${escapeHtml(CONTACT_EMAIL)}</a></p></td></tr></table></body></html>`,
  };
}

async function sendCreditGrantEmail(toEmail, details) {
  return sendEmail(
    buildCreditEventEmail(toEmail, { ...details, kind: 'GRANT' }),
    'credit grant email'
  );
}

async function sendCreditReleaseEmail(toEmail, details) {
  return sendEmail(
    buildCreditEventEmail(toEmail, { ...details, kind: 'RELEASE' }),
    'credit release email'
  );
}

function withdrawalUrl() {
  return `${config.siteUrl}/angra-kop/`;
}

function orderAmount(order) {
  if (!Number.isSafeInteger(order.amountTotal) || !/^[a-z]{3}$/i.test(order.currency || '')) {
    throw new Error('Order confirmation requires the Stripe total and currency');
  }
  return new Intl.NumberFormat('sv-SE', { style: 'currency', currency: order.currency.toUpperCase() }).format(order.amountTotal / 100);
}

async function sendOrderReceivedEmail(order, productName) {
  const companyCode = reportCompanyCode(order);
  await sendEmail({
    from: FROM, to: order.email, sessionId: order.sessionId,
    subject: `Din beställning – ${companyCode}`,
    html: `<!doctype html><html lang="sv"><body>
      <h1>Vi har tagit emot din beställning</h1>
      <p>${escapeHtml(productName)} · Organisationsnummer: ${escapeHtml(companyCode)}</p>
      <p>Order: ${escapeHtml(order.sessionId)}</p>
      <p>Totalt inklusive moms: ${escapeHtml(orderAmount(order))}. ${order.amountTotal === 0 ? 'Ingen betalning krävs.' : 'Beloppet reserveras och dras först när rapporten är klar.'}</p>
      <p>Rapporten tas fram automatiskt och skickas som PDF till denna e-postadress.${order.amountTotal > 0 ? ' Om den inte kan tas fram släpps reservationen.' : ''}</p>
      <p>Som konsument behåller du din ångerrätt i 14 dagar. Du kan meddela att du ångrar köpet via <a href="${escapeHtml(withdrawalUrl())}">Ångra köp</a> eller genom att skriva till ${escapeHtml(CONTACT_EMAIL)}. Ange ordernumret och samma e-postadress som vid köpet.</p>
      <p>Accepterad villkorsversion: ${escapeHtml(order.acceptedTermsVersion || '')}.</p>
      <p>Valuatum Oy, FO-nummer 1612398-8<br>Linnanrakentajantie 6–8 C, Suite 15, 00880 Helsinki, Finland<br>${escapeHtml(CONTACT_EMAIL)}<br>+358 45 123 0308</p>
      <h2>Ångerblankett</h2>
      <p>Du kan använda blanketten nedan genom att kopiera och fylla i den i ett mejl eller skriva ut den. Du kan också använda ångerfunktionen ovan; blanketten är inte obligatorisk.</p>
      <pre style="white-space:pre-wrap;font:inherit;line-height:1.5;">Företag: Valuatum Oy
Postadress: Linnanrakentajantie 6–8 C, Suite 15, 00880 Helsinki, Finland
E-post till företaget: ${escapeHtml(CONTACT_EMAIL)}

Jag vill härmed frånträda avtalet för följande tjänst:
Kreditriskrapport, organisationsnummer: ${escapeHtml(companyCode)}
Ordernummer: ${escapeHtml(order.sessionId)}

Datum då tjänsten beställdes: ____________________
Datum då tjänsten mottogs: ____________________
Köparens/köparnas namn: ____________________
Köparens/köparnas postadress: ____________________
Kontaktuppgift, e-post eller telefon (frivilligt): ____________________
Namnteckning från köparen/köparna (endast på papper): ____________________
Dagens datum: ____________________</pre>
    </body></html>`,
  }, 'order confirmation');
}

async function sendWithdrawalReceipt(order) {
  const companyCode = reportCompanyCode(order);
  await sendEmail({
    from: FROM, to: order.email, sessionId: order.sessionId,
    subject: `Vi har tagit emot din begäran om att ångra köpet`,
    html: `<!doctype html><html lang="sv"><body><h1>Din begäran är registrerad</h1>
      <p>Order: ${escapeHtml(order.sessionId)}</p>
      <p>Produkt: Kreditriskrapport · Organisationsnummer: ${escapeHtml(companyCode)}</p>
      <p>Mottagen: ${escapeHtml(order.withdrawalRequestedAt)}</p>
      <p>Referens: ${escapeHtml(order.withdrawalRequestId)}</p>
      <p>Det här är en bekräftelse på att vi har tagit emot din begäran. En eventuell återbetalning är inte genomförd genom denna bekräftelse. Vi kontrollerar betalningen och hanterar eventuell återbetalning separat.</p>
      <p>Valuatum Oy · ${escapeHtml(CONTACT_EMAIL)} · +358 45 123 0308</p>
    </body></html>`,
  }, 'withdrawal receipt');
}

async function sendWithdrawalAdminAlert(order) {
  const companyCode = reportCompanyCode(order);
  await sendEmail({
    from: FROM, to: ADMIN, sessionId: order.sessionId,
    subject: `Withdrawal ${order.withdrawalPaymentResolution}: ${order.sessionId}`,
    html: `<h1>Report withdrawal requires review</h1>
      <p>Order: ${escapeHtml(order.sessionId)}</p>
      <p>Customer: ${escapeHtml(order.email)}</p>
      <p>Organisation number: ${escapeHtml(companyCode)}</p>
      <p>PaymentIntent: ${escapeHtml(order.paymentIntentId || '')}</p>
      <p>Received: ${escapeHtml(order.withdrawalRequestedAt)}</p>
      <p>Payment resolution: ${escapeHtml(order.withdrawalPaymentResolution)}</p>
      <p>${order.withdrawalPaymentResolution === 'REFUND_REQUIRED'
        ? 'The customer has been charged. No refund has been issued automatically. Review and refund the payment in Stripe within the applicable deadline; record the refund reference and close the REVIEW_REQUIRED item only after verifying the outcome.'
        : 'The authorization was released or no payment was required. Verify the request and contact the customer if further action is needed.'}</p>`,
  }, 'withdrawal admin alert');
}

function reportCompanyCode(order) {
  const code = order.params?.companyCode;
  if (typeof code !== 'string' || !code.trim()) throw new Error('Report company code is required for the order receipt');
  return code;
}

module.exports = {
  buildCreditEventEmail,
  sendReportEmail,
  sendCreditGrantEmail,
  sendCreditReleaseEmail,
  sendAdminGenerationAlert,
  sendOrderReceivedEmail,
  sendWithdrawalReceipt,
  sendWithdrawalAdminAlert,
};
