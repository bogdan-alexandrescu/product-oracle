# B1 Split · report

Frames rendered with Playwright (Chromium headless shell), Google Fonts loaded from the network.
Desktop is 1440×900 and phone is 390 wide, with the viewport sized to the page height.
After every render, `src/render.mjs` checks for clipped text (none) and for text under 13 px (none), and checks horizontal scroll width: 1440 on desktop, 390 on phone, so there is no horizontal scroll.

## Contrast (every text and background pair used)

Body text needs 7:1, everything else 4.5:1. Computed by `src/contrast.py` from the CSS tokens. 0 failures.

| Theme | Text | Background | Use | Ratio | Need | Result |
|---|---|---|---|---|---|---|
| light | `text` #16132c | `surface` #ffffff | body | 18.05 | 7 | pass |
| light | `text` #16132c | `bg` #f5f4fb | body | 16.51 | 7 | pass |
| light | `text` #16132c | `surface2` #efedf8 | body | 15.59 | 7 | pass |
| light | `text` #16132c | `accent-soft` #ebe6ff | body (selected row) | 14.86 | 7 | pass |
| light | `text2` #3f3a63 | `surface` #ffffff | label | 10.52 | 4.5 | pass |
| light | `text2` #3f3a63 | `bg` #f5f4fb | label | 9.62 | 4.5 | pass |
| light | `text2` #3f3a63 | `surface2` #efedf8 | label (table head) | 9.08 | 4.5 | pass |
| light | `text2` #3f3a63 | `accent-soft` #ebe6ff | label (selected row) | 8.66 | 4.5 | pass |
| light | `accent-ink` #3d23b8 | `surface` #ffffff | link, count | 9.85 | 4.5 | pass |
| light | `accent-ink` #3d23b8 | `accent-soft` #ebe6ff | chip, id | 8.12 | 4.5 | pass |
| light | `on-accent` #ffffff | `accent` #5a3cf0 | primary button | 6.29 | 4.5 | pass |
| light | `pass` #0d6a4c | `pass-bg` #d9f4e8 | chip | 5.67 | 4.5 | pass |
| light | `warn` #7a3f00 | `warn-bg` #ffecd0 | chip | 7.15 | 4.5 | pass |
| light | `crit` #a3122f | `crit-bg` #ffe1e8 | chip | 6.40 | 4.5 | pass |
| light | `na` #46416b | `na-bg` #ebe9f3 | chip | 7.84 | 4.5 | pass |
| light | `pass` #0d6a4c | `surface` #ffffff | delta figure | 6.60 | 4.5 | pass |
| light | `crit` #a3122f | `surface` #ffffff | numeral | 7.82 | 4.5 | pass |
| light | `warn` #7a3f00 | `surface` #ffffff | numeral | 8.27 | 4.5 | pass |
| light | `hero-text` #f3f1ff | `hero` #1c1838 | inspector title | 15.23 | 4.5 | pass |
| light | `hero-text2` #d4cff5 | `hero` #1c1838 | inspector label | 11.35 | 4.5 | pass |
| light | `hero-text` #f3f1ff | `hero-2` #2a2550 | inspector chip | 12.74 | 4.5 | pass |
| light | `on-lime` #16132c | `lime` #c8f169 | now chip, nav active | 13.96 | 4.5 | pass |
| light | `nav-text` #d4cff5 | `nav` #16132c | nav label | 12.07 | 4.5 | pass |
| light | `tip-text` #f3f1ff | `tip` #16132c | tooltip | 16.19 | 4.5 | pass |
| dark | `text` #f1efff | `surface` #17152b | body | 15.72 | 7 | pass |
| dark | `text` #f1efff | `bg` #0e0d1a | body | 16.98 | 7 | pass |
| dark | `text` #f1efff | `surface2` #1f1c38 | body | 14.46 | 7 | pass |
| dark | `text` #f1efff | `accent-soft` #2a2357 | body (selected row) | 12.55 | 7 | pass |
| dark | `text2` #c9c4ec | `surface` #17152b | label | 10.68 | 4.5 | pass |
| dark | `text2` #c9c4ec | `bg` #0e0d1a | label | 11.54 | 4.5 | pass |
| dark | `text2` #c9c4ec | `surface2` #1f1c38 | label (table head) | 9.83 | 4.5 | pass |
| dark | `text2` #c9c4ec | `accent-soft` #2a2357 | label (selected row) | 8.53 | 4.5 | pass |
| dark | `accent-ink` #c3b8ff | `surface` #17152b | link, count | 9.86 | 4.5 | pass |
| dark | `accent-ink` #c3b8ff | `accent-soft` #2a2357 | chip, id | 7.87 | 4.5 | pass |
| dark | `on-accent` #120f26 | `accent` #a796ff | primary button | 7.53 | 4.5 | pass |
| dark | `pass` #5fe0a9 | `pass-bg` #0f2b22 | chip | 9.16 | 4.5 | pass |
| dark | `warn` #ffc46e | `warn-bg` #2f2413 | chip | 9.67 | 4.5 | pass |
| dark | `crit` #ff8ca6 | `crit-bg` #3a1426 | chip | 7.30 | 4.5 | pass |
| dark | `na` #c9c4ec | `na-bg` #221f3a | chip | 9.50 | 4.5 | pass |
| dark | `pass` #5fe0a9 | `surface` #17152b | delta figure | 10.79 | 4.5 | pass |
| dark | `crit` #ff8ca6 | `surface` #17152b | numeral | 8.11 | 4.5 | pass |
| dark | `warn` #ffc46e | `surface` #17152b | numeral | 11.35 | 4.5 | pass |
| dark | `hero-text` #f3f1ff | `hero` #241f4a | inspector title | 13.75 | 4.5 | pass |
| dark | `hero-text2` #d4cff5 | `hero` #241f4a | inspector label | 10.25 | 4.5 | pass |
| dark | `hero-text` #f3f1ff | `hero-2` #2e2860 | inspector chip | 11.86 | 4.5 | pass |
| dark | `on-lime` #16132c | `lime` #c8f169 | now chip, nav active | 13.96 | 4.5 | pass |
| dark | `nav-text` #c9c4ec | `nav` #07060f | nav label | 12.08 | 4.5 | pass |
| dark | `tip-text` #16132c | `tip` #f1efff | tooltip | 15.92 | 4.5 | pass |

