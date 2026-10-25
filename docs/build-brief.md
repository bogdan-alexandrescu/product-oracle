# Product Oracle — build brief and reuse catalogue

**For an agent drafting a new build brief.** Reuse what is listed here before designing
anything new. Each component below says where it lives, what it does, its interface, how
finished it is, and what it is coupled to. Decisions are cited by their ID in
[`docs/questions.md`](questions.md), which is the source of truth when this page and the
code disagree. State as of 2026-10-19, `main` at the "SwarmCloud interface" commits after
`ac44d5c`.

## 1. What Oracle is

An AI head of product. It turns a company's code, conversations and docs into a
**baseline** that links company goals to products to features. It then runs agent flows
that turn that baseline into a prioritized feature set, a **PRD** reviewed and revised
until approved, and a **roadmap** built from the approved PRD. Everything is exposed
three ways: a web app, a full REST API, and an MCP server. Agents run in SwarmCloud;
Oracle's own model jobs (review comments, reporting, refinement) run on Oracle's Claude
account pool.

- **Live:** `https://oracle.swarm.saga.xyz` (Cloud Run behind a load balancer with IAP).
  `/mcp` and the OAuth endpoints are public.
- **Size:** API ~32.5k lines of Python across 18 packages, 44 tables, ~115 REST routes,
  161 MCP tools. Web app: Next.js 16 / React 19, 27 pages, 31 components.
- **Tests:** 1145 API tests on Postgres, PDF rendering included; 96 Playwright tests
  against a mock API.
- **Shape:** one company per deployment (single tenant), with users in roles viewer <
  commenter < approver < owner.

## 2. Constraints any reuse inherits

- **Separate from SwarmCloud.** The only shared surface is the agent runtime API and
  Oracle's MCP server ([`swarmcloud-interface.md`](swarmcloud-interface.md)). Never use
  SwarmCloud words in Oracle's product: no "workspace", no tenants in SwarmCloud's sense.
  Oracle's words are a company, its users and their roles.
- **No company or customer data in code, GitHub or agent prompts.** It lives in a
  gitignored `private/` folder only.
- **Evidence never sits in a document's body (O1c).** A final "Sources and data points"
  section holds every source, data point and the evidence by section. Body text may state
  numbers (O1e).
- **Brief and full layers (O1f, O1g).** Every document has a slide-sized brief layer and a
  full layer. Present mode shows one brief section per slide. Presenter notes come only
  from `notes` blocks.
- **Templates (O1d) and roadmap shape (O4).** Seven built-in PRD templates and five
  roadmap templates, with a picker. The default roadmap is Now/Next/Later on the planning
  horizons. Roadmaps are built from an approved PRD (O4b).
- **Connections are per user (S5).** Disconnecting revokes only Oracle's own grants
  (S5b).
- **Agents run in SwarmCloud; built-in jobs run on Oracle's Claude account pool (P3b).**
  Runs show a cost estimate first, and runs above $50 wait for an owner (P3).
- **Full REST/MCP parity, with OAuth for MCP (I2).** MCP's default scope is read and
  write.
- **Review discipline.** Every PR is reviewed before merge, tests are written to fail
  first, and the API is migrated by its own startup, never before the new image is live
  (§9).

## 3. Architecture

| Layer | What | Where |
|---|---|---|
| API | FastAPI, SQLAlchemy 2 async, asyncpg, Alembic (linear `0001`–`0012`), Pydantic 2 | `api/oracle/`, `api/migrations/` |
| Docs and exports | markdown-it, Jinja2, WeasyPrint 70 (PDF), python-pptx, pypdf | `api/oracle/docs/`, `api/oracle/export/` |
| MCP | official `mcp` SDK, Streamable HTTP | `api/oracle/mcp/` |
| Web | Next.js 16 app router, React 19, Tailwind 4, typed client from OpenAPI (`openapi-fetch` + `openapi-typescript`) | `web/app/`, `web/components/`, `web/lib/api/` |
| CLI | `oracle` (push/pull drafts, sync, baseline YAML, Claude accounts, tick) | `api/oracle/cli/` |
| Runtime | Cloud Run (api, web), Cloud SQL Postgres 16, HTTPS load balancer with IAP on the app; a second backend without IAP for `/mcp`, `/oauth/{register,token,revoke}` and `/.well-known/*` | deploy scripts are local-only (`private/deploy/`); they name company infrastructure |

