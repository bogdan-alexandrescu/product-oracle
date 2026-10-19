# Lane: the run ticker (W3)

One SwarmCloud `claude-code` task, strategy `direct-pr`, on main. It ships with the adapter v2
deploy.

## Prompt

THE RUN TICKER for Product Oracle (decision W3 in docs/questions.md, owner 2026-10-19; read it first, then api/oracle/auth/ (deps.py, iap.py), api/oracle/runs/router.py and service.py (tick), api/oracle/claude_accounts/sweep.py, api/oracle/llm/ (the job worker), api/oracle/tenancy.py and api/oracle/main.py).

Oracle's cloud runs only advance when something calls tick, and nothing does, because SwarmCloud never calls Oracle back. Build the endpoint that a Cloud Scheduler job calls every minute.

1. `POST /internal/scheduler/tick`, outside /v1 and excluded from OpenAPI, so no MCP tool is generated (like the OAuth endpoints).
2. Auth: `Authorization: Bearer <Google ID token>` only. Verify it yourself with PyJWT against Google's published certs (https://www.googleapis.com/oauth2/v3/certs, cached and refreshed, following how auth/iap.py fetches its keys):
   - the RS256 signature;
   - issuer `accounts.google.com` or `https://accounts.google.com`;
   - audience equal to ORACLE_TICKER_AUDIENCE;
   - `email` equal to ORACLE_TICKER_SERVICE_ACCOUNT, with `email_verified` true;
   - not expired, with a small leeway.
   Anything else is 401, with no detail about which check failed. Certs that cannot be fetched are 503. With either setting empty, the endpoint is 404 (disabled). This principal can call nothing else: it never becomes a user or a token principal.
3. Work: for every company (tenant), in its own tenant session, run what POST /v1/internal/tick runs (service.tick, the Claude account sweep and the queued built-in model jobs). One company's error never stops the others. Return only counts per kind, never ids or error text with secrets.
4. No overlap: the scheduler fires every minute, and a tick can take longer. Take a Postgres advisory lock; if it is held, answer 200 with `{"skipped": "running"}`. Bound the total time.
5. Settings documented beside the others in oracle/config.py (ORACLE_TICKER_AUDIENCE, ORACLE_TICKER_SERVICE_ACCOUNT).
6. Tests (tests first; a locally generated RSA key with the cert fetch monkeypatched):
   - a valid token ticks, and a run waiting on the fake runtime advances through this endpoint;
   - wrong audience, wrong email, unverified email, expired, wrong issuer, alg none or HS256, a missing header, and an API token or OAuth token instead of an ID token are all refused;
   - disabled when unset;
   - an overlapping tick is skipped;
   - the endpoint is not in OpenAPI.
7. docs/ops-run-ticker.md: the runbook, with $PROJECT, $REGION and $HOST placeholders and no real ids:
   - create the oracle-ticker service account (no roles);
   - the Cloud Scheduler job (`* * * * *`, POST, OIDC token from that account, audience = https://$HOST/internal/scheduler/tick, retries 1);
   - add /internal/scheduler/tick to the load balancer's public path rule (the IAP backend would refuse it);
   - the two settings;
   - how to pause the job.
Never touch .github/, deployment files or private/. Run the full API suite, ruff, make openapi (confirm no change), web lint, tsc and build. Commit, and write $SWARM_ARTIFACTS_DIR/run-ticker-report.md.
