# I1 Outbound webhooks: Oracle tells the company's other tools when a run, a draft or an approval changes, signed, retried and logged

Group I (Interfaces) · Size L (three lanes, M each) · Verified against `f972c5e` (merge train Q) on 2026-10-25 · `docs/questions.md` I1 "REST + OpenAPI with webhooks for run/draft/approval events" has status **default**: REST and OpenAPI are built, webhooks are not (`docs/product-oracle-v2/00-baseline-and-delta.md:145`: "Webhooks (I1, default) | none | none | spec").

Owner decisions this spec needs are in `questions.json` (Q-I1-1 to Q-I1-6). The spec is written to each recommended answer and says so where it applies.

## Why this matters

- **For the person using Oracle.** A founder's team already works in other tools: a channel bot, a tracker, a no-code automation, an internal dashboard. Today those tools only learn what Oracle did when someone polls the API or reads the Inbox.
  - "The PRD run is waiting for your checkpoint" doesn't reach the eng lead's own tooling.
  - "v4 of the Checkout PRD was approved" can't open a ticket on its own.
  - "The run failed" can't page anyone.

  Oracle's one push channel is its own Slack app (F6 alignment report, G8 discussion mirror; `docs/ops-slack-notifications.md`). It posts to one channel, in Oracle's words, and nothing a machine can act on.
- **For the product.** I1 was answered by default as "REST + OpenAPI **with webhooks** for run/draft/approval events". REST, OpenAPI and MCP parity (I2) are built; the webhook half is the one piece of I1 that isn't.
  - The SaaS module even asks PRDs about `webhooks` (`docs/product-oracle-v2/02-template-modules.md:142`).
  - The build prompt asks for webhooks "when relevant" (`docs/product-oracle-v2/build-prompt.md:218`).
- **For engineering.** Most of what this needs already exists:
  - a guarded outbound HTTP transport: public addresses only, no redirects (`api/oracle/baseline/public_links.py:267`);
  - encryption at rest for credentials (`api/oracle/crypto.py`);
  - a retrying outbox delivered by the minute tick (`api/oracle/slack/outbox.py`, called from `api/oracle/ticker/router.py:347`);
  - the visibility rule for owners-and-approvers content in one module (`api/oracle/docs/visibility.py`);
  - audit actions at every state change this needs;
  - MCP tools derived from OpenAPI (`api/oracle/mcp/tools.py:1-6`).

  This pick adds two tables (hooks and deliveries, plus an event log), one capture call at about a dozen existing points, one outbox, one Settings tab and an ops runbook.

## Verified current state

