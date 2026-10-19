# Runbook: the run ticker

Decision W3 (docs/questions.md). SwarmCloud never calls Oracle back, so a run's finished
segment is only noticed when something ticks. A Cloud Scheduler job, `oracle-tick`, calls
`POST /internal/scheduler/tick` every minute with a Google ID token from the
`oracle-ticker` service account. One tick, for every company: advances its runs, sweeps its
Claude account pool and runs its queued built-in model jobs (what `POST /v1/internal/tick`
does for one company).

Placeholders: `$PROJECT` (the GCP project id), `$REGION` (the Cloud Scheduler region, e.g.
the API's Cloud Run region) and `$HOST` (the host people open Oracle at, behind the load
balancer). Use your own values; none are written here.

## What the endpoint accepts

- Only a Google ID token as the bearer credential of the `Authorization` header, signed by Google (RS256, checked against
  https://www.googleapis.com/oauth2/v3/certs, cached for an hour), issuer
  `https://accounts.google.com` or `accounts.google.com`, audience equal to
  `ORACLE_TICKER_AUDIENCE`, `email` equal to `ORACLE_TICKER_SERVICE_ACCOUNT` with
  `email_verified` true, not expired (30 s leeway).
- Anything else is `401 {"detail": "Not authenticated"}`, whichever check failed (the API
  log says which, at INFO). API tokens, MCP OAuth tokens, session cookies and IAP
  assertions are all refused here, and the ID token opens no other endpoint.
- Google's certs unreachable with none cached: `503`. Either setting empty: `404`.
- The answer is counts only: companies ticked, failed and deferred; runs checked, segments
  finished, runs advanced and paused, run errors; the account sweep's counts; built-in
  jobs ran, succeeded, failed, retried; and `timed_out`. Errors are in the API log.
- Ticks never overlap: a Postgres advisory lock is held for the whole tick. A tick that
  finds it taken answers `200 {"skipped": "running"}`. No company is started after 45 s
  (the rest are `deferred` to the next minute; the order is random each tick), and a tick
  is cut off after 240 s.
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

## 2. The API settings

Set both on the API's Cloud Run service (beside the other `ORACLE_*` settings), then
deploy a new revision:

| Setting | Value |
|---|---|
| `ORACLE_TICKER_AUDIENCE` | `https://$HOST/internal/scheduler/tick` |
| `ORACLE_TICKER_SERVICE_ACCOUNT` | `oracle-ticker@$PROJECT.iam.gserviceaccount.com` |

The audience must match the job's `--oidc-token-audience` character for character. Unset
either one and the endpoint is a 404.

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
| 401 every minute | Audience differs from `ORACLE_TICKER_AUDIENCE` (scheme, host, path, trailing slash), or the job uses another service account. The API log's INFO line names the check. |
| 404 | A setting is unset on the running revision. |
| 503 | The API cannot reach www.googleapis.com for Google's certs. |
| 302 or IAP 403 | The path rule is missing: the request went to the IAP backend. |
| `companies.failed` > 0 | One company's runs, sweep or jobs raised; the API log has the traceback. Others still ticked. |
