---
name: Kreditrisker (SE)
description: Swedish company facts set like a central-bank stability report; every number is a numbered, sourced figure.
colors:
  paper: "#f5f6f3"
  paper-2: "#eceee9"
  sheet: "#ffffff"
  ink: "#0f1e26"
  ink-2: "#33444d"
  ink-3: "#56656c"
  rule: "#d3d8d3"
  rule-2: "#b9c0bb"
  statsbla: "#1d4f6e"
  statsbla-light: "#8fb0c4"
  statsbla-wash: "#d6e3ea"
  ochre: "#c58a1c"
  ochre-ink: "#7d5308"
  ochre-wash: "#f6ebd3"
  red: "#9a2d24"
  red-wash: "#f5e2de"
  green: "#2c6147"
typography:
  display:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "clamp(2.5rem, 1.4rem + 4.2vw, 4.4rem)"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.028em"
  headline:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "clamp(1.9rem, 1.3rem + 2vw, 2.6rem)"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.022em"
  title:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.005em"
  figure-value:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "1.85rem"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Schibsted Grotesk Variable, Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "kern"
  figure-title:
    fontFamily: "Schibsted Grotesk Variable, Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
  label:
    fontFamily: "Schibsted Grotesk Variable, Schibsted Grotesk, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  hairline: "2px"
  base: "3px"
  pill: "999px"
spacing:
  gutter: "clamp(16px, 3.2vw, 40px)"
  col-gap: "24px"
  section: "clamp(56px, 8vw, 112px)"
  max: "1320px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.base}"
    padding: "0 18px"
    height: "44px"
  button-primary-hover:
    backgroundColor: "{colors.statsbla}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.base}"
    height: "44px"
  button-disabled:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-3}"
  input-search:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.base}"
    height: "60px"
  tag:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  tag-warn:
    backgroundColor: "{colors.ochre-wash}"
    textColor: "{colors.ochre-ink}"
  tag-alert:
    backgroundColor: "{colors.red-wash}"
    textColor: "{colors.red}"
  panel:
    backgroundColor: "{colors.sheet}"
    padding: "18px 20px 20px"
---

# Design System: Kreditrisker (SE)

## Overview

**Creative North Star: "The Stability Report"**

Company facts are presented the way a Riksbank or Finansinspektionen stability report presents the economy: cool white paper, ink-blue text, a hairline grid, and numbered exhibits. Every number lives inside a figure that has a number ("Tabell 1", "Diagram 1"), a sans title with a grey subtitle, and a closing "Källa:" or "Anm." line naming source, period and retrieval date. Nothing floats free.

The mood is calm, sourced and unhurried. Density is report-like: generous section padding, tight tables. Gaps in the data are shown, never hidden; ochre is the colour of "look here": figure numbers, missing years, provisional notices. The system rejects the navy fintech dashboard with gauges and the cream editorial magazine.

**Key Characteristics:**
- Numbered figures with a 2px ink top rule and a hairline-separated source line.
- Serif headlines and headline numbers; grotesk for body, labels and table data.
- Flat paper, 1px hairlines, almost no shadow.
- Honest value states: negative, missing and incomparable each look different from zero.
- One ochre accent, used for signalling, never for decoration.

## Colors

Cool, desaturated paper-and-ink with one statistical blue and one ochre signal.

### Primary
- **Statsblå** (statsbla): links, focus outline, button hover, the highlighted (latest) bar in charts. Its lighter step (statsbla-light) fills the other bars; the wash (statsbla-wash) is the 3px focus halo on inputs.

### Secondary
- **Report Ochre** (ochre): the dashed outline of missing-year slots in charts, the 2px top rule of notices, dots on warn tags, the active-nav underline. **Ochre Ink** (ochre-ink) is the AA-legible text form, used for figure numbers ("Tabell 1") and warn text. **Ochre Wash** is the synthetic-data banner, warn tags and chart notes.

### Tertiary
- **Deficit Red** (red): negative values and negative bars (at 0.85 opacity), alert tags on Red Wash.
- **Registry Green** (green): only the dot on an "ok" tag.

