.PHONY: up down logs test lint fmt migrate seed openapi web-build e2e e2e-mock

COMPOSE ?= docker compose
# Tests need a Postgres; `make up` provides one with an oracle_test database.
TEST_DATABASE_URL ?= postgresql+asyncpg://oracle:oracle@localhost:5432/oracle_test

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

test:
	cd api && ORACLE_TEST_DATABASE_URL=$(TEST_DATABASE_URL) uv run pytest

lint:
	cd api && uv run ruff check . && uv run ruff format --check .
	cd web && npm run lint

fmt:
	cd api && uv run ruff check --fix . && uv run ruff format .

migrate:
	$(COMPOSE) exec api alembic upgrade head

# Creates the tenant, the admin user and a new API token (printed once).
# Pass ARGS="--email you@example.com --password ..." to choose credentials.
seed:
	$(COMPOSE) exec api python -m oracle.seed $(ARGS)

# Dumps the OpenAPI document and regenerates the web client types. Commit both files.
openapi:
	cd api && uv run python -m oracle.openapi ../web/lib/api/openapi.json
	cd web && npx openapi-typescript lib/api/openapi.json -o lib/api/schema.d.ts

web-build:
	cd web && npm run build

# End-to-end against the real stack: Postgres (compose), the API on :8100 with a fresh
# oracle_e2e database (dropped on every run), and a production web build on :3200.
# Already running a Postgres 16 on localhost:5432? `make e2e E2E_POSTGRES=`.
E2E_POSTGRES ?= $(COMPOSE) up -d --wait postgres

e2e:
	$(E2E_POSTGRES)
	cd api && uv sync --frozen
	cd web && npx playwright test -c playwright.real.config.ts

# The UI suite against the in-browser mock API (no backend needed).
e2e-mock:
	cd web && npx playwright test
