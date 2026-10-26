# TRK Two-way tracker: an approver connects Linear (or Jira), previews and pushes a track's Now and Next items as epics and issues, and Oracle reads status, estimates and dates back, with every conflict shown, never overwritten silently

Group E (Engineering alignment) · Size L · Verified against `f972c5e` (merge train Q) on 2026-10-25 · Owner decisions TRK-Q1 to TRK-Q6 in `questions.json`. This spec is written to the recommended answers and says where it does.

## Why this matters

- **For the person using Oracle.** E1 (`docs/questions.md:107`) decided "two-way with the eng tracker: approved PRD -> epics + issues; read back status, estimates, plan; flag drift both ways". Today an approver who has an approved roadmap must retype every Now and Next item into the tracker by hand, and engineering's status gets back to Oracle only if someone posts it (`POST /v1/tracker/records`) or links their own GitHub issues one at a time (F7, #184). The **Push to tracker** button on the Plan screen (`web/app/plan/_tracks.tsx:389-410`) always fails with "Two-way tracker sync is off".
- **For the product.** The read-only alignment report, drift (`ahead`, `date_slip`, `overdue`, `cancelled`, `unplanned`), date bases and track monitoring are all built on `tracker_records` (`api/oracle/roadmap/tracker.py`, `views.py`, `schedule.py`). They are only as good as the records, and today the records are typed in. A connector that both writes the plan and reads the state back turns these into live signals, with nobody retyping.
- **For engineering.** Most of it is built:
  - the preview of what a push would create (`GET /v1/tracks/{id}/tracker-plan`, `api/oracle/roadmap/router.py:1138-1167`);
  - the record table with per-field history (`TrackerRecord`, `TrackerRecordEvent`, `api/oracle/roadmap/models.py:180-221`; `tracker._changes`);
  - the gate (`ORACLE_TRACKER_TWO_WAY_ENABLED`, `api/oracle/config.py:77-81`) and the refusal (`tracker.refuse_push`, 409 off and 501 on but unverified);
  - per-user OAuth connections with encrypted credentials (`api/oracle/connections/`).

  This pick adds a company-level tracker connection, a mapping, a push that writes through the preview, a pull on the ticker and a conflict list. It is Oracle's **first write to a system outside the company's own Oracle**, so every outbound field is listed below and nothing is written without a person pressing Push.

## Verified current state

| Piece | Where | State on `f972c5e` |
|---|---|---|
| Gate | `api/oracle/config.py:77-81` | `tracker_two_way_enabled: bool = False` |
| Connector status | `api/oracle/roadmap/tracker.py:43-75`; `GET /v1/tracker/connector` (`router.py:850-853`) | `writes_allowed=False` always; reason "off" or "no connector has been verified end to end" |
| Push | `POST /v1/tracks/{id}/tracker-push` (`router.py:1170-1178`) | Approver; always refused: 409 off, 501 on. Nothing is written |
| Preview | `GET /v1/tracks/{id}/tracker-plan` (`router.py:1138-1167`) | One epic per Now and Next item of the approved roadmap version (title, horizon, outcome as description, PRD link), one issue per linked requirement; Later skipped; never written |
| Records | `tracker_records` (`models.py:180-221`); `TRACKERS = ("linear", "jira", "github", "other")`, `TRACKER_STATES = ("todo", "in_progress", "done", "cancelled", "unknown")` (`models.py:52-53`) | Unique per (tenant, tracker, external_ref). State, raw status, estimate and unit, target date, track and item key, `observed_at` |
| History | `tracker_record_events`; `GET /v1/tracker/records/{id}/events` (`router.py:1395`) | One event per changed field on each import |
| Import | `POST /v1/tracker/records` (`router.py:870-900`, `tracker.import_records`) | An approver posts records; upserted under an advisory lock per tracker; re-checks milestones resting on them (`schedule.recheck_tracker_milestones`) |
| GitHub links (F7) | `api/oracle/roadmap/links.py`; `GET /v1/tracker/issues`, `DELETE /v1/tracker/links/{id}` | One way: a person links their own synced GitHub issue to a roadmap item. Oracle reads nothing from GitHub here and writes nothing |
| Drift | `tracker.drift_of`, `tracker.unplanned`; alignment report (`router.py:468-...`, `views.py`) | Computed from records, read-only; works without write access (E1 (4)) |
| Connections | `api/oracle/connections/providers.py:270-345` (`PROVIDERS`: github, slack, notion, fireflies, google); `oauth.py` (`ORACLE_OAUTH_<PROVIDER>_CLIENT_ID/SECRET`) | Per user (S5). No Linear or Jira provider. No company-level connection |
| Run tokens | `api/oracle/runtokens.py`, `api/oracle/mcp/scopes.py` | The `tracker` area is in no run-token scope (`router.py:171-175`): agents cannot post records. Keep it so |
| Who verifies dates | SQ19 (`docs/questions.md:190`); `User.engineering_lead` (`api/oracle/setup.py:123`) | Engineering leads and owners verify a date basis; an approver's waits as Proposed |
| Plan screen | `web/app/plan/_tracks.tsx:389-410`; mock `web/lib/api/mock/roadmap.ts:855-870`; e2e `web/e2e/roadmap-tracks-mock.spec.ts:91-92` | Push to tracker button, refused in mocks too |

