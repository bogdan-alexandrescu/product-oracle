# Direction A: Ledger

**Dense, cool and analytical. Oracle as an instrument panel.**

## Rationale

Ledger treats Oracle's work as evidence to be audited. It keeps today's left sidebar, sharpens
it with counts, and puts as much of the goal-to-feature graph, the run and the review on one
screen as legibility allows: 13 px IBM Plex Sans, 32 px rows, tabular IBM Plex Mono figures,
hairline tables, one blue accent and status colour used only for status. Calm comes from
order and predictability rather than from white space. Every inspector opens *in place*,
next to the thing it explains: the evidence for a claim expands as a table under the
requirement, the composition sits in a fixed right panel, and the waiting checkpoint opens
inside its segment row. Dark mode is a cool blue-black with lifted surfaces, not an inversion.

## Who it suits

Reviewers, approvers and product people who live in Oracle for hours, compare many items at
once, and want to scan confidence, evidence counts and cost without clicking. It suits the
engineering lead's review stop and the operator watching runs and spend.

## Information architecture

Unchanged. Sidebar: Baseline, Runs, PRDs, Priorities, Roadmap, Inbox, then Settings (Members,
Connections, Claude accounts, Sources, Templates, Themes). **New product idea** is a primary
button on Baseline (and PRDs), as §13 step 1 says. The new-idea flow shows its six §13 steps
as a segmented indicator. On mobile the sidebar becomes a Menu button; the section outline
becomes a "Section 5 of 8 / Sections" picker.

## Risks

- Density can intimidate a founder opening Oracle for the first time, and can read as
  "spreadsheet" rather than "head of product": the opinion (Oracle's view) is easy to miss.
- 12-13 px text is at the floor for comfortable reading; long PRD prose needs the 14 px body
  style and the reading width cap shown in the review screen.
- Tables need careful responsive rules; the mobile frames show the pattern, but every table in
  the design-system lane needs its own mobile treatment.
- Closest to today's look, so the redesign may feel incremental.

## Type and tokens

Fonts (Google Fonts): IBM Plex Sans, IBM Plex Mono. Density: compact: 32px rows, 13px body.
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
| light | `text` #111921 | `bg` #f3f5f7 | 16.22 | AA |
| dark | `text` #e4e9ee | `bg` #0d1217 | 15.40 | AA |
| light | `text` #111921 | `surface` #ffffff | 17.72 | AA |
| dark | `text` #e4e9ee | `surface` #141b22 | 14.21 | AA |
| light | `text` #111921 | `surface2` #eef1f4 | 15.63 | AA |
| dark | `text` #e4e9ee | `surface2` #1a232c | 13.01 | AA |
| light | `text2` #384655 | `bg` #f3f5f7 | 8.83 | AA |
| dark | `text2` #b4c0cc | `bg` #0d1217 | 10.17 | AA |
| light | `text2` #384655 | `surface` #ffffff | 9.65 | AA |
| dark | `text2` #b4c0cc | `surface` #141b22 | 9.39 | AA |
| light | `text2` #384655 | `surface2` #eef1f4 | 8.52 | AA |
| dark | `text2` #b4c0cc | `surface2` #1a232c | 8.60 | AA |
| light | `text3` #55636f | `bg` #f3f5f7 | 5.65 | AA |
| dark | `text3` #93a1af | `bg` #0d1217 | 7.13 | AA |
| light | `text3` #55636f | `surface` #ffffff | 6.18 | AA |
| dark | `text3` #93a1af | `surface` #141b22 | 6.58 | AA |
| light | `text3` #55636f | `surface2` #eef1f4 | 5.45 | AA |
| dark | `text3` #93a1af | `surface2` #1a232c | 6.03 | AA |
| light | `accent` #1d5bb8 | `bg` #f3f5f7 | 5.93 | AA |
| dark | `accent` #6aa3ff | `bg` #0d1217 | 7.43 | AA |
| light | `accent` #1d5bb8 | `surface` #ffffff | 6.48 | AA |
| dark | `accent` #6aa3ff | `surface` #141b22 | 6.86 | AA |
| light | `onAccent` #ffffff | `accent` #1d5bb8 | 6.48 | AA |
| dark | `onAccent` #07111f | `accent` #6aa3ff | 7.48 | AA |
| light | `accentSoftText` #163f80 | `accentSoft` #e3ecfa | 8.58 | AA |
| dark | `accentSoftText` #b5d0ff | `accentSoft` #14284a | 9.38 | AA |
| light | `highlightText` #111921 | `highlight` #fff1b8 | 15.64 | AA |
| dark | `highlightText` #fff3c4 | `highlight` #4a3d0e | 9.60 | AA |
| light | `pass` #16653a | `passBg` #e1f2e7 | 6.11 | AA |
| dark | `pass` #6fd49b | `passBg` #0f2a1b | 8.46 | AA |
| light | `warn` #80460a | `warnBg` #fbefd9 | 6.59 | AA |
| dark | `warn` #f0b45e | `warnBg` #2d2111 | 8.52 | AA |
| light | `crit` #a3202b | `critBg` #fbe3e4 | 6.15 | AA |
| dark | `crit` #ff8e96 | `critBg` #36161a | 7.43 | AA |
| light | `na` #4c5865 | `naBg` #e8ecf0 | 6.12 | AA |
| dark | `na` #a8b4c0 | `naBg` #1e2731 | 7.16 | AA |
| light | `info` #1d5bb8 | `infoBg` #e3ecfa | 5.44 | AA |
| dark | `info` #8cb8ff | `infoBg` #14284a | 7.27 | AA |
| light | `pass` #16653a | `surface` #ffffff | 7.10 | AA |
| dark | `pass` #6fd49b | `surface` #141b22 | 9.56 | AA |
| light | `warn` #80460a | `surface` #ffffff | 7.50 | AA |
| dark | `warn` #f0b45e | `surface` #141b22 | 9.42 | AA |
| light | `crit` #a3202b | `surface` #ffffff | 7.50 | AA |
| dark | `crit` #ff8e96 | `surface` #141b22 | 7.90 | AA |
| light | `warn` #80460a | `bg` #f3f5f7 | 6.87 | AA |
| dark | `warn` #f0b45e | `bg` #0d1217 | 10.21 | AA |
| light | `crit` #a3202b | `bg` #f3f5f7 | 6.87 | AA |
| dark | `crit` #ff8e96 | `bg` #0d1217 | 8.57 | AA |
| light | `navText` #2f3c49 | `navBg` #e9edf1 | 9.58 | AA |
| dark | `navText` #b4c0cc | `navBg` #10161c | 9.84 | AA |
| light | `navActiveText` #0b1219 | `navActiveBg` #ffffff | 18.84 | AA |
| dark | `navActiveText` #ffffff | `navActiveBg` #1f2a35 | 14.57 | AA |
