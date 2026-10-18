---
document: roadmap
title: Cycle bets roadmap
template: cycle-bets
template_version: 1
kind: roadmap
brief: [summary, goals, problems, brief-items, brief-roadmap, not-doing, top-risks, decisions]
---

# {{product}} cycle bets {#roadmap}

<!-- For teams that work in fixed cycles (Shape Up style: six-week cycles and a two-week cool-down). Shows the bets placed for the current cycle, the pitches up for the next betting table, and raw ideas. Horizon is one cycle; nothing here is a long-range promise. One line under the title: cycle number and dates, approved version. -->

## Summary {#summary}

<!-- Brief: fits one slide; plain language for an all-hands. The cycle's dates, the bets placed, the goals they serve, and anything carried over by explicit decision. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goals served {#goals}

<!-- Brief: fits one slide; plain language for an all-hands. The confirmed goals (from the baseline) this cycle's bets serve, one line each with metric, target and owner, and a short code (G1, G2...) used as chips on bets. -->

## Problems we are solving {#problems}

<!-- Brief: fits one slide; plain language for an all-hands. The two to four customer or business problems this roadmap addresses, one line each in the customer's terms, with the goal each one moves. -->

## Bets by cycle {#brief-items}

<!-- Brief: fits one slide; plain language for an all-hands. One row per item, one line each. Rows are grouped by milestone (in this roadmap, the cycle column: This cycle, Next betting table, Raw ideas) in order, and the milestone is named only on the first row of its group. Columns: | Cycle | Bet | Goal | Outcome |. The milestone cell links to the milestone's detail section and the item cell links to the item's detail section, using in-document links such as [This cycle](#current) and [Bulk import](#bet-bulk-import); the detail section ids must match the links. Link This cycle to #current and each bet to its bet section (id bet-<slug>); link Next betting table to #candidates and each pitch to its pitch section (id pitch-<slug>); raw ideas have no section of their own, so link them to #ideas. -->

| Cycle | Bet | Goal | Outcome |
|---|---|---|---|
| [This cycle](#current) | [{{bet_title}}](#bet) | {{goal_code}} | {{one_line_outcome}} |

## Outcomes by cycle {#brief-roadmap}

<!-- Brief: fits one slide; plain language for an all-hands. One line per cycle: the cycle linked to its section, then the outcome it delivers for customers or the business, not the bets in it. Nothing beyond the next betting table is a promise. -->

- [This cycle](#current): {{outcome}}
- [Next betting table](#candidates): {{outcome}}

## Not doing {#not-doing}

<!-- Brief: fits one slide; plain language for an all-hands. Pitches and ideas deliberately not bet on this cycle, and the main no-gos across bets, one line each with the reason. Unfinished bets that were not argued for again belong here. -->

## Top risks {#top-risks}

<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks, one line each with its mitigation. -->

- {{risk}}: {{mitigation}}

## Decisions needed {#decisions}

<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience, one line each with the owner and the date the decision is needed by. -->

- {{decision}}: owner {{owner}}, needed by {{date}}

# Full version {#full}

<!-- Everything below is the full document: the detail behind each brief section. -->

## Layout {#layout}

<!-- Machine-readable layout. The renderer reads this block. -->

```yaml
layout:
  type: cycles
  cycle:
    length_weeks: 6                   # tenant-configurable
    cooldown_weeks: 2
    current: {dates_allowed: true}    # the cycle is the Now horizon
  columns:
    - {key: current, label: This cycle, maps_to: now}
    - {key: candidates, label: Next betting table, maps_to: next}
    - {key: ideas, label: Raw ideas, maps_to: later}
  swimlanes:
    group_by: team                    # applies to the current column
  hill_chart:
    show: true                        # uphill = unknowns remain, downhill = execution
    applies_to: current
  item_fields:
    title: {required: true}
    problem: {required: true}
    goal: {required: true, multiple: true, flag_if_missing: "serves no confirmed goal"}
    appetite: {enum: [small_batch, big_batch]}
    hill_position: {range: [0, 100], only_in: [current]}
    rabbit_holes: {list: true}
    no_gos: {list: true}
    team: {only_in: [current]}
    pitch_link: {required: false}
  rules:
    circuit_breaker: true             # unfinished bets return to the table; no automatic extension
  markers:
    confidence: hill_position
    appetite: tag
  variants:
    board: {not_recommended: true, fallback_template: outcome-roadmap}
    team: {hide: []}
    engineering: {show: [tracker_links]}
    public: {not_supported: true, fallback_template: now-next-later}
```

## This cycle {#current}

<!-- Bets placed at the last betting table. -->

### {{bet_title}} {#bet}

<!-- Problem, goal chip(s), appetite, team, hill position, rabbit holes and no-gos from the pitch. -->

## Cool-down {#cooldown}

<!-- Dates and planned use: fixes, tech health, shaping for the next table. -->

## Next betting table {#candidates}

<!-- Shaped pitches ready to bet on, each with problem, appetite, goal, and why now. Unfinished bets from this cycle appear here only if someone argues for them again. -->

### {{pitch_title}} {#pitch}

<!-- Repeat per shaped pitch. Problem, goal chip(s), appetite, why now, and a link to the pitch. -->

## Raw ideas {#ideas}

<!-- Unshaped problems worth shaping later, each tied to a goal. -->

## Sources and data points {#sources}

<!-- Generated: pitches, evidence and goal citations, with retrieval dates. Format background: Basecamp, Shape Up (https://basecamp.com/shapeup); Hill Charts (https://basecamp.com/hill-charts). -->
