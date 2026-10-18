---
document: roadmap
title: Quarterly timeline roadmap
template: quarterly-timeline
template_version: 1
kind: roadmap
---

# {{product}} quarterly roadmap {#roadmap}

<!-- Time-axis view (O4 "Quarterly timeline") for audiences who need "when": leadership, sales, marketing, finance. Only Now-horizon work carries dates; later work spans its quarters without end dates. One line under the title: as-of date, approved version, audience variant. -->

## Layout {#layout}

<!-- Machine-readable layout. The renderer reads this block. -->

```yaml
layout:
  type: timeline
  axis:
    unit: quarter                     # quarter | month
    span_quarters: 4                  # current + next 3; tenant can set 2-6
    today_line: true
    fiscal_year_start_month: 1
  swimlanes:
    group_by: team                    # team | theme | goal | product
  bars:
    now: {style: solid, dates: exact, label_dates: true}      # from eng-tracker estimates
    next: {style: hatched, dates: quarter_range, label_dates: false}
    later: {style: outline, dates: quarter_range, label_dates: false}
  milestones:
    glyph: diamond
    only_in: [now]
    kinds: [estimate, external, announced]
  dependencies:
    draw: arrows
    conflict_rule: blocker_ends_after_dependent_starts   # draw in warning colour
  capacity:
    strip_per_lane: true
    source: eng_tracker
    hide_if_no_estimates: true
  item_fields:
    title: {required: true}
    goal: {required: true, multiple: true, flag_if_missing: "serves no confirmed goal"}
    horizon: {enum: [now, next, later], required: true}
    start: {only_in: [now]}
    end: {only_in: [now]}
    quarters: {list: true}            # used for next and later
    owner: {required: false}
    team: {required: false}
    confidence: {enum: [high, medium, low]}
    depends_on: {list: true}
    effort: {required: false}
  variants:
    board: {group_by: goal, hide: [owner, effort, team], dependency: none, capacity: none}
    team: {hide: []}
    engineering: {show: [effort, tracker_links, drift], axis_unit: month}
    public: {group_by: theme, allow: [public_title, public_summary, announced_quarter], bars_only_if: announced, require_disclaimer: true}
```

## Summary {#summary}

<!-- Three to five sentences: the key dates in the period, what they depend on, and what is planned but not yet dated. -->

## Goals served {#goals}

<!-- Confirmed goals with codes (G1, G2...), metric, target and owner; codes are used as chips on bars. -->

## Timeline {#timeline}

<!-- The rendered chart. One subsection per swimlane. -->

### {{lane_name}} {#lane}

<!-- Per lane: items in start order. Now items with start and end dates and their source; Next and Later items with their quarter range only. Milestones listed with date and kind (estimate, external, announced). -->

## Key milestones {#milestones}

<!-- Table of dated milestones in the Now horizon: name, date, kind, owner, depends on. External dates (events, contracts, regulation) marked as such. -->

## Dependencies {#dependencies}

<!-- Cross-lane dependencies, with any conflicts where a blocker ends after the dependent starts. -->

## Capacity {#capacity}

<!-- Per lane: planned effort versus available capacity for the dated period. Omit the section when the eng tracker has no estimates and say so. -->

## Changes since last version {#changes}

<!-- Dates moved, items added or removed, and why. -->

## Sources and data points {#sources}

<!-- Generated: every citation behind dates, estimates, goals and items, with retrieval dates. Format background: Productboard timeline boards (https://support.productboard.com/hc/en-us/articles/29983922254739); Jira Plans capacity and dependencies (https://confluence.atlassian.com/jirasoftwareserver/plan-your-work-in-advanced-roadmaps-1044784164.html). -->
