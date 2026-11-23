# Deploying from GitHub Actions (runbook draft, #1569)

The owner decided (Nov 20): Oracle deploys to Cloud Run, the services `oracle-api` and
`oracle-web` as today, from the `deploy` job of `.github/workflows/ci.yml`. The job is **off**
until the steps below are applied and the repository variable `ORACLE_DEPLOY_ENABLED` is set
to `true`. It holds no key and no secret: it signs in with the job's GitHub OIDC token
(Workload Identity Federation) as one deploy service account with the least IAM below. The
job runs as the GitHub environment `production`, which the federation requires.

Names in angle brackets are placeholders; nothing here names real infrastructure.

## What the job does

On a push to `main`, after every test job of the workflow has passed (`needs:` lists them all;
`api/tests/test_deploy_workflow.py` fails when one is missing):

1. **Already served?** `web/scripts/deploy-serves.ts` asks each `/version` route, with a
   Google ID token for that service's IAP audience (`gcloud auth print-identity-token`, sent
   as `Authorization: Bearer`; the script reads it from `ORACLE_VERSION_TOKEN`). A service
   that answers 0 (it serves a commit that contains this one: a newer run deployed it first)
   is left alone, so a slow run never rolls a service back.
2. **The serving API does not migrate at start?** `ops/deploy/serving-env.sh` reads
   `ORACLE_MIGRATE_AT_START` from every `oracle-api` revision that has traffic (not the
   latest one). Unless each has `0`, the job stops here with the reason, before the backup:
   such a revision would run Alembic itself when Cloud Run adds an instance during step 6.
3. **Build and push** `oracle-api` and `oracle-web` to Artifact Registry, tagged with the
   commit, built with `--build-arg GIT_SHA=<commit>`; deployed by digest.
4. **Back up** the Cloud SQL instance (`gcloud sql backups create`, waits for it).
5. **Stage** the API: `gcloud run deploy oracle-api --no-traffic --tag c-<commit>` with
   `ORACLE_MIGRATE_AT_START=0`. The new revision starts and passes its start probe but serves
   no one; it does not migrate (`api/oracle/startup.py`).
6. **Migrate**: the Cloud Run job `oracle-api-migrate` is pointed at the new image and run
   with `--wait`: `python -m oracle.startup migrate` brings the database to head and exits.
   If it fails, the job stops here: **no traffic has moved**. Alembic runs every pending
   revision in one transaction, so the database is still on the old schema the serving
   revision reads; the staged revision never takes traffic.
7. **Move the API's traffic** to the staged revision by its tag (`update-traffic
   --to-tags=c-<commit>=100`, never `--to-latest`: a revision someone created meanwhile would
   take the traffic), then remove the tag. A run that fails after staging removes its
   leftover tag in its last step (`if: failure()`); traffic stays where it was.
8. **Deploy the web** (`gcloud run deploy oracle-web`; traffic moves once the revision starts).
9. **Containment check**: `deploy-serves.ts <commit> <version url> --wait 300` for each
   service, with its ID token as in step 1. Exit 0 served, 1 not served, 2 could not ask;
   anything but 0 fails the job.

### Why the API is staged before the migration (Oct 18)

On Oct 18 the cloud database was migrated before the new image was live, and the serving
image could not read the new schema: a 503. Here the new image is already deployed, started
and warm (step 5) before the schema changes (step 6), and traffic moves to it in one
`update-traffic` call right after (step 7): the old revision serves the new schema only for
that call, not for a cold start of the new image. A failed migration leaves the old revision
on the old schema. The staged revision never migrates itself (`ORACLE_MIGRATE_AT_START=0`), so
only step 6 changes the schema.

Still true and not solved by the order: a migration that drops or renames something the old
image reads breaks the old revision for those seconds; such a change ships in two deploys
(expand, then contract). While staged, the new revision's background loops (scheduler, model
job worker) can run against the old schema if the service keeps CPU always allocated; with
Cloud Run's default (CPU only during requests) an unrouted revision gets no CPU for them.

## Repository variables

Set under Settings, Secrets and variables, Actions, **Variables** (none of them is a secret):

| Variable | Example | What |
| --- | --- | --- |
| `ORACLE_DEPLOY_ENABLED` | `true` | turns the job on; anything else keeps it off |
| `ORACLE_GCP_PROJECT` | `<project-id>` | the project |
| `ORACLE_GCP_REGION` | `<region>` | the Cloud Run region |
| `ORACLE_ARTIFACT_REGISTRY` | `<region>-docker.pkg.dev/<project-id>/<repository>` | where images go |
| `ORACLE_WIF_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/oracle-github/providers/oracle-main` | the provider below |
| `ORACLE_DEPLOY_SERVICE_ACCOUNT` | `oracle-deploy@<project-id>.iam.gserviceaccount.com` | the deploy identity |
| `ORACLE_SQL_INSTANCE` | `<instance>` | the Cloud SQL instance to back up |
| `ORACLE_API_VERSION_URL` | `https://<host>/...` | the API's `/version`, reachable from GitHub's runners |
| `ORACLE_WEB_VERSION_URL` | `https://<host>/version` | the web's `/version`, reachable from GitHub's runners |
| `ORACLE_IAP_AUDIENCE_API` | `<api-iap-oauth-client-id>` | the audience of the ID token sent to the API's `/version` |
| `ORACLE_IAP_AUDIENCE_WEB` | `<web-iap-oauth-client-id>` | the audience of the ID token sent to the web's `/version` |
| `ORACLE_API_SERVICE`, `ORACLE_WEB_SERVICE`, `ORACLE_MIGRATE_JOB` | | optional; default `oracle-api`, `oracle-web`, `oracle-api-migrate` |

