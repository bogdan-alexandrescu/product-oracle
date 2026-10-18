# Product Oracle v1 — build plan

Status: DRAFT. Parent design: [`docs/design.md`](design.md). Decisions:
[`docs/questions.md`](questions.md). The MVP ([`docs/mvp-app.md`](mvp-app.md)) is
built and deployed; v1 builds on it, keeping its conventions: FastAPI + async
SQLAlchemy + Alembic, `tenant_id` on every table through `oracle.tenancy`, Next.js
App Router + Tailwind, pytest against Postgres, Playwright in mock mode, generated
API types (`make openapi`). The repo is public: fixtures use generic content only.

## What v1 adds

From the design's phasing table (v1 row), in build order:

1. **Members and roles (C2 Approvals).** Roles owner / approver / commenter /
   viewer, enforced on every endpoint; invites that pre-assign a role to an email,
   so a Google (IAP) sign-in lands with the right role.
2. **Connections and sources (S1–S5).** Integrations are **per user** (S5, revised
   2026-10-17): each person connects their own GitHub, Slack, Notion, Fireflies and
   Google Docs accounts, through each tool's OAuth or a personal token, and picks what
   to pull in. Oracle's own Claude calls run on the company's Claude account pool
   (see "Claude accounts"), not on a connection. Connectors for uploads, GitHub, Slack, Notion, Fireflies and Google Docs;
   incremental sync with cursors; item versions
   so a run can pin the snapshot it started on (S4 Freshness); full-text search.
   DMs are never ingested; source ACL metadata is stored (S3 Visibility).
3. **Baseline graph (B1–B3).** Typed entities (goal, product, feature, requirement,
   constraint, decision, person) and edges (supports, depends_on, blocks, part_of,
   owned_by), evidence on every node and edge, user corrections locked, agent
   writes to locked items become proposals, conflicts resolved by precedence (code >
   tracker > docs > chat; newer beats older) with only material ones escalated, and
   a traceability report: features that serve no confirmed goal are flagged.
4. **Prioritization (O3) and templates (O1).** Goal-weighted scoring by default,
   RICE / MoSCoW / WSJF selectable, dependency-ordered, every number explained.
   PRD **and roadmap** templates that users add, edit and delete, each versioned,
   with a set of built-ins drawn from `docs/research/` (popular formats in use
   today); starting a new PRD or roadmap draft asks which template to use. Every
   template follows O1c: no evidence in the body, a final Sources and data points
   section.
5. **MCP server (X1).** Streamable HTTP at `/mcp`, authenticated by API tokens and
   run-scoped, expiring run tokens; tools to search sources, read the baseline and
   documents, and propose changes.
