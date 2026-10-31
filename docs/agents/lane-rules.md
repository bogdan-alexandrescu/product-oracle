# Lane rules

Shared rules for every SwarmCloud lane on this repo. A lane prompt says "Follow
docs/agents/lane-rules.md"; the product rules are in .claude/rules/oracle-product.md.

## Building a lane

- Red tests first, in their own commit, pushed at once. Then the fix, committed and pushed
  before any long probe or Playwright run, so a crash loses nothing.
- Start every commit subject with "<your lane key>: ".
- API checks, from `api/`:
  - `uv run ruff check . && uv run ruff format --check .` (what `make lint` and CI run).
  - The touched pytest files, at most `-n 2`, in groups of files; never the whole suite
    at once.
  - `make openapi` (from the repo root) if a schema changes; commit both generated files.
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
- Never put the data directory, logs or other scratch under a literal /tmp (3 GiB; a lane
  that filled it was evicted) or in the workspace (5 GiB, checkpointed). Use `$TMPDIR`.
- A migration, if one is needed, chains after the branch's own head, so
  `cd api && uv run alembic heads` shows one head (CLD renumbers when trains merge).
- Web checks, from `web/`: `npx next typegen && npx tsc --noEmit -p .`, then `npm run lint`.
- Every user-facing change gets a mock-backed Playwright spec in `web/e2e` that drives the UI
  as a person would and fails without the change. Import `test` from `e2e/test.ts` (it pins
  the mock clock). The mock (`web/lib/api/mock`) must match the API.
- Run Playwright as in "Browser lanes" below. If Chromium will not start (missing system
  libraries or fonts, which you may unpack under `$TMPDIR` and point to with
  `LD_LIBRARY_PATH` and `FONTCONFIG_FILE`), say plainly which specs you could not run;
  CLD runs them locally.
- Roles in the web go through `can()` or an item's own `can_*` field only.
- No company or customer data in code, tests or the PR.
- Never use pkill, killall or kill on a pattern; kill by PID.
- The container has 8 GiB (a lane was OOM-killed). `free -m` shows the host, not the
  container: watch `cat /sys/fs/cgroup/memory.current` between stages and stop a stage that
  passes 6 GiB. Run one heavy command at a time.

## Reviewing a lane

- Look for new problems the fix brings.
- Run ruff, the touched pytest files (at most `-n 2`, in groups, with the test database set
  up as above), web tsc (after `npx next typegen`) and lint if the web changed, and the
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
  webServer runs `npm run build:mock && npm run start:mock -- -p $E2E_PORT`), so a separate
  `npm run build:mock` first only builds it twice.
- The port comes from `E2E_PORT` (default 3100); `PORT` is not read.
- Run it in the foreground; never background it with & or nohup.
