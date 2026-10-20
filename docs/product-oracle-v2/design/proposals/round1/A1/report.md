# A1 Cockpit: report

## Build
- `src/build.py` reads `docs/product-oracle-v2/design/proposals/quillfield.json` and writes the four HTML files. No number is typed into the markup. Rebuild: `python3 src/build.py && python3 src/render.py`.
- `src/audit.py` walks every rendered text node in all six frames (font size, colour against the composited background, clipping). Raw output: `src/audit.json`.
- Fonts: Google Fonts only (Bricolage Grotesque, Inter, JetBrains Mono), loaded in every frame. No other network.

## Derived numbers (all computed in build.py)
| Figure | Formula | Values |
|---|---|---|
| To target ring | (current − trend_6m[0]) / (target − trend_6m[0]) | G1 38%, G2 47%, G3 25%, G4 50% |
| 6-month delta | current − trend_6m[0] | +3 pts, −1.4 min, +56, −0.4 |
| Needs me | len(decisions) / reviews / questions | 3 / 2 / 2 = 7 (Inbox badge, "7 waiting") |
| New this week, change | weekly_new_8w[-1] − [-2] | 9, +2 |
| Open by state | qualified + unreviewed + merged + disqualified | 24 + 3 + 8 + 6 = 41 = open (asserted) |
| Sources | by_source | 18 + 11 + 7 + 5 = 41 |
| Sections approved | count(status = approved) | 4/8 |
| Reviewers approved | count(verdict = approved) | 1/3 |
| Evidence | sum of evidence counts | 12 + 1 + 1 = 14 |
| Journey | journey_index / len(journey_steps) | 8/9 (Review) |
| Roadmap columns | len(now / next / later) | 2 / 2 / 1 |

"To target" is the only invented metric. It is defined in the one open (i) tooltip on Home. G2's 6.0 start equals its `baseline`, so the formula is consistent with the data.

## Contrast (every text and background pair rendered, 48 pairs, measured from the frames)
Body text (15 px and up) is at least 7:1 everywhere. The only pairs under 7:1 are two chip labels (13–13.5 px semibold): On track 6.42 and the at-risk chip 6.39, both above 4.5. The primary button uses `#4a2fd6` (7.87:1 with white) in place of Atlas `#5a3cf0` (6.29), so that its 15 px label clears 7:1.

| Theme | Text | Background | Ratio | Smallest size | Example | Result |
|---|---|---|---|---|---|---|
| dark | `#a796ff` | `#17152b` | 7.17 | 14px | Roadmap | ≥7 body |
| dark | `#ff8ca6` | `#3a1426` | 7.30 | 13.5px | 1 · SMS arrival link | ≥7 body |
| dark | `#120f26` | `#a796ff` | 7.53 | 14px | MK | ≥7 body |
| dark | `#c3b8ff` | `#2a2357` | 7.87 | 13.5px | In review | ≥7 body |
| dark | `#16132c` | `#ff8ca6` | 8.21 | 13px | 3 | ≥7 body |
| dark | `#c4bfe8` | `#221f3a` | 9.03 | 13.5px | 2 | ≥7 body |
| dark | `#5fe0a9` | `#0f2b22` | 9.16 | 13.5px | On track | ≥7 body |
| dark | `#5fe0a9` | `#241f4a` | 9.29 | 15px | +3 pts | ≥7 body |
| dark | `#d3cbff` | `#2a2357` | 9.32 | 13px | G1 | ≥7 body |
| dark | `#ffc46e` | `#2f2413` | 9.67 | 13.5px | 7 waiting | ≥7 body |
| dark | `#ffc46e` | `#241f4a` | 9.76 | 13.5px | Proposed | ≥7 body |
| dark | `#d4cff5` | `#241f4a` | 10.25 | 13px | 92% | ≥7 body |
| dark | `#5fe0a9` | `#17152b` | 10.79 | 15px | +2 | ≥7 body |
| dark | `#cdc8ee` | `#17152b` | 11.11 | 13px | Track | ≥7 body |
| dark | `#f3f1ff` | `#2c2658` | 12.35 | 13px | 4 | ≥7 body |
| dark | `#cdc8ee` | `#07060f` | 12.56 | 13px | Requests | ≥7 body |
| dark | `#f3f1ff` | `#241f4a` | 13.75 | 13px | Goals | ≥7 body |
| dark | `#16132c` | `#c8f169` | 13.96 | 13px | PO | ≥7 body |
| dark | `#f1efff` | `#17152b` | 15.72 | 14px | Tracks | ≥7 body |
| dark | `#16132c` | `#f1efff` | 15.92 | 14px | To target: share of the  | ≥7 body |
| dark | `#f1efff` | `#0e0d1a` | 16.98 | 30px | Home | ≥7 body |
| light | `#a3132f` | `#ffe1e8` | 6.39 | 13.5px | 1 · SMS arrival link | ≥4.5 label only |
| light | `#0b6146` | `#d9f4e8` | 6.42 | 13px | On track | ≥4.5 label only |
| light | `#7a3f00` | `#ffecd0` | 7.15 | 13.5px | 7 waiting | ≥7 body |
| light | `#0b6146` | `#ffffff` | 7.47 | 15px | +2 | ≥7 body |
| light | `#120f26` | `#a796ff` | 7.53 | 14px | MK | ≥7 body |
| light | `#a3132f` | `#ffffff` | 7.80 | 15px | Same-day refund rule una | ≥7 body |
| light | `#46416b` | `#ebe9f3` | 7.84 | 13px | 2 | ≥7 body |
| light | `#ffffff` | `#4a2fd6` | 7.87 | 15px | New idea | ≥7 body |
| light | `#3d23b8` | `#ebe6ff` | 8.12 | 13px | In review | ≥7 body |
| light | `#16132c` | `#ff8ca6` | 8.21 | 13px | 3 | ≥7 body |
| light | `#3d3863` | `#f2f0fa` | 9.58 | 15px | PRDs | ≥7 body |
| light | `#3d23b8` | `#ffffff` | 9.85 | 14px | Roadmap | ≥7 body |
| light | `#5fe0a9` | `#1c1838` | 10.28 | 14px | +3 pts | ≥7 body |
| light | `#cdc8f2` | `#1c1838` | 10.62 | 13px | 92% | ≥7 body |
| light | `#3d3863` | `#ffffff` | 10.80 | 13px | Track | ≥7 body |
| light | `#ffc46e` | `#1c1838` | 10.81 | 13.5px | Proposed | ≥7 body |
| light | `#d4cff5` | `#16132c` | 12.07 | 13px | Requests | ≥7 body |
| light | `#f3f1ff` | `#262046` | 13.68 | 13px | 4 | ≥7 body |
| light | `#16132c` | `#c8f169` | 13.96 | 13px | PO | ≥7 body |
| light | `#c8f169` | `#16132c` | 13.96 | 13.5px | 2 | ≥7 body |
| light | `#f3f1ff` | `#1c1838` | 15.23 | 13px | Goals | ≥7 body |
| light | `#16132c` | `#f2f0fa` | 16.00 | 26px | Home | ≥7 body |
| light | `#f3f1ff` | `#16132c` | 16.19 | 14px | To target: share of the  | ≥7 body |
| light | `#16132c` | `#e9fbb8` | 16.29 | 16px | 38% of no-shows are firs | ≥7 body |
| light | `#16132c` | `#f6f5fc` | 16.66 | 14px | Charge no-show fee autom | ≥7 body |
| light | `#16132c` | `#ffffff` | 18.05 | 13px | Tracks | ≥7 body |
| light | `#ffffff` | `#16132c` | 18.05 | 15px | All | ≥7 body |

