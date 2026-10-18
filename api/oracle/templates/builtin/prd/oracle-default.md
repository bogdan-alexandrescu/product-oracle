---
document: new-prd
title: "<Feature or product> PRD"
template: oracle-default
template_version: "1"
---

# <Feature or product> PRD {#title}
<!-- Goal-traced PRD: Oracle's default. Two alignment stages (problem, then solution) with a review between them, then launch. State conclusions in the body; put every source, number and piece of evidence in the last section. -->

## 1. Summary {#summary}
<!-- Three to five sentences a busy founder can approve from: what we will build, for whom, which goal it serves, and the decision asked of the reader. Write it last. -->

## 2. Goal trace {#goal-trace}
<!-- Which confirmed company goals this serves and how. One bullet per goal: goal name, horizon, expected contribution. If a proposed feature serves no confirmed goal, say so here; it is flagged and ranked last. -->

## 3. Problem alignment {#problem-alignment}

### 3.1 Problem {#problem}
<!-- The problem in one or two sentences from the customer's side: the outcome they want, why, and what hurts today. No solution words. -->

### 3.2 Who has it {#audience}
<!-- Segments or job stories ("when ..., I want to ..., so I can ..."). Who is not the target. -->

### 3.3 Why now {#why-now}
<!-- What changed that makes this worth doing this horizon rather than later. -->

### 3.4 Success measures {#success}
<!-- Two to four measurable outcomes with target and time frame, tied to the goals in the goal trace. Include one guardrail metric that must not get worse. -->

### 3.5 Non-goals {#non-goals}
<!-- Things a reasonable reader might expect us to do that we deliberately will not. Not negated goals. -->

## 4. Solution alignment {#solution-alignment}

### 4.1 Approach {#approach}
<!-- The chosen approach at the right altitude: enough for design and engineering to see the shape, not the implementation. Name the main alternative and why it lost. -->

### 4.2 Prioritized features {#features}
<!-- Features in priority order from the selected method (goal-weighted by default; RICE, MoSCoW or WSJF if chosen). One line each: feature, goal served, score summary, dependency. Explanations of each number go in the sources section. -->

### 4.3 Key flows {#flows}
<!-- End-to-end user flows for the top features. Reference the SVG flow and low-fi wireframes by name. -->

### 4.4 Requirements {#requirements}
<!-- Numbered, stable ids (R1, R2 ...) that never get renumbered between versions. Each: the requirement, the feature it belongs to, acceptance criteria in Given / When / Then form. -->

### 4.5 Rules and edge cases {#edge-cases}
<!-- Business logic, permissions, empty and error states, limits, migrations. -->

## 5. Risks and open questions {#risks}
<!-- Each risk with likelihood, impact and mitigation. Open questions with owner and the date they must be answered by. -->

## 6. Launch {#launch}
<!-- Rollout stages (internal, beta, general) with exit criteria for each; teams that must be ready (support, sales, docs, analytics). Delete if the change ships dark or is trivial. -->

## 7. Post-launch recap {#recap}
<!-- Filled after launch: did the success measures move, did the feature serve its goal, what we learned. Feeds the replay test. Leave empty until then. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