**Request path:** every `/v1` route goes through
1. auth: IAP header, session cookie, API token, OAuth access token or run token;
2. a role check (`oracle/authz.py`);
3. a tenant-scoped session (`oracle/tenancy.py`).

MCP tools are those same routes, called in-process (§5, MCP server).

## 4. Data sources and inputs

Everything Oracle reads, as built and as planned. Every connector is **per user** (S5):
each person connects their own account, and disconnecting revokes only Oracle's own
grants (S5b).

Common rules for all sources:
- **Admin allowlist (S3):** only the channels, spaces, repos and folders an admin
  allowlists are read. What is ingested is visible company-wide in Oracle, and each
  source's access metadata is stored.
- **Incremental sync with cursors (S4):** every item is versioned, and a run pins the
  snapshot it started on. Sync runs on demand, from the app, the API or `oracle sync`.
- **Credentials** are encrypted at rest.
- **Confidence:** every item is scored by source kind, freshness, independent mentions
  and goal impact. A company can tune the weights.

### Built

| Source | What it reads | How it connects |
|---|---|---|
| GitHub | README and docs, issues, pull requests, releases and milestones of allowlisted repos | OAuth, or a fine-grained personal token |
| Slack | Allowlisted public and private channels. **Direct and group messages are never read** (S3) | User or bot token, through Slack OAuth |
| Notion | Pages under allowlisted root pages and databases (rows included), as markdown | OAuth, or an internal integration token |
| Fireflies | Meeting transcripts: summary, action items, keywords and the transcript; optional date and title filters | API key |
| Google Docs | Docs in allowlisted Drive folders (recursively), plus single docs | Google OAuth, refreshed automatically |
| Uploads | `.md`, `.markdown`, `.txt` and `.pdf` files; re-uploading a file versions it | Upload in the app or the API |
| Public links | Public Notion pages, public Google Docs and public web pages, which commenters attach as evidence without connecting an account (C2b); weighted 0.7 (C2c) | None: fetched as a public link |

### Other inputs (built)

- **Baseline:**
  - edits and confirmations in the app;
  - baseline YAML import (`oracle baseline push`, API);
  - agent proposals through MCP. Locked items turn those into proposals. Accepting a
    proposal applies it, and the item is then locked against Oracle's changes until a
    person unlocks it.
- **Drafts written outside a run:** markdown import through `oracle push`, `POST
  /v1/documents/{doc}/versions` or the MCP `import_version` tool. Citations point at
  sources; `resolutions` closes feedback.
- **Review:** inline comments, section verdicts, suggestions and evidence links, by role.
- **Company setup:** settings (confidence weights, new-draft defaults, job settings),
  templates and themes.
- **Not data, but inputs:** a Claude plan per user, and Oracle's Claude account pool for
  its own model jobs.

### Planned (decided, not built)

| Input | What | Decision | Phase in `design.md` |
|---|---|---|---|
| Engineering tracker, two-way | Linear or Jira: approved PRD → epics and issues; status, estimates and plan read back; drift flagged both ways | E1, S1 | v1.1 |
| Code understanding | A capability map per repo (modules, APIs, data models, flags, jobs) built by a SwarmCloud indexer task, refreshed on merge; GitHub App auth | S2 | later batch |
| Design | Figma, read (and frames written, O6) | S1, O6 | v1.2 |
| Product analytics | The tool is chosen during dogfood setup | S1 | v1.2 |
| Customer voice | Support tickets, CRM | S1 | v1.2 |
| Slack feedback | Draft-ready pings; thread replies become feedback items | C1 | later batch |
| Goals interview | Asks people where goals are missing or unmeasurable | B2 | later batch |
| Freshness | Webhooks and background polling instead of on-demand sync; "N new items since draft k, refresh?" between drafts | S4 | later batch |
| Per-user access mirroring | Each user sees only what the source lets them see (access metadata is already stored) | S3 | before selling |

