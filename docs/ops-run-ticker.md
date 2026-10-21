# Runbook: the run ticker

Decision W3 (docs/questions.md). SwarmCloud never calls Oracle back, so a run's finished
segment is only noticed when something ticks. A Cloud Scheduler job, `oracle-tick`, calls
`POST /internal/scheduler/tick` every minute with a Google ID token from the
`oracle-ticker` service account. One tick, for every company: advances its runs, sweeps its
Claude account pool and runs its queued built-in model jobs (what `POST /v1/internal/tick`
does for one company).
After a company's track monitoring, the tick also builds its weekly alignment report once
the scheduled moment has passed and makes the Slack posts that are due
(`docs/ops-slack-notifications.md`).

Placeholders: `$PROJECT` (the GCP project id), `$REGION` (the Cloud Scheduler region, e.g.
the API's Cloud Run region) and `$HOST` (the host people open Oracle at, behind the load
balancer). Use your own values; none are written here.

## What the endpoint accepts

- Only a Google ID token as the bearer credential of the `Authorization` header, signed
  by Google (RS256, checked against https://www.googleapis.com/oauth2/v3/certs, cached
  for an hour), issuer `https://accounts.google.com` or `accounts.google.com`, audience a single string equal
  to `ORACLE_TICKER_AUDIENCE` (a list audience is refused, even one that contains it),
  `email` exactly equal to `ORACLE_TICKER_SERVICE_ACCOUNT` (no case folding) with
  `email_verified` true, not expired (30 s leeway), and a lifetime (`exp - iat`) of at
  most an hour plus that leeway.
- Anything else is `401 {"detail": "Not authenticated"}`, whichever check failed (the API
  log says which, at DEBUG). API tokens, MCP OAuth tokens, session cookies and IAP
  assertions are all refused here, and the ID token opens no other endpoint.
- Google's certs unreachable (or an answer with no usable RS256 key) with none cached:
  `503`, and every request for the next 30 s is a `503` without another fetch. Either
  setting empty: `404`. (IAP sign-in shares the key cache code with a 5 s back-off, so one
  failed fetch on a cold instance does not refuse sign-ins for long.)
- The answer is counts only: companies ticked, failed and deferred; runs checked, segments
  finished, runs advanced and paused, run errors; the account sweep's counts; built-in
  jobs ran, succeeded, failed, retried; and `timed_out`. Errors are in the API log.
- Ticks never overlap: a Postgres advisory lock is held for the whole tick. A tick that
  finds it taken answers `200 {"skipped": "running"}`. First every company's runs and
  account sweep: no company is started after 45 s (the rest are `deferred` to the next
  minute; the order is random each tick). Then the built-in jobs of the companies ticked,
  one job per company in turn, so one company's backlog delays neither another's runs
  nor its jobs (`ORACLE_LLM_JOBS_MAX_PER_TICK=0` runs none). A tick is cut off after
  240 s.
