---
document: roadmap
title: Outcome roadmap
template: outcome-roadmap
template_version: 1
kind: roadmap
brief: [summary, goals, problems, brief-items, brief-roadmap, not-doing, top-risks, decisions]
---

# {{product}} outcome roadmap {#roadmap}

<!-- Goal-first view (O4 "Outcome roadmap"). Rows are confirmed company goals; columns are horizons. Answers "are we working on the right things?" before "what ships when". One line under the title: as-of date, approved version, audience variant. -->

## Summary {#summary}

<!-- Brief: fits one slide; plain language for an all-hands. Three to five sentences: the goals that matter most this period, where investment is concentrated, and which goal is under-served. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goals {#goals}

<!-- Brief: fits one slide; plain language for an all-hands. One line per confirmed goal, in weight order: code, title, the metric's current value and target, and whether anything in Now serves it. The full picture per goal lives under [Goal detail](#goal-detail). -->

## Problems we are solving {#problems}

<!-- Brief: fits one slide; plain language for an all-hands. The two to four customer or business problems this roadmap addresses, one line each in the customer's terms, with the goal each one moves. -->

## Items by horizon {#brief-items}

<!-- Brief: fits one slide; plain language for an all-hands. One row per item, one line each. Rows are grouped by milestone (in this roadmap, the horizon: Now, Next, Later) in order, and the milestone is named only on the first row of its group. Columns: | Horizon | Item | Goal | Outcome |. The milestone cell links to the milestone's detail section and the item cell links to the item's detail section, using in-document links such as [Now](#now) and [Bulk import](#now-bulk-import); the detail section ids must match the links. Link each horizon to its section (#now, #next, #later) and each item to its item section under that horizon (ids now-<slug>, next-<slug>, later-<slug>). The Outcome column is the expected change in the goal metric. -->

| Horizon | Item | Goal | Outcome |
|---|---|---|---|
| [Now](#now) | [{{item_title}}](#now-item) | {{goal_code}} | {{one_line_outcome}} |

## Outcomes by horizon {#brief-roadmap}

<!-- Brief: fits one slide; plain language for an all-hands. One line per horizon: the horizon linked to its section, then the change in goal metrics it is meant to deliver, not the items in it. -->

- [Now](#now): {{outcome}}
- [Next](#next): {{outcome}}
- [Later](#later): {{outcome}}

## Not doing {#not-doing}

<!-- Brief: fits one slide; plain language for an all-hands. Initiatives deliberately dropped or parked this version, including items that served no confirmed goal and were dropped, one line each with the reason. -->

## Top risks {#top-risks}

<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks, one line each with its mitigation. The full list lives in Risks and dependencies. -->

- {{risk}}: {{mitigation}}. See [Risks and dependencies](#risks).

## Decisions needed {#decisions}

<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience, one line each with the owner and the date the decision is needed by. -->

- {{decision}}: owner {{owner}}, needed by {{date}}

# Full version {#full}

<!-- Everything below is the full document: the detail behind each brief section. -->

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

## Goal detail {#goal-detail}

<!-- One subsection per confirmed goal, in weight order. -->

### {{goal_code}}: {{goal_title}} {#goal}

<!-- Metric, current value, target, horizon, owner. Then the initiatives under Now / Next / Later that support it, each with its expected outcome, contribution (0-3) and confidence. Say plainly if a goal has nothing in Now. -->

## Now {#now}

<!-- Initiatives in progress or starting this horizon, one section each; the goal sections above say which goals they serve. -->

### {{item_title}} {#now-item}

<!-- Repeat per initiative (id now-<slug>). Expected outcome, goals supported with contribution (0-3), confidence, owner, dependencies, and milestones with dates and their source. -->

## Next {#next}

<!-- Initiatives planned for the next horizon, one section each. No dates. -->

### {{item_title}} {#next-item}

<!-- Repeat per initiative (id next-<slug>). Expected outcome, goals supported with contribution (0-3), confidence, and what must be learned first. -->

## Later {#later}

<!-- Bets for the long horizon, one section each. No dates, no owners required. -->

### {{item_title}} {#later-item}

<!-- Repeat per initiative (id later-<slug>). The outcome it would deliver and the goal it would serve. -->

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
