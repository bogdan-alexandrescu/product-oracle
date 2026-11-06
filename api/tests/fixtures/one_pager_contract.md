---
document: pantry-lists
title: Pantry lists PRD
template: oracle-default
template_version: "1"
snapshot: 2026-10-20T10:00Z
citations:
  - id: c1
    source: web
    ref: https://example.com/pantry-survey
    title: Pantry survey, fall
    excerpt: "Most households write the same list every week"
    retrieved_at: 2026-10-20T09:00Z
  - id: c2
    source: web
    ref: https://example.com/list-usage
    title: List usage, Q3
    excerpt: "Two lists a week per household"
    retrieved_at: 2026-10-20T09:10Z
---

# Pantry lists PRD {#title}

Households plan the week's shopping in one shared list.

## Summary {#summary}

We will let a household keep one shared pantry list. It serves the repeat use goal.

```notes
Open with how often a list is written from scratch.
```

## Problem {#problem}

Households write the same shopping list every week, by hand, on paper or in a chat [c:c1]. Items get missed, two people buy the same thing, and the list is lost once the trip ends. The person who shops is often not the person who knows what ran out, so they call home from the store, guess, or come back without it. Many give up and shop from memory.

## Features by milestone {#brief-items}

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [Beta](#milestone-beta) | [Shared list](#feature-shared-list) | Repeat use | One list for the whole household |
|  | [Ran out button](#feature-ran-out) | Repeat use | An item goes on the list the moment it runs out |
| [General release](#milestone-ga) | [Store order](#feature-store-order) | Faster trips | The list follows the store's aisles |

## Feature detail {#feature-detail}

Keep every household's list on our servers, so each member sees the same list.

### Shared list {#feature-shared-list}

**Story:** as a member of a household, I want one list we all edit, so nobody buys twice.

**Acceptance:** an item added on one phone shows on the others within five seconds.

## Success metrics {#success-metrics}

- Lists made per household each week: from 2 to 5 [c:c2]
- Trips with a missed item: 40% → 15%
- Members who open the list in a week: from 1 to 3
- Shoppers tell us the list saves them time.
- Days between two trips: 7 days -> 3 days
- Repeat lists kept for a month: from 10% to 35%

## Non-goals {#non-goals}

- Prices and deals from stores.
- Lists shared outside the household.
- <!-- Add more only if asked. -->

## Risks and open questions {#risks}

1. Two members edit the same item at once: the last edit wins and the other sees a note about it, which we test with five households before the beta starts and again before the general release.
2. Too many alerts: one alert per trip, never more.
- Pick the store order source (our own map or the store's): owner the design lead, needed by Nov 20, 2026.

## Out of scope {#out-of-scope}

## Sources {#sources}

- Pantry survey, fall [c:c1]
