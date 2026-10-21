---
document: new-one-pager
title: "<Idea> one-pager"
template: one-pager
template_version: "1"
brief: [summary, goal-trace, problem, brief-items, brief-roadmap, non-goals, top-risks, decisions]
---

# <Idea> one-pager {#title}
<!-- Fits on one page. Short answers under each heading, no sub-sections. The aim is a yes/no on investing more time, not a build spec. -->

## Summary {#summary}
<!-- Brief: fits one slide; plain language for an all-hands. Two or three sentences: the idea, who it is for, the goal it serves, and the yes/no asked for. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goal served {#goal-trace}
<!-- Brief: fits one slide; plain language for an all-hands. One line: the confirmed company goal this moves and how. If none, say so; Oracle will flag it. -->

## Problem {#problem}
<!-- Brief: fits one slide; plain language for an all-hands. The customer problem, in the customer's terms. No solution words. -->

## Features by milestone {#brief-items}
<!-- Brief: fits one slide; plain language for an all-hands. One row per feature, one line each; a one-pager usually has one or two milestones. Rows are grouped by milestone in delivery order, and the milestone is named only on the first row of its group. Columns: | Milestone | Feature | Goal | Outcome |. The milestone cell links to the milestone's detail section under Milestones and the feature cell links to the feature's detail section under Feature detail, using in-document links such as [Beta](#milestone-beta) and [Bulk import](#feature-bulk-import); the detail section ids must match the links. -->

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [<Milestone>](#milestone-item) | [<Feature>](#feature-item) | <goal> | <one-line outcome> |

## Roadmap {#brief-roadmap}
<!-- Brief: fits one slide; plain language for an all-hands. One line per milestone, in order: the milestone linked to its detail section, then the outcome it delivers for customers or the business, not the features in it. -->

- [<Milestone>](#milestone-item): <outcome this milestone delivers>

## Not doing {#non-goals}
<!-- Brief: fits one slide; plain language for an all-hands. Two or three explicit exclusions. -->

## Top risks {#top-risks}
<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks, one line each with its mitigation. -->

- <Risk>: <mitigation>

## Decisions needed {#decisions}
<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience, one line each with the owner and the date the decision is needed by. -->

- <Decision>: owner <name>, needed by <date>

# Full version {#full}
<!-- Everything below is the full document: the detail behind each brief section. -->

## What it is {#description}
<!-- One or two sentences a newcomer would understand. -->

## Why we believe it {#why}
<!-- Why this is a real problem worth solving now, as conclusions. The evidence itself goes in the sources section. -->

## Who it is for {#audience}
<!-- Target segment or a job story. Name who it is not for. -->

## What success looks like {#success}
<!-- One or two measurable outcomes with a target and time frame. -->

## What it looks like {#what}
<!-- The shape of the solution in a few bullets or one sketch reference. -->

## Feature detail {#feature-detail}
<!-- One level-3 section per feature, id feature-<slug>; the brief table links to each. The only sub-sections in a one-pager: keep each to a few lines of user stories, acceptance criteria, flow and dependencies. -->

### <Feature> {#feature-item}
<!-- Repeat per feature. What it does for whom, the goal it serves, one or two user stories, acceptance criteria, flow, dependencies. -->

## Milestones {#milestones}
<!-- One level-3 section per milestone, id milestone-<slug>, in date order; the brief table and roadmap link to each. Keep each to a few lines. -->

### <Milestone> {#milestone-item}
<!-- Repeat per milestone. Scope (the features it contains), exit criteria, the date and its source (tracker estimate, external date, or not yet dated). -->

## Priority {#priority}
<!-- One line: score summary from the selected method and the rank among current candidates. -->

## Next step {#next-step}
<!-- The decision asked for and what happens if approved (full PRD, pitch, prototype). -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web, oracle), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
