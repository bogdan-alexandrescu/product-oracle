---
document: checkout-redesign
title: Checkout redesign PRD
template: oracle-default
template_version: "1"
snapshot: 2026-10-16T14:00Z
citations:
  - id: c1
    source: slack
    ref: https://example.slack.com/archives/C123/p1700000000
    title: "#product thread on drop-off"
    excerpt: "Most users abandon at the shipping step"
    retrieved_at: 2026-10-16T13:10Z
  - id: c2
    source: gdocs
    ref: https://docs.example.com/d/checkout-funnel-q3
    title: Checkout funnel analysis, Q3
    excerpt: "38% of sessions that reach shipping never reach payment"
    retrieved_at: 2026-10-16T13:20Z
  - id: c3
    source: fireflies
    ref: https://app.example.com/view/interview-07
    title: Customer interview 7
    excerpt: "I did not know what shipping would cost until the very end"
  - id: c4
    source: github
    ref: https://github.com/example-org/storefront/issues/412
    title: "Address form loses state on back navigation"
---

# Checkout redesign PRD {#title}

Owner: product. Status: draft for review.

## 1. Goal trace {#goal-trace}

Serves G1 (activation): more first-time buyers complete a purchase [c:c1].

## 2. Problem {#problem}

Too many shoppers leave checkout before paying. The biggest drop is at the
shipping step, where 38% of sessions stop [c:c2]. Shoppers say shipping cost
comes as a surprise [c:c3].

## 3. Users {#users}

- First-time buyers on mobile.
- Returning buyers with a saved address.

## 5. Proposed solution {#solution}

A three-step checkout: cart, shipping, payment.

### 5.1 Payment step {#s-5-1}

Show saved cards first and offer wallet payments above the card form.

### 5.2 Shipping step {#s-5-2}

Show the shipping cost on the cart page, before the shopper enters an address.
Keep the address form state when the shopper navigates back [c:c4].

#### Edge cases

- Addresses outside supported regions show a clear message.

## 6. Success metrics {#metrics}

| Metric | Baseline | Target |
|--------|----------|--------|
| Checkout completion | 52% | 60% |

## 7. Risks {#risks}

Showing shipping cost early may lower cart-to-checkout clicks.

## 8. Open questions {#open-questions}

Do we need guest checkout in the first release?
