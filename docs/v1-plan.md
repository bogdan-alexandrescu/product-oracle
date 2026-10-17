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
2. **Sources (S1–S5).** A source registry with an admin allowlist; connectors for
   uploads, GitHub, Slack and Notion; incremental sync with cursors; item versions
   so a run can pin the snapshot it started on (S4 Freshness); full-text search.
   DMs are never ingested; source ACL metadata is stored (S3 Visibility).
3. **Baseline graph (B1–B3).** Typed entities (goal, product, feature, requirement,
   constraint, decision, person) and edges (supports, depends_on, blocks, part_of,
   owned_by), evidence on every node and edge, user corrections locked, agent
   writes to locked items become proposals, conflicts resolved by precedence (code >
   tracker > docs > chat; newer beats older) with only material ones escalated, and
   a traceability report: features that serve no confirmed goal are flagged.
4. **Prioritization (O3) and templates (O1).** Goal-weighted scoring by default,
   RICE / MoSCoW / WSJF selectable, dependency-ordered, every number explained;
   PRD templates with versions.
5. **MCP server (X1).** Streamable HTTP at `/mcp`, authenticated by API tokens and
   run-scoped, expiring run tokens; tools to search sources, read the baseline and
   documents, and propose changes.
6. **Runs on SwarmCloud (P2, W1, W2, P3).** Code-defined flows (Baseline → PRD,
   Feedback loop) with knobs (depth, agent roles, checkpoints, budget); one
   SwarmCloud workflow per segment between checkpoints until `await_input` (#1436)
   lands; cost estimate first, runs over $50 wait for approval, overrun past 1.5×
   the estimate pauses; an Inbox of checkpoints waiting on you.
7. **Workspace shell (I4).** Navigation: Baseline, Runs, PRDs, Roadmap (v1.1),
   Inbox, Settings (Members, Sources, Templates).

Later batches: Slack pings and thread feedback (C1), the docked head-of-product chat
(I4), the roadmap flow and its HTML/PDF (v1.1), share links (O5), engineering
alignment (E1), Fireflies and Google Docs connectors, SVG flows and wireframes (O2),
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

## Lanes

Each lane is one SwarmCloud `claude-code` task, strategy `collect`, cloned from
`main` after Lane 0 is merged. A lane owns only the paths listed; it may read
anything. No lane edits migrations or models (Lane 0 owns them): a lane that needs
a column stops and says so in its report. Every lane runs the full API suite, ruff
(check + format), `make openapi`, web lint and build, and writes a report to
`$SWARM_ARTIFACTS_DIR/<lane>-report.md`.

| Lane | Owns | Delivers |
|---|---|---|
| 0 Foundation | `api/migrations/`, models, `api/oracle/authz.py`, `api/oracle/crypto.py`, `api/oracle/runtokens.py`, `api/oracle/sources/base.py`, package skeletons, `api/pyproject.toml` + locks, web shell (`web/app/layout.tsx`, nav, route stubs) | Migration 0002 and models above; `require_role()`; credential encryption; run-token mint/verify; the `Connector` protocol; router stubs; workspace navigation |
| A Members | `api/oracle/members/`, role checks in `docs/`, `review/`, `export/`, IAP provisioning by invite, `web/app/settings/members/` | Roles enforced everywhere; members + invites API and UI |
| B1 Sources | `api/oracle/sources/` (not `connectors/`), `oracle sync` CLI, `web/app/settings/sources/`, `web/app/sources/` | Source registry, credentials, sync engine with versions and snapshots, uploads, search API + UI |
| B2 Connectors | `api/oracle/sources/connectors/` | GitHub, Slack, Notion connectors on the `Connector` protocol, tested on recorded fixtures |
| C Baseline | `api/oracle/baseline/`, `oracle baseline push/pull`, `web/app/baseline/` | Graph API, locks, proposals, conflicts, traceability, YAML import/export, Baseline screen |
| D MCP | `api/oracle/mcp/` | `/mcp` Streamable HTTP server, token + run-token auth, read and propose tools, contract tests |
| E Runs | `api/oracle/runs/`, `api/oracle/swarm/`, `oracle tick` CLI, `web/app/runs/`, `web/app/inbox/` | Flow templates, estimates and approval, segment execution against SwarmCloud (fake in tests), checkpoints, Runs + Inbox screens |
| F Priorities | `api/oracle/priorities/`, `api/oracle/templates/`, `web/app/priorities/`, `web/app/settings/templates/` | Scoring methods with explanations, dependency order, snapshots; template registry |

Merge order after the parallel lanes: A, B1, B2, C, F, D, E, then one integration pass
(regenerate OpenAPI types, wire run artifacts into baseline import, end-to-end test).
