---
document: new-pitch
title: "<Project> pitch"
template: shape-up-pitch
template_version: "1"
brief: [summary, goal-trace, problem, brief-items, brief-roadmap, no-gos, top-risks, decisions]
---

# <Project> pitch {#title}
<!-- A Shape Up style pitch: a shaped, rough solution offered for a fixed time budget, decided at a betting table. Conversational prose, rough sketches, no wireframe-level detail. -->

## Summary {#summary}
<!-- Brief: fits one slide; plain language for an all-hands. Two or three sentences: the problem, the shaped solution, the appetite, and the bet asked for. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goal served {#goal-trace}
<!-- Brief: fits one slide; plain language for an all-hands. One or two lines: the confirmed company goal this moves. If none, say so. -->

## Problem {#problem}
<!-- Brief: fits one slide; plain language for an all-hands. The raw situation or use case that motivates this, told concretely. A pitch without a problem cannot be judged. -->

## Features by milestone {#brief-items}
<!-- Brief: fits one slide; plain language for an all-hands. One row per element of the solution, one line each. Rows are grouped by milestone (for a single-cycle pitch, usually one milestone: the end of the cycle), and the milestone is named only on the first row of its group. Columns: | Milestone | Feature | Goal | Outcome |. The milestone cell links to the milestone's detail section under Milestones and the feature cell links to the feature's detail section under Feature detail, using in-document links such as [Beta](#milestone-beta) and [Bulk import](#feature-bulk-import); the detail section ids must match the links. -->

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [<Milestone>](#milestone-item) | [<Feature>](#feature-item) | <goal> | <one-line outcome> |

## Roadmap {#brief-roadmap}
<!-- Brief: fits one slide; plain language for an all-hands. One line per milestone: the milestone linked to its detail section, then the outcome it delivers for users, not the features in it. -->

- [<Milestone>](#milestone-item): <outcome this milestone delivers>

## No-gos {#no-gos}
<!-- Brief: fits one slide; plain language for an all-hands. Functionality and cases explicitly left out to fit the appetite. -->

## Top risks {#top-risks}
<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks to finishing within the appetite, one line each with how the pitch handles it. The full list lives in Rabbit holes. -->

- <Risk>: <mitigation>. See [Rabbit holes](#rabbit-holes).

## Decisions needed {#decisions}
<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience (usually the bet itself at the betting table), one line each with the owner and the date the decision is needed by. -->

- <Decision>: owner <name>, needed by <date>

# Full version {#full}
<!-- Everything below is the full document: the detail behind each brief section. -->

## Appetite {#appetite}
<!-- How much time this is worth (for example a two-week small batch or a six-week cycle) and with what team. This is a budget, not an estimate; the solution must fit it. -->

## Priority {#priority}
<!-- Score summary from the selected method, using the appetite as effort, and how it ranks against other pitches this cycle. -->

## Solution {#solution}
<!-- The core elements, rough enough to leave design to the team. Reference fat-marker style sketches or a breadboard (places, affordances, connections) by name. -->

## Feature detail {#feature-detail}
<!-- One level-3 section per element of the solution, id feature-<slug>; the brief table links to each. Stay rough: the user story it serves, what done looks like (acceptance criteria), the flow as places and affordances, and dependencies. -->

### <Feature> {#feature-item}
<!-- Repeat per element. What it lets the user do, the goal it serves, rough acceptance criteria, flow, dependencies. -->

## Rabbit holes {#rabbit-holes}
<!-- Details that could swallow the cycle and how the pitch already resolves or timeboxes each one. -->

## Milestones {#milestones}
<!-- One level-3 section per milestone, id milestone-<slug>; the brief table and roadmap link to each. A single-cycle pitch usually has one: the end of the cycle. -->

### <Milestone> {#milestone-item}
<!-- Repeat per milestone. Scope (the elements it contains), exit criteria, the date and its source (cycle calendar or not yet bet). -->

## Done means {#done}
<!-- What a user can do at the end of the cycle, and the measure we will look at afterwards. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web, oracle), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
