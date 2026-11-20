#!/usr/bin/env bash
# #1569: a laptop deploy of oracle-api, while the deploy job of .github/workflows/ci.yml is
# off. The local scripts (private/deploy/, which name the real project) call this with their
# values instead of running gcloud run deploy themselves. Needs gcloud, gh and jq.
#
#   ORACLE_GCP_PROJECT=<project-id> ORACLE_GCP_REGION=<region> \
#     ops/deploy/deploy-api.sh <image> <NAME=value,...> [more gcloud run deploy flags]
#
# - Once Actions deploys are on (the repository variable ORACLE_DEPLOY_ENABLED is 'true'), or
#   when gh can not tell, it deploys nothing and prints the traffic-only rollback: main is
#   deployed by the job, and a laptop only moves traffic back to an earlier revision.
# - --set-env-vars replaces every variable, so ORACLE_MIGRATE_AT_START is read from the
#   revision serving now and passed through with the same value (never dropped: a revision
#   without it migrates at start). It is never taken from the arguments. With 0 (set when the
#   job is turned on) the new revision does not migrate either.
# - The traffic then moves to the new revision. When the serving
#   revisions can not be read, or disagree, it deploys nothing.
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

case ",$env_vars" in
  ,^*)
    echo "Give the variables as NAME=value,...; the ^delimiter^ form is not read here."
    exit 2
    ;;
  *,ORACLE_MIGRATE_AT_START=*)
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
  env_vars="$env_vars,ORACLE_MIGRATE_AT_START=$keep"
fi

gcloud run deploy "$service" --image="$image" --project="$project" --region="$region" \
  --set-env-vars="$env_vars" "$@" || exit
# An Actions deploy leaves the traffic on one revision (by its tag), and a new revision then
# takes none: move it to the one just deployed.
exec gcloud run services update-traffic "$service" --project="$project" --region="$region" --to-latest