## Rule check per frame
| Frame | 1 No prose | 2 Readable | 3 Home value above 900 | 4 Few cards | 5 Same place | 6 Cost quiet | 7 Nav / scope |
|---|---|---|---|---|---|---|---|
| home-light-desktop | Pass: labels, numbers, chips. One sentence, only inside the open (i) tooltip | Pass: min 13 px, body ≥7:1 | Pass: goals, tracks + PRD, needs me, requests all end by y≈866 | Pass: hero + 3 panels | Pass: Home + "7 waiting" / New idea | Pass: 4.00 and 7.60/8.00 only | Pass: 9 nav items |
| home-dark-desktop | Pass | Pass: real dark tokens (Atlas dark), not inverted | Pass | Pass | Pass | Pass | Pass |
| home-light-mobile | Pass. The tooltip sits inline under "Goals" so it covers nothing | Pass: 390 wide, no horizontal scroll; tab bar fixed at the bottom | n/a (stacked: goals, needs me, tracks, requests) | Pass | Pass | Pass | Tab bar: Home, Requests, PRDs, Inbox, More |
| requests-light-desktop | Pass: request titles are user content | Pass | n/a | Table + one side panel | Requests + "41 open" / Add request; themes on the right | n/a | Pass |
| prd-review-light-desktop | Pass: FR text, claim, suggestions and blockers are content | Pass | n/a | Sections, document, inspector stack | Title + In review / Approve r4; inspector right | n/a | Pass |
| roadmap-light-desktop | Pass | Pass | n/a | Board + inspector | Roadmap + Snapshot P-7 / Run roadmap; inspector right | n/a | No dates on milestones |

## Checks for duplicates and clipping
- Removed after review: the 81% beside the claim (the Evidence ring holds it), the v3 and blocker-count chips in the PRD title (the version switch and Blockers panel hold them), r4 in the section list, the "Done/Next/At risk" rows in the roadmap inspector, the "On track" chip on the M1 card, the 41 on the "All" filter, and the 9 above the weekly bars.
- `audit.py` reports 0 clipped text nodes and 0 under 13 px in all six frames. scrollWidth equals the viewport in every frame.

## Could not render or left open
- Render environment: Chromium headless shell with Debian libraries unpacked locally (no root). Web fonts loaded and were verified by `document.fonts`.
- Home on mobile has no "6 mo" label next to the delta (hidden for width). The sparkline still carries the trend.
- `slipped: 2` for Check-in is shown on the roadmap, not on Home. The roadmap snapshot's "16 Oct" is left off, per "no dates".
