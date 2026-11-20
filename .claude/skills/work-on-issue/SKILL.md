---
name: work-on-issue
description: Work one GitHub issue of this repo end to end in a local session - intake, branch, implement, scoped gates, planted defects, review rounds, PR, merge and the serving check. Use when asked to work, fix or ship an issue by number.
---

# Work on an issue

One issue per session (root `CLAUDE.md`, Token economy). Where `docs/agents/lane-rules.md`
already decides something (the gates and their commands, `$TMPDIR`, ports, the verdict
file), follow it there; this skill does not copy it.

## 1. Intake

- Read the issue and its comments: `gh issue view <n> --comments`. Note its acceptance line
  ("Done when ...") word for word; it is what the PR proves.
- Read the open PRs that touch it, so you do not redo or collide with them:
  `gh pr list --state open --search "<n>"` and `gh pr list --state open` for the same files.
  If one already does the work, stop and say so.
- Confirm the bug still exists on main: `git fetch origin main`, then reproduce it there
  (a failing test, or the page through the UI). If it no longer does, say so with the
  evidence, comment on the issue, and stop.
- Find the code through the `explorer` subagent or the code-graph skill, not by reading the
  tree; read large files by range (`.claude/rules/large-files.md`).
- A decision that is the owner's (scope, a product choice, a new dependency) is asked, not
  guessed.

## 2. Branch

- `git switch -c <type>/<n>-<short-slug> origin/main` (type: fix, feat, chore, docs).
- Commit subjects start with the issue's area or number, as the issue or lane gives.

## 3. Implement

- Follow the router in the root `CLAUDE.md`: the area file (`api/CLAUDE.md`,
  `web/CLAUDE.md`) and `.claude/rules/oracle-product.md` for what you touch.
- Red test first, in its own commit: a pytest test for an API change, a mock-backed
  Playwright spec in `web/e2e` for a user-facing change. Then the fix.
- Exact edits across files: `node web/scripts/replace.mjs <spec.json>`. Mechanical work from
  a written brief can go to the `routine-helper` subagent.
- No new dependency (package, tool, Action or image) without the owner's go.

## 4. Local gates, scoped

Run the gates of `docs/agents/lane-rules.md` (Building a lane, Browser lanes), scoped to what
reads the changed files:

- the pytest files that import or exercise the changed modules (code-graph "which tests cover
  these files", or `git grep -l <module>` under `api/tests`), never the whole suite;
- the Playwright specs that visit the changed pages or read the changed mock routes, plus the
  prose guard when visible text changed;
- ruff, `make openapi` if a schema changed, web tsc and lint if the web changed, one alembic
  head if a migration was added.

Keep one verdict line per gate (the runner's own summary line, e.g. `12 passed in 40s`). A
gate you could not run is named with the reason.

## 5. Planted defects

Prove each new guard: write a `mutate.mjs` spec that plants the defect the guard is for
(revert the fix, drop the check) with the guard's own test command, and run
`node web/scripts/mutate.mjs <spec.json>`. It refuses a dirty file or a red baseline, so
commit first. Its `MUTATE: OK` line goes in the PR body; a `NOT RED` defect means the test
does not test the change: fix the test.

## 6. Review rounds

Follow `review.md`.

## 7. PR, merge and the serving check

Follow `ship.md`.