IAP stays in front of both version URLs: the job asks them as the deploy service account
(IAM step 2 lets it through IAP and lets it mint its own ID token).

Create the GitHub environment `production` (Settings, Environments), with the deployment
branch rule "Selected branches: `main`". The job declares it, so its OIDC token carries
`environment: production`, which the provider's condition below requires.

## IAM runbook

Run once, as a project owner. `<repo>` is `<owner>/<name>` of this GitHub repository;
`<repository-id>` and `<owner-id>` are its numeric ids (`gh api repos/<repo> --jq
'.id, .owner.id'`), which unlike the names can not be taken over by a renamed or recreated
repository.

### 1. The identity and its federation

```sh
gcloud iam service-accounts create oracle-deploy --project=<project-id> \
  --display-name="Oracle deploy from GitHub Actions"

gcloud iam workload-identity-pools create oracle-github --project=<project-id> --location=global
# Only a push to this repository's main branch, in the environment production, running the CI
# workflow as it is on main, can sign in.
gcloud iam workload-identity-pools providers create-oidc oracle-main --project=<project-id> \
  --location=global --workload-identity-pool=oracle-github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.event_name=assertion.event_name,attribute.environment=assertion.environment,attribute.workflow_ref=assertion.workflow_ref \
  --attribute-condition="assertion.repository_id == '<repository-id>' && assertion.repository_owner_id == '<owner-id>' && assertion.ref == 'refs/heads/main' && assertion.event_name == 'push' && assertion.environment == 'production' && assertion.workflow_ref == '<repo>/.github/workflows/ci.yml@refs/heads/main'"

gcloud iam service-accounts add-iam-policy-binding \
  oracle-deploy@<project-id>.iam.gserviceaccount.com --project=<project-id> \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/oracle-github/attribute.repository_id/<repository-id>"
```

No key is created for the account; the job gets a token that lasts about an hour.

### 2. What the identity may do

Each grant is on the one resource it needs, never the project, except the Cloud SQL backup,
which Cloud SQL only grants at the project: there it is a custom role limited to one instance
by an IAM condition.

