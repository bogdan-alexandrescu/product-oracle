# codes-at-write handoff (PR #1811, fix round 3)

## Write paths that number an item at write (file:line, at this branch)
- Every flush of a roadmap item: `api/oracle/tenancy.py:144` calls `codes.check_flush`
  (`api/oracle/roadmap/codes.py:281`); Priorities add relies on it (`api/oracle/simple/targets.py:837`).
- Link (merge_item with feature_id): `api/oracle/simple/changes.py:1414` (`_number_linked`, :1464), audited at
  :1510 (`codes.numbered`, `api/oracle/roadmap/codes.py:538`); the response's `change.numbered` at
  `api/oracle/simple/changes_router.py:157`.
- Restore: `api/oracle/trash/service.py:908` (`trash_items.coming_back`, `api/oracle/simple/trash_items.py:409`)
  then :916 (`codes.claim`, `api/oracle/roadmap/codes.py:352`); `_codes_free` (trash_items.py:420) refuses only a
  typed title code.
- The mock's twins: link in `web/lib/api/mock/simple-changes.ts` (planS7, merge_item with feature_id; applyS7;
  createS7's `numbered`), restore in `web/lib/api/mock/trash.ts` (restoreFromTrash -> `claimBack`) and
  `web/lib/api/mock/simple-roadmap.ts` (`nextCode`, `claimBack`); `restoreCodeTaken` refuses only a typed code.

## Part 3's choice
- "part" goes away as a code source: a copy of an item (a version row, a working draft) keeps its code through
  `copied_from` / `_held` in `api/oracle/roadmap/codes.py`, so no separate rule for parts is needed.

## This round (re-review NOT_YET, one major)
- Major fixed: the mock numbers on Merge into a feature and on Restore, as the API. Red specs first
  (`web/e2e/codes-at-write.spec.ts`, two tests on the new "codes-at-write" mock scenario), then the fix.
  The mock's look-alikes may now name a Ground Truth feature by id (kind "feature"), as additions.reconcile.
- Minor fixed: `api/tests/test_stale_settled_on_approval.py::test_approving_a_version_settles_what_it_keeps`
  reads the kept note's day in the company's time zone (`company_time.day_in_words`), so it passes after
  midnight UTC. Its sibling `test_the_migration_settles_todays_flags` keeps the UTC day: the migration writes it.
- Minors handoff (write paths, Part 3): this section.
- Minors left (not one-line or test-only): Restore's response does not carry the new code (the page reads it on
  its next roadmap read); a commenter's link fixes its number at proposal time; the lock test's
  `asyncio.sleep(0.3)` in `api/tests/test_codes_at_write.py`.

# prioritize handoff (owner's Nov 23 order: prioritize in place)

Built on d62c215d5 (the direct-edit merge below). Parts 1 to 3 are built; part 4 is NOT built.

## Built
- Part 1, Goal buckets: drag a feature within its bucket (grip) or Alt+ArrowUp/Down on it; stored as the
  Priorities order (override_priority, the same op as the Priorities list's move, so one order). A proposer
  files a proposal and sees the pending mark; a viewer has no grip. Spec: web/e2e/prioritize-buckets.spec.ts.
- Part 2, goals: drag a goal's heading (or Alt+Arrow) on Goal buckets and on the Goal map; stored as the goal
  order (storeGoalOrder, attrs.position) that every page reads. Spec: web/e2e/prioritize-goals.spec.ts.
- Part 3, Goal map: drag a chip within its cell (or Alt+ArrowUp/Down); the same feature order as part 1.
  Spec: web/e2e/prioritize-map.spec.ts.

## NOT built
- Part 4, Roadmap timeline (rows in priority order, drag a row by its name, Alt+Arrow, Gantt and Now / Next /
  Later following the order). Nothing of it is in the code, so nothing half-built is reachable: rows still follow
  start date. Why: the Simple `reorder` op sets one item's position and the Simple roadmap read does not carry
  position; renumbering a track's neighbours in one request needs a keyed form of the op (as shift_dependents
  is keyed: changes.py KEYED, drafts._keys, _current, _touched, simulate, undo), its mock twin in
  simple-changes.ts, a red-first pytest with the rights check, `make openapi`, then the timeline. Not safe to
  finish in the fix step's time. Next step: add `position` to SimpleRoadmapItem, a keyed reorder (after =
  {item_id: {position}} for the track's renumbered rows, undone together), then sort in _timeline/_lanes/_board.
- Goal-order proposals: a commenter (commenter@example.com in the mock) gets no goal handle on Goal buckets or
  the Goal map, so no proposal and no pending mark for a goal move. Needs a change op for the goal order (with a
  server rights check and pytest) and the mark on the goal heading. The spec covers what is built: "a commenter
  has no goal handle on either page". Seen while fixing: an approver (approver@example.com) may edit goals, so
  moves them at once on Goal buckets (can_edit and update_entity), but has no goal handle on the Goal map, whose
  rule reads the map's own can_edit; left as is (not a review finding), for the owner to decide.

## Fix step (review verdict NOT_YET, three findings)
- blocker, part 4: recorded above as not built (owner may send it to its own step).
- major, sleeps: prioritize-goals waits for the second save's toast (the first gone, a new one shown) before
  the reload; the viewer tests in prioritize-buckets and prioritize-map check no move note and no pending mark
  instead of waiting 300 ms.
- major, goal commenter case: the spec test above and this note.
- minors left as they were (the brief: fix blockers and majors only).

## Gates for the fix step (at 39f190f; mock build, E2E_PREBUILT=1, --retries=0)
- Lane specs prioritize-buckets/goals/map: 13 passed.
- prio*.spec.ts (22 files): 156 passed. goal-*.spec.ts (31 files): 196 passed.
- simple-roadmap-*.spec.ts (39 files): 384 passed, 9 skipped, 2 failed: simple-roadmap-filter-review.spec.ts:107
  and simple-roadmap-stale-filters.spec.ts:60, both the duplicate 'Track' select (strict mode, 2 elements) in
  _add.tsx from before this lane, which the parallel fix step is fixing.
- Prose guard (PROSE_BASE=dbf36d4): 33 passed. tsc --noEmit: exit 0. format:check: exit 0.
- FULL `npm run lint` (about 10 minutes): exit 2 at 844c446. One error was this lane's (an unneeded `!` in
  prioritize-goals.spec.ts), fixed in 39f190f; eslint on the three specs now exits 0. Two errors are left, neither
  in a file this lane changed: app/simple/roadmap/_add.tsx max-lines (472 > 400; the fix step's file) and
  components/simple/FeatureDelete.tsx:41 cognitive complexity 19 > 15 (from the direct-edit merge). Lint also says
  some suppressions are unused (`--prune-suppressions`); eslint-suppressions.json was not touched.
- No pytest: no API change.

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
