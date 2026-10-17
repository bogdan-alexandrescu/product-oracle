# Product Oracle — decision log

Working description (2026-10-16): an AI head of product. It turns a company's code,
conversations and docs into a **baseline** that links company goals to products to
features, then runs agent pipelines that turn intake into prioritized features, a
**PRD** that iterates with user feedback until approved, and an approved **roadmap**
rendered as HTML and PDF. Exposed through a web UI, a full API and an MCP server.

Flows named so far:
1. Baseline -> intake -> agents learn current state -> feature set + dependencies ->
   high-level design per feature -> review + priority order -> PRD draft -> user review
2. Feedback loop: draft n -> feedback collected + analyzed -> draft n+1 -> approve or loop
3. Roadmap: PRD (+ other data) -> milestones + priorities draft -> review loop ->
   approved -> visual roadmap as HTML + PDF via API/MCP/UI

Status: `open` · `answered` · `default` (engineering default I propose; veto any time)

## Round 1 — Foundations (everything else cascades from these)

| ID | Question | Status | Answer |
|----|----------|--------|--------|
| F1 | Who is the customer: your own company first, or SaaS for other companies from day 1? | answered | Us first, sell later. Multi-tenant data model (tenant_id everywhere) from day 1; signup, billing, SOC 2 deferred. |
| F2 | Who sits in front of it: founder/CEO with no head of product, a PM team, a head of product? | answered | Founder/CEO with no head of product. The app is the HoP: opinionated, makes the call, shows reasoning; one decider approves/overrides. |
| F3 | Why now: what happened that makes this needed? | answered | All four: no one owns product; context scattered; PRDs/roadmaps too slow; built the wrong things. Plus (user's words): "Product and Engineering need to communicate and align better on their roadmaps (engineering needs to support product and be super aligned)". Sharpest one: see F3b. |
| F3b | If v1 could fix only one of those, which? | answered | Built the wrong things. v1 quality bar = goal traceability: every proposed feature traces to a company goal with citations; anything serving no goal is flagged and sinks. Test: replay last quarter's features, does it flag the regretted ones? |
| F5 | First target | answered | The company's next product version, to hit company goals (specifics kept local in private/, never committed). A second internal product follows later. Oracle is built standalone, on no existing product. |
| F4 | First release scope: which flows and sources must a real user touch in v1? | answered | Baseline + PRD loop. v1: GitHub, uploads, one conversation source; baseline map, intake, feature set, PRD draft + feedback loop; UI + API + MCP. v1.1: roadmap + HTML/PDF. v1.2: remaining connectors. |

## Round 2 — Platform

| ID | Question | Status | Answer |
|----|----------|--------|--------|
| P1 | Tenancy and hosting: your GCP/GKE, managed cloud, self-hosted option for customers? | answered | App components (api, workers, web, MCP) on existing GKE + Cloud SQL Postgres (pgvector), GCS for blobs, gitops deploy. |
| P2 | Agent runtime: Claude Agent SDK in-app, SwarmCloud, Claude Managed Agents, or a workflow engine? | answered | **SwarmCloud** (https://swarm.saga.xyz), developed separately. Oracle orchestrates; the agents that do the work run as SwarmCloud tasks/workflows. |
| P3 | Models and cost: Claude only or multi-provider; cost ceiling per pipeline run? | answered | Models: Claude only (default; SwarmCloud's codex profile is disabled). Cost: every run shows an estimate first; runs over **$50** wait for approval; live spend vs estimate; overrun > 1.5x estimate pauses and asks. |
| P3b | Which Claude account pays for Oracle's own model calls | answered | A pool of Claude accounts managed like SwarmCloud's account pool (states, 5h/7d quota, most-headroom choice, drain), starting with the owner's account; added by pasted `claude setup-token` or Claude Code login JSON; calls run through Claude Code headless. Data connections stay per user. |
| P4 | Stack and repo: language/framework, which GitHub org, monorepo? | answered | Python (FastAPI, async SQLAlchemy, Alembic) + Next.js/Tailwind. Standalone repo; ai-studio patterns may be copied, no shared code. Repo location: P4b. |
| P4b | Which GitHub org/repo? | answered | `bogdan-alexandrescu/product-oracle`, next to SwarmCloud. This folder becomes the local checkout. |
| R0 | Repo visibility for bogdan-alexandrescu/product-oracle | answered | **Public.** Company/customer data never committed (`private/` is gitignored). |

## Round 2b — Product Oracle x SwarmCloud contract (added after P2)

Facts checked against SwarmCloud's live catalogue on 2026-10-16 (`swarm_profiles`, dispatch/workflow schemas):
- Profiles usable today: `claude-code` (2 h timeout), `claude-code-browser`, `indexer`, `browser`, `generic` (make/pytest/npm only), `merge`. `codex` disabled.
- A task clones one repo or none; in a workflow the repo is workflow-level (every step clones the same one).
- Steps pass data only as named artifact files (`input_from`), one file per upstream step.
- Per-task inputs are limited to what the profile declares (`issue` for claude-code). No way to attach an MCP server, a secret, or pick a model per task.
- No pause-for-human inside a workflow; Oracle would run one workflow per draft version.

| ID | Question | Status | Answer |
|----|----------|--------|--------|
| X1 | How do SwarmCloud agents reach Oracle's knowledge (baseline, sources, prior drafts)? | answered | Oracle's own MCP server with a run-scoped, expiring token per task. Code via SwarmCloud's native clone. Data stays in Oracle (ACLs + audit). Same MCP serves external users. |
| X2 | SwarmCloud gaps Oracle needs: extend SwarmCloud, or work around inside Oracle? | answered | Extend SwarmCloud broadly: (1) per-task MCP server + scoped secret, (2) multi-repo checkout per step, (3) per-step model choice, (4) `await_human` step type. Oracle v1 depends on these. When to file them: X4. |
| X4 | When to file the SwarmCloud feature requests? | answered, re-asked | User chose "file now". Re-asked as X4b because two new facts surfaced while filing: the SwarmCloud repo is **public**, and request 3 (per-step model) contradicts SwarmCloud invariant 10. Drafts ready: `docs/swarmcloud-requests.md`. |
| X4b | Public filing: generic wording, Oracle context, or hold? | answered | Generic wording, no product or company details. **Filed 2026-10-16:** #1433 per-task MCP + ephemeral credential, #1434 extra read-only repos per step, #1435 model-tier profiles, #1436 await_input step. |
| X2b | Per-step model vs SwarmCloud invariant 10 ("a caller never chooses the model", owner decision 2026-09-26, #226): model-tier profiles, reverse the invariant, or drop? | answered | Model-tier profiles (`claude-code-sonnet`, `claude-code-haiku`); invariant 10 kept. |
| X3 | When Oracle is sold, is SwarmCloud bundled / required for customers? | open | |

## Round 3 — Sources and baseline

| ID | Question | Status | Answer |
|----|----------|--------|--------|
| S1 | Sources beyond the six named (Linear/Jira, Figma, analytics, support tickets, CRM)? | answered | All four categories matter: eng tracker, design (Figma), product analytics, customer voice. Exact tools per category: collected with T3 Dogfood setup. Phasing: proposed in the design doc. User also added **output tools** (Figma, PDF, HTML, vector images, inputs for engineering): see O6. |
| S2 | GitHub depth: docs + issues + PRs only, or full code understanding? Auth via GitHub App? | answered | Full code understanding: one SwarmCloud `indexer` task per repo builds a capability map (modules, APIs, data models, flags, jobs) + issues, PRs, milestones, releases; refreshed on merge. Access via GitHub App (default). |
| S3 | Permissions: respect each source's ACLs per user, or one org-wide view? | answered | Admin allowlist of channels/spaces/repos/folders; everything ingested visible org-wide within the tenant; DMs never ingested; source ACL metadata stored so per-user mirroring can come before selling. |
| S4 | Freshness: continuous sync or snapshot when a pipeline runs? | answered | Background incremental sync (webhooks + polling); each run pins the snapshot it started on; between drafts Oracle offers "N new items since draft k, refresh?". |
| S5 | Connector auth | answered, revised 2026-10-17 | **Per user:** each person connects their own GitHub, Slack, Notion, Fireflies, Google Docs (and later others) through each tool's OAuth or a personal token. Oracle's own LLM calls can run on a connected Claude plan, the way the owner's other internal tools do. |
| B1 | Baseline shape: structured graph (goals -> products -> features -> requirements) the user can correct, or document search? | answered | Correctable graph: typed entities + links, evidence on every node, search on top for agents; user corrections are first-class and locked (agents must ask before overriding). |
| B2 | Goals framework: OKRs, north star, free-form? What do short / medium / long term mean in time? | answered | Goals are spread across everything: a written OKRs/goals doc, a board/strategy deck, founders' heads, and Slack, Notion, Fireflies, Google Docs and uploaded docs. Oracle must extract goals from all sources, propose measurable versions, and confirm them with the user (goals interview where gaps remain). Horizons default (veto any time): short = current quarter, medium = next 2 quarters, long = 12-24 months. |
| B3 | When sources disagree, who wins? Must every claim cite its source? | answered | Cite every claim. Resolve by stated precedence (code > tracker > docs > chat; newer beats older) with reasoning shown; ask the user only when a conflict changes a feature or priority; immaterial conflicts logged. |

## Round 4 — Pipelines and outputs

| ID | Question | Status | Answer |
|----|----------|--------|--------|
| W1 | Pipelines: fixed built-in flows, or user-editable workflows (visual builder)? | answered | Built-in flows (Baseline -> PRD, Feedback loop, Roadmap) as code-defined templates with knobs: depth, agent roles, checkpoints, budget. Custom flows via API specs in v2; no visual builder. |
| W2 | Human checkpoints beyond PRD review: approve the baseline? the feature set before the PRD? | answered | Four stops, each **toggleable at the start of a flow**: (1) baseline confirm, (2) feature set + dependencies, (3) priority order, (4) PRD draft review. Default all on (veto any time). Each stop = SwarmCloud `await_input` step (#1436). |
| O1 | PRD template: yours or the app's standard? Where does the PRD live (in-app, Notion, Google Docs)? | answered | **Multiple templates with template versioning** (Oracle's default traceability template + user-supplied ones). Where the PRD lives: O1b. |
| O1b | PRD home: Oracle as source of truth with exports, or Notion/Google Docs as source of truth? | answered | Oracle is the source of truth (all versions, diffs, citations, feedback threads, approvals). Exports to Notion, Google Docs, Markdown, PDF are snapshots bannered with their Oracle version; edits in exports are not read back. |
| O1c | Where evidence lives in a PRD | answered | The PRD body (goals, problem, features, flows, requirements, roadmap, risks) carries no citations, quotes or evidence prose. A final **Sources and data points** section lists every source, every data point (value, as of, source) and the evidence by section. Applies to the default template. Traceability (F3b) is kept through that section and the baseline graph. |
| O2 | Feature "design" depth: text, user flows, wireframes, clickable mockups? | answered | v1 default: user stories + acceptance criteria + SVG flow + low-fi grayscale HTML wireframes of 2-4 key screens. v2: user can opt in per flow to hi-fi mockups and clickable prototypes. |
| O3 | Prioritization: RICE, WSJF, MoSCoW, or weighted against company goals? | answered | Default goal-weighted: sum(goal weight x contribution) x confidence / effort, ordered by dependencies, every number explained with sources. User can choose RICE, MoSCoW or WSJF instead. |
| O4 | Roadmap shape: Now/Next/Later, quarterly timeline, milestones with dates? Team capacity as input? | answered | Default Now / Next / Later on B2 horizons; dated milestones only in Now, from eng-tracker estimates. User can switch the shape to Quarterly timeline or Outcome roadmap. |
| O5 | Roadmap HTML/PDF: company branding? Shareable public link? | answered | All four: tenant branding (logo, colors, fonts) on every HTML/PDF; expiring, revocable share links with view log; audience variants (board / team / engineering) from one source; public links (need a public-safe variant so internal detail cannot leak). |
| O6 | Output tools (from S1): which artifacts Oracle generates and when — Figma frames, HTML, PDF, vector images (SVG), engineering inputs (issues, specs, diagrams)? Feasibility per tool (e.g. what Figma's API allows writing) to verify before committing. | answered | All four: HTML + PDF docs, SVG diagrams, Figma frames, engineering inputs (epics/issues + tech brief per feature). **Figma checked 2026-10-16:** REST API cannot create nodes; Figma's official remote MCP server (`mcp.figma.com/mcp`) has a write-to-canvas tool `use_figma` that runs Plugin API code in a file. Beta, free during beta, "will eventually become a usage-based paid feature"; needs Professional+ plan, a Full seat and edit access. Unconfirmed: whether it works headless from a server agent. Oracle path: SwarmCloud agent with Figma MCP attached (needs #1433). |
| E1 | Product/engineering alignment (from F3): what does engineering receive (epics, issues, a tech plan per feature), and does the app read engineering's roadmap and capacity back to check alignment? | answered | All four: (1) two-way with the eng tracker: approved PRD -> epics + issues; read back status, estimates, plan; flag drift both ways; (2) eng review stop as a toggleable W2 checkpoint; (3) tech brief per feature from the S2 code map; (4) weekly read-only alignment report (also the mode when tracker write access is not granted). |

## Round 5 — Feedback and collaboration

| ID | Question | Status | Answer |
|----|----------|--------|--------|
| C1 | How feedback is given: inline comments, chat, per-section approve/reject, from Slack? | answered | All four: inline comments on selections (tracked into the next version), per-section approve / reject / request changes (approved sections locked), chat with Oracle that turns discussion into structured feedback items, Slack (draft-ready pings; thread replies become feedback items). |
| C1b | Pushback policy: when feedback contradicts goals or evidence, does Oracle push back (as an opinionated head of product) or comply? | answered | Push back once: Oracle flags feedback that contradicts goals/evidence with reasoning + sources; user keeps their call or takes the advice; overrides logged with reason for later review. |
| C2 | Multiple reviewers? Who can approve, and does approval need everyone? | answered | Approver per stop: user approves baseline, feature set, priority, PRD stops; eng lead approves the eng review stop; anyone invited comments. Roles: owner, approver, commenter, viewer. |
| C3 | Version history: diffs between drafts, "how each comment was addressed" report? | default | Every draft version kept; diff between any two versions; per-version report of how each feedback item was addressed (or why not). |
| C4 | Write-back: push approved PRD/roadmap into Linear/Jira/Notion/Slack? | answered | Covered by E1 Eng alignment (tracker write) and O1b PRD home (exports). Slack notifications/feedback: see C1. |

## Round 6 — Interfaces

| ID | Question | Status | Answer |
|----|----------|--------|--------|
| I1 | API: REST + OpenAPI with webhooks for run/draft/approval events | default | |
| I2 | MCP: remote (Streamable HTTP + OAuth) with full parity, or read-only first? | answered | Full parity with the REST API, plus OAuth 2.1 (dynamic client registration, PKCE) for external MCP clients, in v1. |
| I3 | UI: web only? Existing brand/design system, or design one? | open | |
| I4 | Primary UX: chat with the head-of-product persona, or a document-and-pipeline workspace? | answered | Workspace (Baseline, Runs, PRDs, Roadmap, Inbox) with a head-of-product chat docked beside every screen, aware of what is on screen. |

## Round 7 — Trust, quality, release

| ID | Question | Status | Answer |
|----|----------|--------|--------|
| T1 | Security/compliance target: SOC 2, data residency, zero-retention LLM use, audit log? | open | |
| T2 | Quality bar: how do we know a PRD is good? Golden dataset, LLM judge, human rating? | open | |
| T3 | Dogfood data: which real org(s) do we test against? | open | Partial: the first dogfood target and its sources are recorded locally (private/, gitignored). |
| T4 | Test layers: unit, connector integration on recorded fixtures, API/MCP contract, Playwright E2E, eval suite in CI | default | |
| R1 | Release: alpha users, environments, target date? | open | |
| R2 | Who builds it: you + agent lanes on SwarmCloud? Budget for build and run? | answered | Builds run as SwarmCloud lanes (claude-code tasks) from the public repo. |
| R3 | Pricing (if sold) | open | |
| R4 | Product name | answered | **Product Oracle** (working name) |
