# Product Oracle

An AI head of product. Oracle keeps a cited graph of a company's goals, features and the
links between them (the Ground Truth), turns requests and meetings into PRDs and a
roadmap, and runs agents that draft, check and revise that work while people review,
comment and approve.

- Design: [`docs/design.md`](docs/design.md); the first app's spec:
  [`docs/mvp-app.md`](docs/mvp-app.md); the current design set:
  [`docs/product-oracle-v2/`](docs/product-oracle-v2/)
- The Ground Truth, defined once: [`docs/ground-truth.md`](docs/ground-truth.md)

```
api/                FastAPI + async SQLAlchemy 2 + Alembic on Postgres 16 (Python 3.12, uv)
web/                Vite + React + TanStack Router (TypeScript, Tailwind), served by nginx
ops/                deploy scripts (ops/deploy/), access grants, lane and workflow briefs
docs/               design, specs, runbooks, contracts, lessons
.github/workflows/  CI and the vulnerability scan
```

## The product today

Two modes, switched with *Simple* / *Detailed* at the top of the app.

**Simple** (the plain view for most people):

- **Home**
- **One-pagers**
- **Roadmap**, shown as Timeline, Gantt, Now / Next / Later or Waterfall
- **Goal map**
- **Priorities**, with Goal buckets
- **Meetings**, **Decisions**, **Inbox**
- **Ask Oracle**, a panel that opens beside any page

**Detailed** (the full view): Home, Requests, Ground Truth, PRDs (draft versions, inline
comments, a verdict per section, diffs, approve and export to PDF, HTML or Markdown),
Priorities, Plan (with Launches), Runs, Inbox, Company, Settings.

Simple is behind a flag, off by default: `ORACLE_SIMPLE_MODE` on the API and
`VITE_ORACLE_SIMPLE_MODE=1` in the web build (the mock build turns it on). With it off,
everyone lands in Detailed.

**Roles**, lowest to highest: *viewer* (reads), *commenter* (comments; edits become
proposals), *approver* (also confirms or rejects run proposals), *owner* (also accepts
proposals, invites and manages members). The web checks them only through `can()` or an
item's own `can_*` field.

**Agents.** Agent runs execute in SwarmCloud, behind `api/oracle/swarm/`. Oracle hands
each run a short-lived run token, and the agents call back into Oracle's MCP endpoint,
`/mcp`, whose tools are Oracle's own API operations, limited by the caller's rights. API
tokens can call `/mcp` too. How the two sides talk:
[`docs/swarmcloud-interface.md`](docs/swarmcloud-interface.md). Oracle's own model jobs
run on a pool of Claude accounts: [`docs/claude-accounts.md`](docs/claude-accounts.md).

## Run locally

Requires Docker (with Compose), and for development and the agent-track CLI `uv` and
Node 24.

```sh
make up        # postgres:16 + api (:8000, migrates on start) + web (:3000)
make seed      # creates the tenant and the admin; prints the sign-in and a new API token
open http://localhost:3000
```

The API image starts with `python -m oracle.startup`: it brings the database to the
Alembic head (unless `ORACLE_MIGRATE_AT_START=0`), then serves.

`make seed` needs the admin's email (`make seed ARGS="--email you@yourcompany.com"`,
optionally `--password ...`; see `python -m oracle.seed --help`): there is no default
admin, and reserved example domains (example.com, \*.test, ...) are refused outside the
test build. It prints the password the first time and, on every run, a new API token for
the agent track (send it as a bearer token in the Authorization header; the `oracle` CLI reads
`ORACLE_API_TOKEN`). The token acts as the admin. Both secrets are shown once: only
hashes are stored.

The browser only talks to the web app: nginx proxies `/v1/*`, `/uploads/*` and
`/healthz` to the API (`web/nginx/`; `vite.config.mts` in dev), so the session cookie is
same-origin and needs no CORS.

Without Docker for the apps: start only Postgres (`docker compose up -d postgres`), then

