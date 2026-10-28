'use strict';

// Server-side product catalog. Price and line-item label are derived from
// `reportType` here — NEVER trusted from the client. The flow is parameterized
// by report type so future report products reuse the same checkout + webhook +
// poller: add an entry here, no fork of the flow.
//
// `generator` selects how the PDF is produced:
//   - 'reportEngine'  → async job submitted to the Lambda report engine, then
//                       polled to completion (docs/report_generation_api.md).
//   - 'valuatumRest'  → synchronous GET to the authenticated Valuatum REST
//                       /reports endpoint (Bearer token), which returns the
//                       finished PDF in one call. No job/poll. Same mechanism
//                       the FI directory uses. See valuatumReports.js.

// `lang` — the BUYER's language: Stripe line item, receipt, delivery email.
const SUPPORTED_LANGS = ['sv', 'en'];
const DEFAULT_LANG = 'sv';

const SUPPORTED_REPORT_LANGS = ['sv', 'en'];
const DEFAULT_REPORT_LANG = 'sv';

const REPORT_LANG_NAMES = {
  sv: { sv: 'svenska', en: 'engelska' },
  en: { sv: 'Swedish', en: 'English' },
};

const REPORT_LANG_DISCLOSURE = {
  sv: 'Rapportens språk',
  en: 'Report language',
};

const REST_LANG_CODES = { sv: 'sv', en: 'en' };
const PRICE_TARGETS = require('./report-price-targets.json');

// Swedish catalog. A product is sold only once it has a Stripe product id
// (the allowed Stripe price must also match the approved target) - see getProduct().
//
// Both reports are rendered by the report engine under the `Sweden` customer
// (aspQueryKey), whose secret points at sweden.valuatum.com. Until there are
// enough Swedish companies for models and statistics of their own, Finnish
// credit-model outputs are omitted. Industry comparisons use Finnish companies.
const PRODUCTS = {
  se_ai_credit_risk: {
    stripeProductId: process.env.STRIPE_PRODUCT_SE_AI || '',
    currency: 'sek',
    taxBehavior: 'exclusive',
    expectedUnitAmount: PRICE_TARGETS.ai,
    taxCode: 'txcd_10000000',
    name: {
      sv: 'AI-kreditriskrapport',
      en: 'AI credit risk report',
    },
    description: {
      sv: 'Företagsspecifik, AI-assisterad kreditriskrapport (PDF).',
      en: 'Company-specific, AI-assisted credit risk report (PDF).',
    },
    generator: 'reportEngine',
    templateName: 'luottomuistio',
    aspQueryKey: 'Sweden',
    reportCurrency: 'SEK',
    reportCountry: 'SE',
    omitUnvalidatedCreditModel: true,
    bankruptcyRiskModel: process.env.SE_BANKRUPTCY_RISK_MODEL || undefined,
    includeFraud: true,
  },

  se_credit_risk: {
    stripeProductId: process.env.STRIPE_PRODUCT_SE_BASIC || '',
    currency: 'sek',
    taxBehavior: 'exclusive',
    expectedUnitAmount: PRICE_TARGETS.basic,
    taxCode: 'txcd_10000000',
    name: {
      sv: 'Kreditriskrapport',
      en: 'Credit risk report',
    },
    description: {
      sv: 'Företagsspecifik kreditriskrapport (PDF).',
      en: 'Company-specific credit risk report (PDF).',
    },
    // The engine's rebuild of the Jasper credit risk report. aiTexts adds its
    // three short LLM texts (key observations and chart interpretation on the
    // summary page, the balance-sheet commentary), as the FI site does.
    generator: 'reportEngine',
    templateName: 'staattinen_luottomuistio',
    aspQueryKey: 'Sweden',
    reportCurrency: 'SEK',
    reportCountry: 'SE',
    omitUnvalidatedCreditModel: true,
    bankruptcyRiskModel: process.env.SE_BANKRUPTCY_RISK_MODEL || undefined,
    aiTexts: true,
  },

  se_credit_risk_bundle: {
    stripeProductId: process.env.STRIPE_PRODUCT_SE_BASIC_BUNDLE || '',
    currency: 'sek',
    taxBehavior: 'inclusive',
    taxCode: 'txcd_10000000',
    name: {
      sv: 'Kreditriskrapporter, paket (3 st.)',
      en: 'Credit risk report bundle (3 pcs)',
    },
    description: {
      sv: 'Tre företagsspecifika kreditriskrapporter (PDF). Paketet kopplas till din e-postadress.',
      en: 'Three company-specific credit risk reports (PDF). The bundle is linked to your email address.',
    },
    grants: [{ reportType: 'se_credit_risk', count: 3 }],
    immediateCapture: true,
  },

  se_ai_credit_risk_bundle: {
    stripeProductId: process.env.STRIPE_PRODUCT_SE_AI_BUNDLE || '',
    currency: 'sek',
    taxBehavior: 'inclusive',
    taxCode: 'txcd_10000000',
    name: {
      sv: 'AI-kreditriskrapporter, paket (3 st.)',
      en: 'AI credit risk report bundle (3 pcs)',
    },
    description: {
      sv: 'Tre företagsspecifika AI-kreditriskrapporter (PDF). Paketet kopplas till din e-postadress.',
      en: 'Three company-specific AI credit risk reports (PDF). The bundle is linked to your email address.',
    },
    grants: [{ reportType: 'se_ai_credit_risk', count: 3 }],
    immediateCapture: true,
  },
};