### Neutral
- **Cool Paper** (paper): page background, nav (94% with blur), sticky table first column.
- **Paper 2**: disabled buttons, segmented-tab track.
- **Sheet** (white): panels, inputs, tags, dropdowns: anything that sits "on" the page.
- **Ink** (ink): text, primary buttons, 2px figure rules, table top rule, chart baseline.
- **Ink 2 / Ink 3**: secondary text (ledes, table heads) / tertiary (captions, source lines, placeholders, missing values).
- **Rule / Rule 2**: 1px hairlines between rows and sections / stronger hairlines for quiet buttons, tag borders, sum rows, hatch strokes.

### Named Rules
**The Ochre Means Attention Rule.** Ochre marks figure numbers, gaps, provisional states and current position. It is never a fill for decoration or a brand splash.

**The Missing Is Not Zero Rule.** A missing or incomparable value is never rendered as 0 or a dash; it gets its own visual state (see Components: Values).

## Typography

**Display Font:** Source Serif 4 (variable, optical sizing on; Georgia fallback)
**Body Font:** Schibsted Grotesk (variable; system-ui fallback)

**Character:** A book-weight report serif for statements and headline figures against a sturdy Scandinavian newspaper grotesk for everything read at working size.

### Hierarchy
- **Display** (500, clamp 2.5–4.4rem, 1.08, -0.028em): page h1, balanced wrap.
- **Headline** (500, clamp 1.9–2.6rem, -0.022em): section h2. In prose and documents h2 drops to 1.6rem.
- **Title** (500, 1.25rem, 1.25): h3; also the lede size (sans, ink-2, 1.5 line height, max 58ch).
- **Figure value** (serif 400, 1.85rem; 1.5–1.55rem compact/mobile): key-figure cells. Missing values inside fall back to sans 1.05rem.
- **Figure title** (sans 600, 1rem): figure heads, next to the ochre-ink figure number (600, 0.8125rem).
- **Body** (400, 1.0625rem, 1.55): prose max 68ch, documents 76ch. Tables run at 0.95rem.
- **Label** (400, 0.8125rem): table heads (600, ink-2), key-figure labels, source lines, crumbs (ink-3).

### Named Rules
**The Lining, Not Tabular Rule.** Numerals use `lining-nums` only. Tabular figures were removed on purpose: Schibsted's `tnum` widens the Swedish decimal comma. Right-aligned table columns carry the alignment instead.

**The No Eyebrow Rule.** No uppercase kickers or tracked labels above headings. The figure number is the only label a heading gets.

## Layout

A 12-column grid (24px gaps) inside a 1320px shell with a fluid gutter (16–40px). Section heads split 7/5: serif h2 left, ink-2 lede right aligned to the bottom; they stack below 860px. Sections pad 56–112px vertically and are separated by a 1px rule. Profile pages pair a main column with a sticky ~320px report panel (top 88px) that stacks below 900px; documents use a 220px sticky table of contents that stacks below 900px.

Key figures sit in a 3-column hairline grid (2 columns compact and below 640px), cells divided by 1px left rules. Tables scroll horizontally inside their wrapper; below 720px the first column becomes sticky on paper with a soft edge shadow. The sticky nav is 64px; scroll padding is 88px.

## Elevation & Depth

Flat. Depth comes from paper vs. sheet (white) and from rules, not shadows. Shadows appear only where something floats over content.

### Shadow Vocabulary
- **Focus halo** (`box-shadow: 0 0 0 3px var(--blue-3)`): search inputs on focus.
- **Dropdown** (`box-shadow: 0 22px 40px -24px rgb(15 30 38 / 0.5)`): search suggestions list.
- **Mobile sheet** (`box-shadow: 0 18px 30px -24px rgb(15 30 38 / 0.35)`): open mobile menu.
- **Selected segment** (`box-shadow: 0 1px 2px rgb(15 30 38 / 0.18)`): active segmented tab.
- **Sticky column edge** (`box-shadow: 6px 0 8px -8px rgb(15 30 38 / 0.35)`): mobile table first column.

### Named Rules
**The Rule Before Shadow Rule.** If a surface needs separation, give it a hairline or a 2px ink top rule. Reach for shadow only when it overlaps content.

## Shapes

