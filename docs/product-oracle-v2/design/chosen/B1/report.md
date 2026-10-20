# B1 Split · round 2 · report

Rendered with Playwright (Chromium headless shell), Google Fonts from the network. Desktop is 1440×900; every desktop frame fits in 900 px, so no screen scrolls. Phone is 390 wide, with the viewport sized to the page height so the tab bar sits at the bottom. After each render, `src/render.mjs` checks for truncated or clipped text, text under 13 px, wrapped rows and horizontal scroll. Final run: 0 truncated, 0 under 13 px, scroll width 1440 / 390 everywhere. The only wrapped rows are on the PRD review phone frame (see notes).

## Owner's notes and how each was applied

| Note | Applied |
|---|---|
| Master and detail on every screen | All nine screens: a Ledger table left (908 px), the inspector right (380 px), same place on every screen. On the phone, the inspector is drawn open below the table |
| Precise table left, dark-headed visual inspector right | Hairline one-line rows, tabular numbers; inspector with dark `hero` head, big numerals, rings, sparklines, journey track |
| Selected row's inspector open | Home: PRD in review · Requests: deposit request · Baseline: Check-in feature · Interview: waiting gap · PRD review: claim · Priorities: rank 1 · Roadmap: Check-in v1.1 · Runs: run 0412, segment 3 · Publish: block 1 |
| PRD review claim above the requirements, never a row | Claim is its own tinted block between the section header and FR-1…FR-4; its evidence (81 confidence, 14 items, 3 sources) is in the inspector only |
| Body 15 px, one-line rows, no second grey line | Body Inter 15/22; no row has a sub-line; column widths measured so titles fit without ellipsis. Tabular figures only on numbers (round 1 set them on the whole body, which spaced out hyphens) |
| Every number from quillfield.json | Built by `src/make.mjs` from `src/quillfield.json` (a copy of docs/product-oracle-v2/design/proposals/quillfield.json); derived numbers listed below |
| Round 2 facts: distance to go | "5 pts to go", "1.6 min to go", "164 to go", "0.4 to go" on Home, Baseline headers, Priorities by goal, every inspector goal block; rings show confidence |
| Online deposits is "In flight", joins after publish | Home "In flight" table · Roadmap "In flight" group under Later, never inside Now |

## Rule check per frame

Rules 1–7 from ops/v2-design-proposals.lane.md. "pass" for all four columns, unless noted.

| Frame | 1 No prose | 2 Readable | 3 Home value | 4 Few cards | 5 Same place | 6 Cost quiet | 7 Scope |
|---|---|---|---|---|---|---|---|
| home light / dark | pass; one (i) tooltip open | pass | pass: goals (current/target, 6-month trend, confidence, to go), In flight (status, next, done/total, risk; PRD with journey stage), Needs you 7 = 3/2/2 with actions, requests (9 new, 8-week bars, top themes → goals), all above 900 | 4 places + inspector | title + "7 waiting", "New idea", inspector right | $64.00 est. and $27.60 / $18.00 only | pass |
| home phone | pass | pass | blocks stacked; status chips become a coloured dot (see notes) | pass | pass | costs kept visible | tabs Home, PRDs, Roadmap, Inbox, More |
| requests light / dark | request titles are content | pass | n/a | strip + table + inspector | "Add request" | none | pass |
| baseline light / dark | pass | pass; goal names in headers at 13 px | n/a | count strip + matrix + inspector | "Run baseline" | none | pass |
| idea-interview light / dark / phone | questions and answers are content | pass | n/a | chat + inspector | "Finish interview" | none | four quick replies; no typing indicator, the waiting turn says "Waiting for you" |
| prd-review light / dark / phone | requirements, claim, suggestions are content | pass | n/a | journey, sections strip, document, inspector | "Approve r4" | none | pass |
| priorities light / dark | pass | pass | n/a | table + by-goal table + inspector | "Save order"; drag handles | none | pass |
| roadmap light / dark / phone | pass | pass | n/a | table + inspector | "Run roadmap" (the roadmap is derived; no moving of milestones) | none | Now/Next/Later only, snapshot label P-7, no dates |
| runs light / dark | pass | pass | n/a | runs + segments + inspector | "New run"; inspector actions are secondary | $64.00 est. and $27.60 / $18.00 on the approval and overrun rows; run 0412's $18.40 of $22.00 est. is one small mono figure in the inspector head (question for the owner in questions.json) | segments and roles exactly as in `runs` |
| publish light / dark | one sentence: "Only an owner can accept this risk", the required approver message | pass | n/a | one table (blocks, 4 hard checks, 10 advisory) + inspector | "Publish v3" disabled | none | owners-only risk acceptance |

