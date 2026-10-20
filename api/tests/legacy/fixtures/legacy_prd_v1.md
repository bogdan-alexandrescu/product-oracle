---
document: legacy-onboarding
title: Onboarding checklist PRD
template: oracle-default
template_version: "1"
snapshot: 2026-09-01T09:00Z
citations:
  - id: c1
    source: slack
    ref: https://example.slack.com/archives/C000/p1000
    title: "#product thread on setup"
    excerpt: "New teams stall before inviting anyone"
    retrieved_at: 2026-09-01T08:10Z
  - id: c2
    source: gdocs
    ref: https://docs.example.com/d/activation-review
    title: Activation review
    excerpt: "Only a third of new teams finish setup in week one"
---

# Onboarding checklist PRD {#title}

## Summary {#summary}

New teams get a five-step checklist that ends with their first shared project.

```notes
Open with the week-one setup number.
```

## Goal trace {#goal-trace}

Serves G1 (activation): more new teams reach their first shared project [c:c1].

## Problem {#problem}

Only a third of new teams finish setup in their first week [c:c2].

# Full version {#full}

## Requirements {#requirements}

### Checklist panel {#req-checklist}

Show the five steps with their state on the home screen.

### Invite step {#req-invite}

The invite step opens the invite form already filled with the team's domain.

#### Edge cases

- A team with no domain sees an empty form.

## Risks {#risks}

The checklist may feel like nagging to experienced users.

## Sources and data points {#sources}

- Week-one setup rate: one third, as of 2026-09-01, Activation review [c:c2]
- Setup stall: #product thread [c:c1]