Near-square. Buttons, inputs, notices and segment tracks use a 3px radius; inner controls (search submit, segment buttons, dropdown items) use 2px. Figures and panels have square corners. Tags are the one rounded form: full pills with a 6px status dot. Borders are 1px hairlines; the signature stroke is the 2px ink top rule that opens every figure, panel and table of contents.

## Components

### Figures (signature)
Every table, chart and key-figure block is a figure: 2px ink top rule, 14px padding, head row with the ochre-ink number ("Tabell n" / "Diagram n") and a sans 600 title plus grey subtitle ("– räkenskapsåret 2025"). It closes with a source line above a 1px rule, 0.8125rem ink-3, lead word in bold ink-2: "Källa:" for provenance, "Anm." for method notes. A figure without a source line is incomplete.

### Values
- **Positive / zero:** ink, Swedish formatting (space thousands, decimal comma, "Mkr"/"tkr").
- **Negative:** Deficit Red with a true minus sign (U+2212).
- **Missing / incomparable / not applicable:** "saknas" / "ej jämförbar" in ink-3 italic at 0.92em, dotted rule-2 underline, help cursor; the reason sits in a tooltip and in visually-hidden text.

### Charts
SVG bar charts: statsblå-light bars, latest year statsblå with a bold ink value label, 1px ink baseline (3px zero line when values cross it), negative bars red. Missing years are drawn as slots with a 45° rule-2 hatch, a 4/3 dashed ochre outline and an italic ink-3 label. Bars grow in over 900ms (70ms stagger) only without reduced motion.

### Buttons
- **Shape:** 3px radius, 44px min height, 0 18px padding, sans 500 0.95rem.
- **Primary:** ink fill, paper text. Hover: statsblå fill and border (160ms ease-out).
- **Quiet:** transparent, ink text, rule-2 border; hover goes to sheet with an ink border.
- **Disabled:** paper-2 fill, rule border, ink-3 text, not-allowed cursor.

### Tags
Pills on sheet with a rule-2 border, 0.8125rem ink-2 text, and a 6px dot (ink-3 default, green ok). Warn: ochre wash, ochre-ink text. Alert: red wash, red text. Used for company status, freshness and report availability ("Inte lanserad").

### Inputs / Search
Hero search: sheet field, 1px ink border, 3px radius, 60px tall (72px hero), 22px icon inset, ink submit button (2px radius) inset 6px. Focus adds the 3px statsblå-wash halo. The nav search is 38px with a rule-2 border that turns ink on focus. Labels sit above in 0.8125rem 600 ink-2.

### Panels & Notices
Panels (report box, hero preview): sheet, 1px rule border, 2px ink top rule, 18–22px padding. Notices: sheet with a 2px ochre top rule, bottom corners 3px, ochre-ink icon. Synthetic-data banner: full-width ochre wash strip under the nav.

### Tables
1px ink top rule on the wrapper, 1px rule row lines, 10px 12px cells, right-aligned numbers, left first column. Sum rows bold with rule-2 lines; group rows serif 600 1.05rem with an ink underline.

### Navigation
Sticky 64px bar on 94% paper with a 10px backdrop blur and a bottom hairline. Brand wordmark in serif 600 1.45rem with "från Valuatum" in ink-3. Links 0.94rem ink-2; the current page gets ink text and a 2px ochre underline. Below the desktop breakpoint, a 44px menu button opens a paper sheet with its own search and ruled link list.

## Do's and Don'ts

### Do:
- **Do** wrap every number block in a numbered figure with a "Källa:" or "Anm." line naming source, period and retrieval date.
- **Do** render missing data as "saknas" / "ej jämförbar" in the missing-value style and missing years as hatched ochre-dashed slots.
- **Do** use a true minus (U+2212) and Deficit Red for negative values.
- **Do** keep figures and panels square with a 2px ink top rule; keep controls at 3px.
- **Do** use ochre-ink, not ochre, for any ochre text.

### Don't:
- **Don't** use `tabular-nums`; Schibsted's tabular figures widen the decimal comma.
- **Don't** add eyebrow or kicker labels above headings.
- **Don't** build dashboards with gauges, dials, navy fills or glowing KPI cards.
- **Don't** drift toward a cream editorial magazine: paper stays cool (#f5f6f3), never warm.
- **Don't** show a missing value as 0, a dash or an empty cell.
- **Don't** use shadows for resting surfaces.