6. **Runs on SwarmCloud (P2, W1, W2, P3).** Code-defined flows (Baseline → PRD,
   Feedback loop) with knobs (depth, agent roles, checkpoints, budget); one
   SwarmCloud workflow per segment between checkpoints until `await_input` (#1436)
   lands; cost estimate first, runs over $50 wait for approval, overrun past 1.5×
   the estimate pauses; an Inbox of checkpoints waiting on you.
7. **App navigation (I4).** Screens: Baseline, Runs, PRDs, Roadmap (v1.1),
   Inbox, Settings (Members, Sources, Templates).

## Boundary with SwarmCloud

Product Oracle and SwarmCloud are separate products. The only shared surface is how
agents running in SwarmCloud talk to Oracle: Oracle's MCP server (`/mcp`, run tokens)
and Oracle's calls to SwarmCloud's task and workflow API, all behind
`api/oracle/swarm/`. Oracle has no SwarmCloud accounts, tenancy, pool or vocabulary in
its product, data model, UI or docs; SwarmCloud is one agent runtime behind that
adapter, and it also happens to build Oracle's code lanes, as any CI service would.

Later batches: Slack pings and thread feedback (C1), the docked head-of-product chat
(I4), the roadmap flow and its HTML/PDF (v1.1), share links (O5), engineering
alignment (E1), SVG flows and wireframes (O2),
the GitHub code indexer via SwarmCloud's `indexer` profile (S2), the quality bar (T2).

## Data model added by Lane 0 (migration 0002)

Every table is `TenantScoped` unless noted.

- `users.role` widens to `owner | approver | commenter | viewer`.
  `api_tokens.role` (default `owner`) so a token acts with a role.
- `invites`: email (lowercased, unique per tenant while open), role, invited_by,
  accepted_at, revoked_at.
- `run_tokens`: run_id, token_hash (sha256, unique), scopes (text[]), expires_at,
  revoked_at, last_used_at. Scopes: `read:sources`, `read:baseline`,
  `read:documents`, `write:proposals`, `write:drafts`.
- `sources`: kind (`upload | github | slack | notion`), name, config (jsonb:
  the allowlist — repos, channel ids, root pages), status (`active | paused |
  error`), last_error, last_synced_at, cursor (jsonb).
- `source_credentials`: source_id (unique), ciphertext (bytea, Fernet key derived
  from `ORACLE_SECRET_KEY` with HKDF), key_version. Never returned by any endpoint.
- `source_items`: source_id, external_id (unique per source), kind (`file | page |
  message | thread | issue | pull_request | release | milestone | readme | doc`),
  title, url, author, acl (jsonb), occurred_at, source_updated_at, deleted_at,
  current_version_id.
- `source_item_versions`: item_id, title (copied from the item at write time),
  content (text), content_hash, fetched_at, and a generated `search` tsvector
  (`to_tsvector('english', title || ' ' || content)`) with a GIN index. A new version
  is written only when the content hash changes.
- `snapshots`: label, as_of (timestamptz), created_by. A pinned read selects, per
  item, the newest version with `fetched_at <= as_of`.
- `entities`: type, key (slug, unique per tenant + type), title, body, attrs
  (jsonb: goal metric/target/horizon/weight/owner; feature effort/confidence/
  status; ...), status (`proposed | confirmed | rejected`), origin (`user | agent |
  import`), locked (bool), locked_by, locked_at, run_id (nullable).
- `edges`: src_id, dst_id, type, attrs (jsonb; `supports` carries contribution
  0–3), status, origin, locked, run_id. Unique (src_id, dst_id, type).
- `evidence`: entity_id or edge_id (exactly one), source_item_id (nullable), url,
  excerpt, ref, retrieved_at.
- `entity_revisions`: entity_id or edge_id, before (jsonb), after (jsonb), actor,
  reason.
- `proposals`: target entity_id or edge_id (nullable for a new item), payload
  (jsonb), origin run_id, status (`open | accepted | rejected`), decided_by,
  decided_at. Agent writes to locked items land here.
- `conflicts`: entity_id or edge_id, field, claims (jsonb list of {value,
  evidence ids, source kind, observed_at}), resolution (jsonb), material (bool),
  status (`open | resolved | logged`).
- `templates`: key (unique), name. `template_versions`: template_id, version,
  body (markdown skeleton with section ids and guidance), required_sections
  (text[]), created_by. Seed `oracle-default` v1.
- `priority_snapshots`: method (`goal_weighted | rice | moscow | wsjf`), params
  (jsonb), ranking (jsonb), created_by.
- `runs`: flow (`baseline_to_prd | feedback_loop`), status (`draft | awaiting_approval
  | running | awaiting_checkpoint | paused_overrun | succeeded | failed |
  cancelled`), knobs (jsonb: depth, roles, checkpoints, budget_usd), snapshot_id,
  document_id (nullable), estimate_usd, spent_usd, created_by, started_at,
  finished_at, error.
- `run_segments`: run_id, seq, name, status, swarm_workflow_id, estimate_usd,
  cost_usd, artifacts (jsonb), started_at, finished_at, error.
- `checkpoints`: run_id, kind (`baseline_confirm | feature_set | priority_order |
  prd_review | eng_review`), status (`pending | approved | changes_requested |
  skipped`), approver_role, decided_by, decided_at, note, payload (jsonb).

## Amendments (migration 0003, 2026-10-17)

- **Connections are per user** (`connections`): one row per user per provider account
  (`github | slack | notion | fireflies | google | claude`), credential encrypted with
  `oracle.crypto`, `auth_mode` `oauth` (provider OAuth, refreshed) or `token` (a
  pasted personal token, or `claude setup-token` for a Claude plan). Replaces
  `source_credentials`.
- (Superseded by migration 0007: the `claude` provider and `default_claude_connection_id`
  are gone; Oracle's own Claude calls run on the Claude account pool.)
- **Sources are owned and private** (`sources.owner_user_id`, `connection_id`): what
  a user's connections pull in is visible only to that user (S3 revised). Others see
  it only as evidence the owner adds to the shared baseline (excerpt, url, ref), and a
  run or an MCP call reads the items of the user it acts for. Source kinds add
  `fireflies` and `google_docs`.
- **Confidence** (`evidence.confidence` + `confidence_factors` + `scored_at`,
  `entities.confidence`, `edges.confidence`): see the next section.
- **Templates and themes**: `templates.kind` (`prd | roadmap`), `description`,
  `builtin`, `archived_at` (delete = archive, so documents keep resolving); new
  `themes` (design tokens + CSS for app, HTML and PDF); `documents.kind` and
  `documents.theme`. Starting a PRD or roadmap draft asks for a template and a theme.
- **Company settings** (`tenant_settings`, key → JSON): `iap_default_role`
  (`commenter`), `default_claude_connection_id` (the Claude plan used when a user has
  none; the owner's own plan first), `confidence_weights`.

## Integration (migrations 0004-0005, 2026-10-17)

- **0004** (Lane D2): OAuth clients, codes and tokens for MCP clients. An OAuth access
  token (`poa_...`) works on `/mcp` and on the REST API as the approving user, with the
  role capped by the granted scope.
- **0005**: `api_tokens.user_id` (nullable). A token with a user acts as that user (their
  role, connections and sources), so `oracle sync` works with `ORACLE_API_TOKEN`; `make
  seed` mints its token for the admin. Tokens without a user act with their own role.
- A sync whose credential is rejected also marks the user's connection `expired` (with
  `last_error`). Disconnect revokes a grant Oracle obtained through GitHub, Slack or
  Google OAuth (best effort) before deleting Oracle's copy.
- A run's `baseline` segment merges its `baseline.yaml` through the baseline's YAML import
  as agent writes (locked items become proposals); priorities score unscored evidence
  through the baseline's confidence.

## Public-link evidence (migration 0006, owner's decision 2026-10-17)

Commenters and up attach evidence from **public links** without connecting an account:
public Notion pages (`notion.so`, `*.notion.site`), Google Docs shared with "anyone with
the link", and plain public web pages.

- `POST /v1/baseline/evidence/link` `{entity_id | edge_id, url, note?}`, `POST
  /v1/baseline/evidence/link/preview` (title, excerpt and confidence before saving,
  saves nothing) and `POST /v1/baseline/evidence/{id}/refresh` (fetch again, update the
  snapshot, rescore). Removing evidence stays with approvers.
- `oracle.baseline.public_links` fetches anonymously (no credential, cookie or
  environment proxy): `https` on port 443 only, no user info; every host, the first
  request's and each redirect's, must resolve to public addresses only (private,
  loopback, link-local, shared, reserved, multicast, mapped and NAT64 forms refused), and
  the transport connects only to the addresses it checked; timeouts per request and per
  fetch, a 2 MB cap after decompression, HTML or plain text only. Sign-in (401/403, a
  redirect to a sign-in page, Notion's 404 or app shell) is `not_public`: "This link is
  not public".
- Text: Google Docs through `/export?format=txt` (title from the export's file name);
  Notion from the page HTML it serves to link-preview bots (hence the `ProductOracleBot`
  user agent); other pages from `<main>`, else `<article>`, else the body without
  navigation, header, footer and scripts.
- `evidence.kind` (`notion | google_docs | web`) and `evidence.note`;
  `evidence_link_snapshots` keeps title, text, fetched_at and last_modified (the
  `Last-Modified` header, else `article:modified_time` / `og:updated_time` /
  `dateModified`); a refresh adds a snapshot only when the page changed. Confidence
  scores link evidence as its kind (`web` added to `DEFAULTS`: source 0.55, half-life 90
  days), freshness from last_modified else fetched_at, and each distinct link counts as
  a mention. The page is public, so every user sees the snapshot, unlike items from
  private connections.
- UI: "Add evidence link" in the Baseline feature drawer (with Refresh per link) and on
  each document section (pick the baseline item it supports).

## Agents and model calls (Bogdan, 2026-10-17)

- **Agents run in SwarmCloud.** Product Oracle orchestrates all of its agents in
  SwarmCloud, not in its own environment or a separate runtime; those agents use
  SwarmCloud's LLM providers. Runs execute as SwarmCloud workflows (one per segment
  until #1436). Until #1433 lands, agents cannot yet reach Oracle's data through `/mcp`.
- **Built-in model jobs run in Oracle.** Review-comment handling (classify, group,
  suggest resolutions, push back once per C1b), reporting (resolution reports, what
  changed since version N) and refinement (revise a section from accepted
  suggestions, keeping ids, O1c and O1e) run directly in Oracle as jobs.
- **Their provider is Oracle's Claude account pool,** managed exactly like SwarmCloud's
  account management (ported, for local personal use): see the next section.
- Data connections (GitHub, Slack, Notion, Fireflies, Google) stay per user.

## Claude accounts

The pool behind Oracle's built-in model jobs copies SwarmCloud's account management
exactly: the label rule, states `available | paused | draining | reauth_required`,
quota windows, holds and the hold log, browser sign-in with PKCE and a pasted code, the
paste route for Claude Code's saved login, the single-writer refresh sweep, usage
polling and `rate_limit_event` readings, staleness, the assignment policy and its
no-account reasons, swap and drain, the accounts screen and the CLI. Adapted for a
local, single-company app: no lending; credentials encrypted in Oracle's database; the
sweep runs from `oracle tick`; calls run through Claude Code headless with
`CLAUDE_CODE_OAUTH_TOKEN` set per call. The pool starts with the owner's account.

Built (migration 0007): `api/oracle/claude_accounts/`, `api/oracle/llm/gateway.py`,
`/v1/claude-accounts`, Settings > Claude accounts, `oracle accounts` and `oracle account
add|pause|resume|drain|remove`. See [claude-accounts.md](claude-accounts.md) for how it
works and every adaptation. Agent workflows still run in SwarmCloud on SwarmCloud's own
accounts; `ORACLE_RUNTIME` defaults to `swarmcloud`.

## Confidence

`api/oracle/confidence.py` (shared, already on `main`) scores a source item or a piece
of evidence from four factors, each 0–1, as a weighted mean so every number can be
explained: **source** kind (code and releases highest, then tracker, docs, meetings,
chat; planning documents get a bonus), **freshness** (halves every N days after the
latest timestamp, per kind, with a floor), **mentions** (independent sources stating
the same claim), and **goal impact** (the contribution of the goal link it supports).
Defaults live in `DEFAULTS`; a company overrides them in the `confidence_weights`
setting. The score sets how much a source weighs in outputs: search ranking
(`rank_weight`), conflict resolution (`prefer`, falling back to precedence on a tie),
a feature's priority confidence (mean of its evidence), the PRD's data-points table,
and agent guidance (claims under `low` are flagged).

## Lanes

Each lane is one SwarmCloud `claude-code` task, strategy `collect`, cloned from
`main` at a pinned commit. A lane owns only the paths listed; it may read anything.
No lane edits migrations or models, except Lane D2 which owns migration 0004 for its
OAuth tables; a lane that needs another column stops and says so in its report. Every
lane runs the full API suite, ruff (check + format), `make openapi`, web lint and
build, and writes a report to `$SWARM_ARTIFACTS_DIR/<lane>-report.md`. Product Oracle
words only: one company's Oracle, its users and their roles.

| Lane | Owns | Delivers |
|---|---|---|
| 0 Foundation (merged) | migrations 0002–0003, models, `authz`, `crypto`, `runtokens`, `confidence`, `sources/base.py`, app navigation | Data model, roles helper, encryption, run tokens, Connector protocol, router stubs |
| A Members | `api/oracle/members/`, role checks in `docs/`, `review/`, `export/`, `auth/iap.py` provisioning, `web/app/settings/members/` | Roles enforced everywhere; members + invites; Google sign-in without an invite gets `iap_default_role` (commenter) |
| K Connections | `api/oracle/connections/`, `api/oracle/llm/`, `api/oracle/tenant_settings*`, `web/app/settings/connections/` | Per-user connect / reconnect / disconnect (OAuth PKCE where configured, pasted token otherwise), token refresh, company settings API; its per-user Claude plan is replaced by the Claude account pool (integration workflow) |
| B1 Sources | `api/oracle/sources/` (not `connectors/`), `oracle sync` CLI, `web/app/settings/sources/`, `web/app/sources/` | Owner-scoped source registry, sync engine with versions and snapshots, uploads, item confidence, search ranked by relevance × confidence |
| B2a GitHub + Notion | `api/oracle/sources/connectors/github.py`, `notion.py` (+ fixtures, tests) | Connectors on the protocol, provider OAuth metadata, recorded-fixture tests |
| B2b Slack + Fireflies + Google Docs | `api/oracle/sources/connectors/slack.py`, `fireflies.py`, `google_docs.py` (+ fixtures, tests) | Same; Slack never ingests DMs |
| C Baseline | `api/oracle/baseline/`, `oracle baseline push/pull`, `web/app/baseline/` | Graph API, locks, proposals, conflicts resolved by confidence then precedence, evidence scoring, traceability, YAML import/export, Baseline screen |
| D1 MCP | `api/oracle/mcp/` (not `oauth/`) | `/mcp` Streamable HTTP; every REST operation as a tool (generated from the routes, so parity holds as routes are added) plus curated tools; API-token and run-token auth with scope checks |
| D2 MCP OAuth | `api/oracle/mcp/oauth/`, migration 0004, `web/app/oauth/` | OAuth 2.1 authorization server for MCP clients: metadata, dynamic client registration, authorization code + PKCE with a consent screen behind Google sign-in, tokens, refresh, revoke |
| E Runs | `api/oracle/runs/`, `api/oracle/swarm/`, `oracle tick` CLI, `web/app/runs/`, `web/app/inbox/` | Flow templates, estimates and approval, segments against a fake agent runtime until SwarmCloud #1433 lands, checkpoints, Runs + Inbox screens |
| F Priorities + templates | `api/oracle/priorities/`, `api/oracle/templates/`, `web/app/priorities/`, `web/app/settings/templates/`, `web/app/settings/themes/`, new-draft picker | Scoring methods with explanations (confidence from evidence), dependency order, snapshots; PRD + roadmap templates and themes (add / edit / delete) with built-ins from `docs/research/`; template + theme picker when a draft starts |

Merge order: A, K, B1, B2a, B2b, C, F, D1, D2, E, then one integration pass
(regenerate OpenAPI types, wire run artifacts into baseline import, end-to-end test).
