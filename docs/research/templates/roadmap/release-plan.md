---
document: roadmap
title: Release plan
template: release-plan
template_version: 1
kind: roadmap
brief: [summary, goals, problems, brief-items, brief-roadmap, not-doing, top-risks, decisions]
---

# {{product}} release plan {#roadmap}

<!-- Engineering-facing delivery view for the Now horizon and the next one or two releases. Pairs with the approved roadmap; dates come from the eng tracker (E1) and drift is shown both ways. One line under the title: as-of date, approved version, tracker sync time. -->

## Summary {#summary}

<!-- Brief: fits one slide; plain language for an all-hands. Next release name and date, health, and the one thing most likely to move the date. Presenter notes for this slide, if any, go in a fenced ```notes block at the end of the section. -->

## Goals served {#goals}

<!-- Brief: fits one slide; plain language for an all-hands. The confirmed goals (from the baseline) these releases serve, one line each with metric, target and owner, and a short code (G1, G2...) used as chips. -->

## Problems we are solving {#problems}

<!-- Brief: fits one slide; plain language for an all-hands. The two to four customer or business problems this roadmap addresses, one line each in the customer's terms, with the goal each one moves. -->

## Items by release {#brief-items}

<!-- Brief: fits one slide; plain language for an all-hands. One row per item, one line each. Rows are grouped by milestone (in this roadmap, the release) in date order, and the milestone is named only on the first row of its group. Columns: | Release | Item | Goal | Outcome |. The milestone cell links to the milestone's detail section and the item cell links to the item's detail section, using in-document links such as [2.4](#release-2-4) and [Bulk import](#release-2-4); the detail section ids must match the links. Items are detailed inside their release section here, so both cells link to the release section (ids such as release-<slug>). Must items first within each release. -->

| Release | Item | Goal | Outcome |
|---|---|---|---|
| [{{release_name}}](#release) | [{{item_title}}](#release) | {{goal_code}} | {{one_line_outcome}} |

## Outcomes by release {#brief-roadmap}

<!-- Brief: fits one slide; plain language for an all-hands. One line per release, in date order: the release linked to its section with its target date, then the outcome it delivers for customers or the business, not the items in it. -->

- [{{release_name}}](#release) ({{target_date}}): {{outcome}}

## Not doing {#not-doing}

<!-- Brief: fits one slide; plain language for an all-hands. Scope deliberately cut or deferred from these releases, one line each with the reason. -->

## Top risks {#top-risks}

<!-- Brief: fits one slide; plain language for an all-hands. The three biggest risks to the dates or scope, one line each with its mitigation. The detail lives in Drift and Capacity. -->

- {{risk}}: {{mitigation}}. See [Drift](#drift) and [Capacity](#capacity).

## Decisions needed {#decisions}

<!-- Brief: fits one slide; plain language for an all-hands. The decisions asked of this audience, one line each with the owner and the date the decision is needed by. -->

- {{decision}}: owner {{owner}}, needed by {{date}}

# Full version {#full}

<!-- Everything below is the full document: the detail behind each brief section. -->

## Layout {#layout}

<!-- Machine-readable layout. The renderer reads this block. -->

```yaml
layout:
  type: releases
  orientation: columns                # columns | rows
  release_fields:
    name: {required: true}
    target_date: {required: true, source: eng_tracker}
    status: {enum: [planning, in_progress, code_freeze, released, slipped]}
    health: {enum: [on_track, at_risk, off_track]}
    goal: {multiple: true}
  item_fields:
    title: {required: true}
    goal: {required: true, multiple: true, flag_if_missing: "serves no confirmed goal"}
    scope: {enum: [must, should, could]}
    readiness: {checklist: [spec, design, build, qa, docs, launch]}
    tracker_key: {required: false}    # epic or issue id
    estimate: {source: eng_tracker}
    planned: {source: roadmap}
    drift: {derived: true}            # estimate vs plan, and tracker scope vs PRD
    owner: {required: false}
    depends_on: {list: true}
  capacity:
    per_release: true
    source: eng_tracker
  markers:
    health: chip
    drift: badge                      # "+2w", "scope added", "not in PRD"
    dependency: list
  variants:
    board: {not_recommended: true, fallback_template: now-next-later}
    team: {hide: [tracker_key, estimate]}
    engineering: {hide: []}
    public: {relabel: changelog_preview, allow: [public_title, public_summary, release_name], dates_only_if: announced, require_disclaimer: true}
```

## Releases {#releases}

<!-- One subsection per release, in date order. -->

### {{release_name}} ({{target_date}}) {#release}

<!-- Status and health, goals served, then the scoped items: scope tag, readiness checklist, tracker key, estimate versus plan, owner, dependencies. Must items first. -->

## Drift {#drift}

<!-- From the eng-tracker read-back: items whose estimate moved, scope present in the tracker but not in the approved PRD, and PRD scope with no tracker work. Each with a recommendation. -->

## Capacity {#capacity}

<!-- Per release: estimated effort versus available capacity, and what to cut first if over. -->

## Launch checklist {#launch}

<!-- Optional: per release, the go-to-market and support tasks (docs, changelog entry, announcement, support briefing) with owners. -->

## Changes since last version {#changes}

<!-- Dates moved, scope added or cut, and why. -->

## Sources and data points {#sources}

<!-- Generated: tracker sync time and links, PRD versions, estimates used. Format background: Aha! releases roadmap (https://www.aha.io/roadmapping/roadmap-templates); ProductPlan release plan template (https://www.productplan.com/learn/roadmap-template-examples). -->