- The Claude account sweep runs for a company only when its last sweep completed more
  than `ORACLE_CLAUDE_SWEEP_SECONDS` (300 s) ago (`claude_accounts.not_due` counts the
  others). Whatever that setting (`0` only turns the API's in-process sweep off), no
  sweep of a company starts within 300 s of the completion of its last one: the check
  is made again in the transaction that takes the company's sweep lease, so it holds
  for every entry point (this tick, `POST /v1/internal/tick`, `oracle tick`, the API's
  in-process sweep, an owner's "sweep now") across any number of API instances, and two
  callers that both found a company due sweep it once. Anthropic's usage endpoint
  allows about five calls per five minutes per account. `POST /v1/internal/tick` and
  `oracle tick` answer `claude_accounts.lease` `not_due` when not due, so a cron
  running `oracle tick` every minute sweeps no more often either. (A sweep whose process
  died mid-sweep records no completion: the next may start once its 120 s lease lapses.)
  A `429`
  from the usage endpoint is kept with its `retry-after` (at most an hour): no usage
  poll of that company starts before it, from any sweep.
- While both ticker settings are set, the API starts no in-process sweep task at all
  (whatever `ORACLE_CLAUDE_SWEEP_SECONDS`): the ticker sweeps, once for all instances.
- A built-in job is claimed only when a whole model call (`ORACLE_LLM_TIMEOUT_SECONDS`,
  plus 5 s) still fits before the 240 s cut-off, and its calls get that deadline: no
  account swap and no further call (a call can move to up to three accounts) starts unless
  a whole call still fits. Out of time before any call started, the job goes back to
  `queued` with its attempt given back; out of time after one had (no time to swap to
  another account), it fails transiently, which counts as an attempt. The default
  timeout, 180 s, fits with a minute to spare; over 235 s no job fits, and built-in jobs
  run only from the API's background worker (`ORACLE_LLM_JOBS_WORKER_SECONDS`); the API
  logs a warning at startup when the ticker is configured and no call fits.
  `POST /v1/internal/tick` (so `oracle tick`) runs jobs inside the same 240 s, from the
  start of its request.
- The tick can still cut a job mid-call, when a call or the work around it overruns.
  Claude Code's process is then killed, and the account's hold given back once it is
  gone. If the API process itself dies (SIGKILL, out of memory), Claude Code dies with it
  on Linux (`PR_SET_PDEATHSIG`); anything else left over ends with the instance, and the
  sweep reclaims the account's hold once it expires. A job cut before any model call
  started goes back to `queued` with its attempt given back and nothing recorded as
  spent. A job cut after one started counts the attempt and records what is known (the
  account, any call that finished; not the cut call's usage, which never arrived): it
  goes back to `queued` once, then fails, so a job whose calls keep overrunning cannot
  hold the tick forever.
- It is not in the OpenAPI document, so it is no MCP tool and the web client never sees it.

## 1. The service account (no roles)

```sh
gcloud iam service-accounts create oracle-ticker \
  --project="$PROJECT" \
  --display-name="Oracle run ticker (Cloud Scheduler OIDC only)"
```

Grant it no roles: it only signs ID tokens, which Oracle checks itself. Cloud Scheduler's
service agent mints those tokens; projects that enabled the Cloud Scheduler API after
2019-03-19 already give it what it needs. Otherwise (a role on Google's agent, not on
`oracle-ticker`):

```sh
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:service-$PROJECT_NUMBER@gcp-sa-cloudscheduler.iam.gserviceaccount.com" \
  --role="roles/cloudscheduler.serviceAgent"
```

Whoever creates the job needs `iam.serviceAccounts.actAs` on `oracle-ticker` (Service
Account User on that one account, not the project).

Anyone who can mint an ID token as `oracle-ticker` can tick Oracle. That is not only
Service Account Token Creator and Service Account User: Owner, Editor, custom roles and
bindings on the folder or organization above the project can carry the same permissions.
Ask Policy Analyzer who holds any of them on the `oracle-ticker` account, through any
role at any level:

```sh
gcloud asset analyze-iam-policy \
  --project="$PROJECT" \
  --full-resource-name="//iam.googleapis.com/projects/$PROJECT/serviceAccounts/oracle-ticker@$PROJECT.iam.gserviceaccount.com" \
  --permissions="iam.serviceAccounts.getOpenIdToken,iam.serviceAccounts.actAs,iam.serviceAccounts.signJwt,iam.serviceAccounts.implicitDelegation" \
  --expand-groups --expand-roles --output-group-edges
```

(Policy Analyzer needs the Cloud Asset API enabled and `cloudasset.assets.analyzeIamPolicy`
for whoever runs it. To include bindings on the folder or organization above the project,
run it with `--organization=<ORG_ID>` or `--folder=<FOLDER_ID>` in place of `--project`.)

The answer should name only Cloud Scheduler's service agent and the people who manage the
Cloud Scheduler job (they need `actAs`). Anyone else, a person, a group or a workload,
holding one of these through a project-level, folder-level or organization-level role
(Owner, Editor, Service Account Token Creator, Service Account User, or a custom role)
can tick Oracle: move that grant to the single service accounts it was meant for, or
remove the permission from the custom role.

## 2. The API settings

Set both on the API's Cloud Run service (beside the other `ORACLE_*` settings), then
deploy a new revision:

| Setting | Value |
|---|---|
| `ORACLE_TICKER_AUDIENCE` | `https://$HOST/internal/scheduler/tick` |
| `ORACLE_TICKER_SERVICE_ACCOUNT` | `oracle-ticker@$PROJECT.iam.gserviceaccount.com` |

The audience must match the job's `--oidc-token-audience` character for character. Unset
either one and the endpoint is a 404.

Two more requirements of the API service, which the tick depends on:

- **A session-mode database connection.** The no-overlap lock is a session-level
  Postgres advisory lock (`pg_try_advisory_lock`), taken and released on one connection
  across several transactions. `ORACLE_DATABASE_URL` must reach Postgres directly or
  through a session-mode pooler; a transaction-mode pooler (PgBouncer
  `pool_mode=transaction`, or a provider's "transaction" pooler port) can hand the lock's
  session to another client, so ticks could overlap or the lock never be released.
- **A request timeout of at least 300 s.** The tick runs for up to 240 s; Cloud Run's
  request timeout on the API service must stay at least 300 s (its default), or Cloud Run
  ends the request first and cuts off whatever is running, a model call included.

## 3. The load balancer's public path rule

The IAP backend would refuse Cloud Scheduler (it has no IAP identity), so the tick goes to
the public backend, like `/mcp`, `/oauth/{register,token,revoke}` and `/.well-known/*`.
Add `/internal/scheduler/tick` (exact path, no wildcard) to the path rule that sends those
to the public (no-IAP) backend service, in the URL map's path matcher for `$HOST`:

```sh
gcloud compute url-maps export <URL_MAP> --project="$PROJECT" --destination=url-map.yaml
# In the path matcher for $HOST, add to the pathRule whose service is the public backend:
#   paths:
#   - /internal/scheduler/tick
gcloud compute url-maps import <URL_MAP> --project="$PROJECT" --source=url-map.yaml
```

Only this one path: `/internal/*` as a whole must stay behind IAP. Check from outside:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$HOST/internal/scheduler/tick"
# 401 from Oracle (not a Google sign-in redirect or an IAP 403) means the rule works;
# 404 means the settings are not set on the running revision.
```

## 4. The Cloud Scheduler job

```sh
gcloud scheduler jobs create http oracle-tick \
  --project="$PROJECT" \
  --location="$REGION" \
  --schedule="* * * * *" \
  --time-zone="Etc/UTC" \
  --http-method=POST \
  --uri="https://$HOST/internal/scheduler/tick" \
  --oidc-service-account-email="oracle-ticker@$PROJECT.iam.gserviceaccount.com" \
  --oidc-token-audience="https://$HOST/internal/scheduler/tick" \
  --attempt-deadline=300s \
  --max-retry-attempts=1
```

The API stays at zero minimum instances: each tick wakes it. Check the first runs:

```sh
gcloud scheduler jobs run oracle-tick --project="$PROJECT" --location="$REGION"
gcloud scheduler jobs describe oracle-tick --project="$PROJECT" --location="$REGION" \
  --format='value(state,lastAttemptTime,status)'
```

An empty `status` is success. In the API's logs, the request is a 200 whose body has
`companies.ticked`; a `{"skipped": "running"}` now and then only means a tick ran past a
minute.

## 5. Pause and resume

```sh
gcloud scheduler jobs pause oracle-tick --project="$PROJECT" --location="$REGION"
gcloud scheduler jobs resume oracle-tick --project="$PROJECT" --location="$REGION"
```

While paused, runs wait where they are (nothing is lost; the next tick picks them up), and
an owner or an API token can still tick by hand with `oracle tick`. To turn the endpoint
off as well, unset `ORACLE_TICKER_AUDIENCE` (it answers 404).

## Troubleshooting

| Seen | Cause |
|---|---|
| 401 every minute | Audience differs from `ORACLE_TICKER_AUDIENCE` (scheme, host, path, trailing slash), or the job uses another service account. The API log's DEBUG line names the check. |
| 404 | A setting is unset on the running revision. |
| 503 | The API cannot reach www.googleapis.com for Google's certs, or the answer had no usable key (after a failure, retried every 30 s). |
| `llm_jobs.ran` always 0 while jobs wait | `ORACLE_LLM_TIMEOUT_SECONDS` is over 235: no model call fits in a tick (see above; the API logs a warning at startup). |
| `{"skipped": "running"}` every minute | A tick never released the lock: check the database URL is session-mode (see step 2). |
| 302 or IAP 403 | The path rule is missing: the request went to the IAP backend. |
| A job `failed` with "cut off by the caller's time limit" | Its model calls kept running past the tick's 240 s cut-off twice: lower `ORACLE_LLM_TIMEOUT_SECONDS`, or let the background worker run it. |
| `companies.failed` > 0 | One company's runs, sweep or jobs raised; the API log has the traceback. Others still ticked. |
