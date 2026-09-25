---
name: Kreditrisker (SE)
description: Swedish company facts shown like a premium fintech at blue hour; every number sourced, dated and honest about gaps.
colors:
  night: "#050a15"
  night-2: "#0a1426"
  night-3: "#111f38"
  ice: "#eef3fa"
  ice-2: "#b7c4d9"
  ice-3: "#8595b0"
  glow: "#7fb2ff"
  gold: "#f4bf72"
  paper: "#f3f5f9"
  paper-2: "#e9edf4"
  sheet: "#ffffff"
  ink: "#0a1426"
  ink-2: "#33415a"
  ink-3: "#5a6781"
  rule: "#dde3ed"
  rule-2: "#c4ccda"
  blue: "#1f56d6"
  blue-3: "#dce8ff"
  ochre: "#d9962f"
  ochre-ink: "#8a5a0e"
  ochre-wash: "#fbf0dc"
  red: "#c2362b"
  red-wash: "#fbe5e2"
  green: "#1f8a5b"
typography:
  display:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "clamp(3rem, 1.4rem + 5vw, 5.4rem)"
    fontWeight: 300
    lineHeight: 0.98
    letterSpacing: "-0.045em"
  headline:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "clamp(2.6rem, 1.4rem + 4.4vw, 4.6rem)"
    fontWeight: 350
    lineHeight: 1.06
    letterSpacing: "-0.035em"
  section:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "clamp(2rem, 1.3rem + 2.4vw, 3rem)"
    fontWeight: 380
    lineHeight: 1.06
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Source Serif 4 Variable, Source Serif 4, Georgia, serif"
    fontSize: "1.1875rem"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Geist Variable, Geist, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Geist Variable, Geist, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.5
  numeral:
    fontFamily: "Geist Mono Variable, Geist Mono, ui-monospace, monospace"
    fontSize: "1.45rem"
    fontWeight: 450
    letterSpacing: "-0.01em"
    fontFeature: "tnum"
rounded:
  control: "10px"
  card: "20px"
  panel: "24px"
  feature: "28px"
  pill: "999px"
spacing:
  gutter: "clamp(16px, 3.4vw, 48px)"
  col-gap: "24px"
  section: "clamp(72px, 10vw, 140px)"
  max: "1320px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "44px"
  button-primary-night:
    backgroundColor: "{colors.ice}"
    textColor: "{colors.night}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "44px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "44px"
  tag:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
  card-day:
    backgroundColor: "{colors.sheet}"
    rounded: "{rounded.card}"
    padding: "clamp(18px, 2.4vw, 28px)"
  input-search:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "56px"
  nav-link-current:
    backgroundColor: "{colors.ice}"
    textColor: "{colors.night}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
---

# Design System: Kreditrisker (SE)

## Overview

