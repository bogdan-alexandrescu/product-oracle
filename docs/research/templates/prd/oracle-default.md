---
document: new-prd
title: "<Feature or product> PRD"
template: oracle-default
template_version: "1"
brief: [summary, goal-trace, problem, brief-items, brief-roadmap, non-goals, top-risks, decisions]
---

# <Feature or product> PRD {#title}
<!-- Goal-traced PRD: Oracle's default. Two alignment stages (problem, then solution) with a review between them, then launch. State conclusions in the body; put every source, number and piece of evidence in the last section. -->

## Summary {#summary}
<!-- Brief: fits one slide; plain language for an all-hands. Three to five sentences a busy founder can approve from: what we will build, for whom, which goal it serves, and the decision asked of the reader. Write it last. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goal trace {#goal-trace}
<!-- Brief: fits one slide; plain language for an all-hands. Which confirmed company goals this serves and how. One bullet per goal: goal name, horizon, expected contribution. If a proposed feature serves no confirmed goal, say so here; it is flagged and ranked last. -->

## Problem {#problem}
<!-- Brief: fits one slide; plain language for an all-hands. The problem in one or two sentences from the customer's side: the outcome they want, why, and what hurts today. No solution words. -->

## Features by milestone {#brief-items}
<!-- Brief: fits one slide; plain language for an all-hands. One row per feature, one line each. Rows are grouped by milestone in delivery order, and the milestone is named only on the first row of its group. Columns: | Milestone | Feature | Goal | Outcome |. The milestone cell links to the milestone's detail section under Milestones and the feature cell links to the feature's detail section under Feature detail, using in-document links such as [Beta](#milestone-beta) and [Bulk import](#feature-bulk-import); the detail section ids must match the links. -->

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [<Milestone>](#milestone-item) | [<Feature>](#feature-item) | <goal> | <one-line outcome> |

## Roadmap {#brief-roadmap}
<!-- Brief: fits one slide; plain language for an all-hands. One line per milestone, in order: the milestone linked to its detail section, then the outcome it delivers for customers or the business, not the features in it. -->

- [<Milestone>](#milestone-item): <outcome this milestone delivers>

## Non-goals {#non-goals}
<!-- Brief: fits one slide; plain language for an all-hands. Things a reasonable reader might expect us to do that we deliberately will not. Not negated goals. -->

## Top risks {#top-risks}
<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks, one line each with its mitigation. The full list lives in Risks and open questions. -->

- <Risk>: <mitigation>. See [Risks and open questions](#risks).

## Decisions needed {#decisions}
<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience, one line each with the owner and the date the decision is needed by. -->

- <Decision>: owner <name>, needed by <date>

# Full version {#full}
<!-- Everything below is the full document: the detail behind each brief section. -->

## Problem alignment {#problem-alignment}

### Who has it {#audience}
<!-- Segments or job stories ("when ..., I want to ..., so I can ..."). Who is not the target. -->

### Why now {#why-now}
<!-- What changed that makes this worth doing this horizon rather than later. -->

### Success measures {#success}
<!-- Two to four measurable outcomes with target and time frame, tied to the goals in the goal trace. Include one guardrail metric that must not get worse. -->

## Solution alignment {#solution-alignment}

### Approach {#approach}
<!-- The chosen approach at the right altitude: enough for design and engineering to see the shape, not the implementation. Name the main alternative and why it lost. -->

### Prioritized features {#features}
<!-- Features in priority order from the selected method (goal-weighted by default; RICE, MoSCoW or WSJF if chosen). One line each: feature, goal served, score summary, dependency. Explanations of each number go in the sources section. -->

### Key flows {#flows}
<!-- End-to-end user flows for the top features. Reference the SVG flow and low-fi wireframes by name. -->

### Requirements {#requirements}
<!-- Numbered, stable ids (R1, R2 ...) that never get renumbered between versions. Each: the requirement, the feature it belongs to, acceptance criteria in Given / When / Then form. -->

### Rules and edge cases {#edge-cases}
<!-- Business logic, permissions, empty and error states, limits, migrations. -->

## Feature detail {#feature-detail}
<!-- One level-3 section per feature, id feature-<slug>, in priority order; the brief table links to each. Each holds the feature's user stories, acceptance criteria (or the requirement ids that carry them), flows and dependencies. -->

### <Feature> {#feature-item}
<!-- Repeat per feature. What it does for whom, the goal it serves, user stories, acceptance criteria or requirement ids, key flow, dependencies on other features or teams. -->

## Risks and open questions {#risks}
<!-- Each risk with likelihood, impact and mitigation. Open questions with owner and the date they must be answered by. -->

## Milestones {#milestones}
<!-- One level-3 section per milestone, id milestone-<slug>, in date order; the brief table and roadmap link to each. -->

### <Milestone> {#milestone-item}
<!-- Repeat per milestone. Scope (the features it contains), exit criteria, the date and its source (tracker estimate, external date, or not yet dated). -->

## Launch {#launch}
<!-- Rollout stages (internal, beta, general) with exit criteria for each; teams that must be ready (support, sales, docs, analytics). Delete if the change ships dark or is trivial. -->

## Post-launch recap {#recap}
<!-- Filled after launch: did the success measures move, did the feature serve its goal, what we learned. Feeds the replay test. Leave empty until then. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web, oracle), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
