---
document: checkout-redesign
title: Checkout redesign PRD
template: oracle-default
template_version: "1"
snapshot: 2026-10-17T09:00Z
resolutions:
  - feedback_id: 11111111-1111-4111-8111-111111111111
    status: addressed
    note: "Shipping estimate now uses the postcode, see 5.2"
  - feedback_id: 22222222-2222-4222-8222-222222222222
    status: declined
    note: "Guest checkout stays out of scope for the first release"
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
  - id: c5
    source: notion
    ref: https://www.notion.so/example/rollout-plan
    title: Rollout plan
---

# Checkout redesign PRD {#title}

Owner: product. Status: draft for review.

## 1. Goal trace {#goal-trace}

Serves G1 (activation) and G2 (retention): more first-time buyers complete a purchase [c:c1].

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

Show an estimated shipping cost on the cart page, based on the postcode only.
Keep the address form state when the shopper navigates back [c:c4].

#### Edge cases

- Addresses outside supported regions show a clear message.

## 7. Risks {#risks}

Showing shipping cost early may lower cart-to-checkout clicks.

## 6. Success metrics {#metrics}

| Metric | Baseline | Target |
|--------|----------|--------|
| Checkout completion | 52% | 60% |

## 8. Rollout {#rollout}

Ship behind a flag to 10% of traffic, then 50%, then everyone [c:c5].
