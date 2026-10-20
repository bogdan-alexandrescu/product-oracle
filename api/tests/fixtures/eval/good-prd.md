---
document: saved-addresses
title: Saved addresses PRD
owner: product-lead
approvers: [founder]
---

# Saved addresses PRD {#title}

## Problem {#problem}

Returning buyers on the example storefront retype their shipping address on every order.
In the synthetic funnel, 21% of returning sessions that reach the address step abandon
there, and support logs list address re-entry as the second most common complaint.

## Users {#users}

- Returning buyers who ordered at least twice in the last 90 days.
- Support agents who correct mistyped addresses.

## Goals {#goals}

Serves the repeat-purchase goal: raise the share of returning buyers who complete checkout.

## Alternatives considered {#alternatives}

- Browser autofill only: no work, but it fails on shared devices; rejected.
- Address book with up to five saved addresses: chosen; more work, full control.
- Third-party address lookup: faster entry, adds a per-lookup cost; kept as a fallback.

Trade-off: we accept two weeks of extra work for control over stored data.

## Risks and constraints {#risks}

The address lookup provider caps requests per minute. Batching keeps us inside the
published quota.

## Scope {#scope}

- Save, edit and delete up to five addresses per buyer.
- Pick a saved address at checkout.

## Non-goals {#non-goals}

- No address sharing between accounts.
- No international address validation in this release.

## Acceptance criteria {#acceptance}

- A buyer with a saved address completes the address step in under 10 seconds at the 90th percentile.
- Deleting an address removes it from checkout within 1 minute.
- At most 0.5% of orders fail address validation after the change.

## Economics and scaling {#economics}

Engineering cost is about 3 engineer-weeks. The lookup fallback costs $0.002 per call; at
40,000 calls a month that is $80. Storage grows by about 1 KB per buyer, 50 MB at 50,000
buyers.

## Success metrics {#metrics}

Repeat checkout completion rises from 62% to at least 68% within 60 days of launch. If it
stays below 64% after 30 days, we stop and revisit the design.

## Validation plan {#validation}

A two-week pilot with 10% of returning buyers, compared with a holdout group, before the
full rollout.

## Rollout and operations {#rollout}

Owner: checkout team. Feature flag rollout 10%, then 50%, then 100%. Monitoring alerts on
an address-step error rate above 1%; support has a runbook for address corrections.

## Sources and data points {#sources}

- Synthetic funnel, as of October.
