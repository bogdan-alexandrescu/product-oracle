#!/usr/bin/env bash
# #1569: a laptop deploy of oracle-api, while the deploy job of .github/workflows/ci.yml is
# off. The local scripts (private/deploy/, which name the real project) call this with their
# values instead of running gcloud run deploy themselves. Needs gcloud, gh and jq.
#
#   ORACLE_GCP_PROJECT=<project-id> ORACLE_GCP_REGION=<region> \
#     ops/deploy/deploy-api.sh <image> <NAME=value,...> [more gcloud run deploy flags]
#
# The variables may also be given as gcloud does, ^<delim>^NAME=value<delim>..., for values
# that hold commas (for example '^##^ORACLE_IAP_BACKENDS=["a-be","b-be"]##ORACLE_ENV=prod').
#
# - Once Actions deploys are on (the repository variable ORACLE_DEPLOY_ENABLED is 'true'), or
#   when gh can not tell, it deploys nothing and prints the traffic-only rollback: main is
#   deployed by the job, and a laptop only moves traffic back to an earlier revision.
# - --set-env-vars replaces every variable, so ORACLE_MIGRATE_AT_START is read from the
#   revision serving now and passed through with the same value (never dropped: a revision
#   without it migrates at start). It is never taken from the arguments.
# - Without 0 the traffic then moves to the new revision, which migrates at start. With 0 (set
#   when the job is turned on, and kept when it is turned off) the new revision is staged with
#   no traffic, the migrate job (ORACLE_MIGRATE_JOB, default oracle-api-migrate) runs on its
#   image, and only then does the traffic move to it. When the serving revisions can not be
#   read, or disagree, it deploys nothing.
set -uo pipefail
image=${1:?usage: deploy-api.sh <image> <NAME=value,...> [gcloud run deploy flags]}
env_vars=${2:?usage: deploy-api.sh <image> <NAME=value,...> [gcloud run deploy flags]}
shift 2
service=${ORACLE_API_SERVICE:-oracle-api}
project=${ORACLE_GCP_PROJECT:?set ORACLE_GCP_PROJECT}
region=${ORACLE_GCP_REGION:?set ORACLE_GCP_REGION}
here=$(cd "$(dirname "$0")" && pwd)

rollback() {
  echo "To roll back, move the traffic to an earlier revision:"
  echo "  gcloud run revisions list --service=$service --project=$project --region=$region"
  echo "  gcloud run services update-traffic $service --project=$project --region=$region --to-revisions=<revision>=100"
}

if ! enabled=$(cd "$here" && gh variable list --json name,value --jq '.[] | select(.name == "ORACLE_DEPLOY_ENABLED") | .value'); then
  echo "Could not read the repository variable ORACLE_DEPLOY_ENABLED (gh), so this deploys nothing."
  rollback
  exit 2
fi
if [ "$enabled" = true ]; then
  echo "Actions deploys are on (ORACLE_DEPLOY_ENABLED is true): main is deployed by .github/workflows/ci.yml, so this deploys nothing."
  rollback
  exit 1
fi

# gcloud's alternate-delimiter form, ^<delim>^NAME=value<delim>..., is read as gcloud reads it
# (for values with commas, such as a JSON list) and passed through unchanged.
delim=,
list=$env_vars
if [ "${env_vars:0:1}" = "^" ]; then
  rest=${env_vars:1}
  delim=${rest%%^*}
  if [ "$delim" = "$rest" ] || [ -z "$delim" ]; then
    echo "Give the variables as NAME=value,... or ^<delimiter>^NAME=value<delimiter>..."
    exit 2
  fi
  list=${rest#*^}
fi
case "$delim$list" in
  *"${delim}ORACLE_MIGRATE_AT_START="*)
    echo "ORACLE_MIGRATE_AT_START is read from the serving revision; leave it out of the arguments."
    exit 2
    ;;
esac
code=0
keep=$(ORACLE_GCP_PROJECT=$project ORACLE_GCP_REGION=$region "$here/serving-env.sh" "$service" ORACLE_MIGRATE_AT_START) || code=$?
if [ "$code" != 0 ]; then
  echo "Could not keep ORACLE_MIGRATE_AT_START from the serving revision, so this deploys nothing."
  exit "$code"
fi
if [ -z "$keep" ]; then
  echo "The serving revision does not set ORACLE_MIGRATE_AT_START (it migrates at start); the new one does not either."
else
  echo "Keeping ORACLE_MIGRATE_AT_START=$keep from the serving revision."
  env_vars="$env_vars${delim}ORACLE_MIGRATE_AT_START=$keep"
fi

if [ "$keep" != 0 ]; then
  gcloud run deploy "$service" --image="$image" --project="$project" --region="$region" \
    --set-env-vars="$env_vars" "$@" || exit
  # An Actions deploy leaves the traffic on one revision (by its tag), and a new revision then
  # takes none: move it to the one just deployed.
  exec gcloud run services update-traffic "$service" --project="$project" --region="$region" --to-latest
fi

# #1709: with 0 the new revision never migrates itself, so do as the Actions job does: stage it
# with no traffic (by a tag), run the migrate job on its image, and only then move the traffic,
# by the tag (a revision created meanwhile never takes it). A failure moves no traffic.
job=${ORACLE_MIGRATE_JOB:-oracle-api-migrate}
tag="laptop-$(date -u +%Y%m%d%H%M%S)"
untag() {
  gcloud run services update-traffic "$service" --project="$project" --region="$region" \
    --remove-tags="$tag" --quiet
}
gcloud run deploy "$service" --image="$image" --project="$project" --region="$region" \
  --no-traffic --tag="$tag" --set-env-vars="$env_vars" "$@" || exit
echo "Staged with no traffic as $tag; migrating with the job $job on the new image."
if ! gcloud run jobs update "$job" --image="$image" --project="$project" --region="$region" \
  --command=python --args=-m,oracle.startup,migrate --max-retries=0 --quiet ||
  ! gcloud run jobs execute "$job" --project="$project" --region="$region" --wait --quiet; then
  echo "The migration failed: no traffic moved."
  untag
  rollback
  exit 1
fi
gcloud run services update-traffic "$service" --project="$project" --region="$region" \
  --to-tags="$tag=100" --quiet || exit
untag