| Grant | On | Why |
| --- | --- | --- |
| `roles/artifactregistry.writer` | the repository `<repository>` | push the two images |
| `roles/run.developer` | the services `oracle-api`, `oracle-web` | deploy, stage, move traffic, tags |
| `roles/run.developer` | the job `oracle-api-migrate` | point it at the new image and run it |
| `roles/iam.serviceAccountUser` | the runtime service accounts of `oracle-api`, `oracle-web` (the migrate job runs as the API's) | deploy revisions that run as them |
| `roles/iam.serviceAccountOpenIdTokenCreator` | the account `oracle-deploy` itself | mint the ID tokens sent through IAP to each `/version` |
| `roles/iap.httpsResourceAccessor` | the IAP backend services of `oracle-api` and `oracle-web` | ask each `/version` through IAP |
| custom `oracleSqlBackup` (`cloudsql.backupRuns.create`, `cloudsql.backupRuns.get`, `cloudsql.instances.get`) | the project, condition `resource.name == "projects/<project-id>/instances/<instance>"` | the backup before the migration |

```sh
SA=serviceAccount:oracle-deploy@<project-id>.iam.gserviceaccount.com

gcloud artifacts repositories add-iam-policy-binding <repository> --project=<project-id> \
  --location=<region> --member="$SA" --role=roles/artifactregistry.writer

for s in oracle-api oracle-web; do
  gcloud run services add-iam-policy-binding "$s" --project=<project-id> --region=<region> \
    --member="$SA" --role=roles/run.developer
done

for runtime in <api-runtime-sa> <web-runtime-sa>; do
  gcloud iam service-accounts add-iam-policy-binding "$runtime" --project=<project-id> \
    --member="$SA" --role=roles/iam.serviceAccountUser
done

gcloud iam service-accounts add-iam-policy-binding \
  oracle-deploy@<project-id>.iam.gserviceaccount.com --project=<project-id> \
  --member="$SA" --role=roles/iam.serviceAccountOpenIdTokenCreator

for backend in <api-backend-service> <web-backend-service>; do
  gcloud iap web add-iam-policy-binding --project=<project-id> \
    --resource-type=backend-services --service="$backend" \
    --member="$SA" --role=roles/iap.httpsResourceAccessor
done

gcloud iam roles create oracleSqlBackup --project=<project-id> \
  --title="Oracle SQL backup" \
  --permissions=cloudsql.backupRuns.create,cloudsql.backupRuns.get,cloudsql.instances.get
gcloud projects add-iam-policy-binding <project-id> --member="$SA" \
  --role=projects/<project-id>/roles/oracleSqlBackup \
  --condition='expression=resource.name == "projects/<project-id>/instances/<instance>",title=oracle-instance-only'
```

To check before turning the job on (not verified against a project yet): `gcloud run deploy`
waits on the service's operation, and `gcloud run jobs execute --wait` reads the execution it
started; if either is refused (`run.operations.get`, `run.executions.get`), grant
`roles/run.viewer` on the same services and job (not the project). Likewise unverified:
`gcloud auth print-identity-token --impersonate-service-account=<deploy sa> --include-email`
from the federated sign-in, and IAP accepting that token on both backends.

### 3. The migrate job

Created once, by hand, with the API's runtime service account and Cloud SQL connection, and
only what a migration reads: the database URL secret, nothing else of `oracle-api`'s
environment or secrets (`python -m oracle.startup migrate` reads only
`ORACLE_DATABASE_URL`), and 1Gi of memory. The deploy job only changes its image:

```sh
gcloud run jobs create oracle-api-migrate --project=<project-id> --region=<region> \
  --image=<the image oracle-api serves now> \
  --service-account=<api-runtime-sa> \
  --set-cloudsql-instances=<project-id>:<region>:<instance> \
  --set-secrets=ORACLE_DATABASE_URL=<database-url-secret>:latest --memory=1Gi \
  --command=python --args=-m,oracle.startup,migrate \
  --tasks=1 --max-retries=0 --task-timeout=15m

gcloud run jobs add-iam-policy-binding oracle-api-migrate --project=<project-id> \
  --region=<region> --member="$SA" --role=roles/run.developer
```

### 4. Turn it on

Once, before the first run: keep the serving API from migrating at start, so an instance it
adds during a deploy's migration never runs Alembic itself:

```sh
gcloud run services update oracle-api --project=<project-id> --region=<region> \
  --update-env-vars=ORACLE_MIGRATE_AT_START=0
```

Set the variables above, then `ORACLE_DEPLOY_ENABLED=true`. The first run after that deploys
the head of `main`. To turn it off at once, set `ORACLE_DEPLOY_ENABLED` to anything else.

## Laptop deploys

Until the job is on, the API is deployed from a laptop through `ops/deploy/deploy-api.sh`
(the local scripts in `private/deploy/` call it with their values instead of running
`gcloud run deploy oracle-api` themselves). It reads `ORACLE_MIGRATE_AT_START` from the
revision serving now and passes it through `--set-env-vars` (which replaces every variable),
so a laptop deploy never drops it; it deploys nothing when the serving revisions can not be
read or disagree, or when the value is given in its arguments. After deploying it moves the
traffic to the new revision (an Actions deploy leaves it on one revision, by tag). Once the
serving revision has `ORACLE_MIGRATE_AT_START=0` (Turn it on), a laptop deploy keeps `0` and
does not migrate, so set it only in the sitting that sets `ORACLE_DEPLOY_ENABLED=true`.

The variables are given as `NAME=value,...`, or, when a value holds a comma (a JSON list), in
gcloud's alternate-delimiter form `^<delim>^NAME=value<delim>...`, exactly as
`gcloud run deploy --set-env-vars` reads it. The string passes through unchanged, the kept
`ORACLE_MIGRATE_AT_START` appended with the same delimiter; other flags (`--set-secrets`, ...)
pass through too:

```sh
ORACLE_GCP_PROJECT=<project-id> ORACLE_GCP_REGION=<region> ops/deploy/deploy-api.sh <image> \
  '^##^ORACLE_ENV=prod##ORACLE_IAP_BACKENDS=["<backend-a>","<backend-b>"]##ORACLE_IAP_AUDIENCES=["/projects/<project-number>/global/backendServices/<backend-id>"]' \
  --set-secrets=<NAME>=<secret>:latest
# runs: gcloud run deploy oracle-api ... --set-env-vars='^##^...##ORACLE_MIGRATE_AT_START=<kept>' --set-secrets=...
```

`ORACLE_MIGRATE_AT_START` among the given variables is refused in either form, as is a `^`
with no closing `^` or an empty delimiter.

Once Actions deploys are on (`ORACLE_DEPLOY_ENABLED` is `true`, read with `gh`), or when `gh`
can not tell, laptop deploys are traffic-only: the script deploys no new revision and prints
the rollback, moving the traffic to an earlier revision.

## Rolling back

Move the traffic back to the previous revision (`gcloud run services update-traffic
oracle-api --to-revisions=<revision>=100`, the same for `oracle-web`); once Actions deploys are on, this is all a laptop does. A schema change is
rolled back from the backup the job took, or with the migration's own downgrade, by hand.
