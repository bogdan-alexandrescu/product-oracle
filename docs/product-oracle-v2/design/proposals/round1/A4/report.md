# A4 Calm: report

## Contrast (WCAG 2.x, every text/background pair used)
Body pairs need 7:1, labels and chips need 4.5:1. Computed by `src/contrast.js` from `tokens.json`.

| Theme | Text | Background | Used for | Ratio | Needs | Result |
|---|---|---|---|---|---|---|
| light | `text` #16132c | `bg` #ffffff | body: titles, rows, numerals | 18.05 | 7:1 | pass |
| light | `text2` #433e66 | `bg` #ffffff | body: labels, context, ages | 9.91 | 7:1 | pass |
| light | `text` #16132c | `surface2` #f5f4fa | plain chip, segmented control | 16.50 | 7:1 | pass |
| light | `accentText` #4527d6 | `bg` #ffffff | kind labels, links, FR ids | 8.35 | 4.5:1 | pass |
| light | `onAccent` #ffffff | `accent` #5a3cf0 | primary button, selected filter | 6.29 | 4.5:1 | pass |
| light | `accentSoftText` #3a21b0 | `accentSoft` #efebff | goal id chip, current section | 8.89 | 4.5:1 | pass |
| light | `text` #16132c | `accentSoft` #efebff | claim highlight | 15.47 | 7:1 | pass |
| light | `pass` #0d6a4c | `passBg` #e1f5eb | chip: on track, qualified, approved | 5.80 | 4.5:1 | pass |
| light | `warn` #874400 | `warnBg` #fff0d9 | chip: drifting, at risk, slipped | 6.55 | 4.5:1 | pass |
| light | `crit` #ad1438 | `critBg` #ffe6ec | chip: disqualified, rejected | 6.06 | 4.5:1 | pass |
| light | `na` #46425f | `naBg` #efedf6 | chip: proposed, merged, pending | 8.22 | 4.5:1 | pass |
| light | `info` #3a21b0 | `infoBg` #efebff | chip: in review, new, open | 8.89 | 4.5:1 | pass |
| light | `pass` #0d6a4c | `bg` #ffffff | 6-month change (good) | 6.60 | 4.5:1 | pass |
| light | `crit` #ad1438 | `bg` #ffffff | at risk, blockers, reasons | 7.16 | 4.5:1 | pass |
| light | `warn` #874400 | `bg` #ffffff | cost figure | 7.35 | 4.5:1 | pass |
| light | `tipText` #f3f1ff | `tipBg` #16132c | tooltip | 16.19 | 7:1 | pass |
| light | `railText` #433e66 | `railBg` #ffffff | rail and tab labels | 9.91 | 7:1 | pass |
| light | `railActiveText` #3a21b0 | `railActiveBg` #efebff | active rail item | 8.89 | 7:1 | pass |
| light | `onBadge` #ffffff | `badge` #5a3cf0 | inbox count badge | 6.29 | 4.5:1 | pass |
| light | `onLime` #16132c | `lime` #c8f169 | journey: current step | 13.96 | 7:1 | pass |
| light | `lime` #c8f169 | `onLime` #16132c | journey: current step number | 13.96 | 7:1 | pass |
| dark | `text` #f1efff | `bg` #100f1e | body: titles, rows, numerals | 16.71 | 7:1 | pass |
| dark | `text2` #c9c4ec | `bg` #100f1e | body: labels, context, ages | 11.35 | 7:1 | pass |
| dark | `text` #f1efff | `surface2` #1c1a33 | plain chip, segmented control | 14.88 | 7:1 | pass |
| dark | `accentText` #b9adff | `bg` #100f1e | kind labels, links, FR ids | 9.45 | 4.5:1 | pass |
| dark | `onAccent` #120f26 | `accent` #a796ff | primary button, selected filter | 7.53 | 4.5:1 | pass |
| dark | `accentSoftText` #dcd6ff | `accentSoft` #2b2459 | goal id chip, current section | 10.08 | 4.5:1 | pass |
| dark | `text` #f1efff | `accentSoft` #2b2459 | claim highlight | 12.36 | 7:1 | pass |
| dark | `pass` #6fe3b0 | `passBg` #123029 | chip: on track, qualified, approved | 8.98 | 4.5:1 | pass |
| dark | `warn` #ffc46e | `warnBg` #33270f | chip: drifting, at risk, slipped | 9.30 | 4.5:1 | pass |
| dark | `crit` #ff92aa | `critBg` #3d1628 | chip: disqualified, rejected | 7.40 | 4.5:1 | pass |
| dark | `na` #cdc9e8 | `naBg` #252240 | chip: proposed, merged, pending | 9.49 | 4.5:1 | pass |
| dark | `info` #d0c8ff | `infoBg` #2b2459 | chip: in review, new, open | 8.93 | 4.5:1 | pass |
| dark | `pass` #6fe3b0 | `bg` #100f1e | 6-month change (good) | 11.98 | 4.5:1 | pass |
| dark | `crit` #ff92aa | `bg` #100f1e | at risk, blockers, reasons | 8.97 | 4.5:1 | pass |
| dark | `warn` #ffc46e | `bg` #100f1e | cost figure | 12.06 | 4.5:1 | pass |
| dark | `tipText` #16132c | `tipBg` #f1efff | tooltip | 15.92 | 7:1 | pass |
| dark | `railText` #c9c4ec | `railBg` #0b0a16 | rail and tab labels | 11.78 | 7:1 | pass |
| dark | `railActiveText` #f1efff | `railActiveBg` #2b2459 | active rail item | 12.36 | 7:1 | pass |
| dark | `onBadge` #120f26 | `badge` #a796ff | inbox count badge | 7.53 | 4.5:1 | pass |
| dark | `onLime` #16132c | `lime` #c8f169 | journey: current step | 13.96 | 7:1 | pass |
| dark | `lime` #c8f169 | `onLime` #16132c | journey: current step number | 13.96 | 7:1 | pass |

