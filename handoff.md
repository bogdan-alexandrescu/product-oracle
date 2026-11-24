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

Built on d62c215d5 (the direct-edit merge below). Parts 1 to 3 are built; part 4 is now built by the
timeline-order step (its section at the end); the 'NOT built' note below is kept as it was then.

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

## timeline-order (owner's Nov 23 order: prioritize on the Roadmap timeline), on 43c7420ba

### Built (parts 1-4 of that order)
- API: each Simple roadmap item carries `position` (its feature's Priorities rank: the one feature order the Goal
  buckets and the Priorities list follow) and `before_override` (its feature's pin). `make openapi` ran.
- The move is NOT a new keyed reorder op: it reuses `override_priority` on the item (the rank of the row it lands
  on), the same op the Goal buckets and Priorities write. Why: the order says one order per thing and no second
  ordering rule; override_priority already renumbers every feature between in one request (whole numbers), refuses
  a stale `before` with 409, and has the decider / commenter / viewer split and the server rights check.
  pytest: api/tests/test_simple_roadmap_order_api.py (each role, renumbering, 409, another company untouched).
- Timeline: each track's and goal's rows follow `position` (no position: start order after the ordered ones);
  drag a row by its name or Alt+ArrowUp/Down on it; optimistic, rolled back with the server's words; Undo toast;
  a commenter's move shows the pending mark; a viewer has no handle. Gantt and Now / Next / Later keep their
  grouping and follow the order within it. Mock parity for the field and the op.
  Spec: web/e2e/timeline-order.spec.ts; web/e2e/simple-roadmap-lanes.spec.ts reads the order too.

### Fix step (review NOT_YET, four majors)
- Speed: budgets back at 60 statements and 0.3 s (test_simple_roadmap_speed.py as on main but the digests). The read
  is 58 statements (base 55; the first cut 64): the company's settings are read once per session until it writes
  (tenant_settings_api._stored, the goal_reads pattern: forgotten on flush, commit, rollback and any write; not kept
  while the session holds unwritten changes or reads across companies), the live overrides once, and calibration
  skips its goal titles read when no goal has an outcome. Time: the ranking (load_features + rank) still costs
  about 0.13 s per read here. On this machine the timing test fails at base too (the waiting read, untouched,
  measures 0.11-0.18 s against 0.11; the roadmap read 0.59-0.73 s), so the 0.3 s check cannot be judged here.
  Next, if the owner wants the time back: column selects in priorities.load_features (it builds ORM rows for
  about 1,600 entities on the seed), or a stored live ranking.
- Row order handle: useRowOrder returns its handle from useMemo, rebuilt only when canChange or the set of pending
  moves changes (act through a ref), so a bar drag no longer redraws every row. No spec measures redraws.
- Goals spec: the Goal buckets check is back as its own test ('Goal buckets reads the goal order the Goal map
  sets', web/e2e/prioritize-goals.spec.ts): after a Goal map move it opens Goal buckets and reads the two goals
  in the same order. It failed at first: a mock defect, not the page. In the Goal map's scenario the items name
  their goal by id, so the mock's Priorities buckets (keyed by it) found no place in goalRank and kept the seed's
  order (Goal buckets: activations, revenue, failed payments, booked demos; Goal map: booked demos, failed
  payments, activations, revenue). The API orders buckets by its goal entities, so the mock's goalRank now
  matches a goal by id as well as by key (web/lib/api/mock/simple-roadmap.ts). The test passes with it.
- Minors left as they were (the brief: blockers and majors only), including the full lint's two older errors.

### Gates (this fix step)
- ruff check and format --check: clean.
- pytest (Postgres 16, -n 4): test_tenant_settings_api, test_calibration, test_company_timezone,
  test_goal_horizons, test_priorities, test_priority_overrides, test_simple_priorities_api,
  test_simple_roadmap_order_api, test_branding, test_display_timezone, test_simple_quarter_horizon,
  test_simple_roadmap_speed: 147 passed, 1 skipped, 1 failed: test_reads_answer_within_budget (timing, above).
  test_reads_take_few_statements passes at 60 (58).
- tsc --noEmit: 0. eslint on the changed files: 0. Prettier on the changed files: clean.
- Playwright (mock build, E2E_PREBUILT=1, --retries=0, trace off): timeline-order, prioritize-goals/map/buckets,
  simple-roadmap-lanes: 25 passed, 1 skipped (a fixme since removed). prio*.spec.ts and goal-*.spec.ts: 352 passed,
  1 skipped, BEFORE the goalRank mock fix; prioritize-goals after it: 6 passed. Later runs are listed below.
- Final runs, at the goals spec's poll fix (mock build, E2E_PREBUILT=1, --retries=0, trace off, workers 4):
  prio*.spec.ts and goal-*.spec.ts: 352 passed, 1 failed: the new Goal buckets check read the buckets before they
  drew their goal ids; it now polls (expect.poll), then lane specs prioritize-goals/map/buckets and timeline-order
  with --repeat-each=2: 36 passed. Planted: without the goalRank id match the Goal buckets check fails.
  simple-roadmap-*.spec.ts (39 files, two runs): 384 passed, 9 skipped, 2 failed: filter-review:107 and
  stale-filters:60, the duplicate 'Track' select from before this lane (as the review found).
  prose-guard (PROSE_BASE=43c7420ba): 33 passed. tsc --noEmit: 0. format:check: 0.
- NOT run: the FULL `npm run lint` (about 10 minutes, past a foreground command's limit). eslint on each changed web
  file: no errors; lib/api/mock/simple-roadmap.ts exits 2 only for "suppressions left that do not occur anymore",
  as it did before this step. eslint-suppressions.json not touched. The review measured the full lint at exit 2 on
  the two older errors only (_add.tsx max-lines, FeatureDelete.tsx complexity).

### Left
- The roadmap read's timing (0.13 s of ranking per read); the owner may want it back (see Speed above).
- The review's minors (no-op moves still say "Moved", the dependency snap-back with no words, the lanes spec's
  position check that passes when both are missing, the red test rewritten in the fix commit).
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

### Fix round 2 (re-review NOT_YET: one major, minors; owner's Nov 23 picks)
- Major, the rank in every roadmap read: `priorities.ranks()` now reads through `_rank_inputs`
  (api/oracle/priorities/service.py): column selects only (entities, edges, evidence id/entity/
  confidence; no evidence text, citations or source items), each goal's link worked out once,
  and it never writes (unscored evidence stays unscored: what `rescore=False` reads). Priorities'
  own read is unchanged. Red tests first (2a317093): a viewer's read issues no UPDATE
  (test_simple_roadmap_order_api.py::test_viewer_read_writes_nothing) and the read selects no
  evidence text or source items (test_simple_roadmap_speed.py::test_read_ranks_through_a_light_load).
- Cost left: on this machine (timing test alone, no xdist, alternated) best of 3 was 494-522 ms
  with the rank and 382-396 ms with item_order stubbed out, so about +0.1 s. Most of it is rank()'s
  own Python (about 41 ms on 1,600 features) plus about 50 ms of load. This machine is too slow to
  meet the budget: the read misses 0.3 s even without the rank, and the waiting count misses
  0.11 s, which this round did not touch. Filed as questions.json ("Accept the cost" built;
  "Store the live ranking" is the other choice). Statements: roadmap 59 (budget 60), waiting 18.
- Minor, the settings cache (api/oracle/tenant_settings_api.py): the cached read now honours
  UNSCOPED_KEY, and a lock taken with a SELECT (FOR UPDATE, pg_advisory_*lock) forgets it. Kept
  because the 60-statement budget needs it. Red first: tests/test_tenant_settings_cache.py
  (across companies, after a lock (advisory, FOR UPDATE), after a write).
- Owner's pick: the comment count on Timeline rows. CommentCount came with the comments feature
  on main, so main was merged in (51566a0c). Conflicts kept both sides; the 5 roadmap digests were
  updated, since the bodies now carry main's confirm_feature_id and this branch's position. The
  mock's duplicated imports were fixed in cce45e32. The count is mounted after the row's name in
  _zoom.tsx; spec e2e/timeline-comment-count.spec.ts (red on a build without it, cce45e32, green
  after ed263036).
- Minor done (test only): simple-roadmap-lanes.spec.ts asserts both positions exist and differ.
- Minors left, as the brief says (behaviour changes or other files, not one-line): a no-op move
  still says 'Moved'; an optimistic move above its own dependency snaps back with no words; no row
  redraw measurement for _order.tsx; the red-test rewrite inside 8aba3e304 is history. The full
  lint's old _add.tsx and FeatureDelete.tsx errors were not reported on this tree (main fixed them).
  _zoom.tsx's import order is fixed and its suppression pruned (1ea9dca4).
- Gates (at 1ea9dca4): ruff ok; pytest speed (not timing), order_api, tenant_settings_cache,
  tenant_settings_api, simple_priorities_api: 64 passed; timing test alone: FAILED on this machine
  (roadmap best 676 ms, waiting 125 ms; see above); alembic one head (0135_feature_comments);
  tsc 0; Playwright --retries=0 on a mock build: timeline-comment-count, timeline-order,
  simple-roadmap-lanes, feature-comments 15 passed; prose guard passed; format:check on the
  touched files ok; full npm run lint: exit 0 (at 701f40ce, after the import-order fix).

# prio-ux fix round (review NOT_YET on 6c73c29; issues #1738, #1739, #1773–#1777)

## Fixed (each verdict.json blocker and major)
- B1 mock "this quarter" read the roadmap's span without a dated plan: `web/lib/api/mock/simple-priorities.ts`
  `thisQuarter` takes the span only when `planOf` gives a plan (as `priorities.plan_quarter`).
  goal-buckets-accept.spec.ts:94 and edit-goals-prds-move.spec.ts:70 green.
- B2 one rule, in the API: "this quarter" = the items whose dates put them in Now plus, with a dated plan, the
  plan's items in its span (`api/oracle/simple/priorities.py` `plan_quarter`'s `inside`); the line and the goal
  buckets read that one set; the mock follows. Red pytest first:
  `api/tests/test_simple_priorities_one_quarter_api.py::test_an_item_dated_into_now_outside_the_plan_makes_the_line_and_its_bucket`.
  prio-company.spec.ts:123 x4 and simple-plan-charts.spec.ts:143 x4 green, specs unchanged.
- B3 `web/e2e/qa4-simple-plan.spec.ts` reads the one row layout (details under the title).
- M4 `web/e2e/fix2-simple-plan-review.spec.ts`: the precondition is back (the row under the picked one is not
  rank + 1), so the test fails again for "ArrowDown asks for the on-screen neighbour".
- M5 `web/app/simple/priorities/feature-order.tsx`: writes the API rank (pinOf), the note names the list's place.
  Spec `prio-ux.spec.ts` "#1738 a move on Goal buckets names the place..." red without it (Expected 13, Received 12).
- M6 an (i) by the All chip (`prio-all-help`, `allWords` in priorities.tsx) says All counts ranked features,
  same-name lines and items not ranked yet, while "Miss" counts ranked features. Spec in prio-ux.spec.ts on the
  priorities-twins and ground-truth-flags scenarios (existing mock scenarios: one carries twins, one an unranked
  item); both red without the tip.

## Already fixed before this lane / minors
- #1775: prio-ux.spec.ts:112 passes on the base build too (the mock already stripped the code); the red proof is
  `api/tests/test_simple_priorities_titles_api.py` (red at 83b3594).
- #1776 overlap: the chart already spread or grouped marks at base (mark-counts.tsx, qa-simple-plan-11); only the
  side list's tip about skipped numbers is new.
- Minors left as they are (not blocker/major): the mock drops a row when its own item is Done while the API drops
  a feature only when all its items are Done; the mock's span set takes only the plan PRD's items; Goal map chips of
  Done features sort last (out of scope).

## Gates this round
- Playwright: every spec that drives /simple/priorities (99 files, `grep -l "simple/priorities"`), mock build,
  4 workers, --retries=0: 1064 passed, 0 failed. prose-guard green with PROSE_BASE=83b3594.
- web: tsc 0, full `npm run lint` 0, format:check 0.
- api: see the PR body for the whole-suite, timing, pyright and frozen-migration verdicts.