## 5. Reuse catalogue

Maturity key:
- **prod**: deployed and exercised;
- **tested**: built with tests, not yet used at scale;
- **partial**: works, with known gaps listed;
- **spec**: designed, not built.

### Platform

**Tenancy and models** (`oracle/tenancy.py`, `oracle/db.py`, `oracle/models.py`). Prod.
- Every table is `TenantScoped`, and every query is scoped to the company.
- Reuse it as is for any multi-table product; it is generic.

**Auth and roles** (`oracle/auth/`, `oracle/authz.py`). Prod.
- Accepts Google IAP sign-in (auto-provisioning by domain), a session cookie, API tokens
  with a role, OAuth access tokens and run tokens.
- Roles are viewer < commenter < approver < owner.
- Generic: reusable for any IAP-fronted app.

**Members and invites** (`oracle/members/`). Prod.
- Role management and invites.

**Company settings** (`oracle/tenant_settings*.py`). Prod.
- One JSON value per key, owner-only writes. Used for confidence weights, draft defaults
  and job settings.

**Per-user preferences** (`oracle/preferences/`). Prod.
- `/v1/me/preferences`, currently the document view (brief or full).

**Audit log** (`oracle/audit.py`). Prod.
- `audit_events` on every write that matters.

**Encryption at rest** (`oracle/crypto.py`). Prod.
- For source and connection credentials.

### MCP server and OAuth 2.1

**MCP server** (`oracle/mcp/server.py`, `oracle/mcp/tools.py`). Prod.
- **One tool per OpenAPI operation**, generated from the live route table. A new route
  becomes a tool automatically and runs through the same role checks.
- This is the most reusable piece: it gives any FastAPI app an MCP server.

**OAuth for MCP** (`oracle/mcp/oauth/`). Prod.
- RFC 8414 and RFC 9728 discovery, dynamic client registration, PKCE (S256), refresh
  rotation and revocation.
- A consent screen sits behind IAP (`web/app/oauth/consent`).
- Verified end to end with Claude Code.

**Run tokens** (`oracle/runtokens.py`). Tested.
- Short-lived, run-scoped credentials for agents calling `/mcp`.
- Revoked when the run ends.

### Knowledge

**Sources and sync** (`oracle/sources/`). Partial.
- A source registry, incremental sync with cursors, item versions and snapshots (a run
  pins the snapshot it started on), full-text search ranked by confidence, and uploads.
- Connectors: GitHub, Slack, Notion, Fireflies, Google Docs (`sources/connectors/`); every source and input, built and planned, is in §4.
- They are tested against fixtures; live use of each depends on per-user connections.

**Per-user connections** (`oracle/connections/`). Tested.
- OAuth or token connections per user, per provider (S5).
- Also connects a Claude plan.

**Confidence scoring** (`oracle/confidence.py`). Prod.
- A weighted mean of source kind, freshness half-life, independent mentions and goal
  impact.
- A company can override the weights.
- `rank_weight`, `prefer` and `aggregate` drive search, conflicts and priorities.
- Small and generic.

**Baseline graph** (`oracle/baseline/`). Tested.
- Typed entities (goal, product, feature, requirement, constraint, decision, person) and
  typed edges.
- Evidence on every node and edge.
- Locked items turn agent writes into proposals. Accepting a proposal applies it, and the
  item is then locked against Oracle's changes until a person unlocks it.
- Conflicts are resolved by precedence and confidence.
- A traceability report flags features that serve no goal.
- YAML import and export, also through the CLI.

**Priorities** (`oracle/priorities/`). Tested.
- Goal-weighted scoring by default; RICE, MoSCoW and WSJF selectable.
- Dependency order, explained numbers, snapshots.

### Documents

**Document model** (`oracle/docs/`). Prod.
- Markdown drafts with YAML front matter and `{#id}` headings are parsed into sections,
  citations and versions.
