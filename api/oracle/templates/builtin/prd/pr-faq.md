---
document: new-pr-faq
title: "<Product> PR/FAQ"
template: pr-faq
template_version: "1"
brief: [summary, goal-trace, problem, brief-items, brief-roadmap, not-doing, top-risks, decisions]
---

# <Product> PR/FAQ {#title}
<!-- Working Backwards: write the launch announcement first, as if the product already shipped, then answer the hard questions. Press release under one page, whole document about six. Plain language, no internal jargon. -->

## Summary {#summary}
<!-- Brief: fits one slide; plain language for an all-hands. Three sentences: the product, the customer and the benefit they get, and the decision asked of the reader. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goal trace {#goal-trace}
<!-- Brief: fits one slide; plain language for an all-hands. Confirmed company goals served, horizon and expected contribution, one line each. If none, say so. -->

## Problem {#problem}
<!-- Brief: fits one slide; plain language for an all-hands. The customer problem in one or two sentences, as the customer would put it. No solution words. -->

## Features by milestone {#brief-items}
<!-- Brief: fits one slide; plain language for an all-hands. One row per feature, one line each. Rows are grouped by milestone in delivery order, and the milestone is named only on the first row of its group. Columns: | Milestone | Feature | Goal | Outcome |. The milestone cell links to the milestone's detail section under Milestones and the feature cell links to the feature's detail section under Feature detail, using in-document links such as [Beta](#milestone-beta) and [Bulk import](#feature-bulk-import); the detail section ids must match the links. -->

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [<Milestone>](#milestone-item) | [<Feature>](#feature-item) | <goal> | <one-line outcome> |

## Roadmap {#brief-roadmap}
<!-- Brief: fits one slide; plain language for an all-hands. One line per milestone, in order: the milestone linked to its detail section, then the outcome it delivers for customers or the business, not the features in it. -->

- [<Milestone>](#milestone-item): <outcome this milestone delivers>

## Not doing {#not-doing}
<!-- Brief: fits one slide; plain language for an all-hands. Two or three things a customer might expect the product to do that it will not, one line each with the reason. -->

## Top risks {#top-risks}
<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks, one line each with its mitigation. The full answer lives in the internal FAQ. -->

- <Risk>: <mitigation>. See [What are the biggest risks?](#faq-risks)

## Decisions needed {#decisions}
<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience, one line each with the owner and the date the decision is needed by. -->

- <Decision>: owner <name>, needed by <date>

# Full version {#full}
<!-- Everything below is the full document: the detail behind each brief section. -->

## Press release {#press-release}
<!-- Written as a future-dated announcement aimed at customers. No numbers that need a source; keep claims to what the customer would experience. -->

### Headline {#headline}
<!-- Product name and the benefit, in words a customer would use. -->

### Subheading {#subheading}
<!-- One sentence: who the customer is and what they now get. -->

### Summary {#pr-summary}
<!-- Opening paragraph: place and future launch date, what it is, the main benefit. -->

### Customer problem {#pr-problem}
<!-- The problem as the customer lives it today. -->

### Solution {#pr-solution}
<!-- How the product removes the problem, from the customer's side. -->

### Leader quote {#leader-quote}
<!-- A short, invented quote from the company's leader on why this matters. Clearly a draft device, not a real statement. -->

### How it works {#how-it-works}
<!-- The few steps a customer takes to get value. -->

### Customer quote {#customer-quote}
<!-- An imagined customer describing the benefit in their own words. Fictional; never attribute to a real person. -->

### How to get started {#call-to-action}
<!-- Where and how a customer starts. -->

## Customer FAQ {#customer-faq}
<!-- Questions a sceptical customer would ask: price, how it differs from what they use now, what it does not do, getting started, data and privacy. One sub-heading per question is optional; keep answers short. -->

## Internal FAQ {#internal-faq}
<!-- Questions leadership and investors would ask. Answer each plainly, including the uncomfortable ones. -->

### Which company goals does this serve? {#faq-goal-trace}
<!-- Goal trace: confirmed goals, horizon and expected contribution. If none, say so. -->

### Why this, and why now? {#faq-priority}
<!-- Rank against other candidates under the selected prioritization method, with the score summary; what we give up by doing this. -->

### How big is the opportunity? {#faq-opportunity}
<!-- Market or usage size as a conclusion; numbers go in the sources section. -->

### What will it cost to build and run? {#faq-cost}
<!-- Effort, teams, dependencies, running costs. -->

### What are the biggest risks? {#faq-risks}
<!-- Product, technical, legal and go-to-market risks, and what would make us stop. -->

### How will we know it worked? {#faq-success}
<!-- Measurable outcomes with targets and a time frame. -->

## Feature detail {#feature-detail}
<!-- One level-3 section per feature, id feature-<slug>, in priority order; the brief table links to each. Each holds the feature's user stories, acceptance criteria, flows and dependencies. -->

### <Feature> {#feature-item}
<!-- Repeat per feature. What it does for the customer, the goal it serves, user stories, acceptance criteria, key flow, dependencies on other features or teams. -->

## Milestones {#milestones}
<!-- One level-3 section per milestone, id milestone-<slug>, in date order; the brief table and roadmap link to each. -->

### <Milestone> {#milestone-item}
<!-- Repeat per milestone. Scope (the features it contains), exit criteria, the date and its source (tracker estimate, external date, or not yet dated). -->

## Sources and data points {#sources}
<!-- The only place for sources, numbers and evidence. The body above states conclusions only. List each source with its citation id from the front matter as plain text; no inline citation markers anywhere. -->

### Sources {#sources-list}
<!-- One line per source: citation id, kind (slack, notion, gdocs, github, fireflies, upload, web, oracle), title, date retrieved. -->

### Data points {#sources-data}
<!-- Each number used in the document: the value, what it measures, period, and the source id it came from. -->

### Evidence by section {#sources-evidence}
<!-- One bullet per body section, keyed by section id (e.g. "problem: c2, c5"), saying which sources and data points support it. Sections with no support say so. -->