Non-text marks (bars, rings, lime dots) are not text. The lime dot on white has a darker `limeEdge` outline (#6e8f12) so it stays visible.

## Type sizes
Body 16 px. Smallest text 13 px: column heads, rail and tab labels, goal-id chips, tooltip body, axis labels. Every numeral uses `font-variant-numeric: tabular-nums` (checked: Bricolage "111111" and "000000" render at the same width).

## Derived numbers (computed in `src/build.js`)
- To go = |target − current|: G1 5 pts, G2 1.6 min, G3 164, G4 0.4
- 6-month change = current − trend_6m[0]: +3, −1.4, +56, −0.4 (green when it moves the way `better` says)
- Confidence ring = confidence × 100: 84, 66, 58, 34; claim 81
- Needs you: 3 decisions + 2 reviews + 2 questions = 7 (rail badge, "All 7")
- Request filters: New 3 (unreviewed) + Qualified 24 + Merged 8 + Disqualified 6 = 41 open; sources 18+11+7+5 = 41
- Evidence total 12+1+1 = 14; sections approved 4/8; open suggestions 2
- Journey: step 8 of 9 (journey_index); track progress 6/9 and 4/7

## Rule check per frame
| Frame | 1 No prose | 2 Readable | 3 Home value | 4 Few cards | 5 Same place | 6 Quiet cost | 7 Nothing extra |
|---|---|---|---|---|---|---|---|
| home-light-desktop | pass: labels and numbers only; one (i) open with the explanation | pass | pass: goals (current → target, sparkline, ring), needs you (3/2/2 + 4 one-line items with actions), tracks + PRD in review (status, Now milestone, done/total, at risk, journey 8/9), requests (9 new, 8-week bars, 41 open, 3 unreviewed, top 4 themes → goals); all end at about 875 px | pass: 4 sections, 0 cards | pass: Home + chip top-left, New idea top-right | pass: one figure, on the Overrun row only | pass |
| home-dark-desktop | pass | pass: dark tokens, not an inversion | pass: same layout | pass | pass | pass | pass |
| home-light-mobile | pass; tooltip closed on phone | pass; 390 wide, no horizontal scroll (scrollWidth 390) | blocks stack in the same order | pass | pass: tab bar fixed at the bottom | pass | pass: Home, Requests, PRDs, Inbox, More |
| requests-light-desktop | pass: request titles are user content | pass | n/a | pass: themes and sources strip, then the table | pass: Add request top-right | n/a | pass: sources, merged duplicate, goal links, reasons, state filters, themes → goal → PRD |
| prd-review-light-desktop | pass: requirement, claim, blocker and suggestion text is content | pass | n/a | pass | pass: Approve r4 top-right, inspector right (evidence, suggestions, composition) | n/a | pass: journey track, v1–v3, Brief/Full, 8 sections, 3 reviewers, 4 suggestions (2 Accept/Reject, 1 rejected with a reason, 1 accepted), 2 blockers |
| roadmap-light-desktop | pass | pass | n/a | pass | pass: Start roadmap run top-right, inspector right | n/a | pass: Now/Next/Later from P-7, at-risk Check-in v1.1 (SMS arrival link), v1.2 kiosk mode slipped from Now, Online deposits pending publish; no dates |

Also checked on every frame: nothing drawn twice (the r4 tag was removed from the section list because the doc header already shows it), no clipped or overlapping text, and every count matches quillfield.json.

## Judgement calls
- The roadmap status chip reads "Snapshot P-7". The snapshot date "16 Oct" is left out because of the no-dates rule.
- Home shows 4 of the 7 needs-you items: one checkpoint, the overrun, one review and one question. The cost-approval item (4.00 estimate) is behind "All 7".
- Home shows the top 4 themes. Requests shows all 5.
- G3's target is shown as "400" and G4's as "1.5". The "by end of 2027" part of G3's target text is not drawn.

## Rendering
Playwright 1.x with Chromium headless shell, 1440×900 at 1×, full page. The phone frame's viewport is resized to the page height (1857 px). Fonts load from Google Fonts. The container had no system libraries for Chromium, so they were extracted from Debian bookworm packages into /tmp/sysroot (see `src/run.sh`). Every frame rendered; nothing is missing.
