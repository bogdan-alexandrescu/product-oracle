Rules only. How-to and the reasons behind each rule live in the files the router points to;
incidents live in `docs/lessons/`. `docs/agents/lane-rules.md` is the lane manual and links
back here; neither copies the other.

## Router

Touching X? Read Y first.

| Touching | Read |
| --- | --- |
| anything under `api/` | `api/CLAUDE.md`, then `docs/agents/lane-rules.md` (Building a lane) |
| anything under `web/` | `web/CLAUDE.md`, then `docs/agents/lane-rules.md` (Building a lane, Browser lanes) |
| a page, a word a person sees, Simple, the mock API | `.claude/rules/oracle-product.md` |
| roadmap items, PRD features, feature codes | `docs/ground-truth.md` |
| a file over about 2k lines, or a broad search | `.claude/rules/large-files.md` |
| a GitHub issue, in a local session | `.claude/skills/work-on-issue/SKILL.md` (`/work-on-issue`) |
| a SwarmCloud lane (build or review) | `docs/agents/lane-rules.md` |
| why a rule exists | `docs/lessons/README.md` |
| an exact edit or a planted defect | `web/scripts/replace.mjs`, `web/scripts/mutate.mjs` (usage at the top of each) |
| search, routine edits, review | `.claude/agents/` (`explorer`, `routine-helper`, `change-reviewer`) |

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
- Work a GitHub issue in a local session → invoke /work-on-issue

## Feature loop

For every new or existing feature:
1. Design and implement.
2. Deploy the feature and its configs.
3. Test it through the UI, as a person would. Never test it by calling the API or by
   changing data or settings by hand.
4. Repeat until the feature is done.

SwarmCloud lanes cannot deploy: they prove the feature with a Playwright test that drives
the built app's UI.

SwarmCloud lanes follow docs/agents/lane-rules.md and .claude/rules/oracle-product.md.

## Token economy

- One issue per session. A second issue starts a fresh session.
- Read narrowly: find the place, then read a range (`.claude/rules/large-files.md`). Never
  read generated files (`web/lib/api/openapi.json`, `web/lib/api/schema.d.ts`).
- Fetch big content through a subagent: a broad search goes to `explorer`, a long log or a
  large diff to a subagent that returns the answer and `path:line`, not the content.
- Mechanical work from a written brief goes to `routine-helper`; review of a commit range to
  `change-reviewer`. A subagent sets its own `model:`; an interactive skill never does.
- Wait in the background once: a long command started in the background is waited on once,
  for its completion notice, never polled with sleep loops. In a SwarmCloud lane,
  `docs/agents/lane-rules.md` wins (tests and Playwright run in the foreground).

## Gates

- Nothing merges red. The gates and their exact commands are in `docs/agents/lane-rules.md`
  (Building a lane, Browser lanes): ruff, the touched pytest files, one alembic head,
  `make openapi` when a schema changes, web tsc and lint, the touched Playwright specs, the
  prose guard.
- Every user-facing change has a mock-backed Playwright spec in `web/e2e` that fails without
  it; every API change has a pytest test that fails without it, red test committed first
  (`.claude/rules/oracle-product.md`).
- A gate that was not run is named as not run, with the reason; never reported green.
- A guard is proven by planting its defect: `web/scripts/mutate.mjs` turns it red and
  restores the file.

## Compact instructions

When compacting, keep: the issue number and its acceptance line, the branch and the last
commit, which gates ran and their verdict lines, failing test names with `path:line`, the
decisions taken and by whom, and what is left. Drop file contents, logs and search results;
they can be read again by range.
