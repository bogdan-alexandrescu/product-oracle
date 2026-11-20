#!/usr/bin/env bash
# #1569: one environment variable of the revisions a Cloud Run service serves now (the ones
# with traffic), not of its latest revision. Read-only; needs gcloud and jq.
#
#   ORACLE_GCP_PROJECT=<project-id> ORACLE_GCP_REGION=<region> ops/deploy/serving-env.sh <service> <name>
#
# Prints the value and exits 0 when every serving revision sets it to the same value; prints
# nothing and exits 0 when none sets it. Exits 1 when the serving revisions disagree (one sets
# it, another does not, or two values), 2 when the service or a revision could not be read.
# Used by ops/deploy/deploy-api.sh and the deploy job of .github/workflows/ci.yml.
set -uo pipefail
service=${1:?usage: serving-env.sh <service> <name>}
name=${2:?usage: serving-env.sh <service> <name>}
where=()
[ -n "${ORACLE_GCP_PROJECT:-}" ] && where+=(--project="$ORACLE_GCP_PROJECT")
[ -n "${ORACLE_GCP_REGION:-}" ] && where+=(--region="$ORACLE_GCP_REGION")

if ! described=$(gcloud run services describe "$service" "${where[@]}" --format=json) ||
  ! revisions=$(jq -er '[.status.traffic[]? | select((.percent // 0) > 0) | .revisionName] | unique | if length == 0 then error("no traffic") else .[] end' <<<"$described"); then
  echo "Could not read which revisions of $service serve now." >&2
  exit 2
fi

values=()
for rev in $revisions; do
  if ! r=$(gcloud run revisions describe "$rev" "${where[@]}" --format=json) ||
    ! v=$(jq -er --arg n "$name" '[.spec.containers[0].env[]? | select(.name == $n)] | if length == 0 then "unset" else "set:" + (.[0].value // "") end' <<<"$r"); then
    echo "Could not read the revision $rev of $service." >&2
    exit 2
  fi
  echo "$rev: $name ${v#set:}" >&2
  values+=("$v")
done

first=${values[0]}
for v in "${values[@]}"; do
  if [ "$v" != "$first" ]; then
    echo "The revisions serving $service do not agree on $name." >&2
    exit 1
  fi
done
[ "$first" = unset ] || echo "${first#set:}"
