#!/usr/bin/env bash
# The grants Oracle's runtime service account needs so invites reach the person (#242).
# The owner runs it once per project; every command is idempotent.
#
#   ops/invite-access-grants.sh <project-id> <runtime-service-account-email> <backend-service>...
#
# - roles/iap.admin on each named IAP backend service (Oracle's two, and only those), so
#   an invite can grant (and a revoke take away) roles/iap.httpsResourceAccessor;
# - roles/iam.serviceAccountTokenCreator on the service account itself, so it can
#   signJwt the delegated Gmail token with no key file.
# Then a Google Workspace admin grants the printed client id domain-wide delegation for
# https://www.googleapis.com/auth/gmail.send (Admin console > Security > API controls).
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <project-id> <runtime-service-account-email> <backend-service>..." >&2
  exit 2
fi
project="$1"
sa="$2"
shift 2

for backend in "$@"; do
  gcloud iap web add-iam-policy-binding \
    --project="$project" \
    --resource-type=backend-services \
    --service="$backend" \
    --member="serviceAccount:$sa" \
    --role=roles/iap.admin
done

gcloud iam service-accounts add-iam-policy-binding "$sa" \
  --project="$project" \
  --member="serviceAccount:$sa" \
  --role=roles/iam.serviceAccountTokenCreator

client_id="$(gcloud iam service-accounts describe "$sa" --project="$project" --format='value(oauth2ClientId)')"
echo "Domain-wide delegation (a Workspace admin grants it):"
echo "  client id: $client_id"
echo "  scope:     https://www.googleapis.com/auth/gmail.send"
