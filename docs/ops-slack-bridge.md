# Slack bridge (G8): mirroring discussions to Slack threads

An open discussion can be mirrored to a thread in a Slack channel through Oracle's Slack
app, the same company install that posts the weekly alignment report
(`docs/ops-slack-notifications.md`). Oracle posts the root message and every new message
through an outbox that the run ticker delivers (`docs/ops-run-ticker.md`). Slack sends
replies in those threads to a public events endpoint, signed with the app's signing secret.

## 1. The Slack app

In Oracle's Slack app (api.slack.com › Your apps):

- **OAuth & Permissions › Bot Token Scopes:** `chat:write`, `chat:write.public`,
  `channels:read`, `groups:read`, `users:read`, `users:read.email`, `channels:history`,
  `groups:history`. The history scopes are what Slack requires to deliver the message events
  below. An install made with the alignment report's scopes only shows "Reconnect Slack to
  allow mirroring discussions" on Settings › Notifications until an owner reconnects.
- **Redirect URL:** `https://$HOST/v1/company-integrations/slack/callback` (unchanged).
- **Event Subscriptions:** on, with the Request URL
  `https://$HOST/integrations/slack/events`. Slack checks it with a `url_verification`
  request, so deploy and add the path rule (section 3) first. Bot events:
  `message.channels`, `message.groups`. Oracle keeps only replies in the threads it started.
  It drops every other event before reading its text and stores only the event id.

## 2. The secret

The signing secret (Basic Information › App Credentials › Signing Secret) goes in Secret
Manager as `oracle-slack-signing-secret`, mounted on the API service as
`ORACLE_SLACK_SIGNING_SECRET`:

```sh
printf '%s' "$SIGNING_SECRET" | gcloud secrets create oracle-slack-signing-secret \
  --project="$PROJECT" --data-file=-
gcloud run services update oracle-api --project="$PROJECT" --region="$REGION" \
  --update-secrets=ORACLE_SLACK_SIGNING_SECRET=oracle-slack-signing-secret:latest
```

While it is empty, the endpoint refuses every request with 401.
`ORACLE_OAUTH_SLACK_CLIENT_ID` and `_SECRET` are reused.

## 3. The load balancer's public path rule

Slack has no IAP identity, so the events endpoint goes to the public backend, as the tick
does (`docs/ops-run-ticker.md` section 3). Back up the URL map first, then add
`/integrations/slack/events` (exact path, no wildcard) to the pathRule whose service is the
public backend:

```sh
gcloud compute url-maps export <URL_MAP> --project="$PROJECT" --destination=url-map.yaml
cp url-map.yaml url-map.backup.yaml
# In the path matcher for $HOST, add to the public backend's pathRule:
#   paths:
#   - /integrations/slack/events
gcloud compute url-maps import <URL_MAP> --project="$PROJECT" --source=url-map.yaml
```

## 4. Check

An unsigned POST is refused:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://$HOST/integrations/slack/events" \
  -H 'Content-Type: application/json' -d '{"type":"url_verification","challenge":"x"}'
# 401
```

## Rollback

1. Remove `/integrations/slack/events` from the path rule.
2. Revert the bridge. The down-migration drops `discussion_slack_links`, `slack_outbox`,
   `slack_events_seen`, `company_integrations.bot_user_id` and the two message columns.
   The install row stays.

Messages already posted stay in Slack. If the revert happens before Disconnect, uninstall
the app from Slack by hand.
