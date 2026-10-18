---
document: new-decision-memo
title: "<Decision> memo"
template: narrative-memo
template_version: "1"
brief: [decision, goal-trace, problem, brief-items, brief-roadmap, not-doing, top-risks, decisions]
---

# <Decision> memo {#title}
<!-- A narrative decision memo in the six-page tradition: full sentences and paragraphs, no bullet lists in the body, about six pages before the appendix. Headings exist so each part can be commented on and approved on its own. Keep conclusions in the prose; move numbers and evidence to the sources section. -->

## The decision {#decision}
<!-- Brief: the memo's summary slide; fits one slide; plain language for an all-hands. One paragraph: what we are asking the reader to decide and the recommended answer. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goals this serves {#goal-trace}
<!-- Brief: fits one slide; plain language for an all-hands. The confirmed company goals at stake and how each option moves them. -->

## The problem {#problem}
<!-- Brief: fits one slide; plain language for an all-hands. Two or three sentences: the problem this decision solves and who feels it. The full story is in Where we are and What changed. -->

## Features by milestone {#brief-items}
<!-- Brief: fits one slide; plain language for an all-hands. The brief is slide-shaped, so a table is allowed here even though the memo body is prose. What the recommended option delivers: one row per feature, one line each. Rows are grouped by milestone in delivery order, and the milestone is named only on the first row of its group. Columns: | Milestone | Feature | Goal | Outcome |. The milestone cell links to the milestone's detail section under Milestones and the feature cell links to the feature's detail section under Feature detail, using in-document links such as [Beta](#milestone-beta) and [Bulk import](#feature-bulk-import); the detail section ids must match the links. -->

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [<Milestone>](#milestone-item) | [<Feature>](#feature-item) | <goal> | <one-line outcome> |

## Roadmap {#brief-roadmap}
<!-- Brief: fits one slide; plain language for an all-hands. One line per milestone, in order: the milestone linked to its detail section, then the outcome it delivers for customers or the business, not the features in it. -->

- [<Milestone>](#milestone-item): <outcome this milestone delivers>

## Not doing {#not-doing}
<!-- Brief: fits one slide; plain language for an all-hands. What the recommendation rules out or leaves for later, one line each with the reason. -->

## Top risks {#top-risks}
<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks, one line each with its mitigation. The strongest argument against and the reversal signals live in Risks and what would change our mind. -->

- <Risk>: <mitigation>. See [Risks and what would change our mind](#risks).

## Decisions needed {#decisions}
<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience, one line each with the owner and the date the decision is needed by. -->

- <Decision>: owner <name>, needed by <date>

# Full version {#full}
<!-- Everything below is the full memo, in prose: the detail behind each brief section. -->

## Where we are {#context}
<!-- How things stand today and how we got here. Facts only, no argument yet. -->

## What changed {#trigger}
<!-- The event, learning or shift that makes the current path no longer right. -->

## Options {#options}
<!-- Two to four real options, each in a paragraph: what it is, what it gets us, what it costs, what it rules out. Include doing nothing. -->

## Recommendation {#recommendation}
<!-- The chosen option and the reasoning that links context, trigger and goals to it. Show the ranking from the selected prioritization method in prose. -->

## Feature detail {#feature-detail}
<!-- One level-3 section per feature of the recommended option, id feature-<slug>; the brief table links to each. In prose: the user stories it serves, how we will know it is done (acceptance criteria), the main flow, and its dependencies. -->

### <Feature> {#feature-item}
<!-- Repeat per feature. A short paragraph or two: what it does for whom, the goal it serves, acceptance criteria, flow and dependencies. -->

## Milestones {#milestones}
<!-- One level-3 section per milestone, id milestone-<slug>, in date order; the brief table and roadmap link to each. -->

### <Milestone> {#milestone-item}
<!-- Repeat per milestone. In prose: its scope (the features it contains), exit criteria, the date and its source (tracker estimate, external date, or not yet dated). -->

## What the future looks like {#future}
<!-- What is true in one to four quarters if we do this, including how we will measure it. -->

## Risks and what would change our mind {#risks}
<!-- The strongest argument against, and the signals that would make us reverse. -->

## Appendix {#appendix}
<!-- Optional tables, flows and detail a reader may skip. Tables and diagrams are allowed here. -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
