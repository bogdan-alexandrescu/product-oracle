---
document: roadmap
title: Cycle bets roadmap
template: cycle-bets
template_version: 1
kind: roadmap
---

# {{product}} cycle bets {#roadmap}

<!-- For teams that work in fixed cycles (Shape Up style: six-week cycles and a two-week cool-down). Shows the bets placed for the current cycle, the pitches up for the next betting table, and raw ideas. Horizon is one cycle; nothing here is a long-range promise. One line under the title: cycle number and dates, approved version. -->

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

## Summary {#summary}

<!-- The cycle's dates, the bets placed, the goals they serve, and anything carried over by explicit decision. -->

## This cycle {#current}

<!-- Bets placed at the last betting table. -->

### {{bet_title}} {#bet}

<!-- Problem, goal chip(s), appetite, team, hill position, rabbit holes and no-gos from the pitch. -->

## Cool-down {#cooldown}

<!-- Dates and planned use: fixes, tech health, shaping for the next table. -->

## Next betting table {#candidates}

<!-- Shaped pitches ready to bet on, each with problem, appetite, goal, and why now. Unfinished bets from this cycle appear here only if someone argues for them again. -->

## Raw ideas {#ideas}

<!-- Unshaped problems worth shaping later, each tied to a goal. -->

## Sources and data points {#sources}

<!-- Generated: pitches, evidence and goal citations, with retrieval dates. Format background: Basecamp, Shape Up (https://basecamp.com/shapeup); Hill Charts (https://basecamp.com/hill-charts). -->
