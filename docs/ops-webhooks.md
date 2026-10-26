# Outbound webhooks (I1): runbook

Oracle calls a company's own tools when a run, a draft or an approval changes. A webhook
is a name, an https URL, the event types it wants and a signing secret. Approvers manage
their own webhooks and owners every one (Settings › Webhooks; `/v1/webhooks`). Code:
`api/oracle/webhooks/` (registry `events.py`, capture `service.py`, fan-out `fanout.py`,
signing `sign.py`, sending `outbox.py`, log retention `retention.py`).

## Events and payload

The event types are the fixed registry `EVENT_TYPES` (`GET /v1/webhook-event-types`):

| Group | Types |
|---|---|
| Runs | `run.awaiting_approval`, `run.started`, `run.checkpoint_waiting`, `run.checkpoint_decided`, `run.checkpoint_voided`, `run.paused_overrun`, `run.resumed`, `run.succeeded`, `run.failed`, `run.cancelled` |
| Drafts | `draft.version_created`, `draft.in_review` |
| Approvals | `approval.version_approved`, `approval.approvals_invalidated`, `approval.version_published` |

**Send test event** posts a `webhook.test` event (`data: {"message": "Test from Product
Oracle"}`) to that webhook only.

Each call is a `POST` of UTF-8 JSON, at most 16 KB. The schema of each type is in the
OpenAPI document (`webhooks:` and `components.schemas.WebhookEvent_<type>`):

```json
{
  "id": "evt_01JB7M3Q4Z8X2K5N6P7R8S9T0V",
  "type": "run.checkpoint_waiting",
  "api_version": "2026-10-25",
  "occurred_at": "2026-10-25T14:02:11Z",
  "company": {"id": "…", "name": "Example Co"},
  "data": {
    "run": {"id": "…", "flow": "brief_to_prd", "status": "awaiting_checkpoint",
            "title": "Checkout redesign", "url": "https://oracle.example.test/runs/…"},
    "checkpoint": {"id": "…", "kind": "prd_review", "approver_role": "approver",
                   "url": "https://oracle.example.test/runs/…#checkpoint-…"},
    "actor": {"kind": "oracle"}
  }
}
```

Titles, states and links are read when the call is made, so a renamed document goes out
with its current title. A subject that is gone (deleted, in Trash) is not sent: the
delivery is `withheld`.

### What is never sent

Document or section text, comments, feedback, checkpoint notes, source items or excerpts,
interview content, run prompts, free-text errors (a failed run carries an `error_kind`
code), costs, emails and user ids. People appear by display name only. A receiver that
needs more calls the REST API with its own token, under its own role.

## Checking the signature

Oracle signs every call as the open [Standard Webhooks](https://www.standardwebhooks.com/)
spec does, so its libraries work as they are. Headers:

- `webhook-id`: the event id (`evt_…`), the same on every retry and redelivery: dedupe on it;
- `webhook-timestamp`: Unix seconds;
- `webhook-signature`: `v1,<base64 HMAC-SHA256>` of `<id>.<timestamp>.<body>`, keyed with
  the base64-decoded part of the secret after `whsec_`. During a secret rotation's 24-hour
  overlap it carries two space-separated signatures (new, then old): accept either;
- `user-agent: ProductOracle-Webhooks/1`, `content-type: application/json`.

Refuse a timestamp more than 5 minutes off (replay protection). A verify example
(Python, standard library only):

```python
import base64, hashlib, hmac, time

def verify(secret: str, headers: dict, body: bytes) -> bool:
    key = base64.b64decode(secret.removeprefix("whsec_"))
    msg_id, ts = headers["webhook-id"], headers["webhook-timestamp"]
    if abs(time.time() - int(ts)) > 300:
        return False
    mac = hmac.new(key, f"{msg_id}.{ts}.".encode() + body, hashlib.sha256).digest()
    want = base64.b64encode(mac).decode()
    sent = [s.split(",", 1)[1] for s in headers["webhook-signature"].split(" ")]
    return any(hmac.compare_digest(want, s) for s in sent)
```

The secret is shown once, when the webhook is created or its secret rotated (any write
credential may do either: the browser, an API token or an MCP client with write scope;
never a run's token; each is audited with the credential used). It is stored encrypted
(`oracle.crypto`) and never returned, logged or audited again.

## Where Oracle sends, and retries

- Only to `https` URLs, through `guarded_transport()` (`baseline/public_links.py`): every
  connect resolves the host and refuses private, loopback, link-local and other non-public
  addresses (DNS rebinding safe; logged as `not_public`). Redirects are not followed: a 3xx
  is a failure (`redirect`).
- 5 s to connect, 10 s per call in all; the response body is kept up to 2 KB.
- Any 2xx is `succeeded`. A timeout, a connection or TLS error, 408, 429 and any 5xx are
  retried after 1, 5 and 30 minutes, then hourly, ±10% jitter; a 429's or 503's
  `Retry-After` is honoured up to an hour. A delivery gives up after 24 hours (`failed`).
  Any other 4xx is `failed` at once, with the response kept.
- 410 Gone pauses the webhook (`paused_reason = gone`).
- A webhook whose every delivery failed for 72 hours (at least 5 deliveries) pauses
  (`failing`); its creator and every owner get the Inbox row "Webhook <name> paused: failing
  for 3 days". Resuming sends what is still within 24 hours; older deliveries are `failed`
  and can be redelivered by hand.
- At least once, not ordered: each body has `occurred_at`.
- The minute tick (`ticker/router.py`, `_tick_company`) fans out new events and sends due
  deliveries with up to 15 s of the company's tick. Webhooks are sent side by side, each with
  its own client: at most 20 deliveries per webhook and 50 per company per tick, so one slow
  receiver never holds up another.
- **Redeliver** sends a logged delivery again as a new delivery with the same `webhook-id`.

## The owners-and-approvers rule

Events about content only owners and approvers see (updates, pricing memos, their runs,
checkpoints and approvals) go only to a webhook an owner created and opted in, with a
reason (`include_approvers_content`). Checked twice: at capture (`webhook_events.approvers_only`)
and again at send for the subject's current state; a delivery that fails the second check
is `withheld`, never sent, and shown in the log to owners only. Every other webhook gets no
delivery and no placeholder.

## Delivery log and retention

Each delivery keeps the event, attempts, times, status (`pending`, `retrying`, `succeeded`,
`failed`, `withheld`), HTTP status, an error code (`timeout`, `connect`, `not_public`, `tls`,
`redirect`, `too_large`, `expired`), the first 2 KB of the response and the body sent. Once
a day per company the tick deletes deliveries and events older than 30 days.

## Tests: the loopback switch

`ORACLE_WEBHOOKS_ALLOW_LOOPBACK_FOR_TESTS=1` lets a webhook point at a loopback address
(`http` or `https`), sent without the guarded transport, for the Playwright fixture's stub
receiver. The API refuses to start with it together with `ORACLE_COOKIE_SECURE` or
`ORACLE_IAP_AUDIENCES` (a real deployment). Never set it anywhere real.

## Rollback

1. Pause every webhook (`UPDATE webhooks SET status = 'paused', paused_reason = 'manual'`,
   or Pause on each in Settings › Webhooks); nothing more is sent.
2. Deploy the previous release, then downgrade below `0055_webhooks`
   (`alembic downgrade 0054_reply_opened`). This drops the webhooks, their secrets, events
   and delivery log.
