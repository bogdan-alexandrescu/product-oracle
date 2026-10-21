# A5 Bento: report

## How it was built
- `src/build.js` writes the four HTML files from `docs/product-oracle-v2/design/proposals/quillfield.json`. No number is typed into the markup. Derived values are computed there, and the build fails if the request state counts or source counts do not sum to `open` (41).
- `src/render.js` renders the six frames with Playwright (Chromium headless shell, colour scheme emulated for dark). For each frame it also checks for horizontal scroll, overflowing text boxes, overflowing tiles, and any text under 13 px. The final run reported none of these.
- Fonts: Google Fonts only (Bricolage Grotesque, Inter, JetBrains Mono), all loaded in the final render.

## Derived numbers (all from quillfield.json)
| Value | Formula | Result |
|---|---|---|
| % of target (ring) | current ÷ target; target ÷ current when `better` = down | G1 95 · G2 65 · G3 59 · G4 79 |
| 6-month change | last − first of `trend_6m` | +3 · −1.4 · +56 · −0.4 |
| Needs me | decisions + reviews + questions | 3 + 2 + 2 = 7 (Inbox badge 7) |
| Unique requests | open − merged_duplicates | 41 − 8 = 33 |
| State filters | New = unreviewed 3, Qualified 24, Merged 8, Disqualified 6 | sum 41 = open |
| Sources | Support 18, Sales 11, Slack 7, Interviews 5 | sum 41 |
| Claim evidence | 12 + 1 + 1 | 14 |
| Composition | 6 mandatory + 2 optional on + 1 optional off | 9 |
| Sections | approved / in review / draft | 4 / 1 / 3 |
| Track done | done/total | 6/9 · 4/7 |

## Contrast (WCAG 2.x, every text/background token pair used)
Body text pairs need 7:1. Every other text pair needs 4.5:1. `text3` was removed from the palette: all secondary text uses `text2`.