function getProduct(reportType) {
  const product = PRODUCTS[reportType];
  // Fail closed: without a Stripe product (and so a verified price) nothing is sold.
  return product && product.stripeProductId ? product : null;
}

function grantFor(product, reportType) {
  if (!product || !Array.isArray(product.grants)) return null;
  return product.grants.find(grant => grant.reportType === reportType) || null;
}

function normalizeLang(lang) {
  return SUPPORTED_LANGS.includes(lang) ? lang : DEFAULT_LANG;
}

// An unknown or omitted report language falls back to English, never to the
// buyer's UI language — the two are independent by design.
function normalizeReportLang(reportLang) {
  return SUPPORTED_REPORT_LANGS.includes(reportLang) ? reportLang : DEFAULT_REPORT_LANG;
}

// Name `reportLang`, written in `lang`. E.g. ('en', 'sv') → 'engelsk': a Danish
// buyer being told, in Danish, that their PDF will be English.
function reportLangName(reportLang, lang) {
  return REPORT_LANG_NAMES[normalizeLang(lang)][normalizeReportLang(reportLang)];
}

// One-line disclosure for the Stripe line item, in the buyer's language.
function reportLangDisclosure(reportLang, lang) {
  return `${REPORT_LANG_DISCLOSURE[normalizeLang(lang)]}: ${reportLangName(reportLang, lang)}.`;
}

// Resolve a localized field (name/description) to a plain string. Tolerates a
// product that stores a plain string instead of a {da,en} map.
function localizedField(field, lang) {
  if (field == null) return '';
  if (typeof field === 'string') return field;
  const l = normalizeLang(lang);
  return field[l] || field[DEFAULT_LANG] || Object.values(field)[0] || '';
}

// Map an order's company identifiers to the params persisted on the order row
// and later used to generate the report. The shape depends on the generator:
//   - valuatumRest → { fid, lang, reportName } for the REST /reports call.
//   - reportEngine → { companyCode, aspQueryKey, fiscalYear } for the job API.
//
// `reportLang` is the buyer's chosen PDF language and lands on `params.lang` for
// both generators — that is the field the poller and the report engine read.
function buildReportParams(product, { businessId, fid, fiscalYear, reportLang }) {
  const contentLang = normalizeReportLang(reportLang);
  if (product.generator === 'valuatumRest') {
    return {
      fid: fid ? String(fid) : '',
      lang: REST_LANG_CODES[contentLang],
      reportName: product.reportName,
      ...(product.reportCurrency ? { currency: product.reportCurrency } : {}),
    };
  }
  return {
    companyCode: businessId || '',
    aspQueryKey: product.aspQueryKey,
    lang: contentLang,
    ...(product.reportCurrency ? { currency: product.reportCurrency } : {}),
    ...(product.reportCountry ? { country: product.reportCountry } : {}),
    ...(product.omitUnvalidatedCreditModel ? { omitUnvalidatedCreditModel: true } : {}),
    ...(product.bankruptcyRiskModel
      ? { bankruptcyRiskModel: product.bankruptcyRiskModel }
      : {}),
    ...(typeof product.includeFraud === 'boolean'
      ? { includeFraud: product.includeFraud }
      : {}),
    ...(typeof product.aiTexts === 'boolean' ? { aiTexts: product.aiTexts } : {}),
    ...(fiscalYear ? { fiscalYear: String(fiscalYear) } : {}),
  };
}

module.exports = {
  getProduct,
  grantFor,
  buildReportParams,
  normalizeLang,
  normalizeReportLang,
  reportLangName,
  reportLangDisclosure,
  localizedField,
  PRODUCTS,
  SUPPORTED_LANGS,
  DEFAULT_LANG,
  SUPPORTED_REPORT_LANGS,
  DEFAULT_REPORT_LANG,
};
