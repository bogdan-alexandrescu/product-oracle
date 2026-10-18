---
document: roadmap
title: Outcome roadmap
template: outcome-roadmap
template_version: 1
kind: roadmap
---

# {{product}} outcome roadmap {#roadmap}

<!-- Goal-first view (O4 "Outcome roadmap"). Rows are confirmed company goals; columns are horizons. Answers "are we working on the right things?" before "what ships when". One line under the title: as-of date, approved version, audience variant. -->

## Layout {#layout}

<!-- Machine-readable layout. The renderer reads this block. -->

```yaml
layout:
  type: matrix
  rows:
    source: confirmed_goals           # baseline Goal entities, status confirmed
    order_by: weight                  # goal weight, highest first
    header_fields: [code, title, metric, current, target, horizon, owner]
    extra_rows:
      - key: no_goal
        label: Serves no confirmed goal
        style: flagged                # always last; hidden in board and public variants
  columns:
    - {key: now, label: Now, horizon: short, dates_allowed: true}
    - {key: next, label: Next, horizon: medium, dates_allowed: false}
    - {key: later, label: Later, horizon: long, dates_allowed: false}
  column_mode: horizons               # horizons | quarters
  item_placement: per_supported_goal  # an item appears under every goal it supports
  item_fields:
    title: {required: true}
    outcome: {required: true}         # expected change in the goal metric
    goal: {required: true, multiple: true}
    contribution: {range: [0, 3]}     # from the supports edge
    confidence: {enum: [high, medium, low]}
    evidence_count: {derived: true}
    owner: {required: false}
    depends_on: {list: true}
    milestones: {list: true, only_in: [now], fields: [name, date, source]}
  markers:
    confidence: dots
    contribution: pips
    dependency: badge
    no_goal: flag
  appendix:
    opportunity_tree: {optional: true, levels: [outcome, opportunity, solution, test]}
  variants:
    board: {hide: [owner, depends_on, milestones, evidence_count], max_items_per_cell: 3, show_goal_progress: true}
    team: {hide: []}
    engineering: {show: [effort, tracker_links, drift]}
    public: {not_supported: true, fallback_template: now-next-later}
```

## Summary {#summary}

<!-- Three to five sentences: the goals that matter most this period, where investment is concentrated, and which goal is under-served. -->

## Goals {#goals}

<!-- One subsection per confirmed goal, in weight order. -->

### {{goal_code}}: {{goal_title}} {#goal}

<!-- Metric, current value, target, horizon, owner. Then the initiatives under Now / Next / Later that support it, each with its expected outcome, contribution (0-3) and confidence. Say plainly if a goal has nothing in Now. -->

## Serves no confirmed goal {#no-goal}

<!-- Items currently planned that trace to no confirmed goal. For each: why it is here (request, commitment, tech health) and the recommendation: link to a goal, drop, or keep with the founder's logged override. Omitted in board and public variants. -->

## Investment balance {#balance}

<!-- Share of Now capacity (or item count, if no estimates) per goal versus goal weight. Call out mismatches. -->

## Opportunity map {#opportunities}

<!-- Optional appendix: for the top goal, the outcome, the customer opportunities found in evidence, the candidate solutions, and the tests planned. Use a tree diagram. -->

## Risks and dependencies {#risks}

<!-- Dependencies between initiatives, goals at risk, missing evidence. -->

## Changes since last version {#changes}

<!-- Goals added or reweighted, items moved between goals or horizons, and why. -->

## Sources and data points {#sources}

<!-- Generated: every citation behind goals, metrics and items, with retrieval dates. Format background: Cagan, "The Alternative to Roadmaps" (https://www.svpg.com/the-alternative-to-roadmaps/); opportunity solution trees, Teresa Torres (https://www.producttalk.org/). -->