| Piece | Where | State on main |
|---|---|---|
| Webhooks | `grep -ri webhook api/oracle` | Only module wording (`saas_integrations`, `webhooks` capability tags). No table, route, setting or job |
| Outbound HTTP guard | `api/oracle/baseline/public_links.py:267` `guarded_transport()`; used by `integrations/slack_api.py:54`, `metrics/posthog.py:124` | https only; refuses non-public addresses on every connect (DNS rebinding safe); `retries=0`; max 4 connections. Callers set their own timeouts |
| Retrying outbox | `api/oracle/slack/outbox.py:1-55` | Backoff 1, 5, 30 minutes then hourly; give up after 24 h (`failed`); 429 waits for `Retry-After`; `BATCH = 50`; the tick gives it a time budget (`ticker/router.py:340-353`) |
| Secrets at rest | `api/oracle/crypto.py` | Fernet, key from `ORACLE_SECRET_KEY` by HKDF, `KEY_VERSION` stored beside each ciphertext. `company_integrations` stores the Slack bot token and PostHog key this way, "never returned by any endpoint, logged or audited" (`integrations/models.py:1-8`) |
| Shown-once credentials | `api/oracle/auth/models.py:68-74` (`ApiToken.token_hash`); `web/app/settings/api-tokens/page.tsx` | Personal API tokens are shown once, stored as a hash. A webhook secret can't be stored as a hash: Oracle needs it to sign |
| Browser-only operations | `api/oracle/mcp/tools.py` `BROWSER_ONLY_OPERATIONS`; AC1 (owner 2026-10-20) | `create_personal_token`, `change_password`, `sign_out_everywhere` are never MCP tools and are refused with a token |
| Roles | `api/oracle/authz.py` | viewer < commenter < approver < owner; `require_role_now` re-checks under the review gate (C2); `not_for_runs` refuses run tokens |
| Owners-and-approvers content | `api/oracle/docs/visibility.py:1-48, 110-160` | `visibility = 'approvers'` documents (updates, pricing memos) and what hangs off them (captured decisions, checkpoint records) are absent for commenters and viewers. `MEMBER` reads as a commenter would; `hidden_document_ids`, `hidden_decision_ids` and `names_hidden` exist for exactly this kind of filter |
| Run states | `api/oracle/runs/models.py:53-61, 78` | `draft, awaiting_approval, running, awaiting_checkpoint, paused_overrun, succeeded, failed, cancelled`; checkpoints `pending, approved, changes_requested, skipped`; 12 checkpoint kinds (`update_review` and `pricing_review` belong to approvers-only documents) |
| Run state changes | `api/oracle/runs/service.py` | `run.awaiting_approval` :2182, `run.started` :2186, `run.approved` :2210, `run.failed` :5340, `run.paused_overrun` :5352, `run.resumed` :9511, `run.cancelled` :9357; `_finish` :3986 sets every terminal status; `awaiting_checkpoint` is set at :4623, :7882, :9517; `decide_checkpoint` :6968; `checkpoint.decision_voided` :7738 |
| Draft and approval changes | `api/oracle/docs/service.py:324` (`document.version_imported`), `:1242` (to `in_review`); `api/oracle/review/service.py:153` (to `in_review`), `:1104` (`version.approve`); `api/oracle/review/state.py:947` (`review.invalidate_approvals`); `api/oracle/review/publish.py:1250` (`document.publish`) | All audited, all inside the transaction that makes the change |
| Ticker | `api/oracle/ticker/router.py:183-265` (`_tick_company`) | Per-company steps, each in its own `try`, within `BUDGET_SECONDS` |
| MCP parity | `api/oracle/mcp/tools.py:1-6`; `api/oracle/mcp/scopes.py` | Every OpenAPI operation is a tool with the caller's credentials and role checks; run-token scopes map areas by first path segment |
| Settings tabs | `web/lib/settings-tabs.ts:9-23`; `web/app/settings/notifications/` | Tabs show only for roles that can call their read operation (#370). Notifications holds the Slack app |
| Latest migration | `api/migrations/versions/0054_reply_opened.py` | The next free number is `0055` |

Counts: 0 webhooks, 0 outbound event types. The 15 events below map onto state changes that are already audited or set in one place (`_finish` for the three run endings).

## What to build

### Concepts (plain words, used on screen)

- **Webhook**: an address outside Oracle that Oracle calls when something happens. It has a name, an https URL, the events it wants, and a secret. On screen: **Webhooks**.
- **Event**: one thing that happened, such as "a run is waiting at a checkpoint" or "v4 was approved". Every event has an id, a type, a time and a short description of what it's about. It never carries document text.
- **Delivery**: one attempt to send one event to one webhook, with its response. The **Delivery log** lists them.
- **Signing secret**: a random value Oracle and the receiving tool share, so the receiver can check that a call really came from Oracle and wasn't changed. Oracle shows it **once**, when it's made or rotated.
- **Owners-and-approvers events**: events about content that only owners and approvers see (H8 "Update view", 2026-10-21): updates, pricing memos, their runs, checkpoints and approvals. A webhook doesn't get these unless an owner turned them on for it (below).

### Who can do what (roles)

Written to **Q-I1-1** (recommended: owners and approvers).

| Action | Viewer | Commenter | Approver | Owner |
|---|---|---|---|---|
| See Settings › Webhooks | absent (404) | absent (404) | own webhooks | every webhook |
| Create a webhook, edit, pause, delete, send a test, redeliver, rotate its secret | – | – | own webhooks | every webhook |
| Turn on owners-and-approvers events for a webhook | – | – | – | yes, with a reason (Q-I1-2) |
| Read a delivery log | – | – | own webhooks | every webhook |
| Run tokens (an agent run) | refused 403 (`not_for_runs`) | | | |

- "Own webhooks" means the ones the person created (`created_by`).
- An owner can pause or delete anyone's webhook. The creator gets an Inbox row: "<Owner> paused your webhook <name>".
- **Member changes (C2 rules).**
  - Disabling the creator pauses their webhooks (`paused_reason = 'creator_disabled'`). Restoring the person doesn't resume them; the creator or an owner resumes each one.
  - Demoting the creator below approver also pauses them (`creator_demoted`). Promoting them again doesn't resume them.
  - An owner can **Take over** a paused webhook. That makes the owner its creator; the audit records it.
- **Read-only credentials** (`oracle:read` tokens, read-only MCP clients) can list and read; every write is 403.

### Events (v1)

The event types are a fixed registry in `api/oracle/webhooks/events.py` (`EVENT_TYPES`). The UI and `GET /v1/webhook-event-types` read it, the way the autonomy registry works.

| Type | When | Captured at | `data.subject` |
|---|---|---|---|
| `run.awaiting_approval` | a run's estimate is over $50 and waits for an owner | `runs/service.py:2182` | run |
| `run.started` | a run starts (or an owner approved its spend) | `:2186`, `:2210` | run |
| `run.checkpoint_waiting` | a run stops at a checkpoint for a person | the three `awaiting_checkpoint` sets (`:4623`, `:7882`, `:9517`) | run + checkpoint (kind, approver role) |
| `run.checkpoint_decided` | a checkpoint was approved or sent back with changes | `decide_checkpoint` (`:6968`) | run + checkpoint + `outcome: approved \| changes_requested` (the note's text is **not** sent) |
| `run.checkpoint_voided` | a decision was voided by a disable or demotion (C2) | `:7738` | run + checkpoint |
| `run.paused_overrun` | spend passed 1.5× the estimate; an owner must resume | `:5352` | run |
| `run.resumed` | an owner resumed it | `:9511` | run |
| `run.succeeded` / `run.failed` / `run.cancelled` | the run ended | `_finish` (`:3986`) | run + `error_kind` on failure (a code from `runs/reasons.py`, never the free-text error) |
| `draft.version_created` | a new document version was imported (from a run, an agent's `push_draft` or a person) | `docs/service.py:324` | document + version + `origin` |
| `draft.in_review` | a document moved to In review | `docs/service.py:1242`, `review/service.py:153`, `review/state.py:618` | document + version |
| `approval.version_approved` | a version was approved | `review/service.py:1104` | document + version + approver |
| `approval.approvals_invalidated` | approvals on a version lapsed or were voided (an edit, a demotion, a revoked token) | `review/state.py:947` | document + version + `reason` code |
| `approval.version_published` | a version was published | `review/publish.py:1250` | document + version |

Later, not in v1: decisions (`decision.decided`), requests, launches, rituals. Each later pick adds its types to `EVENT_TYPES`; nothing else changes.

**Capture is transactional.** `webhooks.capture(db, type, subject)` adds one `webhook_events` row in the caller's session, beside the existing `audit.record` call, so the event commits or rolls back with the change. It does no network I/O.

- It writes nothing when the company has no active webhook subscribed to the type. That's one indexed query, and it keeps a company without webhooks free of rows.
- A deliberate per-point call, rather than a hook inside `audit.record`: audit actions are named for the audit trail, not for a public contract, and a renamed audit action must not silently change what customers receive.

### Payloads

Written to **Q-I1-3** (recommended: thin payloads with ids, titles, states and links; no document text).

```jsonc
// POST https://hooks.example.test/oracle   (body is UTF-8 JSON, at most 16 KB)
{
  "id": "evt_01JB7M3Q4Z8X2K5N6P7R8S9T0V",          // unique; the idempotency key
  "type": "run.checkpoint_waiting",
  "api_version": "2026-10-25",
  "occurred_at": "2026-10-25T14:02:11Z",            // UTC; the UI shows the Company time zone
  "company": {"slug": "acme-example"},
  "data": {
    "run": {"id": "…", "flow": "brief_to_prd", "status": "awaiting_checkpoint",
            "title": "Checkout redesign PRD", "url": "https://oracle.example.test/runs/…"},
    "checkpoint": {"id": "…", "kind": "prd_review", "approver_role": "approver",
                   "url": "https://oracle.example.test/runs/…#checkpoint-…"},
    "document": {"id": "…", "kind": "prd", "title": "Checkout redesign", "version": 3,
                 "url": "https://oracle.example.test/docs/…"},
    "actor": {"kind": "person", "name": "Dana Example"}   // or {"kind": "oracle"} / {"kind": "system"}
  }
}
```

- **Never in a payload:** document or section text, comments, feedback, checkpoint notes, source items or excerpts, interview content, run prompts or errors as free text, costs, emails, user ids. A receiver that needs more calls the REST API with its own token, under its own role.
- `actor.name` is the person's display name (people are shown by name, never by id). Q-I1-3 option B drops it as well.
- Schemas: one Pydantic model per type in `api/oracle/webhooks/schemas.py`. They're published in OpenAPI as `components.schemas.WebhookEvent_<type>` and as `webhooks:` entries (OpenAPI 3.1), so `make openapi` documents them and the generated web client types them.
- `api_version` is fixed per webhook at creation. A breaking payload change adds a new version; the old one is kept for at least 6 months.

### Owners-and-approvers events never reach a member's webhook

This is the privacy rule of the pick. Written to **Q-I1-2** (recommended: off by default; only an owner can turn it on, per webhook, with a reason).

- Each webhook has `include_approvers_content` (default `false`).
  - Only an owner sets it, with a required reason, audited as `webhook.approvers_content_on|off`.
  - It can only be `true` while the webhook's creator is an owner. Taking over or creating as an approver leaves or turns it `false`.
- An event is **approvers-only** when its subject is hidden from `visibility.MEMBER`. The test reuses `docs/visibility.py`:
  - a document with `visibility = 'approvers'` (`hidden_document_ids`);
  - a run whose document is hidden, or of a flow that only drafts such documents (`update_draft`, `pricing_memo`);
  - a checkpoint of kind `update_review` or `pricing_review`;
  - anything `names_hidden` flags.
- **Fan-out.** An approvers-only event goes only to webhooks with `include_approvers_content = true`. Every other webhook gets no delivery and no placeholder: from outside, the event didn't happen, the same "absent, not disabled" rule H8 uses for commenters.
- **Checked twice.**
  - At capture, the event row stores `approvers_only`.
  - At send, the rule is evaluated again for the subject's current state, so a document made approvers-only after the event was captured isn't sent. That delivery is recorded `withheld`, visible to owners only.
- The rule is pinned by tests for every type in `EVENT_TYPES`: a new type must declare how its subject is checked, or the registry test fails.

### Signing

An engineering default; no owner decision needed. It follows the open **Standard Webhooks** spec, so receivers can use its libraries.

- **Headers:**
  - `webhook-id: evt_…`;
  - `webhook-timestamp: <unix seconds>`;
  - `webhook-signature: v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>`;
  - `user-agent: ProductOracle-Webhooks/1`;
  - `content-type: application/json`.
- During a rotation's overlap, `webhook-signature` carries two space-separated signatures (old and new).
- **Secret:******** `whsec_` + 32 random bytes, base64. Generated by Oracle only; a person can't choose it.
- **Replay protection:** the receiver should refuse a timestamp more than 5 minutes off. `docs/ops-webhooks.md` shows a 10-line verify example, and the Settings page links to it.

### Secrets: shown once, never again

- Creating a webhook, or **Rotate secret**, returns the secret once: `{webhook, secret}`. The screen shows it in a copy field with "Copy it now. Oracle won't show it again."
- **Storage:** encrypted with `oracle.crypto` (`ciphertext`, `key_version`), as `company_integrations` does. Not hashed, because Oracle must sign with it.
  - No route, export, log line, audit row, MCP tool result or error message ever contains it.
  - `WebhookOut` shows `secret_hint` (the last 4 characters) and `secret_rotated_at`.
- **Rotate** keeps the old secret valid for signing for 24 hours (both signatures sent), then drops it. **Rotate now, end the old one** skips the overlap.
- **Which credentials may get a secret.** Written to **Q-I1-4** (recommended: the signed-in browser only, as AC1 does for personal tokens).
  - `create_webhook` and `rotate_webhook_secret` join `BROWSER_ONLY_OPERATIONS` (`mcp/tools.py`). They're refused 403 with an API token or an MCP grant: "Create webhooks in Settings › Webhooks in the browser".
  - They also take `same_origin` (`auth/deps.py:304`).
  - Every other webhook operation has full parity (below).
- A deleted webhook's secret is deleted with it. The log keeps no secret.

### Where Oracle may send

Written to **Q-I1-5** (recommended: any public https URL, through the guarded transport).

- The URL must be `https`, at most 2,048 characters, with no user-info. It's resolved and connected only through `guarded_transport()`: public addresses only on every connect, no redirects followed (a 3xx counts as a failure: "The address redirected; webhooks don't follow redirects").
- Timeouts: 5 s to connect, 10 s in total. The response body is read up to 2 KB and the rest dropped.
- Limits: 10 webhooks per company (422 above that); 20 event types per webhook (all of them).
- Owners see every destination host on the Webhooks list. Each delivery is logged with the host.

### Delivery, retries and backoff

New `api/oracle/webhooks/outbox.py`, modelled on `slack/outbox.py`, called from `_tick_company` in its own `try` with a share of the tick's budget (`ticker/router.py:340-353`).

- **Fan-out.** On the tick, each new `webhook_events` row becomes one `webhook_deliveries` row per active subscribed webhook, subject to the rule above.
- **Success:** any 2xx. **Retry:** a timeout, a connection error, a 429, any 5xx and 408. **No retry:** any other 4xx (`failed` at once, the response kept). 410 Gone pauses the webhook (`paused_reason = 'gone'`).
- **Backoff:** 1, 5, 30 minutes, then hourly, with ±10% jitter. A 429 or 503 `Retry-After` is honoured, capped at 1 hour. A delivery gives up after **24 hours** (`failed`), as the Slack outbox does.
- **Guarantees.** At least once. Not ordered: each event has `occurred_at`, and receivers dedupe on `webhook-id`. One slow webhook never holds up another: at most 20 deliveries per webhook per tick, `BATCH = 50` per company.
- **A failing webhook.**
  - After 72 hours in which every delivery failed (with at least 5 deliveries), the webhook is paused (`paused_reason = 'failing'`).
  - Its creator and every owner get an Inbox row: "Webhook <name> paused: failing for 3 days", with **Open** and **Resume**.
  - Resuming sends what is still within 24 hours. Anything older is `failed` and can be redelivered by hand.
- **Test.** **Send test event** queues a `webhook.test` event (`data: {"message": "Test from Product Oracle"}`) for this webhook only, delivered on the next tick or at once from the screen (the route sends synchronously with the same 10 s cap and records it in the log).
- **Redeliver.** Any delivery in the log can be sent again. That's a new delivery with the same `webhook-id`, so receivers dedupe it. Redelivering an approvers-only event re-runs the visibility check.

### Delivery log

- `webhook_deliveries` keeps:
  - the event id and type;
  - the attempt number, start and duration;
  - the status `pending | succeeded | retrying | failed | withheld`;
  - the HTTP status, the first 2 KB of the response body (as text, never rendered as HTML), an error code (`timeout`, `connect`, `not_public`, `redirect`, `tls`);
  - the request body as sent.
- **Retention:** written to **Q-I1-6** (recommended: 30 days). A daily ticker step deletes deliveries and events older than that.
- **Screen:** per webhook, newest first. Filters by status and event type. A row opens the body sent, the headers (signature shown as `v1,…` truncated), the response, and **Redeliver**.

### Data model

Migration `0055_webhooks` (additive; the integrator re-chains it):

```sql
CREATE TABLE webhooks (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  url text NOT NULL, host text NOT NULL,
  event_types text[] NOT NULL,                          -- checked against EVENT_TYPES in the API
  api_version text NOT NULL,
  include_approvers_content boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  paused_reason text CHECK (paused_reason IN ('manual','failing','gone','creator_disabled','creator_demoted')),
  ciphertext bytea NOT NULL, key_version int NOT NULL, secret_hint text NOT NULL,
  previous_ciphertext bytea, previous_expires_at timestamptz,  -- the 24 h rotation overlap
  secret_rotated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_events (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  public_id text NOT NULL UNIQUE,                       -- evt_<ulid>
  type text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(),
  subject jsonb NOT NULL, approvers_only boolean NOT NULL,
  fanned_out_at timestamptz
);
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','retrying','succeeded','failed','withheld')),
  attempts int NOT NULL DEFAULT 0, next_at timestamptz, last_at timestamptz,
  http_status int, duration_ms int, error text, response_excerpt text,
  body jsonb, redelivery_of uuid REFERENCES webhook_deliveries(id) ON DELETE SET NULL
);
CREATE INDEX ix_webhook_deliveries_due ON webhook_deliveries (tenant_id, next_at) WHERE status IN ('pending','retrying');
CREATE INDEX ix_webhook_deliveries_log ON webhook_deliveries (webhook_id, last_at DESC);
CREATE INDEX ix_webhook_events_new ON webhook_events (tenant_id, occurred_at) WHERE fanned_out_at IS NULL;
```

The `subject` holds ids only. The payload's titles and URLs are built at send time from the current rows, so a renamed document is sent with its current title, and a deleted (trashed) subject's delivery is `withheld`.

### API

New router `api/oracle/webhooks/router.py`, registered in `main.py`. Every route gets a Pydantic request and response, `require_role_or_absent("approver")` (404 below approver, H8's absent rule), `not_for_runs`, company scoping, an audit event on every change, and a cross-company negative test (`waves.md` rules).

```
GET    /v1/webhook-event-types                   -> [EventTypeOut]           (list_webhook_event_types, approver)
GET    /v1/webhooks                              -> [WebhookOut]             (list_webhooks, approver: own; owner: all)
POST   /v1/webhooks   {name, url, event_types, include_approvers_content?, reason?}
                                                 -> WebhookCreated {webhook, secret}   (create_webhook, approver; browser only, Q-I1-4)
GET    /v1/webhooks/{id}                         -> WebhookOut               (get_webhook)
PATCH  /v1/webhooks/{id}  {name?, url?, event_types?, status?, include_approvers_content?, reason?}
                                                 -> WebhookOut               (update_webhook; include_approvers_content owner only, reason required)
DELETE /v1/webhooks/{id}                         -> 204                      (delete_webhook)
POST   /v1/webhooks/{id}/rotate-secret {end_old_now?: bool}
                                                 -> WebhookCreated           (rotate_webhook_secret; browser only)
POST   /v1/webhooks/{id}/take-over               -> WebhookOut               (take_over_webhook, owner)
POST   /v1/webhooks/{id}/test                    -> DeliveryOut              (test_webhook)
GET    /v1/webhooks/{id}/deliveries?status=&type=&before=  -> DeliveryPage  (list_webhook_deliveries)
GET    /v1/webhooks/{id}/deliveries/{delivery}   -> DeliveryOut              (get_webhook_delivery)
POST   /v1/webhooks/{id}/deliveries/{delivery}/redeliver   -> DeliveryOut    (redeliver_webhook_delivery)
```

- 422: not https, too long, user-info, an unknown event type, more than 10 webhooks, `include_approvers_content` by a non-owner or on an approver's webhook, a missing reason.
- 403: a run token; a write by a read-only credential; `create_webhook`/`rotate_webhook_secret` with a token or MCP grant.
- 404: another person's webhook for an approver; any route for a commenter or viewer.
- Changing `url` keeps the secret but is audited with the old and new host. Owners get an Inbox row when an approver changes a URL (someone redirecting events is the main abuse case).
- `WebhookOut`: `{id, name, url, host, event_types, api_version, include_approvers_content, status, paused_reason, secret_hint, secret_rotated_at, created_by: {name}, created_at, last_delivery: {status, at, http_status}, failing_since}`.

### MCP and REST parity (I2)

- Every route above is an MCP tool through `mcp/tools.py`, under the caller's credential and role. Two exceptions (Q-I1-4): `create_webhook` and `rotate_webhook_secret` are browser-only, so a secret never lands in an MCP client's or an LLM's context.
- **Scopes.**
  - `webhooks` and `webhook-event-types` are not in any run-token area (`mcp/scopes.py`). Run tokens get 403, as for members and tokens.
  - People's credentials need `oracle:write` for writes and `oracle:read` for reads (I2b).
- **Pinned by tests.** A parity test lists every webhook operation and asserts each is either a tool or in `BROWSER_ONLY_OPERATIONS`. It also asserts no tool result, from any of these tools, contains a string starting `whsec_`.
- MCP has no push: an MCP client that wants events polls `list_webhook_deliveries` or configures a webhook. Nothing in MCP's transport changes.

### Screens and copy

**Settings › Webhooks** (`/settings/webhooks`, new entry in `web/lib/settings-tabs.ts` after Notifications, `read: "list_webhooks"`, so commenters and viewers don't see the tab; #370):

- **Header:** "Tell your other tools when runs, drafts and approvals change." A tooltip icon links to the runbook's verify example.
- **Table** (B1 Split: one-line table left, inspector right):
  - Name · Host · Events (count) · Status (Active, Paused: <reason>, Failing) · Last delivery (✓ 200, 2 min ago).
  - Owners also see **Created by**, and a lock icon on webhooks with owners-and-approvers events on.
- **New webhook** sheet: Name, URL, Events (grouped checkboxes Runs · Drafts · Approvals, "All" per group), then **Create**.
  - Owners also see a switch **Include owners-and-approvers content**, off, with a required **Why** when turned on.
  - The next step shows the secret once, with a copy button and "Copy it now. Oracle won't show it again." and **Send test event**.
- **Inspector:** settings; **Rotate secret** (a confirm that names the 24-hour overlap); **Pause** or **Resume**; **Delete** (confirm by name); **Take over** (owners, on a paused webhook of someone else); the Delivery log.
- **Delivery log:** When · Event · Status · HTTP · Time. A row opens the body, headers and response; **Redeliver**. Times are in the Company time zone, labelled.
- **Inbox rows:**
  - "Webhook <name> paused: failing for 3 days" (creator and owners; Open, Resume);
  - "<Owner> paused your webhook <name>";
  - "<Approver> changed where webhook <name> sends" (owners).
- **Phone:** the table collapses to Name and Status; the sheet stacks.

### Docs

- `docs/ops-webhooks.md`:
  - the event list and payload shape;
  - the signature check with a verify example;
  - retries;
  - what is never sent;
  - the owners-and-approvers rule;
  - rollback (pause every webhook, then downgrade `0055_webhooks`).
- `docs/questions.md` I1: status to `answered`, with the owner's answers to Q-I1-1 to Q-I1-6.
- `docs/product-oracle-v2/00-baseline-and-delta.md:145`: the row becomes "built".

## Acceptance criteria

1. An approver creates a webhook in Settings › Webhooks. The secret is shown once; reopening the webhook shows only `…` and the last 4 characters. No API response, log line, audit row or MCP tool result contains the secret (test greps responses and captured logs for `whsec_`).
2. **Send test event** reaches a test receiver. The delivery log shows ✓ 200 with the body sent. The receiver verifies `webhook-signature` with the secret, and a changed body fails verification.
3. A run moving through `running → awaiting_checkpoint → (approve) → succeeded` produces `run.started`, `run.checkpoint_waiting`, `run.checkpoint_decided` (`approved`) and `run.succeeded`, each delivered once to a subscribed webhook and not at all to an unsubscribed one.
4. Importing a version, moving it to In review, approving it and publishing it produce `draft.version_created`, `draft.in_review`, `approval.version_approved` and `approval.version_published`. A demotion that lapses the approval produces `approval.approvals_invalidated`.
5. A state change rolled back (an import refused, a publish that loses a race at `review/publish.py:1245`) produces no event.
6. No payload contains document text, comments, notes, source excerpts, costs, emails or user ids. A schema test checks every type's model against an allowlist of fields.
7. An update document's run, checkpoint and approval events never reach a webhook created by an approver, nor an owner's webhook with owners-and-approvers content off, in deliveries or in the log. With it on (owner, reason given), they arrive. A document switched to `approvers` after capture is `withheld` at send.
8. An approver can't turn on owners-and-approvers content (422), can't see another person's webhook (404), and a commenter gets 404 on every webhook route. A run token gets 403.
9. A receiver answering 500 is retried after about 1, 5 and 30 minutes, then hourly, and the delivery is `failed` after 24 hours. A 429 with `Retry-After: 120` waits about 120 s. A 400 is `failed` at once. A 410 pauses the webhook. A 3xx is a failure and isn't followed.
10. A URL resolving to a private, loopback or link-local address is refused at send (`not_public`), including through DNS rebinding (the guarded transport's own tests cover the connect path; one test proves webhooks use it).
11. Seventy-two hours of failures pause the webhook and put the Inbox row on the creator's and every owner's Inbox. Resume sends what is within 24 hours.
12. Rotating the secret sends both signatures for 24 hours, then only the new one. "End the old one now" sends only the new one at once.
13. `create_webhook` and `rotate_webhook_secret` are not MCP tools and are 403 with an API token. Every other webhook operation works over MCP with the same role results as REST.
14. Disabling the creator pauses their webhooks; restoring them doesn't resume them; an owner can take one over.
15. One webhook timing out on every call doesn't delay another webhook's deliveries in the same tick.
16. Deliveries and events older than the retention (30 days) are deleted by the daily step.
17. Playwright (`web/tests/webhooks.spec.ts`), driving the UI only:
    - an owner creates a webhook pointing at the test receiver, copies the secret, sends a test event and sees ✓ in the log;
    - they start a fake-runtime run, approve its checkpoint in the run page, and see `run.checkpoint_waiting`, `run.checkpoint_decided` and `run.succeeded` appear in the log;
    - a commenter doesn't see the Webhooks tab.

    The test receiver is a stub HTTP server started by the Playwright fixture. Loopback is allowed for it only by `ORACLE_WEBHOOKS_ALLOW_LOOPBACK_FOR_TESTS=1`, which the app refuses to start with when `ORACLE_ENV=production`.

## Lanes

| Lane | Size | Scope | Files |
|---|---|---|---|
| **1. Events and webhooks API** | M | `EVENT_TYPES` registry with per-type subject check and payload model; `capture()` at the points listed in Events; tables and migration `0055_webhooks`; routes, roles, absent rule, `not_for_runs`; secret generation, encryption, shown once, rotation; `BROWSER_ONLY_OPERATIONS` entries; OpenAPI `webhooks:`; audit; Inbox rows for member changes and URL changes; C2 hooks (disable, demote pause webhooks) | `api/oracle/webhooks/{__init__,events,schemas,models,service,router}.py`; `api/migrations/versions/0055_webhooks.py`; `api/oracle/runs/service.py`, `docs/service.py`, `review/service.py`, `review/state.py`, `review/publish.py` (one `capture` line each); `api/oracle/mcp/tools.py`; `api/oracle/members/service.py` (`set_role` :178, `disable_member` :353); `api/oracle/main.py`; `api/oracle/openapi.py`; `api/tests/test_webhooks_*.py` |
| **2. Delivery** | M | Fan-out with the owners-and-approvers check at capture and send; outbox with signing (Standard Webhooks), guarded transport, timeouts, backoff and `Retry-After`, 410 and failing pause; test and redeliver; delivery log; retention step; loopback test switch; `docs/ops-webhooks.md` | `api/oracle/webhooks/{outbox,sign,fanout,retention}.py`; `api/oracle/ticker/router.py` (one step in `_tick_company`, one in the daily steps); `api/oracle/config.py`; `docs/ops-webhooks.md`; tests with a fake receiver transport |
| **3. Screens** | M | Settings › Webhooks list and inspector, New webhook sheet with the shown-once secret, rotate, pause, delete, take over, delivery log and redeliver, Inbox rows; phone layout; Playwright spec with the stub receiver | `web/lib/settings-tabs.ts`; `web/app/settings/webhooks/{page,WebhooksSettings,WebhookInspector,DeliveryLog,NewWebhookSheet}.tsx`; `web/app/inbox/` (three row kinds); `web/tests/webhooks.spec.ts`; mock API fixtures; regenerated client |

Lane 2 starts after lane 1's tables and `capture()` land, or works against its schemas in parallel and rebases. Lane 3 needs lane 1's OpenAPI.

## Owner decisions (questions.json)

| Id | Question | Spec assumes (recommended) |
|---|---|---|
| Q-I1-1 | Who may create and manage webhooks? | Owners and approvers; approvers manage their own, owners all |
| Q-I1-2 | May owners-and-approvers content (updates, pricing memos) ever go to a webhook? | Off by default; an owner turns it on per webhook with a reason, only on a webhook an owner created |
| Q-I1-3 | How much goes in a payload? | Ids, types, states, titles, names and links; never document text, comments, notes, source text or costs |
| Q-I1-4 | Which credentials may create a webhook or rotate its secret (and so receive the secret)? | The signed-in browser only, as AC1 does for personal tokens; everything else at full MCP and REST parity |
| Q-I1-5 | Where may Oracle send events? | Any public https URL through the guarded transport; owners see every host |
| Q-I1-6 | How long are delivery logs (with the bodies sent) kept? | 30 days |

Engineering defaults, not owner choices: Standard Webhooks signing (HMAC-SHA256), at-least-once delivery, the Slack outbox's backoff and 24-hour give-up, the 72-hour failing pause, 10 webhooks per company, 16 KB payloads.

## What it unblocks

- **I1** moves from `default` to `answered` and built, and the baseline delta's "Webhooks" row closes.
- Teams wire Oracle into their own tools without polling: a checkpoint pings the approver's channel bot, an approved PRD opens a tracker ticket, a failed run pages on-call.
- Later picks add events by adding to `EVENT_TYPES`: H1 decisions, C1 requests, H6 launches, H2 rituals. They get signing, retries, the log and the visibility rule for free.
- A future first-party connector (a Linear or Jira two-way sync, RMP-3) can use the same outbox and log for its writes.
- The Slack poster (F6, G8) could later move onto this outbox; this pick doesn't move it.