Counts: 0 tracker connections, 0 writes to any tracker, 0 records that Oracle pulled itself.

## What to build

### Concepts (plain words, used on screen)

- **Tracker**: where engineering plans its work. The first one is **Linear** (TRK-Q1, recommended). Jira Cloud follows as its own lane behind the same interface.
- **Tracker connection**: one per company, made by an owner on Settings › Connections, under a dedicated tracker account or the owner's own (TRK-Q2, recommended: **company connection made by an owner**). It is not a person's source (S3): what it reads lands in `tracker_records`, which every member can already see on the Plan screen, not in anyone's private `source_items`.
- **Mapping**: which Linear team (or Jira project) a product track pushes into, and how the tracker's statuses map to Oracle's five states.
- **Linked item**: a roadmap item and the tracker epic it was pushed to (or linked to by hand). Its requirements map to the epic's issues.
- **Push**: an approver sends a track's preview to the tracker. Oracle creates what is missing and updates the product fields of what it created before. Nothing is pushed on a timer (build prompt §11.1: "no unattended external writes").
- **Pull**: Oracle reads the linked epics and issues back every hour on its ticker: status, estimate, target date, assignee's display name and the tracker's URL. No model call (RMP-2).
- **Conflict**: a field changed on both sides since the last push or pull. Oracle shows it and a person picks a side; it never overwrites a tracker edit without asking.

### Who owns which field (TRK-Q4, recommended: **split by kind**)

