# Lane rules

Shared rules for every SwarmCloud lane on this repo. A lane prompt says "Follow
docs/agents/lane-rules.md"; the product rules are in .claude/rules/oracle-product.md.
The repo-wide rules (router, feature loop, token economy, gates) are in the root
`CLAUDE.md`; the incidents behind these rules are in `docs/lessons/README.md`.

## Building a lane

- Red tests first, in their own commit, pushed at once. Then the fix, committed and pushed
  before any long probe or Playwright run, so a crash loses nothing.
- Start every commit subject with "<your lane key>: ".
- API checks, from `api/`:
  - `uv run ruff check . && uv run ruff format --check .` (what `make lint` and CI run).
  - The touched pytest files, at most `-n 2`, in groups of files; never the whole suite
    at once.
  - `make openapi` (from the repo root) if a schema changes; commit both generated files.
- Checks that only main's CI ran before (#1712), from the repo root:
  - `api/oracle` changed: the pyright baseline, as CI's pyright job runs it:
    `(cd api && uv sync --frozen)`, `web/node_modules/.bin/pyright --outputjson >
    "$TMPDIR/pyright.json"` (exit 1 is normal: the baseline decides), then
    `python3 .github/scripts/pyright_baseline.py check "$TMPDIR/pyright.json"`. Verdict:
    `pyright: N errors, baseline N` and exit 0; "new pyright errors" is red, and "baseline
    errors are gone" asks for its `update` command and a commit.
  - A YAML file (anywhere outside `api/`, front matter, a yaml block in a doc) or a
    `docs/contracts` file changed: `python3 docs/contracts/check.py`. Verdict: no output and
    exit 0; each drift is one line (`--write` refreshes the copies, then commit them).
  - Any web change: `npm run format:check` (below). Verdict: `All matched files use Prettier
    code style!`.
- Test database: Postgres 16, data directory outside the repository, on the cache disk:

  ```sh
  initdb -D "$XDG_CACHE_HOME/pgdata" -U oracle --auth=trust
  pg_ctl -D "$XDG_CACHE_HOME/pgdata" -l "$TMPDIR/pg.log" \
    -o "-c shared_buffers=128MB -c max_connections=60 -c max_locks_per_transaction=256 -k $TMPDIR" start
  createdb -h localhost -U oracle oracle_test
  export ORACLE_TEST_DATABASE_URL=postgresql+asyncpg://oracle:oracle@localhost:5432/oracle_test
  ```

  Set `ORACLE_TEST_DATABASE_URL`: without it, tests that cannot reach a database are
  skipped, not failed. Each xdist worker makes its own database (`oracle_test_gw0`, ...).
  Stop it with `pg_ctl -D "$XDG_CACHE_HOME/pgdata" stop` before tsc or a build.
- Never put the data directory, logs or other scratch under a literal /tmp (3 GiB) or in
  the workspace (5 GiB, checkpointed). Use `$TMPDIR`. Why: `docs/lessons/README.md`.
- A migration, if one is needed, chains after the branch's own head, so
  `cd api && uv run alembic heads` shows one head (CLD renumbers when trains merge).
- Web checks, from `web/`: `npx tsc --noEmit -p .`, then `npx vite build` (Vite does not type-check), then `npm run lint`,
  then `npm run format:check` (Prettier; `npm run format` writes it), then `npm run test:unit`
  (Vitest: logic and render tests beside their module).
- Every user-facing change gets a mock-backed Playwright spec in `web/e2e` that drives the UI
  as a person would and fails without the change. Import `test` from `e2e/test.ts` (it pins
  the mock clock). The mock (`web/lib/api/mock`) must match the API.
- Run Playwright as in "Browser lanes" below. If Chromium will not start (missing system
  libraries or fonts, which you may unpack under `$TMPDIR` and point to with
  `LD_LIBRARY_PATH` and `FONTCONFIG_FILE`), say plainly which specs you could not run;
  CLD runs them locally.
- A lane that adds prose must hide it (an InfoTip, a tick whose tooltip says why, a link) or
  the prose guard fails: `web/e2e/prose-guard.spec.ts` counts each page's visible prose
  against `web/e2e/prose-ceilings.json`; ceilings only go down (`npm run prose:ratchet`).
  Ceilings are never edited by hand: the spec fails when one is above the merge base's
  (`origin/main`), and a new page starts at its measured count. Text a person wrote
  (comments, notes, answers, quotes) is marked `data-user-content` and not counted.
- Roles in the web go through `can()` or an item's own `can_*` field only.
- No company or customer data in code, tests or the PR.
- Never use pkill, killall or kill on a pattern; kill by PID.
- Code navigation in a lane comes from the `swarm-graph` and `swarm-search` tool servers.
  `make agent-setup` and the `code-intel` plugin are for local sessions: with `SWARM_TASK_ID`
  set (#1653) the SessionStart hook prints nothing, `make agent-setup` only sets the git config
  and uses the lane's own `coderabbit`, and `code-intel` stays idle (no language servers).
- The container has 8 GiB. `free -m` shows the host, not the container: watch
  `cat /sys/fs/cgroup/memory.current` between stages and stop a stage that passes 6 GiB. Run
  one heavy command at a time. Why: `docs/lessons/README.md`.

## Reviewing a lane

- Look for new problems the fix brings.
- Run ruff, the touched pytest files (at most `-n 2`, in groups, with the test database set
  up as above), web tsc and lint if the web changed, and the
  touched Playwright specs if Chromium starts; otherwise say which you could not run.
- Same limits as building: 8 GiB, no literal /tmp, no pattern kills, no company or
  customer data.
- Stop within 40 minutes. Be concise.
- Report a verdict: blockers and majors only, each with file:line and a failure scenario;
  minors as one-line items. Write it as `verdict.json`:

  ```json
  {
    "verdict": "MERGE",
    "findings": [
      {"severity": "blocker", "where": "web/app/page.tsx:12", "scenario": "...", "fix": "..."}
    ],
    "minors": ["..."]
  }
  ```

  `verdict` is `"MERGE"` or `"NOT_YET"`; `severity` is `"blocker"` or `"major"`.

## Browser lanes

```sh
cd web
[ -d node_modules ] || npm ci
npx playwright install chromium        # lands in $PLAYWRIGHT_BROWSERS_PATH, the attempt's cache
E2E_PORT=3393 npx playwright test e2e/<spec>.spec.ts ... --workers=2 > "$TMPDIR/e2e.log" 2>&1
```

- `npx playwright test` builds and starts the mock app itself (playwright.config.ts's
  webServer runs `npm run build:mock && npm run start:mock -- --port $E2E_PORT`: `vite build --mode mock`, then `vite preview`), so a separate
  `npm run build:mock` first only builds it twice.
- The port comes from `E2E_PORT` (default 3100); `PORT` is not read.
- Run it in the foreground; never background it with & or nohup.
