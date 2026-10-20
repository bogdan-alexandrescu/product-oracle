# Direction B: Broadsheet

**Warm, editorial and spacious. Oracle as a head of product who writes you a memo.**

## Rationale

Broadsheet leans on Oracle's job: it argues a position. Pages open with a headline and a
one-sentence lede that states the finding ("3 of 4 goals are confirmed…"), set in Newsreader,
a text serif built for screens, with Instrument Sans for controls and data. Colour is warm:
paper and ink in light mode, a dark walnut in dark mode, with one terracotta accent. Rules
(hairlines) separate content instead of boxes. Evidence lives in the margin: on PRD review the
evidence for a marked claim is a margin note beside the paragraph, like a well-edited
document, which matches O1c (the body carries no citations; evidence sits beside it and in
the Sources and data points appendix). Questions arrive as a short letter: "Three questions
for you". Navigation moves to a horizontal masthead, which frees the full width for reading.

## Who it suits

Founders and product leads who read and decide more than they operate; people presenting the
brief to colleagues; reviewers commenting on prose. It makes Oracle feel opinionated and
trustworthy through tone, and pairs naturally with Present mode and the brief layer (O1f).

## Information architecture

Unchanged items, different placement (not a structural change): the main sections run along
the top masthead (Baseline, Runs, PRDs, Priorities, Roadmap, Inbox), and **Settings** is one
link at the right of the masthead leading to today's Settings pages. **New product idea** is
the primary button on Baseline (and PRDs). On mobile the masthead collapses to a Menu button.

## Risks

- Lower density: the Baseline shows four goals side by side, and with more goals or more
  features per goal it needs scrolling or a compact mode. Big run tables and long inboxes
  will need a denser variant.
- A serif UI can feel less "tool-like"; engineers may read it as marketing.
- Margin notes need width: below about 1280 px the evidence note must drop under its claim
  (the mobile frame shows that fallback).
- The warm palette is close to some document themes; the design-system lane must keep the
  app chrome visibly distinct from rendered PRDs.

## Type and tokens

Fonts (Google Fonts): Newsreader, Instrument Sans. Density: comfortable: 48px rows, 15px UI, 18px prose.
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
| light | `text` #1f1a15 | `bg` #f6f1e8 | 15.34 | AA |
| dark | `text` #f2ebe1 | `bg` #1b1714 | 15.05 | AA |
| light | `text` #1f1a15 | `surface` #fffcf6 | 16.85 | AA |
| dark | `text` #f2ebe1 | `surface` #231e1a | 13.95 | AA |
| light | `text` #1f1a15 | `surface2` #efe7da | 14.06 | AA |
| dark | `text` #f2ebe1 | `surface2` #2c2621 | 12.62 | AA |
| light | `text2` #4b4036 | `bg` #f6f1e8 | 8.95 | AA |
| dark | `text2` #d2c6b6 | `bg` #1b1714 | 10.59 | AA |
| light | `text2` #4b4036 | `surface` #fffcf6 | 9.83 | AA |
| dark | `text2` #d2c6b6 | `surface` #231e1a | 9.82 | AA |
| light | `text2` #4b4036 | `surface2` #efe7da | 8.20 | AA |
| dark | `text2` #d2c6b6 | `surface2` #2c2621 | 8.88 | AA |
| light | `text3` #675a4c | `bg` #f6f1e8 | 5.94 | AA |
| dark | `text3` #ab9d8b | `bg` #1b1714 | 6.72 | AA |
| light | `text3` #675a4c | `surface` #fffcf6 | 6.52 | AA |
| dark | `text3` #ab9d8b | `surface` #231e1a | 6.23 | AA |
| light | `text3` #675a4c | `surface2` #efe7da | 5.44 | AA |
| dark | `text3` #ab9d8b | `surface2` #2c2621 | 5.64 | AA |
| light | `accent` #9c3b1b | `bg` #f6f1e8 | 6.11 | AA |
| dark | `accent` #ec8a62 | `bg` #1b1714 | 7.10 | AA |
| light | `accent` #9c3b1b | `surface` #fffcf6 | 6.71 | AA |
| dark | `accent` #ec8a62 | `surface` #231e1a | 6.59 | AA |
| light | `onAccent` #fffcf6 | `accent` #9c3b1b | 6.71 | AA |
| dark | `onAccent` #1b1714 | `accent` #ec8a62 | 7.10 | AA |
| light | `accentSoftText` #7a2e13 | `accentSoft` #f6e2d6 | 7.53 | AA |
| dark | `accentSoftText` #f6bfa6 | `accentSoft` #3b261c | 8.73 | AA |
| light | `highlightText` #1f1a15 | `highlight` #f7e3a1 | 13.52 | AA |
| dark | `highlightText` #fbeec7 | `highlight` #4d3d17 | 9.10 | AA |
| light | `pass` #2b6332 | `passBg` #e3eed8 | 5.96 | AA |
| dark | `pass` #9fd08f | `passBg` #1f2a1b | 8.46 | AA |
| light | `warn` #835000 | `warnBg` #f6e8c8 | 5.56 | AA |
| dark | `warn` #e8b765 | `warnBg` #30271a | 7.96 | AA |
| light | `crit` #a02a1c | `critBg` #f7e0d9 | 5.85 | AA |
| dark | `crit` #f39886 | `critBg` #3a1e18 | 7.00 | AA |
| light | `na` #5a5047 | `naBg` #ebe3d6 | 6.17 | AA |
| dark | `na` #bfb3a4 | `naBg` #2c2621 | 7.25 | AA |
| light | `info` #2c5877 | `infoBg` #e0e9ee | 6.16 | AA |
| dark | `info` #9cc3df | `infoBg` #1d2a33 | 7.88 | AA |
| light | `pass` #2b6332 | `surface` #fffcf6 | 6.99 | AA |
| dark | `pass` #9fd08f | `surface` #231e1a | 9.35 | AA |
| light | `warn` #835000 | `surface` #fffcf6 | 6.59 | AA |
| dark | `warn` #e8b765 | `surface` #231e1a | 8.96 | AA |
| light | `crit` #a02a1c | `surface` #fffcf6 | 7.21 | AA |
| dark | `crit` #f39886 | `surface` #231e1a | 7.58 | AA |
| light | `warn` #835000 | `bg` #f6f1e8 | 6.00 | AA |
| dark | `warn` #e8b765 | `bg` #1b1714 | 9.66 | AA |
| light | `crit` #a02a1c | `bg` #f6f1e8 | 6.57 | AA |
| dark | `crit` #f39886 | `bg` #1b1714 | 8.18 | AA |
| light | `navText` #4b4036 | `navBg` #f6f1e8 | 8.95 | AA |
| dark | `navText` #d2c6b6 | `navBg` #1b1714 | 10.59 | AA |
| light | `navActiveText` #1f1a15 | `navActiveBg` #f6f1e8 | 15.34 | AA |
| dark | `navActiveText` #ffffff | `navActiveBg` #1b1714 | 17.81 | AA |
