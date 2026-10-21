# Runbook: Slack for notifications and the weekly alignment report

F6 Weekly alignment report. Every week Oracle reports the roadmap against engineering, for
every active or paused product track, to the owners' Inbox and to one Slack channel. It is
built on the run ticker (`docs/ops-run-ticker.md`), after track monitoring, with no model
call.

## Oracle's Slack app ("Slack poster", decided 2026-10-20)

Oracle posts through its own Slack app, installed once for the company by an owner in
Settings › Notifications › **Connect Slack for notifications**. It is the same Slack app
people sign in with for their own Slack connections (`ORACLE_OAUTH_SLACK_CLIENT_ID` and
`ORACLE_OAUTH_SLACK_CLIENT_SECRET`); without them, Connect answers "Slack sign-in for
notifications is not configured".

In the Slack app's settings:

- **Bot token scopes**: `chat:write`, `chat:write.public`, `channels:read` and
  `groups:read`, all required: Connect asks Slack for the four. `groups:read` lets the
  channel picker list the private channels the bot was invited to (invite it with
  `/invite @Product Oracle` in the channel first). An install made before `groups:read`
  was asked lists public channels only: Disconnect and Connect again.
- **Redirect URL**: `https://$HOST/v1/company-integrations/slack/callback`
  (`ORACLE_OAUTH_REDIRECT_BASE` is `https://$HOST`).

The bot token is the company's credential (`company_integrations`), encrypted with
`ORACLE_SECRET_KEY` and never returned by any endpoint, logged or audited. A second
Connect while one is installed is refused. **Disconnect** revokes the token at Slack
(`auth.revoke`) and deletes it, and clears the report's channel; people's own Slack
connections are not touched. Messages show as the app, "Product Oracle". Oracle calls
`slack.com` only, through the same guarded transport as public links.

## The weekly report

- Setting `alignment_report` (Settings › Notifications): enabled, day, time and time
  zone (Monday 08:00 America/Los_Angeles by default), and the Slack channel.
- Once that moment of the week has passed, the next tick builds the report for the week
  that just ended (Monday 00:00 to Monday 00:00 local). One weekly report per company and
  week: a unique index makes a second impossible. A company with no active or paused track
  gets none. A track Oracle cannot read is named in the report and logged; the others stand.
- The Slack post follows at once. A failure is retried after 1, 5, 15 and 60 minutes, then
  hourly, for 24 hours (Slack's `ratelimited` waits for its `Retry-After`); after that the
  owners' Inbox shows "Report not posted to Slack" with Retry and Dismiss.
- Owners can **Generate now** on Plan › Alignment reports: the week so far, posted to Slack
  only with "Post to Slack" ticked.

## Rollback

Disconnect Slack in Settings › Notifications first (that revokes the token at Slack), then
revert and downgrade: the downgrade of `0020_alignment_reports` refuses while an install is
stored. The `alignment_report` setting stays harmlessly in `tenant_settings`.