- Also handled: brief and detail layers (`docs/layers.py`), provenance (a roadmap version
  records its PRD version), and section diffs (`docs/diff.py`).
- An import is refused when its kind doesn't match the document. A `resolutions` list in
  front matter closes feedback items.

**Templates and themes** (`oracle/templates/`). Prod.
- 12 built-in templates (`docs/research/templates/`), versioned. Companies add, edit and
  archive their own. Validation, brief markers, and a picker with recommendations.
- 6 built-in themes: design tokens plus validated CSS and slide CSS. The CSS checks are
  linear-time and refuse outside URLs.
- The built-in upgrade leaves templates a company has edited or archived untouched.

**Review and feedback** (`oracle/review/`). Prod.
- Comments and section verdicts, by role. Feedback items with resolutions.
- The feedback package: what an agent pulls to write the next draft.
- Public-link evidence from commenters (C2b, C2c).

**Exports** (`oracle/export/`). Prod.
- HTML, PDF (WeasyPrint), markdown, a deck as PDF slides, and PPTX.
- Brief and full layers, a version banner, and the Sources and data points appendix.
- Themed page layout, including a repeating page header.
- PDF fetches load nothing from outside (`data:` URLs only).

**Present mode** (`web/components/PresentMode.tsx`, `web/app/documents/[doc]/v/[n]/present`). Prod.
- One brief section per slide, keyboard navigation, a presenter view, an audience window.

### Agent work

**Runs and flows** (`oracle/runs/`). Partial.
- Code-defined flows: `baseline_to_prd`, `feedback_loop` and `prd_to_roadmap`.
- Knobs (depth, roles, checkpoints, budget), estimates and owner approval over $50.
- Segments, with checkpoints in the Inbox.
- Each draft is imported with its provenance, and each run gets its own MCP token.
- While SwarmCloud's switches are off, a run is one workflow per segment with prompt-only
  context. Once they are on (adapter v2, `oracle/runs/workflow.py`), a run is one
  workflow whose checkpoints wait for a person in SwarmCloud and are answered from the
  Inbox; agents read earlier outputs through `/mcp` with the run token.

**Agent runtime adapter** (`oracle/swarm/`). Partial.
- A `Runtime` protocol, with a SwarmCloud implementation and a deterministic fake for
  tests.
- v2 is built behind feature detection and tested against a fake SwarmCloud
  ([`swarmcloud-interface.md`](swarmcloud-interface.md)). It covers ID-token auth,
  caller MCP (registration, the run token in `mcp_credentials`, run tokens accepted
  only from SwarmCloud's egress addresses) and await-input (checkpoints as verdict
  waits, answers, expiry, the tail rule). It also de-duplicates submits by label.
  The real end-to-end check waits for SwarmCloud's switches.

**Built-in model jobs** (`oracle/jobs/`, `oracle/llm/`). Tested.
- Review-comment drafts, reporting and refinement, with jobs, a worker and prompts
  (C1c, C1d).
- The pushback threshold is a company setting.

**Claude account pool** (`oracle/claude_accounts/`). Prod.
- A port of SwarmCloud's account management: browser sign-in, holds, quota windows, a
  sweep and a fallback credential.
- One account is live.

### Clients and tooling

**Web app** (`web/`). Prod.
- Screens: Baseline, Sources, PRDs, Roadmap, Runs, Inbox, Priorities, Settings (members,
  connections, sources, templates, themes, Claude accounts).
- Also a document view with brief and full, Expand, Present, diffs and exports.

**Typed web client and mock API** (`web/lib/api/`). Prod.
- `schema.d.ts` is generated from OpenAPI (`make openapi`).
- An in-browser mock API (`web/lib/api/mock/`) runs every Playwright test with no
  backend.

**CLI** (`oracle/cli/oracle_cli.py`). Tested.
- `oracle push`, `pull`, `sync`, `baseline push|pull`, `accounts`, `account add|pause|…`
  and `tick`.

**Test harness** (`api/tests/`, `web/e2e/`). Prod.
- pytest against Postgres, with per-worker databases under xdist; PDF tests are gated by
  `ORACLE_REQUIRE_PDF=1`.