| Theme | Text | Background | Ratio | Used for | Need | Result |
|---|---|---|---|---|---|---|
| light | `text` #16132c | `bg` #f5f4fb | 16.51 | page title, header | 7:1 body | pass |
| light | `text` #16132c | `surface` #ffffff | 18.05 | tile body, rows, requirements | 7:1 body | pass |
| light | `text2` #46416b | `surface` #ffffff | 9.42 | labels, sources, ages, legend | 7:1 body | pass |
| light | `text` #16132c | `surface2` #efedf8 | 15.59 | segmented filters, merged row, pending lane | 7:1 body | pass |
| light | `text` #16132c | `critBg` #ffe1e8 | 14.77 | blocker text | 7:1 body | pass |
| light | `accentSoftText` #3d23b8 | `surface` #ffffff | 9.85 | PRD links | 7:1 body | pass |
| light | `accentSoftText` #3d23b8 | `accentSoft` #ebe6ff | 8.12 | goal ids, counts, In review chip, current section | 4.5:1  | pass |
| light | `onAccent` #ffffff | `accent` #5a3cf0 | 6.29 | primary button | 4.5:1  | pass |
| light | `pass` #0d6a4c | `passBg` #d9f4e8 | 5.67 | On track, Approved, Accepted chips | 4.5:1  | pass |
| light | `warn` #894700 | `warnBg` #ffecd0 | 6.13 | Drifting, Slipped, Proposed chips | 4.5:1  | pass |
| light | `crit` #b01539 | `critBg` #ffe1e8 | 5.71 | At risk, blockers, Rejected chips | 4.5:1  | pass |
| light | `crit` #b01539 | `surface` #ffffff | 6.97 | outlined reason chips, confidence < 50% | 4.5:1  | pass |
| light | `pass` #0d6a4c | `surface` #ffffff | 6.60 | confidence >= 70%, deltas | 4.5:1  | pass |
| light | `warn` #894700 | `surface` #ffffff | 7.08 | confidence 50-69% | 4.5:1  | pass |
| light | `highlightText` #16132c | `highlight` #d8f58a | 14.91 | Now cells, claim | 7:1 body | pass |
| light | `heroText` #f3f1ff | `hero` #1c1838 | 15.23 | Needs me titles, tooltip | 7:1 body | pass |
| light | `heroText2` #c9c3f0 | `hero` #1c1838 | 10.14 | Needs me ages, count labels | 7:1 body | pass |
| light | `lime` #c8f169 | `hero` #1c1838 | 13.13 | Needs me total, tooltip label | 4.5:1  | pass |
| light | `segQ` #ffc46e | `hero` #1c1838 | 10.81 | cost figures | 4.5:1  | pass |
| light | `heroText` #f3f1ff | `heroBtn` #2e2858 | 12.07 | ghost buttons on Needs me | 4.5:1  | pass |
| light | `onLime` #16132c | `lime` #c8f169 | 13.96 | lime buttons, Now header, Inbox badge | 4.5:1  | pass |
| light | `onLime` #16132c | `segR` #a796ff | 7.26 | asker avatar | 4.5:1  | pass |
| light | `navText` #c9c3f0 | `navBg` #16132c | 10.78 | rail, tab bar | 4.5:1  | pass |
| light | `navActiveText` #16132c | `navActiveBg` #c8f169 | 13.96 | active nav item | 4.5:1  | pass |
| light | `text2` #46416b | `surface2` #efedf8 | 8.14 | source in merged row, section counts | 7:1 body | pass |
| dark | `text` #f1efff | `bg` #0e0d1a | 16.98 | page title, header | 7:1 body | pass |
| dark | `text` #f1efff | `surface` #17152b | 15.72 | tile body, rows, requirements | 7:1 body | pass |
| dark | `text2` #c4bfe8 | `surface` #17152b | 10.15 | labels, sources, ages, legend | 7:1 body | pass |
| dark | `text` #f1efff | `surface2` #1f1c38 | 14.46 | segmented filters, merged row, pending lane | 7:1 body | pass |
| dark | `text` #f1efff | `critBg` #3a1426 | 14.17 | blocker text | 7:1 body | pass |
| dark | `accentSoftText` #d3cbff | `surface` #17152b | 11.67 | PRD links | 7:1 body | pass |
| dark | `accentSoftText` #d3cbff | `accentSoft` #2a2357 | 9.32 | goal ids, counts, In review chip, current section | 4.5:1  | pass |
| dark | `onAccent` #120f26 | `accent` #a796ff | 7.53 | primary button | 4.5:1  | pass |
| dark | `pass` #5fe0a9 | `passBg` #0f2b22 | 9.16 | On track, Approved, Accepted chips | 4.5:1  | pass |
| dark | `warn` #ffc46e | `warnBg` #2f2413 | 9.67 | Drifting, Slipped, Proposed chips | 4.5:1  | pass |
| dark | `crit` #ff8ca6 | `critBg` #3a1426 | 7.30 | At risk, blockers, Rejected chips | 4.5:1  | pass |
| dark | `crit` #ff8ca6 | `surface` #17152b | 8.11 | outlined reason chips, confidence < 50% | 4.5:1  | pass |
| dark | `pass` #5fe0a9 | `surface` #17152b | 10.79 | confidence >= 70%, deltas | 4.5:1  | pass |
| dark | `warn` #ffc46e | `surface` #17152b | 11.35 | confidence 50-69% | 4.5:1  | pass |
| dark | `highlightText` #e9fbb8 | `highlight` #3b4a12 | 8.72 | Now cells, claim | 7:1 body | pass |
| dark | `heroText` #f3f1ff | `hero` #241f4a | 13.75 | Needs me titles, tooltip | 7:1 body | pass |
| dark | `heroText2` #c9c3f0 | `hero` #241f4a | 9.16 | Needs me ages, count labels | 7:1 body | pass |
| dark | `lime` #c8f169 | `hero` #241f4a | 11.86 | Needs me total, tooltip label | 4.5:1  | pass |
| dark | `segQ` #ffc46e | `hero` #241f4a | 9.76 | cost figures | 4.5:1  | pass |
| dark | `heroText` #f3f1ff | `heroBtn` #352f66 | 10.76 | ghost buttons on Needs me | 4.5:1  | pass |
| dark | `onLime` #16132c | `lime` #c8f169 | 13.96 | lime buttons, Now header, Inbox badge | 4.5:1  | pass |
| dark | `onLime` #16132c | `segR` #a796ff | 7.26 | asker avatar | 4.5:1  | pass |
| dark | `navText` #c4bfe8 | `navBg` #07060f | 11.48 | rail, tab bar | 4.5:1  | pass |
| dark | `navActiveText` #16132c | `navActiveBg` #c8f169 | 13.96 | active nav item | 4.5:1  | pass |
| dark | `text2` #c4bfe8 | `surface2` #1f1c38 | 9.34 | source in merged row, section counts | 7:1 body | pass |