## Rule check per frame

| Frame | 1 No prose | 2 Readable | 3 Home value | 4 Few cards | 5 Same place | 6 Cost quiet | 7 Nav and scope |
|---|---|---|---|---|---|---|---|
| home-light-desktop | pass: labels, chips, numbers; one (i) tooltip open (Confidence and target) | pass: body 15 px, min 13 px, tnum | pass: whole page is 900 px. Goals: current/target, 6-month sparkline with dashed target, confidence ring, 6-month change, gap to target. Moving: status, next milestone, done/total, risk, plus the PRD in review with its stage. Needs you: 7 = 3 decisions + 2 reviews + 2 questions, each one line with its action. Requests: 9 new, 8-week bars, top 3 themes with goal | pass: 4 places (Goals strip, Requests, Needs you + Moving table, inspector) | pass: title and status top-left, "New idea" top-right, inspector right | pass: $64.00 est. and $27.60 / $18.00 on those 2 rows only | pass |
| home-dark-desktop | same as light | pass: own dark tokens (Atlas indigo), not inverted | same | same | same | same | same |
| home-light-mobile | pass | pass | blocks stacked: goals 2×2, Needs you, Moving, Requests; the inspector opens as a sheet on tap, so it is not drawn | pass | title and status top-left, primary top-right, tab bar fixed at the bottom | pass | tabs: Home, Requests, PRDs, Inbox, More |
| requests-light-desktop | pass: request titles are user content | pass | n/a | strip (sources, merged duplicates, themes) + table + inspector | pass: "Add request" | n/a | pass |
| prd-review-light-desktop | pass: requirement, claim and suggestion text are content | pass | n/a | sections + composition, document + suggestions, inspector | pass: "Approve r4" | n/a | pass |
| roadmap-light-desktop | pass | pass | n/a | table + inspector | pass: "Derive roadmap" | n/a | pass: no dates, snapshot id only |

## Counts checked against quillfield.json

Needs you 7 (3/2/2) · Inbox badge 7 · waiting on Online deposits 5 · requests 41 open = 3 new + 24 qualified + 8 merged + 6 disqualified · sources 18+11+7+5 = 41 · 9 new this week · sections 4 approved / 1 in review / 3 draft of 8 · composition 6+2+1 = 9 · claim evidence 12+1+1 = 14 · Now 2 / Next 2 / Later 1 · goal deltas from trend_6m: +3, −1.4, +56, −0.4 · to go: 5, 1.6, 164, 0.4 · track done 6/9 and 4/7.

## Notes and what I could not render

- Each frame draws its data once. Where the master row and the inspector both mention something, the inspector adds detail the row does not have (journey steps, blocker text, reviewer verdicts).
- The open tooltip on Home sits over empty topbar space, on purpose.
- Some phone rows wrap long content (track names, "Same-day cancellation refund?") onto a second line. They are not clipped.
- Data choices: the "8 of 41" footer on Requests is there because the file has 8 rows of 41 open. Roadmap shows the snapshot id P-7 without its date, to keep the screen free of dates.
- Rendering needed Chromium's system libraries unpacked locally (no root access). The look is unaffected.
