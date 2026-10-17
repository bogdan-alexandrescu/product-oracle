# Product Oracle

An AI head of product. This repo holds the thin MVP app that runs the PRD feedback
loop: import a draft as version N, review it (inline comments, per-section verdicts),
hand open feedback back to the agent track, diff versions, approve and export.

- Design: [`docs/design.md`](docs/design.md)
- MVP spec (the contract for this code): [`docs/mvp-app.md`](docs/mvp-app.md)

```
api/   FastAPI + async SQLAlchemy 2 + Alembic (Python 3.12, uv)
web/   Next.js (App Router, TypeScript, Tailwind)
```

## Run locally

Requires Docker (with Compose), and for development `uv` and Node 24.

```sh
make up        # postgres:16 + api (:8000, runs migrations on start) + web (:3000)
make seed      # creates the tenant, admin@example.com and an API token (printed once)
open http://localhost:3000
```

`make seed` prints a generated admin password unless you pass one:
`make seed ARGS="--email you@example.com --password '...'"`. Every run prints a new
API token for the agent track (send it as a Bearer token in the Authorization header);
only its hash is stored.

Other targets:

| Target | Does |
|--------|------|
| `make down` | stop the stack |
| `make migrate` | `alembic upgrade head` inside the api container |
| `make test` | API tests against the compose Postgres (`oracle_test` database, wiped by the tests) |
| `make lint` | ruff (check + format) and eslint |
| `make openapi` | regenerate `web/lib/api/openapi.json` and `schema.d.ts`; commit both |

Without Docker for the apps: start only Postgres (`docker compose up -d postgres`), then

```sh
cd api && uv sync && uv run alembic upgrade head && uv run python -m oracle.seed
uv run uvicorn oracle.main:app --reload          # :8000
cd web && npm ci && npm run dev                  # :3000, proxies /v1/* to :8000
```

Settings are environment variables with the `ORACLE_` prefix (see
`api/oracle/config.py`): `ORACLE_DATABASE_URL`, `ORACLE_SECRET_KEY` (signs the session
cookie; set it outside local dev), `ORACLE_COOKIE_SECURE`, `ORACLE_CORS_ORIGINS`.
The web app reads `API_INTERNAL_URL` (default `http://localhost:8000`) at build time.
