# Direction C: Atlas

**Vivid, spatial and bold. Oracle as a map of decisions, with the journey always visible.**

## Rationale

Atlas makes v2's new idea visible: a PRD is a journey from a short idea to a published,
evidence-grounded document. A compact **journey track** (Idea, Sources, Gaps, Composition,
Questions, Blockers, Draft run, Review, Publish) sits on every PRD-related screen. The look is
confident: Bricolage Grotesque headlines, Inter for UI, JetBrains Mono for ids and money, a
deep violet accent with a lime "you are here" highlight, 16 px rounded cards and big
numerals. The baseline becomes a **feature × goal matrix** with a confidence ring and evidence
count in each cell, so "built the wrong thing" shows as an empty row. Opportunity and Gaps is
a board (Fit, Tensions, Uncertainties) under a dark hero card holding the idea and Oracle's
view; questions are three cards side by side. Runs show segments as a pipeline, and the
publish check opens as a full-height drawer whose header says the verdict. Dark mode is
native: deep indigo surfaces that keep the lime and violet vivid.

## Who it suits

Teams adopting v2's end-to-end flow, founders who want the status of an idea at a glance, and
demos to colleagues or future customers. It is the most distinctive of the three.

## Information architecture: one proposed change (labelled)

- **Proposed change: the PRD journey track.** A new, persistent per-PRD stage indicator for
  §13's steps, shown on New product idea, Opportunity and Gaps, PRD review and Publish. It
  adds no destination the build prompt does not add; it only makes the steps visible together.
  The owner should approve it as an IA change.
- Navigation items are unchanged, moved to an icon rail with labels (Baseline, Runs, PRDs,
  Priorities, Roadmap, Inbox, Settings at the bottom). The Baseline tabs (Flagged, Conflicts,
  Proposals) appear as counted buttons beside the matrix, which is the Graph view.
- On mobile the rail becomes a bottom tab bar: Baseline, Runs, PRDs, Inbox and More
  (Priorities, Roadmap, Settings).

## Risks

- Strong colour and big type compete with dense information; long lists (inbox, large
  baselines) need a calmer variant.
- The matrix gets wide with more than five or six goals and needs horizontal paging or
  grouping by horizon.
- The lime highlight must stay rare to keep meaning "current"; overuse makes it noise.
- The journey track is an IA change and depends on v2's flow being the main path; old
  `oracle push/pull` drafts enter at Review with earlier stages marked not used.
- Most work for the design-system lane: new components (matrix, pipeline, drawer, track).

## Type and tokens

Fonts (Google Fonts): Bricolage Grotesque, Inter, JetBrains Mono. Density: medium: 40px rows, 14px body, big numerals.
Full tokens (colour for light and dark, type scale, spacing, radius, elevation, motion): [tokens.json](tokens.json).

## Screens

- [Baseline](baseline.html): [light-desktop](baseline-light-desktop.png), [dark-desktop](baseline-dark-desktop.png)
- [Opportunity and Gaps](idea-gaps.html): [light-desktop](idea-gaps-light-desktop.png), [dark-desktop](idea-gaps-dark-desktop.png), [light-mobile](idea-gaps-light-mobile.png)
- [PRD review](prd-review.html): [light-desktop](prd-review-light-desktop.png), [dark-desktop](prd-review-dark-desktop.png), [light-mobile](prd-review-light-mobile.png)
- [Runs and Inbox](runs-inbox.html): [light-desktop](runs-inbox-light-desktop.png), [dark-desktop](runs-inbox-dark-desktop.png)
- [Publish](publish.html): [light-desktop](publish-light-desktop.png), [dark-desktop](publish-dark-desktop.png)

## Token contrast (WCAG 2.x)

Every token pair below meets AA for normal text (4.5:1).

