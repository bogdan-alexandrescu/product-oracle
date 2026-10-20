---
document: new-product-spec
title: "<Feature> product spec and RFC"
template: prd-rfc
template_version: "1"
brief: [summary, goal-trace, problem, brief-items, brief-roadmap, not-doing, top-risks, decisions]
---

# <Feature> product spec and RFC {#title}
<!-- Product half first (why and what, owned by product), engineering half second (how, owned by engineering). The product half is approved before the engineering half is written. Suited to engineering-heavy, API, infra or platform work. -->

## Summary {#summary}
<!-- Brief: fits one slide; plain language for an all-hands. Three sentences: the problem, the proposed change, and the decision needed. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goal trace {#goal-trace}
<!-- Brief: fits one slide; plain language for an all-hands. Confirmed company goals served and expected contribution. If none, say so. -->

## Problem {#problem}
<!-- Brief: fits one slide; plain language for an all-hands. The problem by affected user or system, and what it costs today. -->

## Features by milestone {#brief-items}
<!-- Brief: fits one slide; plain language for an all-hands. One row per feature, one line each. Rows are grouped by milestone in delivery order, and the milestone is named only on the first row of its group. Columns: | Milestone | Feature | Goal | Outcome |. The milestone cell links to the milestone's detail section under Milestones and the feature cell links to the feature's detail section under Feature detail, using in-document links such as [Beta](#milestone-beta) and [Bulk import](#feature-bulk-import); the detail section ids must match the links. -->

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [<Milestone>](#milestone-item) | [<Feature>](#feature-item) | <goal> | <one-line outcome> |

## Roadmap {#brief-roadmap}
<!-- Brief: fits one slide; plain language for an all-hands. One line per milestone, in order: the milestone linked to its detail section, then the outcome it delivers for users or the business, not the features in it. -->

- [<Milestone>](#milestone-item): <outcome this milestone delivers>

## Not doing {#not-doing}
<!-- Brief: fits one slide; plain language for an all-hands. The main non-goals from Goals and non-goals, one line each with the reason. -->

## Top risks {#top-risks}
<!-- Brief: fits one slide; plain language for an all-hands. The three biggest product or technical risks, one line each with its mitigation. Unresolved points stay in Open questions. -->

- <Risk>: <mitigation>

## Decisions needed {#decisions}
<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience (for example Part A sign-off), one line each with the owner and the date the decision is needed by. -->

- <Decision>: owner <name>, needed by <date>

# Full version {#full}
<!-- Everything below is the full document: the detail behind each brief section. -->

## Part A: product requirements {#product}

### Background {#background}
<!-- Objective facts a newcomer needs: current system, users, constraints. No argument. -->

### Goals and non-goals {#goals}
<!-- Goals as outcomes; non-goals as things that could reasonably be goals but are excluded. -->

### Requirements {#requirements}
<!-- Numbered, stable ids (R1, R2 ...), each with priority from the selected method and acceptance criteria in Given / When / Then form. Phase them if delivery is incremental. Mark unresolved points as open questions instead of guessing. -->

### Success measures {#success}
<!-- Product metrics plus service levels (latency, availability, cost) where they matter. -->

### Product sign-off {#product-signoff}
<!-- Who approved Part A and when; Part B starts after this. -->

## Feature detail {#feature-detail}
<!-- Part of the product half. One level-3 section per feature, id feature-<slug>, in priority order; the brief table links to each. Each holds the feature's user stories, acceptance criteria (or the requirement ids that carry them), flows and dependencies. -->

### <Feature> {#feature-item}
<!-- Repeat per feature. What it does for whom, the goal it serves, user stories, requirement ids and their acceptance criteria, key flow, dependencies on other features, systems or teams. -->

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

## Milestones {#milestones}
<!-- One level-3 section per milestone from the delivery plan, id milestone-<slug>, in date order; the brief table and roadmap link to each. -->

### <Milestone> {#milestone-item}
<!-- Repeat per milestone. Scope (the features and requirement ids it contains), exit criteria, the date and its source (tracker estimate, external date, or not yet dated). -->

## Open questions {#open-questions}
<!-- Each with owner and needed-by date. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web, oracle), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