```sh
cd api && uv sync && uv run alembic upgrade head && uv run python -m oracle.seed --email you@yourcompany.com
uv run uvicorn oracle.main:app --reload          # :8000
cd web && npm ci && npm run dev                  # Vite dev server, proxies /v1/* to :8000
```

**No backend at all**: the mock build runs the whole UI against an in-browser fake of the
API (`web/lib/api/mock`), Simple on; sign in as `admin@example.com` / `demo`
([`web/README.md`](web/README.md)).

```sh
cd web && npm ci
npm run dev:mock                          # dev server
npm run build:mock && npm run start:mock  # the build the Playwright suite uses
```

### The agent track's CLI

The `oracle` CLI (from `api/`, `uv run oracle --help`) is the agent track's side of the
PRD loop: `push` imports a draft as the next version, `pull` writes a version's open
feedback, `sync` syncs your sources, `baseline` pushes or pulls the Ground Truth as YAML,
`tick` advances runs and queued jobs, `accounts` / `account` manage the Claude account pool.

```sh
cd api && uv sync
export ORACLE_API_TOKEN=<token>                       # the token make seed printed
uv run oracle push tests/fixtures/prd_v1.md           # "Imported checkout-redesign version 1"
uv run oracle pull checkout-redesign --version 1 --out "$TMPDIR/oracle"
```

## Make targets

| Target | Does |
|--------|------|
| `make up` / `make down` / `make logs` | start, stop, follow the compose stack |
| `make seed` | the tenant, the admin and a new API token (above) |
| `make migrate` | `alembic upgrade head` inside the api container |
| `make test` | API tests against the compose Postgres (`oracle_test` database, wiped by the tests) |
| `make lint` | ruff (check + format) and the web lint |
| `make fmt` | ruff fixes and formats the API |
| `make openapi` | regenerate `web/lib/api/openapi.json` and `schema.d.ts`; commit both |
| `make web-build` | the production web build |
| `make e2e` | the end-to-end Playwright spec against the real stack (below) |
| `make e2e-mock` | the UI Playwright suite against the mock API |

## Tests

- **API**: pytest under `api/tests`. Set `ORACLE_TEST_DATABASE_URL` to a Postgres 16
  database; without it, tests that cannot reach one are skipped, not failed. Each xdist
  worker makes its own database (`oracle_test_gw0`, ...). `make test` uses the compose one.
  Lint: `cd api && uv run ruff check . && uv run ruff format --check .`.
- **Web**, from `web/`:

  ```sh
  npx tsc --noEmit -p .
  npm run lint            # ESLint in three passes (scripts/lint.mjs), with eslint-suppressions.json
  npm run format:check    # Prettier; npm run format writes it
  npm run test:unit       # Vitest: logic and render tests beside their module
  npx playwright test     # the mock-backed UI suite in e2e/ (builds and serves the mock app)
  ```

  Every user-facing change has a mock-backed Playwright spec in `web/e2e`. The prose
  guard (`e2e/prose-guard.spec.ts`) counts each page's visible text against
  `e2e/prose-ceilings.json`; ceilings only go down (`npm run prose:ratchet`).
- **Docs**: `python3 docs/contracts/check.py` checks the quotes, templates and YAML the
  docs contracts pin (`--write` refreshes them).
- **End to end**: `make e2e` runs `web/e2e/real/feedback-loop.spec.ts` against the real
  stack: push v1 with `oracle push`, comment and give verdicts in the UI, `oracle pull`,
  push v2 with resolutions, check the diff, approve and export. Playwright
  (`web/playwright.real.config.ts`) starts the API on :8100 against `oracle_e2e` (dropped,
  migrated and seeded on every run by `web/e2e/real/reset_stack.py`; override with
  `E2E_DATABASE_URL`) and a production web build behind nginx on :3200. It needs Postgres 16
  on localhost:5432 with the compose credentials (`make e2e` starts the compose one;
  `make e2e E2E_POSTGRES=` if you run your own), the API's PDF dependencies (Pango, see
  `api/Dockerfile`) and Chromium (`cd web && npx playwright install chromium`).

