---
document: e2e-team-invoices
title: Team invoices PRD
snapshot: 2026-10-17T09:00Z
citations:
  - id: c1
    source: upload
    ref: https://files.example.com/research/billing-interviews.pdf
    title: Billing interview notes
    excerpt: "Finance leads export invoices one by one every month"
  - id: c2
    source: web
    ref: https://help.example.com/articles/invoices
    title: Help center article on invoices
resolutions:
  - feedback_id: "{{COMMENT_ITEM}}"
    status: addressed
    note: "Rows now offer a bulk download as a zip archive"
  - feedback_id: "{{VERDICT_ITEM}}"
    status: addressed
    note: "Added a numeric target for support tickets"
---

# Team invoices PRD {#title}

Owner: product. Status: draft for review.

## 1. Goal {#goal}

Finance leads get every invoice for their workspace in one place [c:c1].

## 2. Problem {#problem}

Invoices are emailed to whoever paid, so finance leads chase colleagues for
copies at month end [c:c2].

## 3. Proposed solution {#solution}

An invoices page lists every invoice with its amount and status. Each row has a
download link, and selected rows download together as one zip archive.

## 4. Success metrics {#metrics}

Support tickets about missing invoices drop by half within one quarter.