## Rule check per frame
| Rule | home-light-desktop | home-dark-desktop | home-light-mobile | requests | prd-review | roadmap |
|---|---|---|---|---|---|---|
| 1 No prose | pass: labels, numbers, chips; one open (i) tooltip on Goals | pass (same) | pass (tooltip closed) | pass; request titles are content | pass; requirements, claim, suggestions, blockers are content | pass |
| 2 Readable | pass: body 15 px, min 13 px, tabular figures | pass | pass | pass | pass | pass |
| 3 Home above 900 px | pass: all four tiles end at y = 872 | pass | n/a (phone) | n/a | n/a | n/a |
| 4 Few cards | pass: four tiles, one per block | pass | pass | pass: table + Flow + Themes | pass | pass: board + inspector |
| 5 Same place | pass: title and status top-left, one primary action top-right | pass | pass | pass | pass: inspector right | pass: inspector right |
| 6 Cost quiet | pass: $64.00 and $27.60/$18.00 on the two Needs me items only | pass | pass | none | none | none |
| 7 Nothing invented | pass: nav = Home, Requests, Baseline, PRDs, Priorities, Roadmap, Runs, Inbox, Settings | pass | pass: tab bar Home, Requests, PRDs, Inbox, More | pass | pass | pass: no dates |

Rule 3 coverage on Home: (a) four goals, each with current vs target, sparkline with a dashed target line, confidence ring and %, Proposed flag on G4. (b) both tracks with status, done/total, at risk, slipped, the goal served, and Now/Next/Later milestones; Online deposits v3 with journey 8/9 (Review), 2 blockers, G1 and G3. (c) 7 waiting items split 3/2/2 with a segmented bar, and every item on one line with its action. (d) 9 new this week, 8-week bars, Open → Unique → Qualified funnel, and the top four themes that link to goals.

Also checked on every PNG: nothing is drawn twice within a screen (the roadmap inspector shows only the at-risk item and the goal, not the track stats from the lane), no text is clipped or overlapping, and no frame scrolls horizontally (mobile `scrollWidth` 390).

## Decisions and anything not rendered
- The "% of target" formula is mine; the data has no baseline for G4, so the ring uses the ratio for every goal. The open tooltip explains it.
- Context lines under Needs me items ("Online deposits · run 0412") are not shown, because rule 1 bans a second line.
- Roadmap: the snapshot date "16 Oct" is omitted ("No dates"); the header shows "Snapshot P-7". The pending PRD's note "joins after publish" appears as the chip "Pending publish".
- Home omits G3's "by end of 2027" (it shows the target 400 clinics).
- Data note: the Check-in track says `slipped: 2`, but the roadmap lists one slipped milestone (v1.2 kiosk mode). Both are shown as given.
- The requests table shows the 8 rows in the file, sorted by mentions, labelled "8 of 41". The merged row sits indented under the row it was merged into.
- The phone frame is rendered at device scale 2 (PNG 780 px wide; layout 390 CSS px). Its viewport is sized to the page height, so the tab bar sits at the bottom.
- Rendering environment: the container had no browser libraries or system fonts, so Chromium's shared libraries and fontconfig were extracted locally from Debian packages (no root). `src/render.sh` expects them under /tmp/debs.
