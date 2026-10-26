# VOICE Customer voice: a person connects their support desk (Intercom or Zendesk) and CRM (HubSpot), Oracle reads customer conversations and deal notes into their own sources with personal details stripped, and triage turns them into requests with a trail back

Group S (Sources) · Size L · Verified against `f972c5e` (merge train Q) on 2026-10-25 · Owner decisions VOICE-Q1 to VOICE-Q7 in `questions.json`. This spec is written to the recommended answers and says where it does.

## Why this matters

- **For the person using Oracle.** S1 (`docs/questions.md:65`) decided that customer voice matters: "support tickets, CRM" (`docs/build-brief.md:125`, planned v1.2). Today a request reaches Oracle only when someone types it (New request, `web/app/requests/new`), when an interview produces it (C3), or when triage spots it in a person's Slack, meetings or docs (C1 "Found items", SQ10). What customers actually write to support and say to sales never arrives unless a person copies it. The research's loop (ask, decide, reply) starts with the asker's words; the H10 reply already has a place for them (`request_replies`).
- **For the product.** Requests already carry a `channel` of `support` or `sales` and a `requester_kind` of `customer` (`api/oracle/requests/models.py:48-61`) that nothing fills from a real system. Prioritisation counts mentions per request chain (C9); support volume per theme is the evidence a head of product most often lacks. H9 Pricing input notes "no CRM connector (S1 lists CRM as later)" (#516).
- **For engineering.** The pattern exists end to end:
  - per-person connections and OAuth (`api/oracle/connections/`, S5);
  - the connector protocol with cursors, checkpoints, narrowing and rate limits (`api/oracle/sources/base.py`), five connectors to copy (`api/oracle/sources/connectors/`);
  - triage that finds request candidates in the starter's own sources and files them with a 400-character excerpt (`api/oracle/requests/triage.py:360-440`, `request_candidates`).

  This pick adds two connectors, three item kinds, a personal-details filter at ingest, a retention sweep and a channel hint for triage. It sends nothing outside the company and writes nothing back to the support desk or CRM.

## Verified current state

| Piece | Where | State on `f972c5e` |
|---|---|---|
| Source kinds | `api/oracle/sources/models.py:25` | `upload, github, slack, notion, fireflies, google_docs` |
| Item kinds | `api/oracle/sources/models.py:27-39` | `file, page, message, thread, issue, pull_request, release, milestone, readme, doc, transcript`; no ticket, conversation, deal or note |
| Who sees a source | `Source` docstring `:48-52`; S3 revised 2026-10-21 (AUD-9) | Only the person who added it; others see what they share at S6 levels; owners see counts only (A2 coverage, `GET /v1/sources/coverage`) |
| Providers | `api/oracle/connections/providers.py:270-345` | github, slack, notion, fireflies, google. No support desk or CRM |
| Connector protocol | `api/oracle/sources/base.py:1-60, 284-305` | `validate`, `sync` yielding `ItemUpsert` / `ItemDelete` / `ItemUnavailable` / `CursorCheckpoint`; optional `scope`, `normalize_config`, `check_config`, `prunes` |
| Sync | `POST /v1/sources/{id}/sync` (`api/oracle/sources/router.py:343-372`), `sync.sync_source` | On demand (Sync now); background sync is S4 "later batch" (`docs/build-brief.md:128`) |
| Pickers | `web/app/settings/sources/` (`_slack-picker.tsx`, `FirefliesPicker.tsx`, `NotionPicker.tsx`, `_github-picker.tsx`) | One browse picker per kind, backed by `api/oracle/connections/browse_*.py` |
| Personal details | `SourceItem.author` (`models.py:111`) | Stored as the source gives it. No filter for email addresses or phone numbers anywhere in sources |
| Retention | (none) | Items live until the source is narrowed or deleted; `delete_source` (`api/oracle/sources/service.py:824-845`) records a revocation, releases links and deletes items. No age-based deletion |
| Requests | `api/oracle/requests/models.py:123-186` | `channel` includes `support` and `sales`; `requester_name` as given; `requester_kind` customer/team/unknown; `source_item_id` plus copied `source_title`, `source_url`, `source_kind`, `source_excerpt` (≤ 400) kept when the item goes |
| Triage | `api/oracle/requests/triage.py` | Classify now (approver) reads the starter's own sources and writes `found` items as `request_candidates` of the starter; the daily 07:00 run has no `read:sources` and finds nothing (SQ9). Filing shares the item in full (SQ10) |
| Candidates | `GET /v1/request-candidates`, `POST /v1/request-candidates/{id}/file`, `.../dismiss` (`requests/router.py:457-500`) | Shown to their owner only |

Counts: 0 support or CRM sources, 0 ticket items, 0 requests with `channel = support` filled from a system.

## What to build

### Concepts (plain words, used on screen)

- **Support desk**: where customers write to the company. First connector **Intercom** (VOICE-Q1, recommended), with **Zendesk** as the second lane behind the same item shape. Help Scout and Front are listed as later options.
- **CRM**: where sales keeps accounts and deals. First connector **HubSpot** (VOICE-Q2, recommended). Salesforce is a later lane.
- **Conversation**: one support ticket or chat, as one item: its subject, the customer's messages and the team's public replies, with tags and its state. Internal notes are not read (VOICE-Q3, recommended).
- **Deal note**: one CRM note, call summary or the "lost reason" of a closed deal, as one item, attached to a company label, not to a person.
- **Customer label**: how a customer appears in Oracle: the company's name from the CRM or support desk ("Northwind Labs"), or "Customer 14" when there is none. Never an email address, phone number or person's full name (VOICE-Q4, recommended).

### What is read

| Tool | Read | Not read |
|---|---|---|
| Intercom | conversations in the picked inboxes (team inboxes) or with picked tags, in a date window (default last 180 days, then new ones); per conversation: subject or first line, customer parts, admin public replies, tags, state, created and updated times, company name | internal notes, attachments, contacts list, custom attributes, articles, any conversation outside the picks |
| Zendesk | tickets in picked groups or views, or with picked tags, same window: subject, public comments, tags, status, organisation name | private (internal) comments, attachments, user profiles, satisfaction comments, macros |
| HubSpot | notes, call summaries and emails **logged on deals** in picked pipelines; closed-lost and closed-won reasons; the deal's company name, stage and amount band | contacts' emails and phone numbers, marketing emails, tickets (use the support desk), quotes, files, every object outside the picked pipelines |

- Scopes asked are read-only (for example Intercom `read conversations`, Zendesk `read`, HubSpot `crm.objects.deals.read crm.objects.companies.read`); the lane lists the exact scopes it asks for in its report, checked against each vendor's docs. **Oracle never writes back** to these tools: no tags, no replies, no notes.
- A source holds at most 5,000 conversations or notes per sync window (422 above at save time, with "Narrow the inboxes, tags or dates"), so a triage run over it stays within its estimate.

### How it lands as source items

- `SOURCE_KINDS` gains `intercom`, `zendesk`, `hubspot`; `ITEM_KINDS` gains `conversation` and `deal_note`. Migration `0056_customer_voice` (or the next free number after TRK's) widens both CHECKs and adds `source_items.customer_label text` and `source_items.retain_until timestamptz`.
- Connectors `api/oracle/sources/connectors/{intercom,zendesk,hubspot}.py` follow `base.Connector`: cursor = the tool's `updated_at` high-water mark; `scope(config)` = picked inboxes, groups, pipelines, tags and window, so narrowing deletes what falls outside (S5); `ConnectorRateLimited` with the tool's `Retry-After`.
- Item content is plain text, oldest message first, each part prefixed "Customer:" or "Team:", the tags on one line, then "State: Open". `external_id` = `<tool>:<workspace>:<conversation id>`; `url` = the tool's own link (opens only for people with access there).
- **Personal-details filter at ingest** (new `api/oracle/sources/redact.py`, applied by the three connectors before `ItemUpsert`):
  - email addresses → `[email]`, phone numbers → `[phone]`, card-like and IBAN-like numbers → `[number]`;
  - the customer person's name in the item header and `author` → the customer label; team members keep their display names;
  - signatures after a standard delimiter are dropped.

  The original is never stored. It is a deterministic filter with no model call; its patterns are unit-tested on invented samples. A name inside free text may survive; the setup sheet says so in one line.
- Pickers: `web/app/settings/sources/_intercom-picker.tsx`, `_zendesk-picker.tsx`, `_hubspot-picker.tsx` on the `_browse-list.tsx` pattern, backed by `api/oracle/connections/browse_{intercom,zendesk,hubspot}.py` (lists inboxes, groups, views, pipelines and tags; reads no conversation; routes `/v1/connections/{connection_id}/<tool>/...` as `browse_slack.py:86` does, registered in `api/oracle/main.py`).
- Visibility is unchanged (S3, AUD-9): a support source is its owner's. Typically the support lead or a founder connects it. Owners see its counts in A2 coverage, never its inbox or tag names.

### How it becomes requests (C1, #150)

- Nothing becomes a request on its own. Triage keeps its rule: **Classify now** by the source's owner reads their own sources, and found conversations and notes become that person's `request_candidates` (VOICE-Q5, recommended: **as built, plus a tag hint**).
- **Tag hint**: a support source's config may name up to 5 tags or Intercom/Zendesk fields that mean "feature request" (for example `feature-request`, `product-feedback`). Triage's prompt receives the hint, and items carrying such a tag are offered first. They still arrive as candidates, not requests.
- **Filing a candidate** from a conversation or deal note (existing `POST /v1/request-candidates/{id}/file`):
  - `channel` = `support` for intercom and zendesk, `sales` for hubspot;
  - `requester_kind` = `customer`;
  - `requester_name` = the customer label (never a person's name);
  - `verified` = false (the customer's words, not checked; as for interview answers, V2e);
  - `source_title`, `source_url`, `source_kind`, `source_excerpt` copied from the filtered item (≤ 400 characters), as SQ10 decided.
- **Duplicates and volume**: triage's suggestion may merge a filed request into an existing one; each merge counts as a mention on the root, so ten tickets asking for the same export count as ten mentions with ten trails. The Requests screen shows "Support · 10 mentions" on the chain.
- **Daily triage** still reads no sources (SQ9). A support lead who wants daily candidates runs Classify now; scheduled candidate finding is a follow-up question for when S4 background sync lands.
- **Deal lost reasons**: a closed-lost reason that names a missing feature is a candidate like any other. Feeding H9's win and loss table from HubSpot is out of this pick (VOICE-Q6, recommended: **requests only; win/loss import later**).
- Replies: H10 drafts a reply for the people who asked; a request filed from a conversation shows "Asked in Intercom" with the link. Oracle sends nothing; a person replies in the support desk and marks it sent (unchanged rule, `requests/models.py:13-16`).

### Privacy and retention

- **Retention (VOICE-Q7, recommended: 12 months)**: `retain_until` = the item's `occurred_at` + the company setting `customer_voice_retention_days` (`tenant_settings_api.py` `DEFAULTS`: 365; owners; 90-730).
  - A daily ticker step `sources.expire_customer_voice(db)` soft-deletes expired items through the same path narrowing uses (revocation recorded, links released, so the publish gate and staleness behave as for a removed item), then purges their versions' text after 30 days.
  - A filed request keeps its copied excerpt, label and link (they belong to the request, as SQ10 decided). Baseline evidence that cited the item shows "Source removed after 12 months".
  - Applies to `intercom`, `zendesk`, `hubspot` sources only; other kinds are unchanged.
- **Agents**: runs read these items only under the run rules (S6 (3)): their starter's own, at the item's sharing level. The filter has run before any agent sees the text. Customer words are data, never instructions (the triage prompt already says so; the lane adds the line to every flow with `read:sources`).
- **Nothing leaves the company**: no write-back, no third-party enrichment, no lookup of a customer label. Model calls follow V2c (SwarmCloud, Claude only, P3), the same path as today's Slack and meeting text.
- **Disconnect** deletes the source and its items at once (`delete_source`, unchanged), and the setup sheet says so.
- **Audit**: `source.created` records the tool and the picks' count, never inbox names; `customer_voice.expired` records counts per sweep.

### Screens and copy

- **Settings › Connections**: Intercom, Zendesk and HubSpot cards (connect with the tool's sign-in, or a pasted token until the OAuth app is registered, as S5 allows).
- **Settings › Sources › Add source › Support desk / CRM**: pick inboxes, groups or pipelines, tags, a date window (default 180 days), the feature-request tags; a summary "About 1,240 conversations · emails and phone numbers are removed before Oracle stores them · kept 12 months". Save, then Sync now.
- **Source item view** (`GET /v1/source-items/{id}`): shows the filtered text, the customer label, "Removed: 3 emails, 1 phone number", and "Deleted on <date>" from `retain_until`.
- **Requests**: channel chips "Support" and "Sales" with the tool's icon; the candidate list (owner only) groups by source.
- Phone: picker lists stack; the candidate row shows label, first line and File.

### API

```
GET  /v1/connections/providers                       -> + intercom, zendesk, hubspot
GET  /v1/connections/{connection_id}/intercom/inboxes | /intercom/tags   (the browse_slack.py pattern; each router registered in api/oracle/main.py:226-237)
GET  /v1/connections/{connection_id}/zendesk/groups | /zendesk/views | /zendesk/tags
GET  /v1/connections/{connection_id}/hubspot/pipelines
POST /v1/sources {kind: intercom|zendesk|hubspot, config: {inboxes|groups|pipelines, tags, since, request_tags}}
POST /v1/sources/{id}/sync                            (unchanged)
GET  /v1/source-items/{id}                            -> + customer_label, redactions: {email, phone, number}, retain_until
PUT  /v1/settings/customer_voice_retention_days       (owner, 90-730)
```

`make openapi` regenerates the client; the web mock gains fake Intercom, Zendesk and HubSpot browse and sync data built from invented companies.

## Roles

| Who | Can |
|---|---|
| Any member who may add sources | connect their own support desk or CRM, pick what is read, Sync now, see their own items and candidates |
| Approver | Classify now over their own sources; file and dismiss their candidates; triage requests as today |
| Owner | set the retention days; see per-member counts in coverage (never names or items) |
| Others | see a filed request's text, customer label, link and 400-character excerpt (SQ10); never the source or its other items |
| Oracle (ticker) | expire items past retention; never files requests |
| Agents | read only their starter's items at the sharing level, already filtered |

## Acceptance criteria

1. A member connects the fake Intercom on Settings › Connections, adds a source picking one inbox and one tag over 180 days, and sees the count estimate and the privacy line before saving.
2. Sync now stores one `conversation` item per conversation in the picks; internal notes, attachments and conversations outside the picks are absent (asserted on the fake's fixtures).
3. Every stored item has emails, phone numbers and card-like numbers replaced, and the customer person's name replaced by the label; the item view shows the redaction counts. No original value is stored in any table (a test scans the item and version rows).
4. Narrowing the picks deletes the items now outside them; disconnecting deletes the source and its items.
5. Classify now by the source's owner turns a conversation asking for a feature into a candidate visible to that person only; filing it creates a request with channel Support, requester kind customer, the label as requester, verified false, and a ≤ 400-character excerpt.
6. Another member sees the filed request with label, link and excerpt, and cannot open the source or its other items (404).
7. Two filed requests about the same thing merge, and the root shows 2 mentions with both trails.
8. The daily triage run reads no support items (its token lacks `read:sources`, unchanged).
9. With retention set to 90 days, an item older than that is soft-deleted by the next daily sweep and its text purged 30 days later; the filed request keeps its excerpt; cited evidence shows "Source removed after 90 days".
10. HubSpot: a deal note on a picked pipeline lands as a `deal_note` item with the company label, and filing it gives channel Sales. Contacts' emails are never requested (asserted on the fake's request log).
11. Oracle makes no write call to any of the three tools (the fakes fail any POST, PUT, PATCH or DELETE).
12. A Playwright test drives the built app's UI through criteria 1, 3, 5 and 6 against the fakes, as a person would. No API calls or database edits in the test.
13. `make test`, `make lint`, `make openapi`, web ESLint, `tsc` and Playwright pass.

## Lanes

| Lane | Size | Owns | Depends on |
|---|---|---|---|
| `voice-core` | S | migration (kinds, `customer_label`, `retain_until`), `api/oracle/sources/redact.py` and its tests, the retention setting and daily sweep in the ticker, item view fields | none |
| `voice-intercom` | M | `intercom` provider, `browse_intercom.py`, `connectors/intercom.py`, `_intercom-picker.tsx`, fake Intercom, the tag hint in triage (`requests/triage.py` prompt and config), channel mapping on file | `voice-core` |
| `voice-hubspot` | M | `hubspot` provider, `browse_hubspot.py`, `connectors/hubspot.py`, `_hubspot-picker.tsx`, fake HubSpot, `deal_note` rendering | `voice-core` |
| `voice-zendesk` | M | `zendesk` provider (subdomain + OAuth), browse, connector, picker, fake | `voice-core`; only if VOICE-Q1 picks it |
| `voice-e2e` | S | the Playwright journey across connect, sync, classify, file and view as another member; Requests channel chips | `voice-intercom` |

## Owner decisions (in `questions.json`)

- **VOICE-Q1 Which support desk first**: recommended **Intercom first, Zendesk next**.
- **VOICE-Q2 Which CRM**: recommended **HubSpot**.
- **VOICE-Q3 What of a conversation is read**: recommended **customer messages and public replies; no internal notes or attachments**.
- **VOICE-Q4 How customers appear**: recommended **company label, personal details stripped at ingest**.
- **VOICE-Q5 How tickets become requests**: recommended **candidates as built, plus a feature-request tag hint**.
- **VOICE-Q6 CRM deals and win/loss**: recommended **requests only now; H9 win/loss import later**.
- **VOICE-Q7 How long items are kept**: recommended **12 months, owner-adjustable 90-730 days**.

## What it unblocks

- C1 Requests fed by real customer words with a trail, and mention counts that reflect support volume (C9 priorities, SQ12 pushback has evidence to read).
- H10 Reasoned no: replies to customers who asked in support, with the link to answer them there.
- H9 Pricing input: a later win/loss import from the CRM (VOICE-Q6), and willingness-to-pay statements in support and sales notes the memo run may read.
- H7 Competitive digest: mentions of alternatives in filed support requests (its `competitor_mentions` reads requests).
- S4 Freshness: the first sources where background sync clearly pays off.
