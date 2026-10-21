---
document: product-strategy
title: "Product strategy"
template: product-strategy
template_version: "1"
kind: strategy
brief: [summary, focus, stop]
horizon: {from: "<YYYY-MM-DD>", to: "<YYYY-MM-DD>"}
review_on: "<YYYY-MM-DD>"
choices: []
---

# Product strategy {#title}
<!-- A decision framework, not a plan: the few problems that matter now, the insight behind each, what we stop, and how this serves the company strategy. It lasts one to two years, is checked every quarter and reviewed every year. Oracle recommends; the head of product, then the CEO, approve. Front matter: horizon (from, to), review_on, and choices, one {id, title, stance, goals or features} per choice: stance focus lists the confirmed goal keys it serves; stance stop lists the feature keys it covers. Every choice has its own {#choice-<id>} section below. At most five focus choices. -->

## Strategy in one paragraph {#summary}
<!-- Brief: fits one slide; plain language for an all-hands. One paragraph: where we focus, why, and what we stop. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Focus {#focus}
<!-- Brief: fits one slide; plain language for an all-hands. The few problems that matter now, at most five. One level-3 section per focus choice, id choice-<id>, matching the front matter. -->

### <Focus choice> {#choice-item}
<!-- Repeat per focus choice. The problem, the insight behind it (with its evidence in Sources), the confirmed goals it serves, and what success looks like. -->

## What we stop or won't do {#stop}
<!-- Brief: fits one slide; plain language for an all-hands. One level-3 section per stop choice, id choice-<id>, matching the front matter. -->

### <Stop choice> {#choice-stop-item}
<!-- Repeat per stop choice. The work, why it stops, and which features or roadmap items it covers. -->

# Full version {#full}
<!-- Everything below is the detail behind the brief. -->

## Insights {#insights}
<!-- What the data and customers tell us that others have not acted on. Each insight cites its evidence. -->

## How this serves the company strategy {#company}
<!-- The company's own strategy material (cited from its sources) and how each focus choice serves it. -->

## Trade-offs and risks {#tradeoffs}
<!-- What these choices cost, the strongest argument against them, and the signals that would change them. -->

## Horizon and review {#horizon}
<!-- The dates the strategy covers, the quarterly check, and the yearly review date (the front matter's review_on). -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web, oracle), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "focus: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