**Creative North Star: "Blå timmen"** (name taken from the direction contract's thesis)

Swedish company facts shown the way a premium fintech shows money. The chrome is night navy laid over Stockholm and Nordic blue-hour photography (Stockholm blue hour, Stockholm dusk, aurora lake, Lapland aerial), shaded down so ice-white type and glass product panels float on it. Long reading, tables and profiles below the fold switch to cool day surfaces with white 20px cards. The site alternates night bands and day sections; the `.dark` scope re-maps every day token, so one component works in both.

The feel is luxurious and calm, not loud: light serif display, quiet Geist UI, Geist Mono for every figure. Motion makes the data feel alive (count-ups, self-drawing lines, a gold trace along the skyline) but never hides content; everything is visible without JS and all motion stops under reduced motion. Honesty is the brand: every number carries a period and source, and gaps are drawn, never zeroed. Gold is the colour of the city lights and of "look here": emphasis and missing data share it.

The world refuses the flat grey directory table and the generic purple SaaS gradient.

**Key Characteristics:**
- Night-navy chrome over shaded blue-hour photography, with film grain.
- Glass panels (translucent white fill, 1px white hairline, backdrop blur) for product surfaces on night.
- Light serif display, Geist UI, Geist Mono tabular numerals.
- Pills for every tag, button, nav link and search field.
- Missing is drawn in gold (night) or italic "saknas" (day), never as zero.
- Motion that assembles the data, all gated by reduced motion.

## Colors

A two-mode palette: a night set for chrome and heroes, a cool day set for reading, joined by one blue and one gold.

### Primary
- **Glow Blue** (night) / **Report Blue** (day): the data colour. Chart lines, links, focus rings, selection. On night it becomes the soft glow value; on day the deep blue. Also the pointer-spotlight tint on tiles.

### Secondary
- **City-Light Gold** (night) / **Ochre** with **Ochre Ink** text (day): emphasis and gaps. The gold words in the hero headline, the last point of a line chart, the skyline trace, missing values, dashed gap slots, warn tags. Day text in this hue uses Ochre Ink for contrast; the Ochre Wash fills warn tags and notices.

### Tertiary
- **Deficit Red** with Red Wash: negative values and alert tags. Lifts to a coral red under `.dark`.
- **Registry Green**: active status dots and positive deltas. Lifts to a mint green under `.dark`.

### Neutral
- **Night** (theme colour, page chrome), **Night-2** (report panel base), **Night-3** (deep fills).
- **Ice**, **Ice-2**, **Ice-3**: text tiers on night (primary, secondary, captions and labels).
- **Day Paper** and **Paper-2**: day page background and pill fills; **Sheet** (white) for cards.
- **Ink**, **Ink-2**, **Ink-3**: day text tiers. **Rule** and **Rule-2**: 1px hairlines and stronger borders. On night, rules become white at 10% and 20%.

### Named Rules
**The Missing Is Never Zero Rule.** A missing, incomparable or not-applicable value is never rendered as 0, a dash or an empty cell. It is the italic word "saknas" (or "ej jämförbar") in Geist, dotted-underlined; on night surfaces it turns gold. In charts a missing year is a hatched slot with a gold dashed frame (4 3) and an italic label.

**The Gold Means Look Here Rule.** Gold marks emphasis, the latest data point and gaps. It is never a large fill or a decorative wash beyond a faint radial light.

**The One Scope Rule.** Night is a scope, not a second stylesheet: wrap a band in `.dark` and the day tokens re-map. Don't hard-code night colours into components that also live on day.

## Typography

**Display Font:** Source Serif 4 (with Georgia)
**Body Font:** Geist (with system-ui)
**Label/Mono Font:** Geist Mono (with ui-monospace)

**Character:** A light, optically sized serif gives the headlines a quiet luxury; Geist keeps the UI crisp; Geist Mono makes every figure read as data.

### Hierarchy
- **Display** (300, clamp 3 to 5.4rem, 0.98, -0.045em): home hero h1 only, max 12ch, gold words set in the same weight (no italic).
- **Headline** (350, clamp 2.6 to 4.6rem, 1.06): page h1s such as company names in the night band.
- **Section** (380, clamp 2 to 3rem, 1.06): section h2s, in a 7/5 split with a lede paragraph aligned to the bottom.
- **Title** (400, 1.1875rem, 1.25): h3; larger light serif (1.4 to 2rem, 350 to 400) for tile and report-card titles.
- **Body** (400, 1rem, 1.6): running text, prose max 70ch, lede 1.1875rem at 58ch.
- **Label** (500, 0.72 to 0.82rem, sentence case): KPI terms, figure heads, table heads, source lines, footer column heads.
- **Numeral** (Geist Mono, tabular, -0.01em): every figure, org number, period and axis label.

### Named Rules
**The Mono Numbers Rule.** Figures, org numbers, periods and chart labels are Geist Mono with tabular numerals. Negative numbers use a true minus (U+2212).

**The No Eyebrow Rule.** No uppercase or tracked kicker labels above headings. Labels stay sentence case and sit beside or inside what they name.

**The No Gradient Text Rule.** Text is always a solid colour; emphasis is Gold, not a gradient fill.

## Layout

A 1320px shell with fluid gutters (16 to 48px) and a 12-column grid at a 24px gap. Sections breathe (72 to 140px block padding). The home hero is full-bleed photography at least 760px tall: copy in columns 1 to 6, a floating glass profile card in 8 to 12. Inner pages open with a night band (dusk photo, 124px top padding to clear the 72px transparent nav) carrying crumbs, the page title and a six-cell KPI strip, then drop to day sections.

The home page uses a 12-column bento of night tiles (7/5 spans), a five-card states row, a photo-plus-list sources split and two glass report cards over photography. Documents use a 220px sticky table of contents beside a 76ch body.

Responsive: section heads stack at 860px, documents at 900px, the nav collapses to a sheet at 1060px, KPI strips go 6 to 3 to 2 columns (1100px, 560px), the first table column sticks under 720px.

## Elevation & Depth

Hybrid: depth on night comes from glass, blur and long soft drop shadows; day cards sit on a faint two-layer shadow. Photography is always shaded with navy gradients so type holds contrast, and a grain overlay (fractal noise, 12%, overlay blend) sits on night bands.

### Shadow Vocabulary
- **Day card** (`0 1px 2px rgb(10 20 38 / 0.04), 0 12px 32px -12px rgb(10 20 38 / 0.14)`): cards, states cards, the day search field.
- **Night card** (`0 30px 80px -30px rgb(0 0 0 / 0.7)`): the same token re-mapped under `.dark`.
- **Glass** (`inset 0 1px 0 rgb(255 255 255 / 0.12), 0 40px 100px -40px rgb(0 0 0 / 0.8)`): with a 10% to 3% white fill, a 14% white hairline and `blur(18px) saturate(1.3)`.
- **Dropdown** (`0 30px 60px -20px rgb(0 0 0 / 0.45)`): search suggestions.
- **Focus** (`0 0 0 4px` Blue-3): search field focus ring, alongside a 2px blue outline elsewhere.

### Named Rules
**The Light Not Halo Rule.** Light comes from the scene (radial washes, the pointer spotlight, the photo), never from glow halos or blurred coloured shadows around text, buttons or cards.

## Shapes

Soft and rounded throughout. Controls and small insets at 10px, day cards 20px, night panels and hero card 24px, feature cards and photo frames 28px, inner cells 14 to 16px. Everything interactive or labelling is a full pill (999px). Borders are 1px hairlines; night borders are translucent white. Status dots are 6px circles. The logo is a 9px-radius square with a gold setting sun and three rising ice bars.

## Components

### Buttons
Confident pills that lift on hover.
- **Shape:** full pill (999px), 44px min height, 20px side padding, 500 weight at 0.95rem.
- **Primary:** Ink fill with Paper text on day; Ice fill with Night text on night.
- **Quiet:** transparent with a Rule-2 border; border goes to Ink on hover.
- **Hover / Focus:** 1px lift (`translate 0 -1px`, 200ms ease-out) and the trailing arrow slides 3px; focus is a 2px blue outline at 3px offset.

### Tags
- **Style:** pill, 1px Rule border, Sheet fill, 0.78rem 500, a 6px dot before the text.
- **Variants:** ok (green dot with a faint 3px green ring), warn (Ochre Wash, Ochre Ink text, gold dot, used for "Inte lanserad" and stale data), alert (Red Wash, red), plain (no dot).

### Cards / Containers
- **Day card:** Sheet, 1px Rule, 20px radius, 18 to 28px padding, day-card shadow. Figure cards carry a mono pill number, a 600 sans title with a grey subtitle and a hairline-topped source line (Källa).
- **Glass panel:** see Elevation. Used for the hero profile card, report cards and photo chips.
- **Night tile / report panel:** faint white gradient or Night-2 base with navy and gold radial washes, 24px radius, and a pointer spotlight (a 300 to 420px radial of blue or gold at 10 to 14% that follows the cursor).

### Inputs / Fields
- **Search:** pill field, 56px (68px hero), leading 20px icon, a `/` key hint, and an inset pill submit (Ink on day, Ice on night). On night it becomes glass with a navy fill and 20px blur.
- **Focus:** border to blue plus a 4px Blue-3 ring.
- **Suggestions:** white 16px-radius list with 10px-radius rows, mono meta line.
- The hero field types its placeholder with a gold caret.

### Navigation
Transparent 72px bar over the hero that turns to 78% Night with blur once the page scrolls. Serif wordmark with the logo; links live in a translucent pill track, each link a pill (Ice-2, hover white 6%, current page Ice fill with Night text). A solid Ice pill CTA "Sök företag" sits right. Under 1060px it becomes a menu button opening a Night sheet with a pill search and serif links.

### KPI Strip
Six glass cells (18px radius, blur 14px) in the night band: a label in Ice-3, a Geist Mono value at 1.45rem, and a small pill delta (green up, coral down). Missing values drop to 1rem gold italic "saknas".

### Charts
Line: a 2.4px blue line with round caps, dashed 2 5 grid, open points, the latest point in gold, a hatched gold dashed slot for missing years. Bars: blue bars that grow from the baseline (70ms stagger), a 3px Ink zero line, the same gap slot. All labels Geist Mono.

### Motion
One ease (`cubic-bezier(0.16, 1, 0.3, 1)`). Scroll reveal: fade, 24px rise and 6px blur over 900ms with a 90ms stagger. Count-up: 1400ms quartic ease in sv-SE format. Lines self-draw over 1600ms. The hero draws a gold skyline trace with a travelling light, the photo drifts over 30s, a serif marquee scrolls at 50s. Hero card tilts up to 5 degrees on fine pointers. All of it is off under `prefers-reduced-motion`.

## Do's and Don'ts

### Do:
- **Do** set every figure, org number and period in Geist Mono with tabular numerals and a true minus.
- **Do** render missing data as italic "saknas", gold on night, and missing chart years as hatched slots with a gold dashed frame.
- **Do** give every number block its period and a source line.
- **Do** use pills (999px) for tags, buttons, nav links and search fields.
- **Do** shade photography with navy gradients and put product surfaces in glass on top of it.
- **Do** wrap night sections in `.dark` so day tokens re-map, rather than hard-coding night colours.
- **Do** gate every animation behind `prefers-reduced-motion: no-preference` and keep content visible without JS.

### Don't:
- **Don't** show a missing value as 0, a dash or an empty cell.
- **Don't** add eyebrow or kicker labels above headings.
- **Don't** use gradient-filled text.
- **Don't** put glow halos or blurred coloured shadows around text, buttons or cards.
- **Don't** use gold as a large fill or decoration; it marks emphasis and gaps.
- **Don't** drift toward the flat grey directory table or a purple SaaS gradient.
