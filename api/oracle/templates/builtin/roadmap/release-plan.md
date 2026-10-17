---
document: roadmap
title: Release plan
template: release-plan
template_version: 1
kind: roadmap
---

# {{product}} release plan {#roadmap}

<!-- Engineering-facing delivery view for the Now horizon and the next one or two releases. Pairs with the approved roadmap; dates come from the eng tracker (E1) and drift is shown both ways. One line under the title: as-of date, approved version, tracker sync time. -->

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

## Summary {#summary}

<!-- Next release name and date, health, and the one thing most likely to move the date. -->

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
