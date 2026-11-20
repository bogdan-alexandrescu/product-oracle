# Deploying from GitHub Actions (runbook draft, #1569)

The owner decided (Nov 20): Oracle deploys to Cloud Run, the services `oracle-api` and
`oracle-web` as today, from the `deploy` job of `.github/workflows/ci.yml`. The job is **off**
until the steps below are applied and the repository variable `ORACLE_DEPLOY_ENABLED` is set
to `true`. It holds no key and no secret: it signs in with the job's GitHub OIDC token
(Workload Identity Federation) as one deploy service account with the least IAM below.

Names in angle brackets are placeholders; nothing here names real infrastructure.

## What the job does

On a push to `main`, after every test job of the workflow has passed (`needs:` lists them all;
`api/tests/test_deploy_workflow.py` fails when one is missing):

1. **Already served?** `web/scripts/deploy-serves.ts` asks both `/version` routes. Exit 0 (the
   serving commit contains this one: a newer run deployed first) skips the rest, so a slow run
   never rolls the services back.
2. **Build and push** `oracle-api` and `oracle-web` to Artifact Registry, tagged with the
   commit, built with `--build-arg GIT_SHA=<commit>`; deployed by digest.
3. **Back up** the Cloud SQL instance (`gcloud sql backups create`, waits for it).
4. **Stage** the API: `gcloud run deploy oracle-api --no-traffic --tag c-<commit>` with
   `ORACLE_MIGRATE_AT_START=0`. The new revision starts and passes its start probe but serves
   no one; it does not migrate (`api/oracle/startup.py`).
5. **Migrate**: the Cloud Run job `oracle-api-migrate` is pointed at the new image and run
   with `--wait`: `python -m oracle.startup migrate` brings the database to head and exits.
   If it fails, the job stops here: **no traffic has moved**. Alembic runs every pending
   revision in one transaction, so the database is still on the old schema the serving
   revision reads; the staged revision never takes traffic.
6. **Move the API's traffic** to the staged revision (`update-traffic --to-latest`), then drop
   its tag.
7. **Deploy the web** (`gcloud run deploy oracle-web`; traffic moves once the revision starts).
8. **Containment check**: `deploy-serves.ts <commit> <api version url> <web version url>
   --wait 300`. Exit 0 served, 1 not served, 2 could not ask; anything but 0 fails the job.

### Why the API is staged before the migration (Oct 18)

On Oct 18 the cloud database was migrated before the new image was live, and the serving
image could not read the new schema: a 503. Here the new image is already deployed, started
and warm (step 4) before the schema changes (step 5), and traffic moves to it in one
`update-traffic` call right after (step 6): the old revision serves the new schema only for
that call, not for a cold start of the new image. A failed migration leaves the old revision
on the old schema. The staged revision never migrates itself (`ORACLE_MIGRATE_AT_START=0`), so
only step 5 changes the schema.

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
| `ORACLE_WIF_PROVIDER` | `projects/<project-number>/locations/global/workloadIdentityPools/github/providers/oracle-main` | the provider below |
| `ORACLE_DEPLOY_SERVICE_ACCOUNT` | `oracle-deploy@<project-id>.iam.gserviceaccount.com` | the deploy identity |
| `ORACLE_SQL_INSTANCE` | `<instance>` | the Cloud SQL instance to back up |
| `ORACLE_API_INTERNAL_URL` | `https://oracle-api-<hash>-<region-code>.a.run.app` | the web image's `/v1` proxy target (as the manual deploy builds it today) |
| `ORACLE_API_VERSION_URL` | `https://<host>/...` | the API's `/version`, reachable from GitHub's runners |
| `ORACLE_WEB_VERSION_URL` | `https://<host>/version` | the web's `/version`, reachable from GitHub's runners |
| `ORACLE_API_SERVICE`, `ORACLE_WEB_SERVICE`, `ORACLE_MIGRATE_JOB` | | optional; default `oracle-api`, `oracle-web`, `oracle-api-migrate` |

The two version URLs must answer without IAP (the app's load balancer puts IAP in front of
the web): see the open question in the pull request.

## IAM runbook

Run once, as a project owner. `<repo>` is `<owner>/<name>` of this GitHub repository.

### 1. The identity and its federation

```sh
gcloud iam service-accounts create oracle-deploy --project=<project-id> \
  --display-name="Oracle deploy from GitHub Actions"

gcloud iam workload-identity-pools create github --project=<project-id> --location=global
# Only this repository's main branch, and only its CI workflow, can sign in.
gcloud iam workload-identity-pools providers create-oidc oracle-main --project=<project-id> \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping=google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref \
  --attribute-condition="assertion.repository == '<repo>' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref.startsWith('<repo>/.github/workflows/ci.yml@')"

gcloud iam service-accounts add-iam-policy-binding \
  oracle-deploy@<project-id>.iam.gserviceaccount.com --project=<project-id> \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/<project-number>/locations/global/workloadIdentityPools/github/attribute.repository/<repo>"
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

gcloud iam roles create oracleSqlBackup --project=<project-id> \
  --title="Oracle SQL backup" \
  --permissions=cloudsql.backupRuns.create,cloudsql.backupRuns.get,cloudsql.instances.get
gcloud projects add-iam-policy-binding <project-id> --member="$SA" \
  --role=projects/<project-id>/roles/oracleSqlBackup \
  --condition='expression=resource.name == "projects/<project-id>/instances/<instance>",title=oracle-instance-only'
```

To check before turning the job on: `gcloud run deploy` waits on the service's operation; if
it is refused `run.operations.get`, grant `roles/run.viewer` on the same two services (not the
project).

### 3. The migrate job

Created once, by hand, with the same runtime service account, Cloud SQL connection,
environment and secrets as `oracle-api` (copy them from `gcloud run services describe
oracle-api`); the deploy job only changes its image:

```sh
gcloud run jobs create oracle-api-migrate --project=<project-id> --region=<region> \
  --image=<the image oracle-api serves now> \
  --service-account=<api-runtime-sa> \
  --set-cloudsql-instances=<project-id>:<region>:<instance> \
  --set-env-vars=<as oracle-api> --set-secrets=<as oracle-api> \
  --command=python --args=-m,oracle.startup,migrate \
  --tasks=1 --max-retries=0 --task-timeout=15m

gcloud run jobs add-iam-policy-binding oracle-api-migrate --project=<project-id> \
  --region=<region> --member="$SA" --role=roles/run.developer
```

### 4. Turn it on

Set the variables above, then `ORACLE_DEPLOY_ENABLED=true`. The first run after that deploys
the head of `main`. To turn it off at once, set `ORACLE_DEPLOY_ENABLED` to anything else.

## Rolling back

Move the traffic back to the previous revision (`gcloud run services update-traffic
oracle-api --to-revisions=<revision>=100`, the same for `oracle-web`). A schema change is
rolled back from the backup the job took, or with the migration's own downgrade, by hand.