| Theme | Text | Background | Ratio | Result |
|---|---|---|---|---|
| light | `text` #16132c | `bg` #f5f4fb | 16.51 | AA |
| dark | `text` #f1efff | `bg` #0e0d1a | 16.98 | AA |
| light | `text` #16132c | `surface` #ffffff | 18.05 | AA |
| dark | `text` #f1efff | `surface` #17152b | 15.72 | AA |
| light | `text` #16132c | `surface2` #efedf8 | 15.59 | AA |
| dark | `text` #f1efff | `surface2` #1f1c38 | 14.46 | AA |
| light | `text2` #46416b | `bg` #f5f4fb | 8.62 | AA |
| dark | `text2` #c4bfe8 | `bg` #0e0d1a | 10.97 | AA |
| light | `text2` #46416b | `surface` #ffffff | 9.42 | AA |
| dark | `text2` #c4bfe8 | `surface` #17152b | 10.15 | AA |
| light | `text2` #46416b | `surface2` #efedf8 | 8.14 | AA |
| dark | `text2` #c4bfe8 | `surface2` #1f1c38 | 9.34 | AA |
| light | `text3` #5d5882 | `bg` #f5f4fb | 6.04 | AA |
| dark | `text3` #9e98c8 | `bg` #0e0d1a | 7.13 | AA |
| light | `text3` #5d5882 | `surface` #ffffff | 6.60 | AA |
| dark | `text3` #9e98c8 | `surface` #17152b | 6.60 | AA |
| light | `text3` #5d5882 | `surface2` #efedf8 | 5.70 | AA |
| dark | `text3` #9e98c8 | `surface2` #1f1c38 | 6.07 | AA |
| light | `accent` #5a3cf0 | `bg` #f5f4fb | 5.75 | AA |
| dark | `accent` #a796ff | `bg` #0e0d1a | 7.74 | AA |
| light | `accent` #5a3cf0 | `surface` #ffffff | 6.29 | AA |
| dark | `accent` #a796ff | `surface` #17152b | 7.17 | AA |
| light | `onAccent` #ffffff | `accent` #5a3cf0 | 6.29 | AA |
| dark | `onAccent` #120f26 | `accent` #a796ff | 7.53 | AA |
| light | `accentSoftText` #3d23b8 | `accentSoft` #ebe6ff | 8.12 | AA |
| dark | `accentSoftText` #d3cbff | `accentSoft` #2a2357 | 9.32 | AA |
| light | `highlightText` #16132c | `highlight` #d8f58a | 14.91 | AA |
| dark | `highlightText` #e9fbb8 | `highlight` #3b4a12 | 8.72 | AA |
| light | `pass` #0d6a4c | `passBg` #d9f4e8 | 5.67 | AA |
| dark | `pass` #5fe0a9 | `passBg` #0f2b22 | 9.16 | AA |
| light | `warn` #894700 | `warnBg` #ffecd0 | 6.13 | AA |
| dark | `warn` #ffc46e | `warnBg` #2f2413 | 9.67 | AA |
| light | `crit` #b01539 | `critBg` #ffe1e8 | 5.71 | AA |
| dark | `crit` #ff8ca6 | `critBg` #3a1426 | 7.30 | AA |
| light | `na` #524e6c | `naBg` #ebe9f3 | 6.56 | AA |
| dark | `na` #b8b4d8 | `naBg` #221f3a | 7.97 | AA |
| light | `info` #3d23b8 | `infoBg` #ebe6ff | 8.12 | AA |
| dark | `info` #c3b8ff | `infoBg` #2a2357 | 7.87 | AA |
| light | `pass` #0d6a4c | `surface` #ffffff | 6.60 | AA |
| dark | `pass` #5fe0a9 | `surface` #17152b | 10.79 | AA |
| light | `warn` #894700 | `surface` #ffffff | 7.08 | AA |
| dark | `warn` #ffc46e | `surface` #17152b | 11.35 | AA |
| light | `crit` #b01539 | `surface` #ffffff | 6.97 | AA |
| dark | `crit` #ff8ca6 | `surface` #17152b | 8.11 | AA |
| light | `warn` #894700 | `bg` #f5f4fb | 6.48 | AA |
| dark | `warn` #ffc46e | `bg` #0e0d1a | 12.26 | AA |
| light | `crit` #b01539 | `bg` #f5f4fb | 6.38 | AA |
| dark | `crit` #ff8ca6 | `bg` #0e0d1a | 8.76 | AA |
| light | `navText` #c9c3f0 | `navBg` #16132c | 10.78 | AA |
| dark | `navText` #c4bfe8 | `navBg` #07060f | 11.48 | AA |
| light | `navActiveText` #16132c | `navActiveBg` #c8f169 | 13.96 | AA |
| dark | `navActiveText` #16132c | `navActiveBg` #c8f169 | 13.96 | AA |
| light | `heroText` #f3f1ff | `hero` #1c1838 | 15.23 | AA |
| dark | `heroText` #f3f1ff | `hero` #241f4a | 13.75 | AA |
| light | `heroText2` #c9c3f0 | `hero` #1c1838 | 10.14 | AA |
| dark | `heroText2` #c9c3f0 | `hero` #241f4a | 9.16 | AA |
| light | `lime` #c8f169 | `hero` #1c1838 | 13.13 | AA |
| dark | `lime` #c8f169 | `hero` #241f4a | 11.86 | AA |
| light | `onLime` #16132c | `lime` #c8f169 | 13.96 | AA |
| dark | `onLime` #16132c | `lime` #c8f169 | 13.96 | AA |