Open decisions never carry a done check: checks appear only on approved sections, succeeded segments, passed checks and the accepted suggestion.

## Counts against quillfield.json

Needs you 7 (3 decisions, 2 reviews, 2 questions), Inbox badge 7 · goals to go 92−87=5 pts, 4.6−3=1.6 min, 400−236=164, 1.9−1.5=0.4 · 6-month change +3, −1.4, +56, −0.4 · tracks 6/9 and 4/7, 1 at risk, 2 slipped · PRD journey 8/9, 2 blockers (1 critical), sections 4 approved / 1 in review / 3 draft of 8, waiting on Online deposits 5 · requests 41 = 3 new + 24 qualified + 8 merged + 6 disqualified; sources 18+11+7+5 = 41; 9 new this week; 8 of 41 rows; the selected request has 6 + 5 merged = 11 mentions · baseline 3/4 goals, 5/6 features traced, 86 evidence items, 6 sources, flagged 1, conflicts 2, proposals 3; low-confidence links 2 = links under 0.6 (0.57, 0.31) · claim evidence 12+1+1 = 14, confidence 81 · composition 6+2+1 = 9 · interview gaps 3 open / 5 answered / 1 critical · priorities 7 = Now 2 + Next 2 + Pending 2 + Unplanned 1; by goal G1 3 (top #3), G2 2 (#1), G3 2 (#2), G4 0 · roadmap Now 2 / Next 2 / Later 1 / In flight 1 · runs 3; 0412 has 3 of 4 segments succeeded, segment 3 waiting for "approver or above", 3 proposed items · publish 2 blocks, 4 hard checks (2 fail: 4 of 8, 1 open), advisory 7 pass / 2 warning / 1 critical.

## Contrast (every text and background pair used)

Body text needs 7:1, everything else 4.5:1. From `src/contrast.py` on the CSS tokens. 0 failures.

| Theme | Text | Background | Use | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| light | `text` #16132c | `surface` #ffffff | body | 18.05 | 7 | pass |
| light | `text` #16132c | `bg` #f5f4fb | body | 16.51 | 7 | pass |
| light | `text` #16132c | `surface2` #efedf8 | body (table head, chat bubble, approver box) | 15.59 | 7 | pass |
| light | `text` #16132c | `accent-soft` #ebe6ff | body (selected row, claim) | 14.86 | 7 | pass |
| light | `text2` #3f3a63 | `surface` #ffffff | label, cost | 10.52 | 4.5 | pass |
| light | `text2` #3f3a63 | `bg` #f5f4fb | label | 9.62 | 4.5 | pass |
| light | `text2` #3f3a63 | `surface2` #efedf8 | label (table head) | 9.08 | 4.5 | pass |
| light | `text2` #3f3a63 | `accent-soft` #ebe6ff | label (selected row) | 8.66 | 4.5 | pass |
| light | `accent-ink` #3d23b8 | `surface` #ffffff | link, count, run id | 9.85 | 4.5 | pass |
| light | `accent-ink` #3d23b8 | `accent-soft` #ebe6ff | chip, goal id, claim label | 8.12 | 4.5 | pass |
| light | `on-accent` #ffffff | `accent` #5a3cf0 | primary button, own chat bubble | 6.29 | 4.5 | pass |
| light | `pass` #0d6a4c | `pass-bg` #d9f4e8 | chip | 5.67 | 4.5 | pass |
| light | `warn` #7a3f00 | `warn-bg` #ffecd0 | chip | 7.15 | 4.5 | pass |
| light | `crit` #a3122f | `crit-bg` #ffe1e8 | chip | 6.40 | 4.5 | pass |
| light | `na` #46416b | `na-bg` #ebe9f3 | chip | 7.84 | 4.5 | pass |
| light | `pass` #0d6a4c | `surface` #ffffff | delta, check icon | 6.60 | 4.5 | pass |
| light | `crit` #a3122f | `surface` #ffffff | numeral, blocker icon | 7.82 | 4.5 | pass |
| light | `warn` #7a3f00 | `surface` #ffffff | numeral | 8.27 | 4.5 | pass |
| light | `hero-text` #f3f1ff | `hero` #1c1838 | inspector title, waiting question | 15.23 | 4.5 | pass |
| light | `hero-text2` #d4cff5 | `hero` #1c1838 | inspector label, run cost | 11.35 | 4.5 | pass |
| light | `hero-text` #f3f1ff | `hero-2` #2a2550 | inspector chip | 12.74 | 4.5 | pass |
| light | `on-lime` #16132c | `lime` #c8f169 | now chip, nav active, Oracle avatar | 13.96 | 4.5 | pass |
| light | `nav-text` #d4cff5 | `nav` #16132c | nav label | 12.07 | 4.5 | pass |
| light | `tip-text` #f3f1ff | `tip` #16132c | tooltip | 16.19 | 4.5 | pass |
| dark | `text` #f1efff | `surface` #17152b | body | 15.72 | 7 | pass |
| dark | `text` #f1efff | `bg` #0e0d1a | body | 16.98 | 7 | pass |
| dark | `text` #f1efff | `surface2` #1f1c38 | body (table head, chat bubble, approver box) | 14.46 | 7 | pass |
| dark | `text` #f1efff | `accent-soft` #2a2357 | body (selected row, claim) | 12.55 | 7 | pass |
| dark | `text2` #c9c4ec | `surface` #17152b | label, cost | 10.68 | 4.5 | pass |
| dark | `text2` #c9c4ec | `bg` #0e0d1a | label | 11.54 | 4.5 | pass |
| dark | `text2` #c9c4ec | `surface2` #1f1c38 | label (table head) | 9.83 | 4.5 | pass |
| dark | `text2` #c9c4ec | `accent-soft` #2a2357 | label (selected row) | 8.53 | 4.5 | pass |
| dark | `accent-ink` #c3b8ff | `surface` #17152b | link, count, run id | 9.86 | 4.5 | pass |
| dark | `accent-ink` #c3b8ff | `accent-soft` #2a2357 | chip, goal id, claim label | 7.87 | 4.5 | pass |
| dark | `on-accent` #120f26 | `accent` #a796ff | primary button, own chat bubble | 7.53 | 4.5 | pass |
| dark | `pass` #5fe0a9 | `pass-bg` #0f2b22 | chip | 9.16 | 4.5 | pass |
| dark | `warn` #ffc46e | `warn-bg` #2f2413 | chip | 9.67 | 4.5 | pass |
| dark | `crit` #ff8ca6 | `crit-bg` #3a1426 | chip | 7.30 | 4.5 | pass |
| dark | `na` #c9c4ec | `na-bg` #221f3a | chip | 9.50 | 4.5 | pass |
| dark | `pass` #5fe0a9 | `surface` #17152b | delta, check icon | 10.79 | 4.5 | pass |
| dark | `crit` #ff8ca6 | `surface` #17152b | numeral, blocker icon | 8.11 | 4.5 | pass |
| dark | `warn` #ffc46e | `surface` #17152b | numeral | 11.35 | 4.5 | pass |
| dark | `hero-text` #f3f1ff | `hero` #241f4a | inspector title, waiting question | 13.75 | 4.5 | pass |
| dark | `hero-text2` #d4cff5 | `hero` #241f4a | inspector label, run cost | 10.25 | 4.5 | pass |
| dark | `hero-text` #f3f1ff | `hero-2` #2e2860 | inspector chip | 11.86 | 4.5 | pass |
| dark | `on-lime` #16132c | `lime` #c8f169 | now chip, nav active, Oracle avatar | 13.96 | 4.5 | pass |
| dark | `nav-text` #c9c4ec | `nav` #07060f | nav label | 12.08 | 4.5 | pass |
| dark | `tip-text` #16132c | `tip` #f1efff | tooltip | 15.92 | 4.5 | pass |

## Notes, choices, what I could not do

- **Advisory criteria:** names are the ten T2 criteria from build-prompt.md §18, shortened to labels. quillfield.json gives only the counts (7/2/1), so which ones warn or fail is my choice: critical = blocker and feasibility (the open same-day refund gap); warnings = business goal alignment (cites proposed G4) and scope / testable requirements (FR-3 same-day gap). `src/screens.mjs` fails the build if the counts drift from the data.
- **Roadmap:** round 1's track × horizon grid truncated every milestone at 15 px. It is now one table grouped under Now / Next / Later headers, one line per milestone, with the track as a column. The inspector covers the selected milestone, not the track's lanes, so nothing is drawn twice.
- **PRD review:** reviewers moved from the sections strip into the inspector, because the strip ran past 1440 px.
- **Phone wrapping:** on the PRD review phone frame, requirement and suggestion sentences wrap to two or three lines. They are user content and cannot fit 390 px at 15 px without truncation. Every UI row stays on one line.
- **Phone status:** on the Home phone frame, "In flight" status chips show only their coloured dot so the track names fit on one line without ellipsis. The label stays in the accessible name; desktop shows the full chip.
- **Interview journey:** the interview shows step Gaps (3/9) because `idea_interview.step` says so, while the PRD's own journey is at Review. The data has both; I drew each where it belongs.
- **Primary actions:** "Run baseline", "Finish interview", "Save order" and "New run" are my labels for each screen's single primary action. The data does not name them.
- Rendering needed Chromium's system libraries unpacked locally (no root). The look is unaffected.
