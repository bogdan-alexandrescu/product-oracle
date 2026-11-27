# inbox-codes (#1786 reopened) — handoff

Base 926a307 (train night-m). Commits: 5af3e77 red pytest (proposals), e829e20 API item_code on
InboxSimpleChange, 898c063 web proposal row + mock + spec, d00b425 request words, ad3d648 red
pytest (action items), 20b935c action item rows, a791259 handoff. Review round (verdict NOT_YET,
one major): 18cbbc6 red pytest (checkpoint child), 374d4c3 API `code` on InboxChild, f994fa2 web
row + mock + spec, 0d23096 lint order (see "Review round" below). Worker publishes the branch.

## What the auditor saw, and the cause
A proposal row named its feature without its code. The row's code came only from the Simple
roadmap read (useItemRef, GET /v1/simple/roadmap), which leaves out an item of a replaced roadmap;
such a row showed the bare name (no code, no flag). Fix: the API read behind the row now carries
`item_code` (codes.code_of, as the roadmap reads it) and the row's name takes it first, through
the one helper (`Named` in components/simple/FeatureName.tsx, via app/inbox/_proposals.tsx's
FeatureName). Reproduced on the mock's "inbox-replaced-proposal" scenario: its Trusted seller
badge (replaced roadmap) now comes from section F-45, and the Owner has an invented action item
on it.

