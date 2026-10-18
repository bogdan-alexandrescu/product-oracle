---
document: roadmap
title: Now / Next / Later roadmap
template: now-next-later
template_version: 1
kind: roadmap
brief: [summary, goals, problems, brief-items, brief-roadmap, not-doing, top-risks, decisions]
---

# {{product}} roadmap {#roadmap}

<!-- Default Oracle roadmap (O4). Direction by confidence horizon, not by calendar. One line under the title: the as-of date, the approved version, and the audience variant. -->

## Summary {#summary}

<!-- Brief: fits one slide; plain language for an all-hands. Three to five sentences: what the company is trying to achieve this year, which goals this roadmap serves, and the single most important change since the last version. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goals served {#goals}

<!-- Brief: fits one slide; plain language for an all-hands. List the confirmed goals (from the baseline) this roadmap serves, each with metric, current value, target, horizon and owner. Give each a short code (G1, G2...) used as chips on cards. -->

## Problems we are solving {#problems}

<!-- Brief: fits one slide; plain language for an all-hands. The two to four customer or business problems this roadmap addresses, one line each in the customer's terms, with the goal each one moves. -->

## Items by horizon {#brief-items}

<!-- Brief: fits one slide; plain language for an all-hands. One row per item, one line each. Rows are grouped by milestone (in this roadmap, the horizon: Now, Next, Later) in order, and the milestone is named only on the first row of its group. Columns: | Horizon | Item | Goal | Outcome |. The milestone cell links to the milestone's detail section and the item cell links to the item's detail section, using in-document links such as [Now](#now) and [Bulk import](#now-bulk-import); the detail section ids must match the links. Link each horizon to its section (#now, #next, #later) and each item to its item section under that horizon (ids now-<slug>, next-<slug>, later-<slug>). -->

| Horizon | Item | Goal | Outcome |
|---|---|---|---|
| [Now](#now) | [{{item_title}}](#now-item) | {{goal_code}} | {{one_line_outcome}} |

## Outcomes by horizon {#brief-roadmap}

<!-- Brief: fits one slide; plain language for an all-hands. One line per horizon: the horizon linked to its section, then the outcome it delivers for customers or the business, not the items in it. -->

- [Now](#now): {{outcome}}
- [Next](#next): {{outcome}}
- [Later](#later): {{outcome}}

## Not doing {#not-doing}

<!-- Brief: fits one slide; plain language for an all-hands. Optional. Items deliberately dropped or parked this version, with a one-line reason. Include items flagged as serving no goal that the founder chose to drop. -->

## Top risks {#top-risks}

<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks, one line each with its mitigation. The full list lives in Risks and dependencies. -->

- {{risk}}: {{mitigation}}. See [Risks and dependencies](#risks).

## Decisions needed {#decisions}

<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience, one line each with the owner and the date the decision is needed by. -->

- {{decision}}: owner {{owner}}, needed by {{date}}

# Full version {#full}

<!-- Everything below is the full document: the detail behind each brief section. -->

## Layout {#layout}

<!-- Machine-readable layout. The renderer reads this block; writers do not edit it per roadmap. -->

```yaml
layout:
  type: columns
  columns:
    - key: now
      label: Now
      horizon: short          # B2 default: current quarter
      confidence_default: high
      dates_allowed: true     # only here; from eng-tracker estimates (E1)
      detail: full
    - key: next
      label: Next
      horizon: medium         # B2 default: next 2 quarters
      confidence_default: medium
      dates_allowed: false
      detail: problem_and_candidate_solution
    - key: later
      label: Later
      horizon: long           # B2 default: 12-24 months
      confidence_default: low
      dates_allowed: false
      detail: problem_only
  group_by: none              # none | goal | theme | team (swimlanes across columns)
  order_within_column: priority   # from the active priority snapshot (O3)
  item_fields:
    title: {required: true}
    problem: {required: true}         # the problem or outcome, not a feature name
    goal: {required: true, multiple: true, flag_if_missing: "serves no confirmed goal"}
    confidence: {enum: [high, medium, low]}
    owner: {required: false}
    depends_on: {list: true}          # from baseline depends_on / blocks edges
    milestones: {list: true, only_in: [now], fields: [name, date, source]}
    effort: {required: false}         # from tracker estimates
    date_kind: {enum: [estimate, external, announced], only_in: [now]}
    public_title: {required: false}
    public_summary: {required: false}
  capacity:
    show_in: [now]                    # optional: [now, next]
    source: eng_tracker
    hide_if_no_estimates: true
  markers:
    confidence: dots                  # 3/2/1 filled dots plus text label
    dependency: badge                 # "after: <item>"; arrows in engineering variant
    no_goal: flag
  variants:
    board: {group_by: goal, max_items_per_column: 7, hide: [owner, effort, depends_on, milestones]}
    team: {hide: []}
    engineering: {group_by: team, show: [effort, tracker_links, drift], dependency: arrows}
    public: {columns_relabel: {now: "In progress", next: "Planned", later: "Exploring"}, allow: [public_title, public_summary, date_kind_announced], require_disclaimer: true}
```

## Now {#now}

<!-- Work in progress or starting this horizon. Scoped and committed. Each item: problem, goal chip(s), owner, confidence, dependencies, and dated milestones only when backed by an eng-tracker estimate or a real external date. Show the capacity bar if estimates exist. -->

### {{item_title}} {#now-item}

<!-- Repeat per item. One-line problem or outcome, then a short why (goal and evidence), milestones with dates and their source, dependencies. -->

## Next {#next}

<!-- Validated problems with the solution still being explored. No dates; say what evidence would move each item into Now. -->

### {{item_title}} {#next-item}

<!-- Repeat per item. Problem, goal chip(s), candidate solution(s), confidence, what must be learned first. -->

## Later {#later}

<!-- Strategic bets and problems worth solving, not yet validated. Keep them as problems, not features. No dates, no owners required. -->

### {{item_title}} {#later-item}

<!-- Repeat per item. Problem and the goal it would serve. -->

## Risks and dependencies {#risks}

<!-- Cross-item dependencies, external dependencies, capacity shortfalls and the items they put at risk. -->

## Changes since last version {#changes}

<!-- Items added, removed, or moved between columns, with the reason (new evidence, goal change, capacity). -->

## Sources and data points {#sources}

<!-- Generated: every citation used in this roadmap (goals, evidence, tracker estimates), with retrieval dates. Format background: ProdPad, "We invented the Now-Next-Later roadmap" (https://prodpad.com/blog/invented-now-next-later-roadmap/). -->
