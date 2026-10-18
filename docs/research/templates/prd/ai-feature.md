---
document: new-ai-feature
title: "<AI feature> PRD"
template: ai-feature
template_version: "1"
brief: [summary, goal-trace, problem, brief-items, brief-roadmap, not-doing, top-risks, decisions]
---

# <AI feature> PRD {#title}
<!-- For features whose output comes from a model or agent. Output varies run to run, so requirements are written as behaviour classes and eval thresholds rather than exact outputs. -->

## Summary {#summary}
<!-- Brief: fits one slide; plain language for an all-hands. What the feature does for whom, the goal it serves, and the quality bar for shipping. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goal trace {#goal-trace}
<!-- Brief: fits one slide; plain language for an all-hands. Confirmed company goals served and expected contribution. If none, say so. -->

## Problem and users {#problem}
<!-- Brief: fits one slide; plain language for an all-hands. The user problem and the situations in which they would reach for this feature. Why AI is the right tool rather than deterministic logic. -->

## Features by milestone {#brief-items}
<!-- Brief: fits one slide; plain language for an all-hands. One row per feature, one line each. Rows are grouped by milestone in delivery order, and the milestone is named only on the first row of its group. Columns: | Milestone | Feature | Goal | Outcome |. The milestone cell links to the milestone's detail section under Milestones and the feature cell links to the feature's detail section under Feature detail, using in-document links such as [Beta](#milestone-beta) and [Bulk import](#feature-bulk-import); the detail section ids must match the links. -->

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [<Milestone>](#milestone-item) | [<Feature>](#feature-item) | <goal> | <one-line outcome> |

## Roadmap {#brief-roadmap}
<!-- Brief: fits one slide; plain language for an all-hands. One line per milestone, in order: the milestone linked to its detail section, then the outcome it delivers for users or the business (including the quality bar reached), not the features in it. -->

- [<Milestone>](#milestone-item): <outcome this milestone delivers>

## Not doing {#not-doing}
<!-- Brief: fits one slide; plain language for an all-hands. Two or three things a reader might expect the feature to do that it deliberately will not, including tasks we keep out of the model's hands, each with a one-line reason. -->

## Top risks {#top-risks}
<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks (quality, safety, cost or adoption), one line each with its mitigation. The full list lives in Risks and open questions. -->

- <Risk>: <mitigation>. See [Risks and open questions](#risks).

## Decisions needed {#decisions}
<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience (for example a ship threshold or a budget limit), one line each with the owner and the date the decision is needed by. -->

- <Decision>: owner <name>, needed by <date>

# Full version {#full}
<!-- Everything below is the full document: the detail behind each brief section. -->

## Success measures {#success}
<!-- Product outcomes (adoption, task success, time saved) and their targets. Quality thresholds live in the eval plan below. -->

## Priority {#priority}
<!-- Score summary from the selected method; include model and run cost in effort. -->

## Experience {#experience}
<!-- Key flows and screens, including how the user sees, edits, accepts or rejects model output. -->

## Feature detail {#feature-detail}
<!-- One level-3 section per feature, id feature-<slug>, in priority order; the brief table links to each. Each holds the feature's user stories, acceptance criteria (behaviour classes and the eval thresholds that gate it), flows and dependencies. -->

### <Feature> {#feature-item}
<!-- Repeat per feature. What it does for whom, the goal it serves, user stories, acceptance criteria as behaviour classes and eval thresholds, key flow, dependencies on models, tools, data or teams. -->

## Behaviour {#behaviour}

### Behaviour matrix {#behaviour-matrix}
<!-- Table of input classes (typical, ambiguous, out of scope, adversarial, empty or oversized). For each: the expected behaviour, acceptable failure, and forbidden output. -->

### Fallbacks {#fallbacks}
<!-- What the user sees and what the system does on refusal, low confidence, timeout, tool or retrieval failure, and rate limits. -->

### Guardrails and policy {#guardrails}
<!-- Content, privacy and safety rules; what is logged; human review points; regulatory constraints. -->

## Model and context {#model}
<!-- Approach (prompting, retrieval, tools, fine-tuning, agent), model tier, context sources and their freshness, and why this approach over the simpler one. -->

## Eval plan {#evals}
<!-- Named, versioned eval set; how it is built and refreshed; metrics with ship thresholds (quality, refusal rate, hallucination rate, latency, cost per run); who signs off a threshold. Evals re-run on every prompt or model change. -->

## Prompt and model ownership {#ownership}
<!-- Who may change prompts, models and tools after launch; review and eval gate before a change ships; how versions are recorded so any output traces to a version. -->

## Milestones {#milestones}
<!-- One level-3 section per milestone, id milestone-<slug>, in date order; the brief table and roadmap link to each. -->

### <Milestone> {#milestone-item}
<!-- Repeat per milestone. Scope (the features it contains), exit criteria (including the eval thresholds that must pass), the date and its source (tracker estimate, external date, or not yet dated). -->

## Cost and operations {#operations}
<!-- Expected cost per use and per month, budget limits, monitoring, rollout ramp and kill switch. -->

## Risks and open questions {#risks}
<!-- Each with owner and mitigation. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
