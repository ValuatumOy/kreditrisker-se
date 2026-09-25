# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Astro (static output), isolated app in `sites/se/` of the luottoriskit.fi repository. Own package.json, config, data and deployment; the Finnish site in `src/` is untouched.

## Users

Primary: Swedish SME owners, ekonomiansvariga and sales staff checking a customer, supplier or partner before extending credit or signing a deal. Occasional use, one company at a time, often arriving from Google on a company name or organisationsnummer. They buy a single report when the free profile raises a question. (Confirmed 2026-09-25.)

Secondary: organic visitors reading a company's public figures.

## Product Purpose

Free, sourced company profiles (bokslut, nyckeltal, SNI, kommun) for Swedish companies keyed by organisationsnummer, with a direct path to a paid Basic or AI credit-risk report from Valuatum. Success: a visitor finds the company in seconds, understands its financial position from verified figures, and can order the right report once reports are live.

## Positioning

Built by Valuatum, whose credit-risk and AI report pipeline already runs in Finland (luottoriskit.fi). The Swedish model, scale, horizon and prices are not yet validated and must not be claimed.

## Operating Context

Visitors compare against Allabolag, Proff, Ratsit, Bolagsfakta, Merinfo, UC, Creditsafe, Kreditrapporten. Data will come from Bolagsverket (värdefulla datamängder, iXBRL årsredovisningar from 2020) and SCB, subject to licence review.

## Capabilities and Constraints

- Swedish data pipeline and reports are in development. Until then: synthetic fixtures only, noindex.
- Launch gates: data licence/redistribution rights, IMY kreditupplysningstillstånd assessment, GDPR for enskilda firmor, consumer/distance-selling and payment terms, legal review of claims.
- Domain and product name are undecided and configurable.
- No price, delivery time, score scale or forecast horizon may be shown until verified.

## Brand Commitments

Valuatum is the named provider. Site identity is distinct from luottoriskit.fi. Native Swedish copy.

## Evidence on Hand

None real for Sweden yet. No customers, testimonials, coverage counts or prices may be invented. Synthetic fixtures must be labelled as such.

## Product Principles

1. Search first: the company lookup is always one action away.
2. Every figure carries its source, period and freshness; missing is never shown as zero.
3. No risk judgement without valid model output.
4. Honest availability states beat filler.
5. Calm hierarchy: decision-critical facts first, detail on demand.

## Accessibility & Inclusion

WCAG 2.2 AA: keyboard search and menus, contrast, responsive tables, reduced motion.
