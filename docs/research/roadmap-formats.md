# Research: product roadmap formats for Product Oracle

Research lane, 2026-10-17. Inputs: [`docs/design.md`](../design.md) and decision rows
O4 (roadmap shape), O5 (branding, share links, audience variants, public-safe
variant) and E1 (two-way engineering tracker alignment) in
[`docs/questions.md`](../questions.md).

Every structure below is described in our own words; sources are linked (numbered
`[S#]`, listed at the end). The templates proposed here live in
[`templates/roadmap/`](templates/roadmap/).

## TL;DR

- **Now / Next / Later is today's default for product teams**, and it is what O4
  already chose. ProdPad (who made it), Productboard, Aha!, Jira Product Discovery,
  Miro and Notion all ship it as a template or built-in board, and roadmap writers
  in 2021–2026 keep recommending it [S1–S6, S13, S15, S16]. Its known weakness is that
  executives, sales and finance still ask for dates [S14, S25]. The fix most sources
  agree on, and the one O4 already uses, is **dates only in Now** [S2, S24].
- **Outcome and goal-based roadmaps** (OKR rows, opportunity solution trees,
  Cagan's "alternative to roadmaps") are the most praised *idea*. They usually ship
  as a layer on top of Now/Next/Later or a timeline, not as their own diagram
  [S8–S11, S24]. For Oracle this layer is free: every feature already traces to a
  confirmed goal (B1, F3b).
- **Timeline / quarterly roadmaps with swimlanes** are still the most common
  picture you get when you search "product roadmap". Leadership and go-to-market
  teams still want them [S14, S25]. Every major tool keeps a timeline view with
  milestones and dependency lines [S12, S13, S17, S19].
- **Audience variants come from one source.** Productboard, Jira Product Discovery
  and Released all say "one dataset, many views" [S12, S13, S25]. That matches O5.
  Audience (board / team / engineering / public) should therefore be a **variant
  layer applied to any template**, not a template of its own.
- **Recommendation: five built-in templates.** Now / Next / Later (default),
  Outcome roadmap, Quarterly timeline, Release plan, Cycle bets (Shape Up). On top
  of them sit four audience variants: board, team, engineering, public-safe.

## What Oracle needs from a roadmap format (from O4, O5, E1, B1–B2)

| Need | Source row | Consequence for formats |
|------|------------|-------------------------|
| Default Now / Next / Later on B2 horizons (Now = current quarter, Next = next 2 quarters, Later = 12–24 months) | O4, B2 | Horizon columns are named buckets, not calendar columns. Their meaning in time comes from the tenant's horizons. |
| Dated milestones only in Now, from eng-tracker estimates | O4, E1 | Item `dates` are allowed only when the horizon is `now` and there is a tracker estimate behind them. Next and Later show a horizon label, never a date. |
| Switch shape to Quarterly timeline or Outcome roadmap | O4 | The same items must be able to render in more than one layout. A template is a *layout over shared roadmap items*, not its own data. |
| Goal traceability (every item serves a confirmed goal; items that serve no goal are flagged) | B1, F3b | Every template has a `goal` field on items. Items without a goal render with a visible "no goal" flag. |
| Dependencies | B1 edges `depends_on`, `blocks` | Every template can show dependencies. Timelines draw arrows; column layouts show "after X" badges. |
| Capacity | O4 question, E1 read-back | Item `effort` plus team capacity per horizon or period gives a load bar. This needs tracker estimates (E1). |
| Audience variants: board / team / engineering, from one source | O5 | Variant = field visibility + level of detail + grouping. It applies to any template. |
| Public-safe variant | O5 | Allowlisted fields only, no internal names or effort, no dates beyond what has been announced, mandatory disclaimer. |
| Branded HTML/PDF | O5 | Layout spec must be renderable in print: landscape pages, legends, as-of stamp. |

## Formats

Each entry covers: origin; who uses it; when it fits; structure and layout;
strengths and weaknesses; evidence of popularity; how it maps to Oracle.

### 1. Now / Next / Later

- **Origin.** Janna Bastow and Simon Cast at ProdPad, around 2012. It started out
  labelled "Current / Near term / Future", and customers renamed it [S1, S2]. It
  was made as an answer to timeline roadmaps that promise dates teams cannot keep.
- **Who uses it.** Product teams at startups and scale-ups. It is the built-in
  default view in ProdPad. It is a template or board in Productboard [S5], Aha! [S6],
  Jira Product Discovery (a "Roadmap" field with Now/Next/Later values on a board
  view) [S13], Miro and Notion [S15, S16].
- **When it fits.** Any stage, but especially early-stage and fast-changing
  products. Horizon runs from a quarter up to about two years. Good audiences are
  the team, the whole company and customers. Productboard warns it is *thin* for
  executives, who want deadlines, teams and objectives [S5]. Oracle answers that by
  adding goals and Now-dates.
- **Structure / layout.** Three columns. Cards are **problems or initiatives, not
  features** [S1]. Detail and certainty drop from left to right: Now is scoped and
  ready, Next is a validated problem with the solution still open, Later is a hazy
  bet. Cards are often colour-coded by objective [S1]. Aha! adds theme swimlanes
  across the three columns [S6]. ProdPad's "confidence horizons" treat the columns
  as levels of certainty, drawn as a widening cone. Items move left as evidence
  builds, not as time passes [S3].
- **Strengths.** Easy to read in seconds. No false dates. Reprioritising is cheap.
  It pairs naturally with objectives.
- **Weaknesses.** Stakeholders who need dates (sales, marketing, finance, boards)
  push back [S14, S25]. "Later" can turn into a backlog dump. Without objective tags
  it becomes a feature list in three columns.
- **Evidence.** Lenny's Podcast episode with Bastow, 2022-10-16 [S4]. ProdPad
  webinar with Teresa Torres on handling leaders who still want dates [S24].
  Productboard [S5], Aha! [S6] and Jira Product Discovery [S13] all ship it as a
  first-class layout (pages checked 2025–2026). Released.so (2025-05-09) found
  product teams prefer board formats like this one [S25]. A widely repeated claim
  that "about 70% of ProdPad prospects already use it" showed up only in a search
  snippet and could not be checked on a primary page, so it is **not** relied on.
- **Oracle mapping.** This is the O4 default. Columns map to B2 horizons. Dates and
  milestones are allowed only in Now, sourced from tracker estimates (E1). Every
  card carries `goal`, `confidence` and `depends_on`. A capacity bar shows on Now,
  and optionally on Next.

### 2. Outcome / goal-based roadmaps (OKR-linked, opportunity solution trees)

- **Origin.** Marty Cagan, "The Alternative to Roadmaps" (SVPG, 2015). He proposes
  a product vision, then prioritised business objectives per team (OKRs), then
  **high-integrity commitments** made only after discovery [S8]. Teresa Torres'
  **opportunity solution tree** (2016, *Continuous Discovery Habits*): outcome →
  opportunities → solutions → assumption tests [S9, S10]. Itamar Gilad's GIST
  (Goals, Ideas, Steps, Tasks) and his Confidence Meter take the same idea further
  [S11].
- **Who uses it.** Teams with empowered product squads and OKR rituals. ProductPlan
  ships an OKR roadmap template [S17]. Productboard roadmaps can be built around
  objectives [S12]. Linear groups projects under **initiatives** tied to company
  objectives, with health statuses [S19].
- **When it fits.** Seed stage and up, once goals are explicit. Horizon is one to
  four quarters. Good audiences are leadership, the board and the product org.
- **Structure / layout.** Usually a **matrix**: one row per goal or objective
  (with metric and target), horizon columns (Now/Next/Later or quarters), and cards
  are initiatives placed where they serve that goal. The OST itself is a **tree**
  diagram used to *decide*. Sources describe it as a way to choose what goes on
  the roadmap, and the roadmap as the way to *communicate* the decision [S10].
- **Strengths.** Keeps the "why" visible. Holds up when solutions change. Matches
  how boards think, in metrics.
- **Weaknesses.** Needs well-formed, measurable goals. Many teams lack them, which
  is exactly the design doc's "Assignment". Says little about *when*. Trees get
  big quickly and do not print well.
- **Evidence.** Cagan (2015) and Torres (2016 onward) are the two most-cited
  authors for outcome planning. ProductPlan's 2024/2025 guides recommend outcome
  roadmaps rendered in Now/Next/Later [S18]. Torres' advice in the ProdPad webinar
  is to *add* problems and outcomes to the roadmaps teams already use [S24].
- **Oracle mapping.** This is the O4 "Outcome roadmap" switch. Oracle already has
  the goal graph (B1/B2), so rows are confirmed goals with metric, target, horizon
  and owner. Items appear under every goal they `support` (contribution 0–3).
  Unlinked items go to a flagged "Serves no goal" row. The OST view is an optional
  appendix figure (SVG), not the main layout.

### 3. Theme-based roadmaps

- **Origin.** Popularised by *Product Roadmaps Relaunched* (McCarthy, Lombardo,
  Ryan, Connors; O'Reilly, 2017). Themes are customer problems or needs, not
  features [S20]. ProductPlan ships a theme-based template [S17].
- **Who uses it.** Mid-stage companies with several product areas. Atlassian
  ecosystem tools use theme swimlanes [S21].
- **When it fits.** Two or more product areas or teams. Horizon is two to four
  quarters. Good for whole-company and board audiences.
- **Structure / layout.** Themes as **swimlanes** (rows) laid over horizon or
  quarter columns. A theme names the problem; the cards under it are candidate
  answers.
- **Strengths.** Shows the "what and why" and spreads investment across areas.
- **Weaknesses.** Themes can turn into vague labels with no metric attached.
- **Oracle mapping.** Not a separate template. It is a **grouping option** (`group_by:
  theme`) on Now/Next/Later and Quarterly timeline. Theme = product area or a goal
  cluster from the baseline.

### 4. Quarterly and timeline (Gantt-style) roadmaps with dated milestones

- **Origin.** Project-management Gantt charts, carried over into product work.
  Still the most common picture of "a product roadmap" in image search [S14].
- **Who uses it.** Enterprises, companies with launch or contract dates, and
  hardware or regulated businesses. Every major tool has a timeline view:
  Productboard timeline boards with granularity and swimlanes [S12], Jira Product
  Discovery monthly/quarterly timeline [S13], Jira Plans with capacity and
  dependency lines [S22], Linear roadmap timeline [S19], Miro timeline templates
  with dependency connectors [S16], Notion timeline database views [S15].
- **When it fits.** Later stage, or any time external dates exist (events,
  contracts, regulation). Horizon is two to four quarters. Audiences are leadership,
  sales, marketing and finance [S25].
- **Structure / layout.** A time axis (months or quarters) runs left to right, with
  a "today" line. Swimlanes run by team, theme or product. Bars run from start to
  end. Diamonds mark milestones. Arrows show dependencies. A capacity or load strip
  can sit under each lane.
- **Strengths.** Answers "when". Shows sequencing, dependencies and capacity
  conflicts.
- **Weaknesses.** False precision far out. Pulls focus toward speed over why.
  Brittle when plans change [S14, S23].
- **Evidence.** Released.so (2025) talks about "roadmap bilingualism": product
  teams prefer boards, leadership and GTM prefer timelines, and good teams render
  both from one source [S25]. ProdPad's "Ditch the timeline" guide is a
  well-known critique [S14].
- **Oracle mapping.** This is the O4 "Quarterly timeline" switch. To keep O4's
  rule, only Now-horizon items get **dated bars**. Next and Later items render as
  **fuzzy bars** spanning their whole quarter range, with hatched edges and no
  end-date label. Dependencies come from B1 `depends_on`/`blocks` edges. Capacity
  comes from tracker estimates.

### 5. Release plans

- **Origin.** Agile release planning: versions or trains with scope and target
  dates. Productboard [S7], Aha! [S26] and ProductPlan [S17] each ship a release
  plan or releases roadmap.
- **Who uses it.** Engineering-heavy teams, versioned software (mobile, on-prem,
  SDKs), and anyone with go-to-market launch coordination.
- **When it fits.** Delivery horizon of one to two quarters. Audiences are
  engineering, QA, support and marketing.
- **Structure / layout.** One column or row per **release** (name, target date,
  status). Inside each, scoped items with must / should / could, readiness (spec,
  design, build, QA, docs) and tracker links. Often comes with a launch-activity
  checklist [S26].
- **Strengths.** Concrete. Easy to check against the tracker.
- **Weaknesses.** Output-focused. Says nothing about goals unless you add them.
- **Oracle mapping.** This is the engineering-facing companion to the Now column.
  It is the natural render of E1 read-back: epics/issues per release, estimate vs
  plan, and drift flags.

### 6. Shape Up: six-week cycles and the betting table

- **Origin.** Ryan Singer, Basecamp (*Shape Up*, 2019, free online) [S27]. Work
  runs in six-week cycles, then a two-week cool-down. A small group (CEO, CTO, a
  senior programmer, a product strategist) meets at a **betting table** during
  cool-down to pick from shaped **pitches**. A pitch has a problem, an appetite, a
  rough solution, rabbit holes to avoid and no-gos. The **circuit breaker** rule:
  unfinished work does not roll over by default. Progress shows on **hill charts**,
  where uphill means still working things out and downhill means just executing
  [S28].
- **Who uses it.** Small product-led teams (often under 50 engineers) and
  founder-led companies. Plenty of practitioner write-ups through 2024–2025, some
  of them critical of the cool-down [S29].
- **When it fits.** Small team, founder decides, a planning horizon of *one cycle*,
  and no long-range promises.
- **Structure / layout.** Not a long-range roadmap. It is a **cycle board**: the
  current cycle's bets (team, appetite, big or small batch, hill position), the
  next cycle's candidate pitches, and cool-down slots.
- **Strengths.** Fixed time, variable scope. Appetite stands in for estimates. The
  founder decides, which matches C1b "the founder decides".
- **Weaknesses.** No view past about 8 weeks. Needs a shaping discipline. Does not
  fit stakeholders who need a quarter-plus view.
- **Oracle mapping.** An optional template for teams that already run cycles. Now =
  the current cycle (dates are known, so dated milestones are allowed). Next = the
  pitches up for the next betting table. Later = raw ideas. Hill position works as
  a confidence marker.

### 7. Public roadmaps (GitHub, AWS, Buffer, Canny, changelogs)

- **Examples.**
  - **GitHub public roadmap** (2020 onward): a project board with **quarter
    columns plus an "Exploratory" column**, labels for release phase (exploring,
    in design, preview, GA), feature area, SKU and deployment model. Shipped items
    close with a link to the changelog. It carries a strong no-commitment
    disclaimer [S30].
  - **AWS containers roadmap**: stage columns (Researching, We're working on it,
    Coming soon, Just shipped). Reactions on GitHub issues act as votes. No dates,
    with a disclaimer [S31].
  - **Buffer**: a public Trello board from about 2015. Since 2023-08-09, "Buffer
    Suggestions" (on featureOS): voting, then In Review, Planned, In progress,
    Complete [S32].
  - **Canny**: default columns Planned, In progress, Complete [S33].
  - **Changelogs**: Linear's "Startups write changelogs" (2020) argues for a
    weekly or biweekly public log of what shipped [S34].
- **When it fits.** Developer tools and B2B SaaS with an engaged user base. Used
  for trust, feedback and sales enablement.
- **Structure / layout.** **Status columns** (Exploring, Planned, In progress,
  Shipped), at most quarter-level timing, customer-language titles, vote counts,
  a link from shipped items to the changelog, and a disclaimer footer.
- **Weaknesses.** Reveals strategy to competitors. Creates pressure to commit.
  Must be kept curated.
- **Oracle mapping.** This becomes O5's **public-safe variant**, not a separate
  template. The variant filters any roadmap through an allowlist (see below),
  turns Now/Next/Later into Shipped-soon / Planned / Exploring style labels, drops
  dates unless they are marked `announced`, and adds a disclaimer and a link to the
  changelog.

### 8. Audience variants: board / investor vs team vs engineering

- **Evidence.** Productboard's roadmap guide (updated 2026-06-05): decide who the
  roadmap is for first, because "a roadmap built for your executives won't be very
  useful for your engineering team, and vice versa" [S12]. Jira Product Discovery
  publishes custom views per stakeholder group (leadership sees goal alignment,
  customers see requested features) [S13]. ProductPlan's investor and board advice:
  short and memo-like, 6/12/24-month framing, market opportunity over technical
  detail, only key metrics tied to financial targets [S35]. ProductPlan also ships
  an "Executive-facing portfolio" template [S17].
- **Oracle mapping.** One roadmap, rendered with a variant:

| Variant | Shows | Hides | Grouping / detail |
|---------|-------|-------|-------------------|
| `board` | Goals with metric and target, top 3–7 initiatives per horizon, status, confidence, key risks | Owners below lead level, effort, issue links, dependencies (collapsed into a risk note) | Group by goal. One page. 6/12/24-month framing maps to Now/Next/Later. |
| `team` | Everything in the template: goal, owner, confidence, dependencies, Now dates | Tracker issue IDs (optional) | Group by goal or theme |
| `engineering` | Plus effort, capacity bar, tracker epics/issues, estimate vs plan, drift flags (E1), dependency arrows | Board-level financial framing | Group by team. Release plan appendix. |
| `public` | Allowlisted fields only: public title, public description, stage, quarter if `announced`, shipped link | Goals, metrics, owners, effort, internal names, customer names, dependencies, confidence numbers | Status columns plus disclaimer. Needs explicit approval of each item's public text. |

### 9. Roadmaps that show confidence or certainty

- **Conventions found.**
  - Column position as confidence (Now high, Next moderate, Later low) [S3].
  - A widening **cone of uncertainty** [S3].
  - Confidence **scored from evidence** (Gilad's Confidence Meter: opinions score
    low, test and launch data score high) [S11]. The primary page was blocked by a
    bot check, so this is described from secondary summaries.
  - **Hill-chart** position [S28].
  - **Status / health** chips (on track, at risk, off track) as on Linear
    initiatives [S19].
  - **Release-phase** labels as public confidence (exploring, in design, preview,
    GA) [S30].
  - Fuzzy or hatched bar ends on timelines (a common practice; no single primary
    source).
- **Oracle mapping.** Every item has `confidence: high | medium | low`, with an
  optional `evidence_score` from cited evidence count and type (B1 evidence), and an
  optional `health` once work has started. Rendering: a three-dot or filled-ring
  marker plus a text label, so the meaning never depends on colour alone.

### 10. Tools' published formats (summary)

| Tool | Layouts shipped | Notable for Oracle |
|------|-----------------|--------------------|
| ProdPad | Now/Next/Later with objective tags, confidence horizons [S1, S3] | Origin of the default. Objectives on cards. |
| Productboard | Columns boards and timeline boards. Swimlanes. Built around objectives, initiatives, features or releases [S12]. Now/Next/Later template [S5]. | One dataset, many boards. Audience guidance. |
| Aha! | Strategy, portfolio, releases, features/epics, starter, now-next-later. Capacity planning [S6, S26]. | Strategy roadmap = initiatives over time. Release phases. |
| ProductPlan | 12+ templates: agile, OKR, theme-based, executive portfolio, customer-facing, quarterly release, release plan [S17] | The customer-facing vs executive split confirms O5 variants. |
| Linear | Initiatives (goal level, health, target date) → projects (milestones, target dates, status updates) → issues. Roadmap timeline [S19]. Public changelog culture [S34]. | Strong fit for E1 read-back: initiatives ≈ goals, projects ≈ roadmap items. |
| Jira Product Discovery / Jira Plans | Board views by a Roadmap field (Now/Next/Later), monthly/quarterly timeline, published read-only views [S13]. Plans add capacity and dependency lines [S22]. | Published views ≈ O5 share links. |
| Notion | Database with timeline and board views. Properties: status, owner, target date, theme [S15]. | Common at startups. Oracle's export target for O1b-style snapshots. |
| Miro | Now/Next/Later(/Trash) and timeline-with-swimlane templates, dependency connectors [S16] | Workshop canvas, not a system of record. |

## Comparison table

Fit: ● strong, ◐ partial, ○ weak.

| Format | Best stage | Horizon | Primary audience | Dates | Goal traceability | Dependencies | Capacity | Public-safe | Popularity signal (2020–2026) |
|--------|-----------|---------|------------------|-------|-------------------|--------------|----------|-------------|-------------------------------|
| Now / Next / Later | Any, esp. seed–Series B | 1 quarter – 2 years | Team, company, customers | Now only | ◐ (via objective tags) | ◐ badges | ◐ Now only | ● | Built into ProdPad, Productboard, Aha!, JPD, Miro. Lenny's Podcast 2022. |
| Outcome / OKR roadmap | Seed+ with explicit goals | 1–4 quarters | Leadership, board, product | Optional | ● | ○ | ○ | ◐ (hide metrics) | Cagan 2015, Torres 2016+, ProductPlan OKR template, Linear initiatives |
| Theme-based | Multi-area, Series A+ | 2–4 quarters | Company, board | Optional | ◐ | ○ | ◐ | ● | *Roadmaps Relaunched*, ProductPlan template, Aha! theme lanes |
| Quarterly timeline / Gantt | Series B+, date-driven | 2–4 quarters | Exec, GTM, finance | ● | ◐ | ● arrows | ● | ◐ (quarter only) | Default image of "roadmap"; timeline view in every tool |
| Release plan | Any with versioned delivery | 1–2 quarters | Engineering, GTM | ● | ○ | ● | ● | ○ | Productboard, Aha!, ProductPlan templates |
| Shape Up cycles | Small, founder-led | 6–8 weeks | Team, founder | ● (cycle) | ◐ | ○ | ● (appetite) | ○ | Basecamp 2019; many practitioner write-ups 2024–25 |
| Public roadmap | Dev tools, B2B SaaS | 1–4 quarters | Customers | ○ (quarter at most) | ○ | ○ | ○ | ● | GitHub, AWS, Buffer (2023), Canny |

## Recommendation: built-in templates

Five templates (each a file in [`templates/roadmap/`](templates/roadmap/)) plus a
variant layer. Every template uses the same roadmap item model, so O4's "switch
shape" is just a re-render.

| Key | Name | Purpose | Suggest when |
|-----|------|---------|--------------|
| `now-next-later` | Now / Next / Later | **Default (O4).** Direction by confidence horizon. Dated milestones only in Now. Goal tag on every card. | Always the default. Especially early stage, fast change, or when goals are confirmed but dates beyond the quarter are not credible. |
| `outcome-roadmap` | Outcome roadmap | Rows = confirmed goals (metric, target), columns = horizons. Shows what each goal gets and flags items that serve no goal. | Board or leadership audience. A goal-setting or OKR season. A traceability report shows drift. The founder asks "are we working on the right things?" |
| `quarterly-timeline` | Quarterly timeline | Quarter axis, swimlanes by team or theme, dated bars in Now, fuzzy bars beyond, milestones, dependency arrows, capacity strip. | External dates exist (launch, contract, event, regulation). GTM or finance needs timing. Several teams with cross-dependencies. |
| `release-plan` | Release plan | Releases with target dates, scoped items, readiness, tracker links, estimate vs plan drift (E1). | Engineering audience. Versioned or app-store releases. Eng tracker connected with write or read access. |
| `cycle-bets` | Cycle bets (Shape Up) | Current cycle bets with appetite and hill position, next-cycle pitches, cool-down. | The team already works in fixed cycles or the founder wants a betting-table ritual. Small team, horizon of one cycle. |

**Audience variants** (`board`, `team`, `engineering`, `public`), defined above.
These apply to any template. Each template's layout block declares field
visibility per variant. Theme-based layout is a `group_by: theme` option, not a
template. A public roadmap is the `public` variant of Now/Next/Later, rendered as
status columns.

Why not more templates: the extra ones in tools (portfolio, UX, HR, sprint plan,
Kanban) are either groupings of the same data or delivery boards that belong in the
engineering tracker, which Oracle reads through E1 instead of copying.

### Questions the template picker should ask

Ask in this order. Each answer narrows the suggestion, and the picker shows its
reasoning in one line.

1. **Who is this roadmap for first?** Board/investors → `outcome-roadmap` with
   `board` variant. Whole team → `now-next-later`. Engineering → `release-plan`.
   Customers/public → `now-next-later` with `public` variant.
2. **Do real external dates exist in the next two quarters** (launch event,
   contract, regulation, store submission)? Yes → `quarterly-timeline`, or mark
   those items `date_kind: external` in Now/Next/Later.
3. **How far ahead should it look?** One cycle → `cycle-bets`. One or two quarters
   → `release-plan` or `quarterly-timeline`. Up to two years → `now-next-later` or
   `outcome-roadmap`. The answer also confirms or overrides the B2 horizons.
4. **How does engineering plan today?** Fixed cycles (Shape Up), sprints, or
   continuous? Is the eng tracker connected (E1)? Without tracker estimates, Oracle
   shows no dates at all, even in Now, and says so.
5. **Are company goals confirmed in the baseline?** If fewer than two are
   confirmed, warn that `outcome-roadmap` will be thin and offer the goals interview.
6. **How many teams or product areas?** Two or more → offer `group_by: team` or
   `theme` swimlanes, and show dependency arrows.
7. **Should capacity be shown?** Only offered when tracker estimates exist.
8. **Will a public version be shared?** Yes → create the `public` variant and queue
   public-text approval for each item.

## Visual conventions for HTML/PDF (inform visual themes)

General rules (all templates):

- **Page.** Landscape A4/Letter for boards and timelines, portrait for the
  narrative. Repeat the header and legend on every PDF page. Never split a card
  across pages. Long lanes continue on the next page with a "continued" label.
- **Header.** Tenant logo, roadmap title, variant badge (Board / Team / Engineering
  / Public), **as-of date**, version and approval state (O5 branding).
- **Legend** on every page: goal colours, confidence marker, status, dependency
  glyph.
- **Colour is never the only signal.** Every goal colour also has a short code
  (G1, G2 …). Confidence uses a shape plus a word. Tenant brand colours are mapped
  onto semantic tokens (goal-1…n, status-on-track/at-risk/off-track, confidence-
  high/med/low), and a contrast check runs at render time.
- **"No goal" flag**: a red-outline card with a ⚑ glyph and the words "serves no
  confirmed goal". It is visible in team and engineering variants. Such items are
  excluded from board and public views, and the render says so.
- **Footer.** Share-link expiry (if any), "generated by Oracle from approved
  version N", and for public renders, the disclaimer.

Per format:

| Format | Primary structure | Card / bar content | Confidence marker | Dependencies | Capacity |
|--------|------------------|--------------------|-------------------|--------------|----------|
| Now/Next/Later | 3 **columns**. Optional theme/goal **swimlanes** across them. Columns get wider-to-narrower detail. Optional cone graphic in the header. | Title, problem/outcome line, goal chip(s), owner (team variant), confidence, dates only in Now | Column position + ●●● / ●●○ / ●○○ + label | "after: X" badge; arrows optional in engineering variant | Load bar under the Now column header (used / available) |
| Outcome roadmap | **Matrix**: goal rows × horizon columns. Goal row header shows metric, current → target, owner. | Initiative title, contribution (0–3 as pips), confidence | Same dots | Badge only | Hidden |
| Quarterly timeline | **Timeline**: quarter/month axis, today line, team or theme **swimlanes**, bars, ◆ milestones | Bar label, goal chip, owner. Now bars solid with dates. Next/Later bars hatched with fuzzy ends and no dates. | Bar fill: solid = committed, hatched = planned, outline = exploring | Elbow arrows between bars. Red if the blocker ends after the dependent starts. | Per-lane load strip with over-capacity in a warning colour plus ⚠ |
| Release plan | **Columns or rows per release** with target date and status chip | Item, MoSCoW tag, readiness ticks (spec/design/build/QA/docs), tracker key, estimate vs plan delta | Health chip (on track / at risk / off track) | Listed per item | Release load vs capacity |
| Cycle bets | **Cycle board**: current cycle lanes per team. Next-cycle pitch column. Cool-down band. Optional **hill chart** strip. | Bet title, appetite (S/L batch), problem line, goal chip, hill position | Hill position (uphill = unknowns remain) | Rare; badge | Appetite sum vs cycle length |
| Public variant | **Status columns** (Exploring / Planned / In progress / Shipped) | Public title and one-line benefit, quarter if announced, changelog link | Stage label only | None | None |

## What could not be verified

- **No rigorous 2024–2026 survey gives format shares** (for example, what percent of
  teams use Now/Next/Later vs timelines). ProductPlan's 2024 State of Product
  Management (1,400+ responses) says 58% call roadmapping an essential job for PM
  tools, but it does not split by format [S36]. Popularity here is inferred from
  what tools ship, what sources recommend, and practitioner writing.
- The "70% of ProdPad prospects" figure appeared only in a search snippet. Not used.
- Itamar Gilad's Confidence Meter page returned a bot check. The description comes
  from secondary summaries [S11].
- The Linear Method doc URL returned 404. Linear facts come from the initiatives doc
  and Linear's planning pages [S19].
- Several popular guide pages (Productboard examples 2020, Cagan 2015, Torres
  webinar 2021) are older than 2024. They are cited for origin and definitions;
  2024–2026 sources back current practice.

## Sources and data points

| # | Source | Date | Used for |
|---|--------|------|----------|
| S1 | [ProdPad: "We invented the Now-Next-Later roadmap"](https://prodpad.com/blog/invented-now-next-later-roadmap/) | 2022-10-18 | Origin (2012), column meanings, initiatives not features, objective tags |
| S2 | [ProdPad glossary: Now-Next-Later roadmap](https://www.prodpad.com/glossary/now-next-later-roadmap/) | accessed 2026-10 | Co-inventor Simon Cast; dates only when real/external; objective linkage |
| S3 | [ProdPad glossary: Confidence horizons](https://www.prodpad.com/glossary/confidence-horizons/) | accessed 2026-10 | Columns as confidence, cone of uncertainty, items move left on evidence |
| S4 | [Lenny's Newsletter/Podcast: Building better roadmaps, Janna Bastow](https://www.lennysnewsletter.com/p/building-better-roadmaps-janna-bastow) | 2022-10-16 | Endorsement and reach |
| S5 | [Productboard: Now-Next-Later roadmap template](https://productboard.com/now-next-later-roadmap-template) | accessed 2026-10 | When to use / not use (not for execs) |
| S6 | [Aha!: Now, Next, Later roadmap template](https://www.aha.io/roadmapping/guide/templates/create/now-next-later-roadmap) | accessed 2026-10 | Theme swimlanes across columns |
| S7 | [Productboard: Plan releases](https://support.productboard.com/hc/en-us/articles/360058214113-Plan-releases-to-decide-what-to-deliver-when) | accessed 2026-10 | Release planning in tools |
| S8 | [SVPG: The Alternative to Roadmaps (Cagan)](https://www.svpg.com/the-alternative-to-roadmaps/) | 2015-09-07 | Vision, objectives, high-integrity commitments |
| S9 | [ProductPlan glossary: Opportunity solution tree](https://productplan.com/glossary/opportunity-solution-tree) | accessed 2026-10 | OST structure |
| S10 | [ProdPad glossary: Opportunity solution tree](https://www.prodpad.com/glossary/opportunity-solution-tree/) | accessed 2026-10 | Tree decides, roadmap communicates; Torres 2016 |
| S11 | [Mind the Product: Itamar Gilad, evidence-guided development](https://www.mindtheproduct.com/from-opinion-based-to-evidence-guided-product-development-by-itamar-gilad/) | accessed 2026-10 | GIST, Confidence Meter (secondary) |
| S12 | [Productboard help: Quick start guide, Roadmaps](https://support.productboard.com/hc/en-us/articles/29983922254739) | updated 2026-06-05 | Columns vs timeline boards, swimlanes, audience guidance |
| S13 | [Atlassian: Jira Product Discovery roadmaps](https://www.atlassian.com/software/jira/product-discovery/features/roadmaps) | accessed 2026-10 | Now/Next/Later board, timeline, published views per stakeholder |
| S14 | [ProdPad: The trouble with traditional timeline roadmaps](https://www.prodpad.com/resources/guides/ditch-the-timeline-roadmap/the-trouble-with-traditional-timeline-roadmaps/) | accessed 2026-10 | Gantt as the common default; critique |
| S15 | [Notion roadmap glossary (third party)](https://noteforms.com/notion-glossary/roadmap) | accessed 2026-10 | Notion timeline/board database pattern |
| S16 | [Miro: Product roadmap timeline template](https://miro.com/templates/product-roadmap-timeline/) and [Now/Next/Later/Trash](https://miro.com/templates/product-roadmap-now-next-later-trash) | accessed 2026-10 | Swimlanes, dependency connectors |
| S17 | [ProductPlan: Roadmap template examples](https://www.productplan.com/learn/roadmap-template-examples) | accessed 2026-10 | Template catalogue incl. OKR, theme, exec portfolio, customer-facing |
| S18 | [ProductPlan: Why strategic teams focus on outcome-based roadmaps](https://www.productplan.com/blog/why-strategic-product-teams-focus-on-outcome-based-roadmaps) | accessed 2026-10 | Outcome roadmaps rendered as Now/Next/Later |
| S19 | [Linear docs: Initiatives](https://linear.app/docs/initiatives) and [Linear: Plan](https://linear.app/plan) | accessed 2026-10 | Initiatives → projects, health, target dates, roadmap timeline |
| S20 | [Product Roadmaps Relaunched (book page)](https://echai.ventures/books/product-roadmaps-relaunched) | 2017 book | Theme-based roadmaps |
| S21 | [Easy Agile Roadmaps for Jira](https://marketplace.atlassian.com/apps/1215695/easy-agile-roadmaps-for-jira) | accessed 2026-10 | Theme swimlanes in Atlassian ecosystem |
| S22 | [Atlassian: Plan your work in Advanced Roadmaps (Jira Plans)](https://confluence.atlassian.com/jirasoftwareserver/plan-your-work-in-advanced-roadmaps-1044784164.html) | accessed 2026-10 | Capacity, dependency lines |
| S23 | [Appcues: A Gantt chart is not a product roadmap](https://appcues.com/blog/a-gantt-chart-is-not-a-product-roadmap) | accessed 2026-10 | Timeline critique |
| S24 | [ProdPad webinar with Teresa Torres: when leaders still want dates](https://www.prodpad.com/webinars/what-to-do-when-your-leader-still-wants-dates-on-roadmaps-with-teresa-torres/) | ~2021 | Add outcomes to existing roadmaps; dates in Now only |
| S25 | [Released.so: Boards vs timelines](https://www.released.so/articles/boards-vs-timelines) | 2025-05-09 | "Roadmap bilingualism", audience preferences, one source many views |
| S26 | [Aha!: Roadmap templates for every team](https://www.aha.io/roadmapping/roadmap-templates) | accessed 2026-10 | Strategy, portfolio, releases, features, capacity |
| S27 | [Basecamp: Shape Up, Bet, don't backlog / betting table](https://basecamp.com/shapeup/2.2-chapter-08) | 2019 | Cycles, cool-down, betting table, circuit breaker, pitches |
| S28 | [Basecamp: Hill Charts](https://basecamp.com/hill-charts) | accessed 2026-10 | Uphill/downhill confidence |
| S29 | [The uncomfortable Shape Up cool-down](https://alexdebecker.substack.com/p/the-uncomfortable-shape-up-cool-down) | accessed 2026-10 | Practitioner critique |
| S30 | [GitHub public roadmap repo](https://github.com/github/roadmap) | 2020– | Quarter columns, Exploratory, release-phase labels, disclaimer, changelog link |
| S31 | [AWS containers roadmap](https://github.com/aws/containers-roadmap) | accessed 2026-10 | Stage columns, reactions as votes, no dates |
| S32 | [Buffer: Introducing Buffer Suggestions](https://buffer.com/resources/transparent-product-roadmap-v2/) | 2023-08-09 | Voting board, stage columns |
| S33 | [Canny help: Public roadmap](https://intercom.help/canny/en/articles/3828148-public-roadmap) | accessed 2026-10 | Default Planned / In progress / Complete |
| S34 | [Linear: Startups write changelogs](https://linear.app/now/startups-write-changelogs) | 2020-05-18 | Changelog as public companion |
| S35 | [ProductPlan: Presenting your roadmap to investors and the board](https://www.productplan.com/learn/presenting-product-roadmap-to-investors) | accessed 2026-10 | Board variant content |
| S36 | [ProductPlan: 2024 State of Product Management, busy PM's guide](https://www.productplan.com/blog/the-busy-product-managers-guide-to-the-state-of-product-2024) | 2024 | 1,400+ responses; 58% roadmapping essential |
