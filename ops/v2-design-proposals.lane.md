# Lanes: v2 design proposals, 5 on Atlas and 5 on Atlas + Ledger (I3)

Ten SwarmCloud `claude-code` tasks, strategy `collect` (artifacts only), one per
proposal, run in parallel. The orchestrator reviews every rendered frame before the
owner sees any.

## Why a new round

The owner on the Atlas + Ledger blend (2026-10-19): "worse than Ledger or Atlas alone.
It's full of prose and also hard to read, and the home page presents less value than
before." What failed in the blend, so no proposal repeats it:
- every row had a second grey line under its title (context, run id, version), so screens read as paragraphs;
- 13 px grey meta text on white and light grey, which made the text hard to read;
- Home was two lists (needs you, tracks) in white cards with empty space below, with no goals, numbers, trends or requests;
- the owner liked Atlas's big numerals, the feature × goal matrix with confidence rings, and Ledger's precise tables. The blend dropped the first two.

## Common prompt (every proposal)

THE PROPOSAL `<ID>` for Product Oracle v2's visual design. Read first:
- docs/questions.md rows I3 (UI visual language, including the owner's verdict on the blend), V2b (what Oracle is for its users), P3d (cost is secondary), O4 (Now/Next/Later, no invented dates), T2, C1/C2;
- docs/product-oracle-v2/design/directions/atlas/ and .../ledger/: README, tokens.json and every HTML file;
- docs/product-oracle-v2/design/proposals/quillfield.json: the ONLY data you draw. Every number, name and state comes from it, so the ten proposals can be compared. Do not invent goals, tracks, people, counts or dates. Derived numbers (percent to target, totals) must compute from it.

Hard rules. Each one is checked on the rendered frames, and a frame that breaks one is a failed frame:
1. NO VISIBLE PROSE. UI copy is labels of one to three words, numbers, chips, icons and charts. No sentence of explanation anywhere; explanations live behind a small (i) tooltip (draw ONE open, on Home). No subtitle line under row titles. A row is one line: title, then data in columns or chips. User content (request titles, PRD requirement text, a question being asked) is content, not UI copy, and may be a sentence.
2. READABLE. Body text 15 px or more, nothing under 13 px. Every text and background pair at least 4.5:1, and body text at least 7:1. No grey text on a grey surface. Numbers in tabular figures.
3. HOME SHOWS MORE VALUE AT A GLANCE THAN ANY EARLIER MOCKUP, above the 900 px fold on desktop: (a) every goal: current vs target, a trend (sparkline or bars from trend_6m) and confidence; (b) each product track: status, next milestone, done/total, at risk; plus the PRD in review with its journey stage; (c) what needs me: counts by kind (decisions, reviews, questions) and the top items, each one line with its action; (d) requests flow: new this week, weekly trend, top themes linked to goals. Visual first: rings, bars, sparklines, heat cells; lists only where a list is the clearest form.
4. FEW CARDS. Consolidate: one place for each of the four Home blocks, not a card per number.
5. SAME PLACE ON EVERY SCREEN: title and status top-left, ONE primary action top-right, inspector (when there is one) on the right.
6. COST IS QUIET (P3d): a small figure on the cost-approval and overrun items only.
7. Nothing Oracle does not have or v2 does not add. Navigation: Home, Requests, Baseline, PRDs, Priorities, Roadmap, Runs, Inbox, Settings.

Screens (static HTML, Google Fonts only, no other network):
- `home`: the four blocks of rule 3;
- `requests`: feature requests and feedback: sources, merged duplicates, goal links, each qualified or disqualified with a reason, filters by state; the themes;
- `prd-review`: Online deposits at booking v3, Functional requirements r4 in review: the journey track, versions and Brief/Full, section status, reviewers, the evidence for the one claim, the suggestions (accept, or reject with a reason), composition and the two blockers;
- `roadmap`: Now/Next/Later from the priority snapshot, per track, with the at-risk item and the slipped milestone, and Online deposits pending publish. No dates.

Render with Playwright to PNG, exactly six frames:
`home-light-desktop`, `home-dark-desktop`, `home-light-mobile`, `requests-light-desktop`, `prd-review-light-desktop`, `roadmap-light-desktop`.
Desktop is 1440×900 (full-page if taller, but rule 3 must hold above 900 px). Phone is 390 wide, the viewport sized to the page height so fixed bars sit at the bottom, with no horizontal scroll. Dark is a real theme, not an inversion.

Before finishing, open every PNG and check it against rules 1–7, and check that nothing is drawn twice, no text is clipped or overlapping, and every count agrees with the data file. Fix, re-render, look again.

Put under `$SWARM_ARTIFACTS_DIR/<ID>/`: the six PNGs, the HTML, `tokens.json`, a `README.md` of at most ten lines (the angle, in labels, not paragraphs) and `report.md` (contrast table for every text and background pair used, rule check per frame, anything you could not render). Never use real company data. Do not open a pull request.

## The ten proposals

Each angle is a starting point. Keep it distinct from the other nine.

### On Atlas: its type (Bricolage Grotesque, Inter, JetBrains Mono), violet with a rare lime "now", icon rail, big numerals, journey track, matrix

- **A1 Cockpit.** Home is a dashboard. A dark hero band holds the four goals as big numerals with sparklines and target rings; below it, tracks as compact lanes and a needs-me rail. Bold and immediate.
- **A2 Map.** Home is the feature × goal matrix itself, as a heat map, with goal progress as column headers and needs-me badges on the cells and rows they touch. Requests and roadmap are small side panels. Spatial.
- **A3 Journeys.** Home is organised by work in flight: one horizontal lane per track and per PRD in review, each with its journey or milestone progress, the goal it moves (with that goal's trend) and its waiting items inline. Goals sit as a slim scoreboard on top.
- **A4 Calm.** Atlas toned down: white surfaces, violet only, lime only for "now", 16 px body, a single centred column of wide sections, big numbers with lots of air. Home reads top to bottom: goals, needs me, tracks, requests.
- **A5 Bento.** Home is a bento grid of visual tiles of different sizes: goal rings, the request funnel and weekly bars, Now/Next/Later in miniature, a needs-me tile with counts. Charts over lists.

### On Atlas + Ledger: Atlas's numerals, colour and journey with Ledger's tables (IBM Plex or Inter with tabular figures), hairlines and in-place inspectors

- **B1 Split.** Master and detail on every screen: a precise Ledger table on the left and an Atlas-styled visual inspector on the right. Home is a KPI strip of big numerals with a table of everything waiting or moving, and the selected row's inspector.
- **B2 Command.** Two bands: an Atlas scoreboard band (goals with numerals and trend, requests flow) over a dense Ledger table of tracks and PRDs with sparkline and progress columns. Dark navigation.
- **B3 Timeline.** Home is built on Now/Next/Later: tracks as hairline rows across the three columns with milestones, goals as markers, and needs-me pinned as chips at the top. The roadmap is the spine of the product.
- **B4 Triage.** Home is one prioritised queue, a Ledger table with one-line rows and inline actions (approve, answer, open), under an Atlas goal-health header of four numerals with trends. Built for clearing work fast.
- **B5 Scorecard.** Home is a goal scorecard: one row per goal with current, target, trend, confidence and the features and tracks that move it (Ledger precision, Atlas colour for status), then needs-me counts and requests by theme.
