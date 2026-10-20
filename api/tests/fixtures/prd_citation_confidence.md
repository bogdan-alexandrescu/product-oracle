---
document: confidence-prd
title: Confidence PRD
snapshot: 2026-10-20T17:00Z
citations:
  - id: c1
    source: github
    ref: https://github.com/example/shop/issues/12
    title: 'Issue 12: shipping cost shown late'
    item: 3f1c2a4e-8b7d-4c1e-9a2b-5d6e7f809a1b
    confidence: 0.75
    confidence_note: 'two sources agree; fresh'
    low_confidence: false
  - id: c2
    source: slack
    ref: https://example.slack.com/archives/C123/p1700000000
    title: "#product thread on drop-off"
    confidence: 0.3
    confidence_note: 'one mention, 9 months old'
    low_confidence: true
  - id: o-d-ship
    source: oracle
    ref: baseline decision show-shipping-early (D2), locked
    confidence: null
    confidence_note: 'owner decision (confirmed, locked); not evidence-scored'
  - id: c3
    source: web
    ref: https://example.com/benchmarks
---

# Confidence PRD {#title}

## 1. Problem {#problem}

Buyers leave at the shipping step [c:c1] [c:c2].

## 2. Decisions {#decisions}

The shipping cost shows on the cart page [c:o-d-ship], as others do [c:c3].
