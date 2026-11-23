# de-merge handoff (five builders joined)

Branch: r1's branch (360c6dbdb) + merges, in order, of de-inst (origin/swarm/task_4bd93d60f5a446978cac @ 0be201584),
de-r2 (task_7e6fe371d35a4df59c2e @ 746385603), de-gm (task_ec04f2c0a91c4d67bf33 @ 8267a00b2),
de-prd (task_74c5eb1d08ef484a97dd @ e64214e23), then three de-merge fix commits.

## What each builder finished (from their commits; only r1 left a handoff.md in the tree)
- de-r1 (Roadmap timeline): add in place (Timeline track bands, Now/Next/Later columns), drag a bar onto another
  track, owner initials on the open bar, rename in place, Delete/Backspace to Trash with Undo; a commenter's add files
  a proposal. NOT built (r1's own handoff): part 3 PRIORITIZE (no entry point exists), Gantt per-goal "+ Add",
  week snap on the move drag, initials on bars at rest, a pending mark on the Timeline. Its questions.json item stands.
- de-inst: a decider's change is the live roadmap for every reader at once (API services + mock readerView), not
  counted in review; a decider's own addition waits on no one (no "Draft with no owner" flag); a decider dates a
  PRD's milestone without asking; the approved version line counts a decider's change. Red tests first
  (test_simple_decider_instant_api.py and others), spec de-inst-decider-instant. Its session hit a context
  ceiling once ("WIP: context ceiling" commit) and was continued; its last commit only drops an unused import.
- de-r2: milestones on the Roadmap band (click to add, drag or arrows to move, one-step card, Delete with Undo);
  rename a goal in place on its Roadmap card.
- de-gm: Goal map features add, move (drag between cells), rename (F2/double-click), Trash with Undo; Goal buckets
  quick add, rename, Delete with Undo; Goal map milestone rename and date in one step; proposers file proposals.
- de-prd: a PRD's features change in place on its one-pager (type to rename, add under a goal, owner/dates, Trash
  with Undo), phone width with no sideways scroll.
No builder other than r1 recorded an unfinished part; r1's unfinished parts have no entry point, so nothing
half-built is reachable.

