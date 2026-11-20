# api/

Rules for work under `api/`. The root `CLAUDE.md` router and `.claude/rules/oracle-product.md`
still apply; the commands are in `docs/agents/lane-rules.md` (Building a lane).

- Every API change has a pytest test in `api/tests` that fails without it; the red test is
  committed before the fix.
- Run ruff (`uv run ruff check . && uv run ruff format --check .`) and only the touched pytest
  files, at most `-n 2`, in groups; never the whole suite at once.
- Tests need `ORACLE_TEST_DATABASE_URL` (Postgres 16, data directory under `$XDG_CACHE_HOME`
  or `$TMPDIR`): without it, database tests are skipped, not failed. Setup is in lane-rules.md.
- A schema change runs `make openapi` from the repo root and commits both generated files
  (`web/lib/api/openapi.json`, `web/lib/api/schema.d.ts`); the mock (`web/lib/api/mock`) is
  then matched to it.
- One alembic head: a new migration chains after the branch's own head
  (`uv run alembic heads` shows one).
- Dates a person sees (exports, generated text) read month first, never ISO; generated text
  never carries raw tokens, template labels or internal file names.
- No company or customer data in code, tests or fixtures: invented example data only.
- `oracle/runs/service.py` is about 12k lines: read it by range (`.claude/rules/large-files.md`).
