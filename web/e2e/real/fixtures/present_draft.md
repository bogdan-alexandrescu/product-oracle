---
document: e2e-present
title: Present checkout PRD
template: oracle-default
template_version: "2"
citations:
  - id: c1
    source: slack
    ref: https://example.slack.com/archives/C1/p1
    title: Drop-off thread
  - id: c2
    source: notion
    ref: https://notion.so/example/funnel
    title: Funnel review
---

# Present checkout PRD {#title}

## Summary {#summary}
We will cut checkout to one page for returning buyers.

```notes
Open with the drop-off number.
```

## Goal trace {#goal-trace}
- Activation: more first orders this quarter.

## Problem {#problem}
Returning buyers abandon at the shipping step.

## Features by milestone {#brief-items}
| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [Beta](#milestone-beta) | [Saved addresses](#feature-saved-addresses) | Activation | Less typing |
|  | [One-page checkout](#feature-one-page) | Activation | One step to pay |

## Roadmap {#brief-roadmap}
- [Beta](#milestone-beta): returning buyers pay in one step.

## Non-goals {#non-goals}
- Redesigning guest checkout.

## Top risks {#top-risks}
- Payment provider limits: test with the provider first. See [Risks](#risks).

## Decisions needed {#decisions}
- Approve the beta scope: owner the founder, needed by 2026-11-01.

# Full version {#full}

## Feature detail {#feature-detail}

### Saved addresses {#feature-saved-addresses}
Buyers pick a saved address instead of typing it.

### One-page checkout {#feature-one-page}
Shipping, payment and review on one page.

## Milestones {#milestones}

### Beta {#milestone-beta}
Returning buyers in two regions; exit when drop-off falls.

## Risks and open questions {#risks}
- Payment provider limits, likelihood medium.

## Sources and data points {#sources}

### Sources {#sources-list}
- c1 slack Drop-off thread [c:c1]
- c2 notion Funnel review [c:c2]
