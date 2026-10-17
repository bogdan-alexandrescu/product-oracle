#!/bin/sh
# Started by playwright.real.config.ts: fresh E2E database, then the API in the foreground.
set -eu
cd "$(dirname "$0")/../../../api"
uv run python ../web/e2e/real/reset_stack.py
exec uv run uvicorn oracle.main:app --host 127.0.0.1 --port "${E2E_API_PORT:-8100}"