## CI and release

`.github/workflows/ci.yml` runs on every push to `main` and by hand
(`workflow_dispatch`, on any branch); it does **not** run on pull requests. Its jobs: the
API suite in four shards on Postgres 16 with ruff, coverage floors, pyright against its
baseline, the timing tests; the web job (lint, format check, tsc, Vitest, generated API
types up to date, `docs/contracts/check.py`, the build); the real-stack `make e2e`; the
mock Playwright suite in eight shards, with the prose guard; the timing specs.
`.github/workflows/vulnerability-scan.yml` scans the lockfiles with OSV-Scanner on each
push to `main`, weekly and by hand.

Release: the `deploy` job in `ci.yml` runs after every test job passes on a `main` push,
only when the repository variable `ORACLE_DEPLOY_ENABLED` is `true`. It builds and pushes
both images, backs up the database, stages the API with no traffic, migrates in its own
step (`python -m oracle.startup migrate`), moves the traffic, then deploys the web
([`docs/deploy/actions-deploy.md`](docs/deploy/actions-deploy.md)). While that job is
off, the API is deployed by hand with `ops/deploy/deploy-api.sh`, which refuses to run
when the job is on. Access grants are applied by hand too (`ops/invite-access-grants.sh`,
below).

## Configuration

Settings are environment variables with the `ORACLE_` prefix, read by
`api/oracle/config.py` and a few modules beside it. The ones a deployment needs:

