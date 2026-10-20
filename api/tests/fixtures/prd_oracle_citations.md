---
document: example-prd
title: Example PRD
snapshot: 2026-10-20T17:00Z
citations:
  - id: o-g1
    source: oracle
    ref: baseline goal g1 (activation), locked
    title: 'Goal G1: raise first-order completion'
    excerpt: 'Raise first-order completion from 61% to 70% by the end of Q4.'
    retrieved_at: 2026-10-20T17:02Z
  - id: o-d-ship
    source: oracle
    ref: baseline decision show-shipping-early (D2), decided by the product lead 2026-10-18, locked
    title: 'Decision D2: show the shipping cost on the cart page'
    excerpt: 'The shipping cost shows before checkout starts.'
    retrieved_at: 2026-10-20T17:02Z
  - id: c1
    source: slack
    ref: https://example.slack.com/archives/C123/p1700000000
    title: "#product thread on drop-off"
    excerpt: "Most users abandon at the shipping step"
    retrieved_at: 2026-10-16T13:10Z
---

# Example PRD {#title}

## 1. Goal {#goal}

Serves G1 (activation) [c:o-g1]: buyers leave at the shipping step [c:c1].

## 2. Decisions {#decisions}

The shipping cost shows on the cart page [c:o-d-ship].