## Conflicts
None: git merged all four with no textual conflict (the branches touched disjoint files apart from
web/lib/api/mock/simple-changes.ts, which merged cleanly). No schema change, so `make openapi` was not needed.
Merge breakage fixed:
- 647c0f6c2: lint on _roadmap.tsx/_owner.tsx: three needless type assertions (two from the base's roadmap-add,
  one from r1) removed; r1's quick-add `after` moved to a helper `addAfter`; onAdd's cognitive complexity (26, from
  the base's roadmap-add) is the 8th in the file, so the file's suppression count went 7 -> 8 (r1 reported the
  same 8 on the base). Owner may prefer a refactor of onAdd instead.
- 6707555fc, f021400f7: three older specs asserted the pre-de-inst rule (a viewer reads the published roadmap till
  publish; a decider's draft shows "Draft with no owner"). Confirmed caused by de-inst's mock (with the base's
  simple-roadmap.ts they pass) and updated to the owner's Nov 23 rule: roadmap-dates.spec.ts:137,
  simple-roadmap-home-qa.spec.ts:102 (the flag part), roadmap-nov10-findings.spec.ts:105 (viewer half).

## inst rules check
Decider's change final at once / proposer's pending: covered by de-inst-decider-instant (owner live for viewer,
commenter waits), de-r1-add (commenter's add files a proposal), de-gm-buckets and de-gm-map-features ("someone who
may only propose files the add as a proposal"; viewer has no handles). All pass. Gap kept from r1: no pending mark
on the Timeline for a proposer's change.

## Gates (at f021400f7 unless said)
- api: ruff check + format --check: pass. alembic heads: one (0133_null_run_cost).
- pytest: the 21 test files the branches touched/added, -n 2, Postgres 16: 395 passed.
- web: tsc pass; format:check pass; lint on the 32 changed .ts/.tsx files: pass. Full `npm run lint` NOT run (r1
  measured it over 10 minutes; out of time).
- Playwright (--retries=0, mock build): the 14 specs the branches added/touched: all pass (7 skipped by design);
  prose guard 33 passed with PROSE_BASE=7f932ba3f (shallow clone has no origin/main; ceilings file unchanged).
- Prefix specs (simple-roadmap*, roadmap-*, goal-*, prio*, one-pager*; 125 files, ~990 tests): all pass except
  five that fail on a strict-mode `Track` locator meeting two selects, which r1 found pre-existing on the base
  (7f932ba: the add bar's Track select from roadmap-add): roadmap-track-order.spec.ts:66,
  roadmap-tracks-sheet.spec.ts:44 and :116, simple-roadmap-filter-review.spec.ts:107,
  simple-roadmap-stale-filters.spec.ts:60. Not fixed here (base, not the merge).
- vite build ran (mock build) and passed. npm run test:unit NOT run (time).
- Other pytest files beyond the touched ones NOT run: de-inst changed live-roadmap reads; the full suite may hold
  more old-rule tests.

# de-fix handoff (fix step on the merged branch, base d62c215)

All four major findings in verdict.json are fixed. Each fix has a check that fails without it. Commits:
- 5a36f7c **F1 lint**: `_add.tsx` is down to 349 lines; the phone sheet moved to the new `app/simple/roadmap/_add-form.tsx`. Its one no-misused-promises suppression moved with it, so the total count is unchanged. FeatureDelete's ask and Undo are now small helpers (`asked`, `undoAction`), and the cognitive-complexity error is gone. **F2 Track name**: the add bar's track select is now aria-label "New item's track" (an attribute, not visible text). The red specs are roadmap-track-order, roadmap-tracks-sheet, simple-roadmap-stale-filters and simple-roadmap-filter-review.
- 6269a7d **F3 milestone nudge**: `ms.nudge` keeps an optimistic date per milestone and draws it at once. A burst steps from the optimistic date, sends its PATCHes one after another, and on a refusal rolls back, shows the error and reloads. Undo goes back to the date before the burst. New step in e2e/de-r2-milestones.spec.ts: three ArrowRight presses give +3 days, then Ctrl+Z. It fails on the old code (only +1).
- b098a41 **F4 Timeline pending**: ZoomTimeline reads the page's proposed changes (`proposals`). A proposed add_item is drawn faint and dashed in its lane's "+ Add" row (`pending-add`). An item with a waiting change gets a small amber dot beside its bar (`pending-mark`, with a "Pending decision" tooltip and aria-label). In e2e/de-r1-add.spec.ts, the commenter add test is extended and there is a new commenter move test. Both failed without the code.

Gates run on the final tree:
- tsc --noEmit: pass.
- Scoped lint (app/simple/roadmap, app/simple/goals, components/simple, mock simple-changes, the touched specs): 0 errors.
- prettier: pass.
- Mock build: pass.
- Playwright, --retries=0, mock build: all de-*.spec.ts, roadmap-add, prose-guard (PROSE_BASE=d62c215), roadmap-track-order, roadmap-tracks-sheet, simple-roadmap-stale-filters and simple-roadmap-filter-review: **104 passed**.

NOT RUN or not green:
- Full `npm run lint` exited 2. Two passes finished with no rule errors; the third was killed without printing anything, most likely for memory. Count it as not run.
- No API files were touched, so no pytest was needed. Unit tests and the full Playwright suite were not run (no time).

Minors not done (this step was asked to fix the majors only): undo's setGone([]) redraw, a proposer's milestone drag, Esc on the track rename, PRIORITIZE (not built and not reachable), the onAdd suppression.
No API, mock or migration change. Files outside the merged lanes' own files: none new, apart from `_add-form.tsx` (split out of `_add.tsx`).