| Field | Owner | Push writes it | Pull reads it |
|---|---|---|---|
| Epic title | Product (Oracle) | create; update if unchanged in the tracker since the last push | yes; a tracker edit is a conflict |
| Epic description | Product | create (the outbound text below); update as for the title | yes, hash only; a tracker edit is a conflict |
| Issue title (one per requirement) | Product | as for the epic title | as for the epic title |
| Status | Engineering (tracker) | never (new items start in the team's default status) | yes, mapped to the five states |
| Estimate and unit | Engineering | never | yes |
| Target date / due date / cycle | Engineering | never; Oracle's milestone dates are not sent (O4: a date rests on a verified basis, SQ19) | yes; a target date becomes a **proposed** date basis that a lead or owner verifies (F3, unchanged rule) |
| Assignee | Engineering | never | display name only, shown on the item; never an email |
| Labels | Oracle adds one label `oracle` on create | create only | no |
| Epics and issues Oracle did not create | Engineering | never touched | yes, once linked by a person |

A pull never changes a roadmap item. It changes `tracker_records` (and their history) only; the item diff, drift and monitoring read those as today.

### What is written outside the company (TRK-Q3, recommended: **titles, outcome and a link back**)

Per epic: the item title; the item's outcome sentence (`TrackerPlanEpic.description`); one line "Planned in Product Oracle: <PRD title> · <horizon>"; and the link to the PRD section in Oracle (`prd_link`, which needs an Oracle sign-in to open). Per issue: the requirement title and the same link. Oracle sends nothing else:

- no requirement bodies, acceptance criteria, evidence, sources, customer names, request text, confidence or priority scores;
- no Oracle dates or milestones;
- no names of people other than what the tracker already knows.

The Push sheet lists exactly this text, item by item, before anything is sent. Every write is audited (`tracker.pushed`, with the tracker ids and a hash of each body).

### Connect (owner)

- `PROVIDERS` gains `linear` (`api/oracle/connections/providers.py`): OAuth 2 with PKCE, scopes `read,write,issues:create` (Linear's documented app scopes; the lane checks them against Linear's docs and records the result), `identify` reads the workspace and the authorising user's display name, `source_kinds=()` (it serves no source).
- OAuth client in `ORACLE_OAUTH_LINEAR_CLIENT_ID` and `..._SECRET` (the existing `oauth.py` pattern), registered by the owner under the company's own Linear workspace. A pasted personal API key also works until the app is registered, as for other providers before sign-in (S5).
- New table `tracker_connections` (one live row per company and tracker): `tracker`, `connection_id` (the owner's encrypted `connections` row), `workspace_label`, `status` (`active`, `error`, `paused`), `writes_enabled` (bool, off until the owner turns it on), `last_pull_at`, `last_error`, `connected_by`. The tracker credential is never given to agents or run tokens.
- **Settings › Connections › Engineering tracker** card: Connect Linear; the workspace name; "Oracle may create epics and issues" switch (owner, with a reason; audited `tracker.writes_enabled`); Pause; Disconnect. Disconnect keeps the records and their history and stops pulls; records keep their last state and show "Not read since <date>".
- `GET /v1/tracker/connector` returns `writes_allowed=true` only when the gate is on, a connection is `active` and `writes_enabled` is true. The gate stays in config: it is the deployment's switch; the per-company switch is the owner's.

### Map (approver, per track)

- **Plan › track › Tracker** panel: pick the Linear team (listed through the connection), then the status map: each of the team's workflow states maps to `todo`, `in_progress`, `done` or `cancelled`; a sensible default by Linear's state type (`unstarted`, `started`, `completed`, `canceled`), editable.
- Stored on `product_tracks` as `tracker_target` jsonb `{tracker, team_id, team_label, status_map}` (additive column).
- **Link existing**: an approver can link a roadmap item to an epic already in the tracker by its key or URL (the F7 pattern, but over the company connection). Linking reads the epic once and creates its record.

### Push (approver; writes only when the owner allowed writes)

- `POST /v1/tracks/{id}/tracker-push {item_keys?: [...], expect_plan_hash}`:
  - Recomputes the preview, refuses 409 `plan_changed` when its hash differs from the one the approver saw.
  - For each epic in the preview: creates it when it has no link; otherwise updates title and description only where the tracker still holds what Oracle last wrote (else the field becomes a conflict, unwritten).
  - Same for issues under the epic. A requirement removed from the PRD is **not** deleted in the tracker; its issue is listed as "No longer in the plan" for a person to close there.
  - Returns 202 with a push id; runs in the background with the tracker's rate limits (retries with backoff on 429), and records each write in `tracker_pushes` (id, track, started_by, items, created, updated, conflicts, failed, finished_at).
  - Idempotent: a retried push with the same push id never creates a second epic (Oracle stores the tracker id on the link before moving on, and looks up by an `oracle-item:<item_key>` marker in the epic's description footer when a write's answer was lost).
- Refusals stay explicit: 409 when the gate or the owner's switch is off (copy unchanged from `OFF_REASON`); 501 is removed once Linear is verified (below).
- Autonomy: a new responsibility `tracker_write`, ceiling **draft** ("Oracle prepares the push; a person sends it"), default draft, wired by this pick: at Observe the Push button is hidden and only the alignment report shows. Act is not offered: no unattended external writes.

### Pull (Oracle, hourly, no model)

- Ticker step `tracker.pull_due(db)` in `_tick_company` (`api/oracle/ticker/router.py:185-265`), its own `try` and savepoint, at most once an hour per connection.
- Reads every linked epic and issue changed since `last_pull_at` (Linear's `updatedAt` filter), maps state through the track's status map (`unknown` when unmapped), and upserts `tracker_records` through the same path as `import_records` so history, milestone re-checks and drift behave exactly as for a posted record. `recorded_by` is null and the audit actor is `oracle`.
- Unplanned work: issues in the mapped team that carry no link are **not** pulled in bulk. Only items a person linked, or Oracle created, are read (TRK-Q5, recommended: **linked only**). The `unplanned` drift keeps working for records that exist.
- Webhooks are a later step (S4 "Freshness"): hourly polling needs no public inbound endpoint.
- A rejected credential sets the connection to `error`, shows "Reconnect Linear" on Settings and one Inbox row for owners; records keep their last state.

### Conflicts

- Kept in `tracker_conflicts` (record id, field, oracle_value, tracker_value, detected_at, resolved_by, resolution: `keep_tracker`, `send_oracle`, `dismissed`).
- **Plan › track › Tracker** shows "2 conflicts" with each row: the item, the field, both values side by side, and **Keep tracker's** / **Send Oracle's** (approver). Send Oracle's is a push of that one field (same outbound rules). Inbox row for the track's approvers, counts until resolved.
- Engineering fields never conflict: the tracker is right (B3 precedence "code > tracker > docs"). A target date the tracker moved past an Oracle milestone shows as the existing `date_slip` drift, not as a conflict.
- An epic deleted or moved out of the team in the tracker: the record goes `cancelled` with raw status "Removed in Linear", and the link shows "Removed in the tracker · Unlink".

### Screens and copy

- **Plan › track** (`web/app/plan/_tracks.tsx`): Push to tracker opens a sheet "Send to Linear · <team>": rows of epics and issues with Create / Update / Unchanged / Conflict, the exact text that leaves Oracle, and a footer "Oracle writes only these titles, outcomes and links. Status, estimates and dates stay engineering's." **Send** (approver). After: "Sent: 4 epics, 11 issues created; 1 conflict to review."
- Each item row on the Plan screen shows its tracker key as a chip (`ENG-142 · In progress · 5 pts`) linking to the tracker.
- Settings › Connections: the Engineering tracker card above.
- Phone: the push sheet collapses to item title and action; the text is behind "What is sent".

### API

```
GET    /v1/tracker/connector                       -> TrackerConnectorOut (+ tracker, workspace_label, writes_enabled, last_pull_at)
POST   /v1/tracker/connections                     -> TrackerConnectionOut  (owner; from an existing connections row)
PATCH  /v1/tracker/connections/{id}  {writes_enabled?, status?, reason}      (owner)
DELETE /v1/tracker/connections/{id}                                           (owner; keeps records)
GET    /v1/tracker/teams                           -> [{id, label, states:[{id, name, type}]}]   (approver)
PUT    /v1/tracks/{id}/tracker-target {team_id, status_map}                   (approver)
POST   /v1/tracks/{id}/tracker-links {item_key, ref}                          (approver; link an existing epic)
GET    /v1/tracks/{id}/tracker-plan                -> TrackerPlanOut (+ per row: action, outbound text, plan_hash)
POST   /v1/tracks/{id}/tracker-push {item_keys?, expect_plan_hash} -> 202 {push_id}   (approver)
GET    /v1/tracker/pushes/{id}                     -> TrackerPushOut
GET    /v1/tracks/{id}/tracker-conflicts           -> [TrackerConflictOut]
POST   /v1/tracker-conflicts/{id}/resolve {resolution}                        (approver)
```

None of these is reachable by a run token (the `tracker` area stays out of every scope); `make openapi` regenerates `web/lib/api/schema.d.ts`; the mock (`web/lib/api/mock/roadmap.ts`) gains a fake Linear.

### Data

Migration `0055_tracker_two_way` (next free after `0054_reply_opened`): `tracker_connections`, `tracker_links` (track, item_key, requirement_key nullable, tracker, external_id, external_ref, record_id, last_pushed_hash per field, created_by_oracle bool), `tracker_pushes`, `tracker_conflicts`; `product_tracks.tracker_target jsonb`. Additive only; `TRACKERS` unchanged.

### Verification before the gate opens

`tracker.refuse_push` keeps 501 for a tracker until its connector passes a recorded end-to-end check against a **test workspace** the owner provides (create, update, pull, conflict, delete, rate limit). The lane records the check in its report; the owner flips `ORACLE_TRACKER_TWO_WAY_ENABLED` in deployment. Lanes themselves never call real Linear or Jira (waves.md: use the fakes).

## Roles

| Who | Can |
|---|---|
| Owner | connect and disconnect the tracker, allow or stop writes (with a reason), everything an approver can |
| Approver | map a track, link existing epics, preview and push, resolve conflicts |
| Engineering lead | everything a viewer can, plus verify date bases proposed from pulled target dates (SQ19) |
| Commenter, viewer | see tracker chips, states, drift and the alignment report; not the push sheet's buttons |
| Oracle (ticker) | pull linked items hourly; never pushes |
| Run tokens and agents | nothing: no tracker route is in any scope |

## Acceptance criteria

1. With the gate off, Push stays refused with today's 409 copy and nothing calls the tracker (existing `roadmap-tracks-mock.spec.ts:91-92` still passes).
2. An owner connects Linear on Settings › Connections, sees the workspace name, and turns on "Oracle may create epics and issues" with a reason; the audit log shows `tracker.writes_enabled` with the reason.
3. An approver maps a track to a team; the status map defaults by state type and saves.
4. The push sheet lists every epic and issue with its action and the exact text sent; the text contains only title, outcome, the "Planned in Product Oracle" line and the Oracle link (a test asserts the outbound body against the allowlist of fields).
5. Send creates one epic per Now and Next item and one issue per linked requirement in the fake tracker; a second Send with nothing changed creates nothing (all Unchanged); a retried push after a lost response creates no duplicate.
6. A title edited in the tracker and in Oracle shows one conflict; Keep tracker's leaves both unchanged and closes it; Send Oracle's writes only that field.
7. The hourly pull moves a record from `todo` to `in_progress` with one history event; a target date read back becomes a Proposed date basis in the lead's Inbox and no milestone moves until it is verified.
8. Status, estimate and dates are never written by a push (asserted on the fake's write log).
9. A revoked credential sets the connection to error, shows Reconnect, notifies owners once, and records keep their last state.
10. At autonomy `tracker_write` = Observe, the Push button is hidden and the API refuses 403; Act is not selectable.
11. A Playwright test drives the built app's UI against the fake tracker through criteria 2-7 (connect, map, preview, send, conflict, resolve). No API calls or database edits in the test.
12. `make test`, `make lint`, `make openapi`, web ESLint, `tsc` and Playwright pass.

## Lanes

| Lane | Size | Owns | Depends on |
|---|---|---|---|
| `trk-connect` | S | `linear` provider in `connections/providers.py`, `tracker_connections`, Settings › Connections card, `GET/POST/PATCH/DELETE /v1/tracker/connections`, `GET /v1/tracker/teams`, fake Linear in tests and the web mock | none |
| `trk-push` | M | mapping (`tracker_target`), `tracker_links`, preview actions and outbound text, push worker and `tracker_pushes`, autonomy `tracker_write` in `api/oracle/autonomy.py`, Plan push sheet and item chips | `trk-connect` |
| `trk-pull` | M | ticker `tracker.pull_due`, status mapping, upsert through `import_records`, Proposed date bases from target dates, `tracker_conflicts` and the conflict UI, Inbox rows | `trk-connect`; conflicts need `trk-push`'s links |
| `trk-jira` | M | `jira` provider (Atlassian OAuth 3LO), same `TrackerClient` interface (`api/oracle/roadmap/tracker_clients/{linear,jira}.py`), Jira status categories as the default map | `trk-push`, `trk-pull`; only if TRK-Q1 picks both or Jira |
| `trk-verify` | S | the end-to-end check script against the owner's test workspace (run by the owner, not by a lane), report and the 501 lift per tracker | all above |

## Owner decisions (in `questions.json`)

- **TRK-Q1 Which tracker first**: recommended **Linear first, Jira as a follow-up lane**.
- **TRK-Q2 Whose account writes**: recommended **one company connection made by an owner**.
- **TRK-Q3 What text leaves the company**: recommended **titles, outcome sentence and a link back**.
- **TRK-Q4 Who wins a field**: recommended **split by kind; a product-field edit on both sides is a conflict a person resolves**.
- **TRK-Q5 What Oracle reads back**: recommended **only linked or Oracle-created items**.
- **TRK-Q6 When a push happens**: recommended **only when an approver presses Send, per track**.

## What it unblocks

- E1 (1) as decided, and lifts the 501 on `tracker-push`.
- Live drift and track health (F2) without anyone posting records; the weekly alignment report (E1 (4)) gains real data.
- Date bases from engineering's own estimates (F3, O4: "dated milestones only in Now, from eng-tracker estimates").
- H3 Predicted versus actual and H6 Launches: "shipped" can be read from a done epic instead of typed.
- The F4 Engineering review stop can show the tracker's estimates beside the tech brief.
