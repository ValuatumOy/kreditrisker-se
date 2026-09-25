# Domain and name

Researched 2026-09-25. Not legal advice; a trademark attorney should confirm before registration or launch.

## Recommendation: **kreditrisker.se** (product name "Kreditrisker")

1. **It's available.** `.se` WHOIS (whois.iis.se, 2026-09-25) returned *not found*.
2. **It carries over the Finnish brand.** It's a direct translation of luottoriskit.fi, so Valuatum can run one brand across the Nordics without confusing it with the Finnish site.
3. **Less risk of being confused with competitors.** Incumbents own the head-term domains (kreditupplysning.se, kreditupplysningar.se, foretagsupplysning.se, bolagskoll.se, kreditkoll.se). **kreditrapport.se** is free, but it's one letter away from Kreditrapporten.se, an existing competitor, so avoid it.
4. **It fits the product.** "Kreditrisk" is the term for what the reports measure. The free profiles have to rank on company names and orgnr, not on a domain keyword. Allabolag, Proff and Ratsit rank that way without keyword domains.

**First check kreditrisk.se.** It was registered on **2026-01-22** via Loopia, with the holder hidden. foretagsrisk.se was registered via Loopia a day earlier. If Valuatum registered them, **kreditrisk.se** (singular) is slightly stronger: it's the exact search term and shorter. In that case, point kreditrisker.se at it as a redirect. If Valuatum didn't register it, register **kreditrisker.se** now and check what kreditrisk.se is used for.

## Search language (qualitative; no search-volume tool was available)

| Term | Intent | Who ranks | Our angle |
|---|---|---|---|
| kreditupplysning företag | buy a credit report | UC, Creditsafe, Allabolag (sells UC), bank guides | the report pages; requires legal gate before any "kreditupplysning" claim |
| företagsupplysning | look up a company | Creditsafe, Ratsit, Merinfo, Bolagsfakta | company profiles and search |
| kreditvärdighet (företag) | "can I trust them" | UC, Creditsafe, guides | /guider/, profile summaries (no judgement until the model is validated) |
| bokslut + company name | financial statements | Allabolag, Proff, Bolagsfakta, Hitta | profile "Bokslut" table, multi-year |
| nyckeltal (+ soliditet, kassalikviditet) | education and ratios | Allabolag, education sites | /metod/, /guider/nyckeltal/, ratio rows |

Language used in the code: *organisationsnummer / org.nr, bokslut, årsredovisning, nettoomsättning, rörelseresultat, soliditet, kassalikviditet, tkr / Mkr, SNI, säte, kommun*.

## Alternatives checked (WHOIS, 2026-09-25)

| Domain | Status | Note |
|---|---|---|
| kreditrisk.se | registered 2026-01-22 (Loopia, hidden) | best if it's ours |
| **kreditrisker.se** | **free** | recommended |
| kreditrisken.se | free | awkward definite form |
| foretagsrisk.se | registered 2026-01-21 (Loopia) | same pattern as kreditrisk.se |
| foretagsrisker.se, bolagsrisk.se, bolagsrisker.se | free | vaguer; "risk" alone reads as generic |
| kreditprofil.se, kreditbild.se, riskbild.se | free | brandable but no search match |
| kreditrapport.se | free | avoid: confusable with Kreditrapporten.se |
| kreditvardighet.se, foretagskredit.se, bolagskoll.se, kreditkoll.se, kreditupplysning(ar).se, foretagsupplysning.se | registered | — |

## Trademark

- TMview search for "kreditrisk" across SE, EUTM and WIPO returned no rows (2026-09-25). Recheck PRV's own database before filing.
- "Kreditrisk(er)" is descriptive, so a word mark is unlikely to be registrable. Protect the brand with a figurative or combined mark ("Kreditrisker från Valuatum") and the domain, and expect competitors to be free to use the words.
- There's no evident conflict with UC, Creditsafe, Bisnode/Dun & Bradstreet or Enento marks, but have an attorney clear it.

## Configuration

Name and origin come from `SE_SITE_NAME` and `SE_SITE_ORIGIN` (see `src/config/site.ts` and `astro.config.mjs`). Nothing else hard-codes the domain.