## Every Inbox row kind that names a feature (Simple > Inbox and Detailed > Inbox: one page, app/inbox/_inbox.tsx)
| Row kind | Where | Code shown? |
| --- | --- | --- |
| Proposal, item cell | _proposals.tsx proposalRows | Yes. Was missing for an item off the roadmap read; fixed (API item_code). |
| Proposal, request words ("X asks to change the owner of …") | _proposals.tsx withCode | Yes now (code inserted before the name, via Named); before: name alone. |
| Decision on my proposal | same rows (simple_decisions) | Shown on Decisions/Home lists, not as an Inbox row kind; same field now carried. |
| Date suggestion | _proposals.tsx dateSuggestionRows | Yes: an open suggestion's item is always on the roadmap read. Unchanged. |
| Meeting action item (linked feature) | _action-items.tsx | Yes. Was missing off the read; fixed (API item_code on InboxSimpleActionItem). |
| Track alert (stale marks, slips) | _track-alert.tsx AlertItem | Yes, already (item_code from the API, #1786 first pass). Unchanged. |
| Checkpoint child (a run's item under its checkpoint) | _needs.tsx childNeeds | Yes now (review round): InboxChild carries `code` (its title's own, else its PRD section's: codes.code_of in runs/actions.summarize), rendered with Named. Before: name alone. An item with neither stays as its name. |
| Launch (Ready to launch · X) | _needs.tsx launchNeeds | Names the launch by its own title (one or more items), not a feature. Left. |
| Questions, discussions, Oracle-did summaries | _questions.tsx, _needs.tsx | Free text a person or Oracle wrote; not a feature field. Left. |

## Tests
- pytest (runner's Postgres): tests/test_inbox_proposal_codes.py (2) and
  tests/test_inbox_action_item_codes.py (1): red before each fix (KeyError item_code), green after.
- Playwright --retries=0, 2 workers: e2e/inbox-proposal-codes.spec.ts (Simple and Detailed Inbox)
  red without each web change (Expected "F-45"), green with; inbox-2-proposal-rows (its Decisions
  locator now picks the proposal's li, since the scenario's new action item also lists there) and
  inbox-action-items: 6 passed.
- tsc: exit 0. Full `npm run lint`: exit 0. `npm run format:check`: "All matched files use Prettier code style!".
- pyright as ci.yml runs it: `pyright: 1263 errors, baseline 1263`.
- API: every test file that reads the Inbox, simple_proposals, simple_action_items, InboxSimple*,
  meeting_actions or openapi (122 files, tests/test_frozen_migrations.py among them), -n 3:
  937 + 631 (1 skipped) + 924 + 624 passed, 0 failed.
- NOT RUN: the whole API suite end to end (at -n 3 it takes over an hour here, past the step's
  limit; the remaining ~660 files touch neither the changed reads nor their schemas) and the
  timing tests (`-m timing`), for the same reason. The prose guard was not run either: the only
  visible change is a code (e.g. "F-45") placed before a feature name.

## Review round (verdict NOT_YET, its one major: checkpoint children had no code)
- API: InboxChild.code, filled in runs/actions.summarize by codes.code_of (title's own code, else
  prd_code of the item's PRD section). Red pytest first: tests/test_inbox_child_codes.py (3)
  failed with AttributeError 'code' at 18cbbc6, pass after. `make openapi`: only the new field.
- Web: _needs.tsx childNeeds names the child with Named (code chip, then the name, a title's own
  leading code stripped; hover title "F-06 Slack alerts"). Mock checkpoint summary (runs.ts) fills
  `code` with item-code.ts shownCode. No base mock data changed: the spec seeds a copy of the
  roadmap review run whose Slack alerts comes from section f-06.
- Spec e2e/inbox-proposal-codes.spec.ts, two new cases (/simple/inbox, /inbox): "F-06 Slack
  alerts", and Budget caps (section no code) stays as its name. Red with _needs.tsx and runs.ts
  put back (mock rebuilt): Expected "F-06 Slack alerts", Received "Slack alerts"; green with.
- Gates (this round): pytest of every inbox/runs/roadmap_reasons/roadmap_items/checkpoint/
  simple_waiting/openapi file + test_frozen_migrations.py, -n 3, not timing: 415 passed. Timing:
  the three Inbox timing tests, 3 passed. ruff check/format: clean. pyright as ci.yml runs it:
  `pyright: 1263 errors, baseline 1263`. tsc exit 0; full `npm run lint` exit 0 (import placed so
  runs.ts stays at its import-x/order suppression of 14); format:check "All matched files use
  Prettier code style!". Playwright, mock prebuilt, 2 workers, --retries=0: every e2e/inbox-*.spec
  + inbox, qa*-inbox, vqa-b-runs-inbox, simple-walk-fixes3-cp, checkpoint-gate: 172 passed;
  roadmap-items-review, roadmap-items-roles, prose-guard, questions-inbox, track-alerts,
  home-fixes: 79 passed, 3 failed: prose-guard's two merge-base tests (shallow clone, no
  origin/main; passed with PROSE_BASE=HEAD~3, i.e. a791259) and home-fixes.spec.ts:228 (Home's (i)
  tip, not touched here; passed when rerun alone: 36 passed with the prose guard).
- NOT RUN: the whole API suite and the full `-m timing` run (over an hour at -n 3 here, past this
  step's limit; the reviewer also owes it before merge).

## Left
- Launch rows name a launch by its own title, not a feature field. A checkpoint child whose key is
  a live item's but whose title and section carry no code still reads as its name (the reviewer's
  "if cheap" part: it needs a roadmap read per checkpoint; not done).

## Fix round 2 (re-review NOT_YET: one blocker, one pre_existing, three minors)

- Merged the train (origin/swarm/task_f89b44cdd78343dc8bfa at f2308a78) with no conflict: its
  palette-open, prio-twin-propose and inbox-for-wrap specs and app/inbox/_needs.tsx are kept as
  the train wrote them.
- Blocker (module sizes), 827833f: tests/test_module_size.py was already red on the branch, so it
  is the red test (red at the parent: "runs/schemas.py: 1995 ... 1993", "simple/changes.py: 2576 ...
  2572"; green after). simple/changes.py imports `codes` at module level; its four local copies,
  the comment and the blank line go; its entry is lowered to 2568, since a shorter module than its
  entry fails as stale. InboxChild's docstring now has three lines, so the `code` field is the only
  new line (1993). `make openapi` changed only that description.
- pre_existing (prio-twin-propose :84/:141, qa-leftovers :195): the train closed it. On the merged
  tree all 34 pass.
- Minor, commit ids: corrected in the header and in "Review round" above.
- Minor, withCode's words.indexOf(name): still open. Deciding which mention of the name gets the
  code is a design call with its own spec, not a one-line change.
- Minor, a checkpoint child whose key is a coded item but whose title and section have no code:
  still left (see "Left").
- Push: git_push_branch refuses any commit whose message carries the Co-Authored-By line (code
  foreign_author, field message), whoever the author is. The commits keep the line and the
  worker publishes the branch.

### Gates (merged tree, at 827833f)
- ruff check + format --check on the two modules: clean. tsc: 0. `npm run lint`: 0. prettier on
  openapi.json and schema.d.ts: clean.
- Whole API suite, in seven shards, -n 7: 11,762 passed, 15 skipped, 1 xfailed, 4 failed. The four
  failures are timing-budget tests (test_simple_roadmap_card, _api 500 items, _reads_perf,
  _roadmap_speed) that ran over budget under the 7-worker load. Run alone: one of them failed once
  more, then all 9 tests in those files passed. Note: at -n 7, Postgres needs
  max_locks_per_transaction=1024. At 256, setup fails with "out of shared memory".
- Playwright (vite mock build, E2E_PREBUILT=1, --retries=0, 2 workers): inbox-2-proposal-rows,
  inbox-for-wrap, inbox-proposal-codes, palette-open, prio-twin-propose, qa-leftovers: 34 passed.
- Prose guard: not run, because no word a person sees changed (only an API docstring).

# inbox-2 (PR #1922), fix round after re-review NOT_YET — handoff

Branch base: 47e8c419; merged origin/main (d26f6f1c, Nov 24 train) clean as 6330a43c and pushed.
Later commits are local only: git_push_branch refused them (code foreign_author, field "message":
it rejects a message carrying Co-Authored-By/anthropic.com, which the brief requires). The worker
publishes the branch.

## Done (red first, each in its own commit)
1. Blocker, pyright: `assert read_ is not None` before waiting_for in changes.inbox_rows (no new
   line, changes.py stays at its size entry 2591); baseline updated. Verdict:
   `pyright: 1265 errors, baseline 1265`, check exit 0. Red was CI's own run at 47e8c41.
2. Major, Home double count: page.tsx counts kind "inbox" rows keyed `proposal:` under
   drawnOnHome's proposals, not inboxRows. Mock case: scenario "inbox-replaced-proposal" now also
   has a meeting's owner change on Block list routed to commenter@example.com (can_decide false).
   Spec inbox-2-proposal-rows.spec.ts (last test): Decisions lists it with Open, Home shows no
   "more in your Inbox" and the card count equals its rows. Red: home-inbox-more 1 != 0.
3. Major, #1818: allNeeds/decisionNeeds take `simple`; _inbox.tsx passes path.startsWith('/simple');
   decision rows link /simple/decisions?decision=N there, /company/decisions?d=N on /inbox.
   Inbox step added to decisions-open-in-simple.spec.ts (red: landed on /company/decisions?d=11).
Minors done: Open row href '/inbox' -> '/simple/inbox' (API waiting_list.py + mock), red pytest
and spec assertion first; replaced-PRD pytest pins (kind, action) == ("inbox", "Open").

## Gates
- pytest tests/test_simple_waiting_inbox_proposals.py tests/test_simple_waiting_list.py: 15 passed.
- ruff check/format on touched api files: clean.
- Playwright (--retries=0, mock prebuilt): inbox-2-proposal-rows + decisions-open-in-simple 5 passed;
  home-waiting-one-list 41 passed.
- tsc exit 0; npm run lint exit 0; prettier --check on touched web files: clean.
- Prose guard: not run, no visible word changed (hrefs, counts and comments only).
- Alembic, make openapi, contracts check: not applicable (no migration, schema or YAML change).

## Left (not one-line; other pages or a later pass)
- Mock vs API on the replaced-PRD case: API gives the Owner kind "inbox"/Open (pinned now); the mock
  still lets the admin decide it (Accept/Decline). Matching needs the mock's decides() to drop items
  of replaced roadmaps, which touches many pages' specs: a later pass.
- The mock titles a routed-but-unlisted proposal from the Inbox row's `asked` (present tense); the
  API uses changes.words (past tense; for the replaced case it reads "commenter@example.com
  proposed: changed the owner of an item"). Not a one-line change.
- #1913's past tense on Decisions ("Changed the owner of …" while waiting): follow-up issue.
- waiting_reads.proposals cost (no cap, routes all open proposals each read): noted, unchanged.
- Round 1 minors carried: headers hidden so the header check is not red; For and Action still about
  42% of the row; flake at inbox-question-one-pager.spec.ts:170.
- The Inbox's Decide button on /simple now goes to /simple/decisions?decision=N&act=decide; the
  sheet opens, `act` is ignored there.

# inbox-ux handoff (issues #1741, #1782-#1786, review fix round 1)

## This round (verdict NOT_YET, four blockers, all fixed in ea38784)
- format:check: prettier on inbox-ux, inbox-runs, track-alerts, inbox-track-alerts-walk specs.
- lint: `npm run lint -- --prune-suppressions` dropped the stale import-x/order entries (only those).
- Age cell (web/app/inbox/_needs.tsx, shared with Home): the text is the age only again; the label is the
  clock wrapped in role="img" aria-label="Age". dod-meet-minutes.spec.ts unchanged and passes;
  inbox-ux.spec.ts checks the named clock and the exact age text.
- Tab counts: next-draft.spec.ts:184 and :251, runs-sent-back.spec.ts:75 now expect 'Seen0' / 'New0'.
- Already fixed at base (no code change): #1783's first point, the Inbox opens on New, or on Seen when New is
  empty (qa-company-2 rule in web/app/inbox/_inbox.tsx); inbox-ux.spec.ts proves it.
- Minors left as is: on a phone a 0 tab count stays hidden (qa-company-47); the Simple Roadmap still counts
  tracks while the Plan chip counts items, each now named.

## Gates this round
- Playwright --retries=0: dod-meet-minutes, next-draft, runs-sent-back, inbox-ux, inbox-runs, track-alerts,
  inbox-track-alerts-walk: 40 passed. format:check exit 0. Full `npm run lint` exit 0. tsc exit 0.
- No API change this round, so the API suite, timing tests, pyright and frozen migrations were not rerun.

# task-push handoff (#1816, fix round 1: review NOT_YET, two blockers)

## Fixed (exactly the two blockers in verdict.json)
- Head pins: `api/tests/test_migrations.py:196` (and 'task-push' added to its 'renumbered on merge' list),
  `test_stale_settled_on_approval.py:178`, `test_unique_item_codes.py:134` and
  `test_stale_by_meaning_migration.py:61` now pin `0139_task_tracker_push_error`. The down_revision check at
  `test_stale_settled_on_approval.py:177` is unchanged (0138).
- Read digests re-pinned in `api/tests/test_simple_read_speed.py` (roadmap, roadmap-viewer) and
  `api/tests/test_simple_roadmap_speed.py` (goal, track, prd, one-roadmap, viewer). Each JSON body from base
  4ecbc5620 was diffed against the head body (all keys, all list items). The only change in each of the 7 reads
  is three keys added to each of the seed's 268 tasks: `.items[].tasks[].tracker_ref`, `tracker_url` and
  `tracker_error`, all null. Nothing else is added, removed or changed. The other digests match at both commits.
  Full diff: `read-digest-json-diff.txt` in the artifacts.

## Gates
- Whole API suite (`-m "not timing"`, split into 8 groups of files, run with -n 4 or -n 6): every group green, 0 failures
  (1080+1355+1388+1512+1659+1414+1457+1413 passed). The first try at groups 02 and 03 hit Postgres's 'out of shared
  memory' lock table, an environment limit, not the code. Both were rerun with max_locks_per_transaction=1024 and passed.
- ruff check and format: clean. tests/test_frozen_migrations.py passed (in the 36 targeted tests).
- Timing tests in the touched files: one failure, `test_simple_roadmap_speed::test_reads_answer_within_budget`
  (0.37 s). It fails at base 4ecbc5620 in the same environment, and is slower there (0.42 s). This is environment
  noise, as the review also found. The rest of the `-m timing` suite was not rerun for lack of time. The review ran
  405 of 409, and every failure it found was environment noise.
- pyright: NOT RUN. Pyright is not installed here (no web/node_modules). This round changes only test strings and
  comments under api/tests, and the CI job checks api/oracle, so its count cannot move. It stays at the review's 1269
  (the same as the baseline).
- Web: no change this round (the review's tsc, lint, format and Playwright runs still stand).

## Left (minors from the review, not in scope for this round)
- Inline push inside the request transaction: move it to a background job when a real connector lands
  (owner question open).
- A stale tracker_push_error is kept after two-way sync is turned off, so Retry seems to do nothing.
- The mock pushes on the undo of an add (harmless).

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

# roadmap-ux handoff (issues #1740 #1746 #1749 #1750 #1751 #1752 #1753 #1757)

Base 83b3594. Spec: web/e2e/roadmap-ux-nov24.spec.ts (8 tests, one per issue). Red-first commit 3eaaa9b
(6 of 8 red on the base build, as the review re-ran it: #1752 and #1753 are green on base, both already
fixed; the first round's "7 of 8" was wrong about #1753).

## What changed (web/app/simple/roadmap only)
- #1746 `_keydates.tsx`: Key dates closes on a pointerdown outside it (its own button and the toast stack excepted), as on Escape.
- #1750 `_keydates.tsx`: when a roadmap has PRD milestones, its list splits into "Events" and "PRD milestones" (headings; testids key-dates-events / key-dates-milestones).
- #1751 `_keydates.tsx` + new `_dayfield.tsx`: DayField: the day in words, month first ("Dec 3, 2026"), the native date input laid over it unseen (opacity 0), as the milestone card's DateField. Add and Edit both.
- #1749 `_zoom.tsx` (Timeline) and `_timeline.tsx` (Gantt): the open feature's label gets an accent ring, a 4 px accent edge and bold; its bar a 3 px accent outline plus a soft halo (Timeline) or an accent ring rect (Gantt, testid bar-open-ring); the open row's tint is full accent-soft.
- #1753 already fixed: the health mark is an InfoTip trigger, which opens on hover, tap and focus. The first round's invisible pad is dropped (fix round: no test failed without it). The spec taps the mark and focuses it and reads the reason; it passes on base.
- #1757 `_tracks.tsx`: the owner shows in the Tracks sheet only once some track has an owner; then "No owner" is a button (for those who may change) opening the row with Owner focused.
- #1740 `_roadmap.tsx`, `_tracks.tsx`, `_lib.ts`: the goal card count and the track count are each the trigger of an InfoTip saying what they cover (hover, tap, focus; testids goal-counter-count-tip, track-count-tip; no new visible prose). Fix round: was a title attribute, which touch and keyboard cannot open. Finding: the audit compared tracks (drawer, by track, every feature incl. done, filters ignored) with goal cards (by goal, filters applied, PM-owned excluded); the Timeline itself shows no per-lane count now (bands are tracks). Counts were not changed.
- #1752 already fixed: every cut label on the Timeline (row names: title=; milestone chips and band labels: aria-label plus a role=tooltip tip on hover and focus). The spec proves it by hovering each cut label (10 in the roadmap-milestones scenario) and focusing one. No code change.

## Specs updated for the intended change
- e2e/roadmap-tracks-sheet.spec.ts: two asserts of "No owner · 5 features" with no owners in use -> "5 features", no "No owner".
- Key dates: a toast's Undo (the toasts stack) does not count as an outside click (simple-roadmap-plus phone test).

## Gates run (on the final code unless noted)
- npx tsc --noEmit -p .: clean. npm run lint (full): exit 0. npm run format:check: clean.
- Playwright, --retries=0, mock build: roadmap-ux-nov24 (8/8), roadmap-tracks-sheet, roadmap-keydates,
  simple-roadmap-plus, qa4-simple-roadmap, ah-prd-milestones-once, priorities-keydates, prose-guard:
  107 passed. The only failure was prose-guard's "no ceiling above the merge base", because this clone
  has no origin/main. With PROSE_BASE=83b3594 it passes. Ceilings were not touched.
- Every spec that drives /simple/roadmap (248 files), run in chunks before the last lint-only commit
  (fa60642: DayField moved to its own file, the ds Button for No owner): all passed except
  mock-matches-api-roadmap.spec.ts:59 (goal counters order) and qa4r-timeline.spec.ts:163 (rows by start
  date). Both also fail on a base 83b3594 build, so they were already failing and are left as they are.
  de-r1-grab.spec.ts:85 failed once under load and passed alone and on the base. Not checked: the last
  ~90 tests of chunk rest-00, which timed out at 471/560 with no failures.
- No API change, so no pytest, pyright or migration checks were needed.

## Left
- #1740: the counts are labelled, not changed. If the owner wants one number everywhere, the Tracks sheet
  count is the API's (api/oracle/simple/removed.py:191-225) and would need an API change.
- The two pre-existing failures above belong to the timeline-order and goal-order lanes.

## Fix round (review NOT_YET, two majors; minors left as they were)
- Major 1 (#1753): option (a), pad dropped, spec opens the reason by tap and by focus.
- Major 2 (#1740): counts are InfoTip triggers; spec opens each by focus and by click and reads role=tooltip.
- Gates (fix round, on 134b20e, mock build, --retries=0, --trace=off): roadmap-ux-nov24 + roadmap-tracks-sheet
  18/18 passed. Every spec that drives the goal cards, the Tracks sheet or the health mark (36 files) plus
  roadmap-keydates, simple-roadmap-plus, prose-guard: 342 passed, 2 failed: mock-matches-api-roadmap.spec.ts:59
  (already failing on base, see above) and prose-guard.spec.ts:399, which cannot run in this shallow clone (no
  merge base even with PROSE_BASE=83b3594); its page checks all passed and web/e2e/prose-ceilings.json has no
  diff from 83b3594. tsc --noEmit: clean. npm run lint (full): exit 0. npm run format:check: clean.
- Red check: with the three app files at 2acfd1e (title attribute, pad) and the new spec, #1740 fails
  (locator.focus timeout: no tip trigger) and #1753 passes, as an already-fixed issue should.
- Not run: the 248-spec roadmap sweep; no API change, so no API gates.

# task-push (#1816) handoff

## Built (branch head: see git log; subjects start "task-push: ")
- API: `oracle.roadmap.tracker.push_task` is the one gate. It refuses through `refuse_push`, as `push_track_to_tracker`
  does, because no connector is verified. `oracle/simple/task_push.py` has push() and retry(). push() runs at the end
  of `targets._apply` for every task op except an undone add. It runs in a savepoint and never fails the change. A
  failure goes into `roadmap_item_tasks.tracker_push_error` (migration 0139_task_tracker_push_error, the only head).
  The read (`SimpleItemTask`) has new fields tracker_ref, tracker_url and tracker_error. The Retry route is
  `POST /v1/simple/tasks/{task_id}/tracker-push`: per item (can_decide), denied as an Ask Oracle action (outward).
- Web: `web/app/simple/roadmap/_tasks.tsx` TrackerMark shows the record link, the failure behind an (i), and Retry
  (a failed Retry shows a toast). Mock: `web/lib/api/mock/task-push.ts` ("task-tracker" scenario), wired in
  simple-changes.ts, simple-roadmap.ts (taskOut) and server.ts (route, seed).

## What today's behaviour means
- Two-way sync off (default) means no tracker is connected: nothing is pushed and nothing shows.
- Sync on: every push is refused, honestly, with the "no connector verified" reason and Retry on the task. A real
  connector (Linear or Jira) is a new client and so needs the owner's go. The pytest stubs one to prove create,
  link, status-follows and Retry.

## Gates
- pytest tests/test_simple_task_push.py: red first (a78011a), then green.
- All 19 files touching tasks or trackers, plus test_frozen_migrations, test_ask_oracle_actions and
  test_capabilities: green.
- ruff check and format: green. pyright: 1269 errors, baseline 1269 (OK). alembic: one head.
- Web: tsc 0, full npm run lint 0, format:check 0, test:unit 49 files / 308 tests green.
- Playwright (--retries=0): task-push 3/3 (2 fail without the _tasks.tsx change); feature-panel-gaps,
  walkc-roadmap-tasks, simple-home, goal-buckets-accept and prose-guard green (prose-guard with
  PROSE_BASE=4ecbc56, because no origin/main is fetched here).
- goal-buckets-tasks: 2 of the first run failed. "heading clears its feature count" then passed 6/6 with
  --repeat-each=3. The drag test passed on the next run. Both pass at base. Read as flaky.
- Postgres needs max_locks_per_transaction=1024 for -n 6. With 256, DROP SCHEMA runs out of shared memory and the
  run stalls or errors.
- Whole API suite: run in 8 chunks of $TMPDIR/files.txt (see below for how far it got).
  - Green: chunk 00 (test_accept... to test_connections_browse_slack, 1815 passed), chunk 01 (1282 passed) and
    chunk 05 (test_run_frozen_reads to test_simple_goal_map_scoreboard_api, 1149 passed).
  - NOT RUN, out of time: chunks 02, 03, 04, 06 and 07. Their task and tracker files did run in the targeted group
    above. Command: `split -n l/8 -d <(ls tests/test_*.py) c8_`, then `uv run pytest -q -n 6 -m "not timing" $(cat c8_0N)`.
- Timing tests (`-m timing`): NOT finished. 28 passed with 0 failures before the 400 s foreground limit cut the run.
  Next step: run them in parts.

## Left
- The rest of the whole-suite chunks and the timing tests, as above.
- The owner's call: a real tracker connector (Linear or Jira) is a new client and so needs the owner's go.

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
- api: every pytest file that reads priorities, the plan or the goal buckets (37 files, `grep -l
  "simple/priorities|plan_quarter|goal_buckets|/v1/simple/plan"`) plus tests/test_frozen_migrations.py: 408 passed,
  1 skipped. ruff clean. pyright vs baseline: 1269 = 1269.
- NOT RUN (time): the WHOLE API suite and the timing tests. A quarter of the suite takes over 10 minutes; its first
  run (-n 4, timed out at 64%) showed one F at 57% whose name the timeout did not print; a second run (-n 5, more
  Postgres locks) passed that range to 62% with no failure (a load flake likely, unproven). A -n 6 run hit Postgres
  "out of shared memory" on DROP SCHEMA (max_locks_per_transaction=256): use 1024. Next step: run the whole suite.

## train night-m (merge train, from main e2ded48)

Six lanes merged with `git merge --no-ff`, in order, each head checked against its named sha
(all matched): 1922 Inbox and Decisions (ddad55f119), 1928 Priorities re-audit (f8824413ac),
1926 One milestone number (30b9374f70), 1925 Feature panel wording (2ffcae97bb), 1927 Runs
names, test care (f9aa3ffe92), 1888 Command palette (75f49b67a8). No lane was left out.

Conflicts and how each was resolved:
- `api/tests/module_sizes.json` (1922): took main's lower drafts.py 2120 and meetings.py 1548
  (the real lengths); lane 1 moved the Inbox routing to `oracle/simple/inbox_route.py`, so
  changes.py fell to 2572 and its entry was lowered to 2572 (the ratchet asks for the exact length).
- `handoff.md` (1928, 1926, 1925): kept main's content; these notes are added at the end.
- `web/lib/api/mock/server.ts` (1925): kept both imports (inbox-proposal-scenario, panel-words).
- `web/lib/api/mock/server.ts` (1888): kept both imports and main's deferred-save harness
  (take/ownTurn/answer/leave); the palette's route runs ahead of the queue as in the lane, and
  its early answer now calls `leave()` so the burst's in-flight count drops and the deferred
  save still happens at the burst's last call. Priorities files (1928 vs 1926) merged cleanly.

Train duties:
- Migrations: one head, `0139_task_tracker_push_error (head)`; no lane added a migration.
- `python3 docs/contracts/check.py`: exit 0. `make openapi`: no change.
- Pinned read digests: none changed; lane 1 edited `tests/test_simple_waiting_speed.py` (its own read, no digest), and the speed tests pass in the suite unchanged by the train.
- Names (#1763): no added `name or email` / bare email in the merged diff.
- Follow-up: the two raw `<button>`s from the Home fixes (`web/app/simple/page.tsx` others'
  changes item, `web/components/simple/PlanByMonth.tsx` late item) are now the design system's
  `Button` (ghost, styled as the inline link it was); no-raw-button counts back to 21 and 4.

Gates (all run after the last commit with code changes, d0b30e6e6):
- API suite `uv run pytest -q -n 4 -m "not timing"`, run in 5 file chunks (one run passes the
  10-minute foreground limit): 2437 passed 1 skipped 1 xfailed; 2294 passed 2 skipped;
  2218 passed 6 skipped; 2246 passed 6 skipped; 2682 passed 1 skipped. 0 failed.
- `uv run pytest -m timing tests`: 417 passed, 2 failed, both roadmap read budgets:
  test_simple_roadmap_api.py::test_500_items_answer_under_300_ms_and_grouped_by_goal_under_500_ms
  (0.326 s vs 0.3) and test_simple_roadmap_speed.py::test_reads_answer_within_budget (0.478 s vs
  0.36). Alone, the first passes and the second reads 0.398 s. The same test on unchanged main
  e2ded48 in this container reads 0.413 s, so it fails there too: the container is slow, and the
  train is not the cause (no lane touched the roadmap read). CI's timing job decides.
- `tests/test_frozen_migrations.py`: 8 passed.
- pyright as CI runs it: `pyright: 1263 errors, baseline 1263`, check exit 0.
- web `npx tsc --noEmit`: exit 0. `npm run lint` (full): exit 0. `npm run format:check`:
  All matched files use Prettier code style!
- Playwright (`--retries=0 --workers=2`, prebuilt mock) on prose-guard.spec.ts, every spec
  the lanes added or changed (64), and the four Home specs from the commit that added the two
  buttons: 5 chunks, 135 + 115 + 99 + 197 (1 skipped) + 140 passed, 0 failed.

Not done: pushing. This environment publishes the branch after the step, so no push ran
after each merge.

## Train night-m: review round 1 fix (verdict NOT_YET, one major)

- Major fixed: the Home link buttons swapped to the design system's `Button` (ca00d08) forced
  `!font-normal` and kept `text-sm`'s line height, so the Since-your-last-visit item
  (`web/app/simple/page.tsx`, `home-since-item`) and the plan strip's late items
  (`web/components/simple/PlanByMonth.tsx`, `home-strip-late-item`) read at 400 instead of their
  semibold line. Now `![font-weight:inherit] ![line-height:inherit]`; suppression counts stay 21
  and 4.
- Red first (58973c6): `web/e2e/home-2.spec.ts` 1896 and 1900 assert the link's computed
  font-weight, line-height and font-size equal its parent's; they failed on the old tree
  (400/20px vs 600/28px). Fix 65d5969.
- Gates on 65d5969: home-2 + home-fixes specs 18 passed; prose-guard 33 passed + its 2
  merge-base tests passed with PROSE_BASE=e2ded48 (after `git fetch --deepen`); `npx tsc
  --noEmit` exit 0; full `npm run lint` exit 0; `npm run format:check` clean. API suites not
  re-run: no API file changed in this round.
- Minors from the verdict left as they were (brief: blocker and major only). Note: the earlier
  "d0b30e6e6" sha above is wrong; the gates there ran on ca00d08's tree.
