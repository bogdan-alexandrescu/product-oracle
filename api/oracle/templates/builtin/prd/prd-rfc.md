---
document: new-product-spec
title: "<Feature> product spec and RFC"
template: prd-rfc
template_version: "1"
---

# <Feature> product spec and RFC {#title}
<!-- Product half first (why and what, owned by product), engineering half second (how, owned by engineering). The product half is approved before the engineering half is written. Suited to engineering-heavy, API, infra or platform work. -->

## Summary {#summary}
<!-- Three sentences: the problem, the proposed change, and the decision needed. -->

## Part A: product requirements {#product}

### Background {#background}
<!-- Objective facts a newcomer needs: current system, users, constraints. No argument. -->

### Problem {#problem}
<!-- The problem by affected user or system, and what it costs today. -->

### Goal trace {#goal-trace}
<!-- Confirmed company goals served and expected contribution. If none, say so. -->

### Goals and non-goals {#goals}
<!-- Goals as outcomes; non-goals as things that could reasonably be goals but are excluded. -->

### Requirements {#requirements}
<!-- Numbered, stable ids (R1, R2 ...), each with priority from the selected method and acceptance criteria in Given / When / Then form. Phase them if delivery is incremental. Mark unresolved points as open questions instead of guessing. -->

### Success measures {#success}
<!-- Product metrics plus service levels (latency, availability, cost) where they matter. -->

### Product sign-off {#product-signoff}
<!-- Who approved Part A and when; Part B starts after this. -->

## Part B: technical design {#design}
<!-- Written or reviewed by engineering. Oracle drafts from the code map; engineering owns the result. -->

### Proposal {#proposal}
<!-- The design and the trade-offs it makes, at system level. Reference architecture and sequence diagrams by name. -->

### Interfaces and data {#interfaces}
<!-- APIs, events, data model and migration changes. -->

### Cross-cutting concerns {#cross-cutting}
<!-- Security, privacy, observability, performance, cost, rollout and rollback. -->

### Alternatives considered {#alternatives}
<!-- Other designs and why they lost, including the requirement or constraint each failed. -->

### Delivery plan {#delivery}
<!-- Milestones mapped to requirement ids; epics and issues to create. -->

## Open questions {#open-questions}
<!-- Each with owner and needed-by date. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
