---
document: new-ai-feature
title: "<AI feature> PRD"
template: ai-feature
template_version: "1"
---

# <AI feature> PRD {#title}
<!-- For features whose output comes from a model or agent. Output varies run to run, so requirements are written as behaviour classes and eval thresholds rather than exact outputs. -->

## Summary {#summary}
<!-- What the feature does for whom, the goal it serves, and the quality bar for shipping. -->

## Goal trace {#goal-trace}
<!-- Confirmed company goals served and expected contribution. If none, say so. -->

## Problem and users {#problem}
<!-- The user problem and the situations in which they would reach for this feature. Why AI is the right tool rather than deterministic logic. -->

## Success measures {#success}
<!-- Product outcomes (adoption, task success, time saved) and their targets. Quality thresholds live in the eval plan below. -->

## Priority {#priority}
<!-- Score summary from the selected method; include model and run cost in effort. -->

## Experience {#experience}
<!-- Key flows and screens, including how the user sees, edits, accepts or rejects model output. -->

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