| Variable | Meaning |
|----------|---------|
| `ORACLE_DATABASE_URL` | the Postgres database |
| `ORACLE_SECRET_KEY` | signs the session cookie; required on a real deployment (at least 32 characters, not the default), e.g. `openssl rand -hex 32` |
| `ORACLE_ENV` | `production` on a real deployment: it refuses the switches meant for tests |
| `ORACLE_COOKIE_SECURE` | secure session cookie |
| `ORACLE_CORS_ORIGINS` | origins allowed to call the API with credentials |
| `ORACLE_PUBLIC_URL` | where agents and MCP clients reach Oracle (its `/mcp` endpoint) |
| `ORACLE_APP_URL` | where people open the web app (default `ORACLE_PUBLIC_URL`); exports turn links into absolute URLs under it |
| `ORACLE_SIMPLE_MODE` | turns Simple on (with the web build's `VITE_ORACLE_SIMPLE_MODE`) |
| `ORACLE_MIGRATE_AT_START` | `0` stops a start from migrating (the deploy job migrates in its own step) |
| `ORACLE_RUNTIME`, `ORACLE_SWARMCLOUD_*` | where agent runs execute and how Oracle signs in to SwarmCloud (`api/oracle/swarm/settings.py`) |
| `ORACLE_LLM_*`, `ORACLE_CLAUDE_*` | Oracle's own model calls and its Claude account pool |
| `ORACLE_IAP_*`, `ORACLE_GCP_PROJECT`, `ORACLE_MAIL_*` | Google sign-in and invites (below) |

With `ORACLE_ENV=production`, `ORACLE_COOKIE_SECURE` or `ORACLE_IAP_AUDIENCES` set, the API
refuses to start with a weak `ORACLE_SECRET_KEY`. The web build reads `API_INTERNAL_URL`
(default `http://localhost:8000`), where nginx and the dev server send API calls.

## Google sign-in (IAP)

Behind a Google Cloud HTTPS load balancer with Identity-Aware Proxy, the app signs
people in with their Google identity and skips its own login form. The API verifies the
signed `x-goog-iap-jwt-assertion` header on every request (ES256 signature against
Google's public keys, issuer, audience, expiry); the unsigned
`x-goog-authenticated-user-email` header is never trusted. Session cookies and API
tokens keep working, so the agent track can call the API with its Bearer token.

| Variable | Meaning |
|----------|---------|
| `ORACLE_IAP_AUDIENCES` | JSON list of accepted audiences, e.g. `'["/projects/123456789/global/backendServices/987654321"]'`. Empty (default) turns IAP sign-in off and the header is ignored. |
| `ORACLE_IAP_ALLOWED_DOMAINS` | JSON list of email domains, e.g. `'["example.com"]'`, whose users are created on their first visit. Empty: only users that already exist can sign in. |
| `ORACLE_IAP_AUTO_PROVISION` | `true` (default) creates those users; `false` only signs in existing ones. |

The audience is `/projects/<PROJECT_NUMBER>/global/backendServices/<BACKEND_SERVICE_ID>`:

```sh
gcloud projects describe <project-id> --format='value(projectNumber)'
gcloud compute backend-services describe <backend-service-name> --global --format='value(id)'
```

Users are matched by lowercased email in the seeded tenant (run `make seed` first) and
created as owners; roles come later. A present but invalid assertion is a 401. *Sign
out* sends the browser to IAP's `?gcp-iap-mode=CLEAR_LOGIN_COOKIE`, which clears the
IAP session.

### Invites reach the person

Settings › Members invites someone by email. Oracle then lets their Google account
through IAP and emails them the sign-in link; the Members page says what happened to
each invite (access granted or not yet, with Retry; email sent, not sent or failed, with
Resend, which waits a minute after an email went out). An invite takes exactly one plain
address (no name, list or comment); one outside `ORACLE_IAP_ALLOWED_DOMAINS` (when set) is
refused, because Google sign-in would refuse it. Taking access away, or granting it
again on a restore, that fails is retried by the tick until it is done or no longer
needed: for 24 hours, then once a day; the member's row says "Access not removed yet" (or
"not granted yet") meanwhile. Still failing after 24 hours, it shows in owners' Inbox
(even for a revoked invite, which has no row), with Retry. Oracle records only a
short reason for a failure ("Google returned 403 (permission denied)"), never Google's
answer.

| Variable | Meaning |
|----------|---------|
| `ORACLE_IAP_BACKENDS` | JSON list of the IAP backend service names an invite grants `roles/iap.httpsResourceAccessor` on, e.g. `'["oracle-api-be", "oracle-web-be"]'`. Revoking the invite, or removing the member, takes it away (kept while they are an active member or have another open invite); restoring the member grants it again. Empty (default, local and dev): no grant, and the invite says so. |
| `ORACLE_GCP_PROJECT` | The project id of those backend services. |
| `ORACLE_MAIL_PROVIDER` | `gmail_api` sends the invite email through the Gmail API as `ORACLE_MAIL_SENDER`, by domain-wide delegation. Either unset: no email is sent, and the Members page gives the owner the link to send. |
| `ORACLE_MAIL_SENDER` | The company mailbox the invite emails come from. |

Oracle calls IAP and the Gmail API as its own Cloud Run service account, with no key
file: the delegated Gmail token's JWT is signed by the IAM Credentials API. The owner
applies the grants this needs (`ops/invite-access-grants.sh <project-id>
<runtime-service-account-email> <backend-service>...` prints and runs them):
`roles/iap.admin` for the runtime service account on Oracle's two backend services only,
and `roles/iam.serviceAccountTokenCreator` for it on itself. A Google Workspace admin
then grants the service account's client id (the script prints it) domain-wide
delegation for the `https://www.googleapis.com/auth/gmail.send` scope.

## Contributing

The rules live in [`CLAUDE.md`](CLAUDE.md) (router, gates),
[`.claude/rules/oracle-product.md`](.claude/rules/oracle-product.md) (product rules) and
[`docs/agents/lane-rules.md`](docs/agents/lane-rules.md) (how a change is built and
checked); the incidents behind them are in [`docs/lessons/`](docs/lessons/README.md).
