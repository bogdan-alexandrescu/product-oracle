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

Requires Docker (with Compose), and for development and the agent-track CLI `uv` and
Node 24.

```sh
make up        # postgres:16 + api (:8000, runs migrations on start) + web (:3000)
make seed      # creates the tenant and admin@example.com; prints the sign-in and a new API token
open http://localhost:3000
```

`make seed` prints the admin email and, the first time, a generated password; every run
also mints a new API token for the agent track (send it as `Authorization: Bearer
<token>`; the `oracle` CLI reads `ORACLE_API_TOKEN`). The token acts as the admin (their
role, connections and sources), so per-user commands such as `oracle sync` work with it;
tokens created without a user act with their own role. Both secrets are shown once: only
hashes are stored. To choose the email and password, pass them through `ARGS`
(see `python -m oracle.seed --help`).

The browser only talks to the web app: Next.js proxies `/v1/*` and `/healthz` to the
API (`next.config.ts`), so the session cookie is same-origin and needs no CORS.

### First run (about 5 minutes)

The `oracle` CLI is the agent track's side of the loop; run it from `api/`.

```sh
make up && make seed                     # 1. start, seed; note the password and token
cd api && uv sync
export ORACLE_API_TOKEN=<token>           #    the token make seed printed
uv run oracle push tests/fixtures/prd_v1.md       # 2. push a draft -> "Imported checkout-redesign version 1"
```

3. Open http://localhost:3000, sign in as `admin@example.com`, open *Checkout redesign
   PRD*, version 1.
4. Review: select some text in *5.2 Shipping step* and click *Comment*; on *3. Users*
   click *Approve* then *Save*; on *6. Success metrics* click *Request changes*, write
   a note, *Save*.
5. Pull the feedback package, as the agent track would before writing the next draft:

   ```sh
   uv run oracle pull checkout-redesign --version 1 --out /tmp/oracle
   # -> 2 open item(s), 1 locked section(s) (users); see /tmp/oracle/*.open-items.json
   ```

6. Push v2: copy `tests/fixtures/prd_v2.md`, replace the two `feedback_id` values under
   `resolutions:` with the `id`s from `checkout-redesign-v1.open-items.json`, then
   `uv run oracle push /tmp/oracle/prd_v2.md`.
7. In the UI, open version 2: *Compare with v1* shows the diff; the *Resolutions* tab
   shows how each item was handled.
8. *Approve version*, *Confirm*, then *Export PDF* (or HTML / MD).

Other targets:

| Target | Does |
|--------|------|
| `make down` | stop the stack |
| `make migrate` | `alembic upgrade head` inside the api container |
| `make test` | API tests against the compose Postgres (`oracle_test` database, wiped by the tests) |
| `make lint` | ruff (check + format) and eslint |
| `make openapi` | regenerate `web/lib/api/openapi.json` and `schema.d.ts`; commit both |
| `make e2e` | the end-to-end Playwright spec against the real stack (below) |
| `make e2e-mock` | the UI Playwright suite against the in-browser mock API |

Without Docker for the apps: start only Postgres (`docker compose up -d postgres`), then

```sh
cd api && uv sync && uv run alembic upgrade head && uv run python -m oracle.seed
uv run uvicorn oracle.main:app --reload          # :8000
cd web && npm ci && npm run dev                  # :3000, proxies /v1/* to :8000
```

### End-to-end test

`make e2e` runs `web/e2e/real/feedback-loop.spec.ts` against the real stack: push v1
with `oracle push`, comment and give two verdicts in the UI, `oracle pull` and check the
open items and the locked section, push v2 with resolutions for both items, check the
diff and the resolution report, approve v2 and export a PDF. Playwright
(`web/playwright.real.config.ts`) starts:

- the API on :8100 against `oracle_e2e`, which `web/e2e/real/reset_stack.py` drops,
  recreates, migrates and seeds on every run (override with `E2E_DATABASE_URL`);
- a production web build (`web/.next-e2e`) on :3200 that proxies to that API.

It needs a Postgres 16 on localhost:5432 with the compose credentials; `make e2e` starts
the compose one (`make e2e E2E_POSTGRES=` if you already run one), the API's PDF
dependencies (Pango, see `api/Dockerfile`) and Chromium (`cd web && npx playwright
install chromium`). Equivalent by hand:

```sh
docker compose up -d --wait postgres
cd api && uv sync && cd ../web && npm ci && npx playwright install chromium
npx playwright test -c playwright.real.config.ts
```

Settings are environment variables with the `ORACLE_` prefix (see
`api/oracle/config.py`): `ORACLE_DATABASE_URL`, `ORACLE_SECRET_KEY` (signs the session
cookie; set it outside local dev), `ORACLE_COOKIE_SECURE`, `ORACLE_CORS_ORIGINS`, `ORACLE_APP_URL`
(where people open the web app, default `ORACLE_PUBLIC_URL`, where the app and the API
share a host; exports turn a roadmap's links to its PRD's sections into absolute URLs
under it), and the `ORACLE_IAP_*` settings below.
The web app reads `API_INTERNAL_URL` (default `http://localhost:8000`) at build time.

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