- Playwright runs against the mock build.

## 6. Flows as built

1. **Baseline to PRD.** Segments: baseline proposal → feature set and design → priority
   order → PRD draft. Each ends at a checkpoint (baseline confirm, feature set, priority
   order, PRD review).
2. **Feedback loop.** It pulls the open feedback, writes the next draft with
   `resolutions`, and stops at a PRD review. On a roadmap that review is a roadmap
   review.
3. **Roadmap from an approved PRD.** It turns roadmap items into a draft roadmap, with
   item and roadmap-review checkpoints. Items link back to PRD sections, and the roadmap
   version records the PRD version it came from.
4. **By hand** (works today): `oracle push` or the `import_version` MCP tool imports a
   draft written outside a run. This is how the current PRDs were produced.

## 7. Interfaces another product can call

- **REST** `/v1/...`. OpenAPI comes from `python -m oracle.openapi`, and its typed client
  is `web/lib/api/schema.d.ts`.
- **MCP** `https://<host>/mcp`. Every REST operation is a tool. Auth is OAuth (people),
  an API token, or a run token (agents).
- **CLI** `oracle …` against `ORACLE_URL` with `ORACLE_API_TOKEN`.
- **Files:** the draft markdown format (front matter, `{#id}` headings, `[c:id]` citation
  chips, `resolutions`), the baseline YAML, and the template and theme formats in
  `docs/research/templates/`.

## 8. Not built, or partial

- **Agents reading Oracle live (SwarmCloud #1433) and one-workflow runs with person-waits
  (#1436).** Adapter v2 is built and tested against a fake SwarmCloud. Its live
  end-to-end check waits for SwarmCloud's switches.
- **Engineering alignment (E1):** tracker write-back and reading engineering's estimates.
  Dated roadmap milestones depend on it.
- **Flows and wireframes (O2); Figma frames (O6):** decided, not built.
- **Share links and audience variants for roadmaps (O5).**
- **Slack pings (C1), a docked head-of-product chat (I4), a GitHub code indexer (S2), a
  quality bar (T2).**
- **Known open items:**
  - **A pending PR** fills the Roadmap board PDF footer (PR #7).
  - **Oracle's SwarmCloud auth setting is still the access-token mode;** the ID-token mode
    exists and switches once SwarmCloud confirms the audience.

## 9. How to build on it

- **Commands:**
  - `make test`, `make lint` and `make openapi`;
  - `cd web && npx eslint && npx tsc --noEmit && E2E_PORT=<port> npx playwright test`.
- **Local stack:** a run script on Oracle-only ports, 127.0.0.1 only.
- **Every change:**
  - tests that fail first;
  - `ruff`, `make openapi` and the web checks;
  - a reviewer pass on the diff before merge;
  - merge, then deploy.
- **Migrations:**
  - Linear; two parallel lanes renumber at merge.
  - The API image runs `alembic upgrade head` at startup, so deploy the new image and let
    it migrate. Running the migration first takes the old image down.
- **Built-in templates and themes are copied into each company,** and companies may edit
  them. Ship fixes that must reach existing companies through shared code or
  stylesheets, or through an upgrade path that skips edited copies.
- **Parallel build lanes:** one SwarmCloud task per lane, opening a PR. The prompts that
  built v1 and later are in `ops/*.lane.md` and `ops/*.workflow.json`, and they are good
  templates.

## 10. Read next

- [`questions.md`](questions.md): every decision.
- [`design.md`](design.md): the founding design (2026-10-16).
- [`v1-plan.md`](v1-plan.md): v1 scope, data model, lanes.
- Feature specs: [`brief-and-full.md`](brief-and-full.md),
  [`roadmap-from-prd.md`](roadmap-from-prd.md), [`llm-jobs.md`](llm-jobs.md),
  [`claude-accounts.md`](claude-accounts.md), [`mvp-app.md`](mvp-app.md).
- Agent runtime: [`swarmcloud-interface.md`](swarmcloud-interface.md).
- Formats research: [`research/`](research/).
