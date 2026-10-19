<!-- The owner's build prompt for Product Oracle v2 (Bogdan, 2026-10-19), committed verbatim
     so every lane reads the same text. Owner decisions in docs/questions.md take precedence;
     the wave plan is docs/product-oracle-v2/waves.md. The companion
     product_oracle_repo_assessment.md it mentions was not provided. -->

# PRODUCT-ORACLE — MERGED, REPOSITORY-AWARE MASTER BUILD PROMPT

**Version:** 2.0 — 2026-10-19 UTC  
**Target:** `https://github.com/bogdan-alexandrescu/product-oracle`  
**Repository review baseline:** `869d3b78e1a8a2e9fa98f8640abd7c79e4741fbc`  
**Purpose:** Implement the missing Product-Oracle capabilities *incrementally in the existing codebase*, merging its original `docs/build-brief.md` contract with the next-generation modular PRD, discovery, cross-artifact, and SwarmCloud-first design.  
**Audience:** Autonomous staff-level coding agent or coordinated team of engineering agents with read/write access to the checked-out Product-Oracle repository and reviewed access to SwarmCloud.

> This document is an implementation prompt, not an example product PRD. Do not invent features or requirements for any particular character, brand, client, or AI agent. Do not rewrite this application from scratch. Do not use real company confidential content in code, committed files, issue prompts or GitHub artifacts.

---

## 0. MISSION AND THE MOST IMPORTANT INSTRUCTION

You are the principal engineer, product architect, workflow designer, senior UX engineer, quality lead and security reviewer for **Product-Oracle**. Evolve the *working existing application* into an opinionated AI Head of Product and modular product-definition system.

A user provides a short high-level idea, optionally connects allowlisted company resources, reviews the existing company goal/product/feature baseline, answers a small number of critical, source-aware questions, accepts an explainable PRD composition, reviews AI-generated proposals with colleagues, and ultimately approves an immutable, evidence-grounded PRD. From an approved PRD, users obtain a consistent roadmap and may request engineering specifications, flows, wireframes, Figma designs, and secure clickable prototypes.

**Primary objective:** prevent building the wrong things. Every proposed feature must tie to a confirmed business/product goal, and important decisions must have evidence or an explicitly confirmed assumption. Users can override the system's advice with a documented reason. This product is an *opinionated head of product*, not a passive fill-in-the-blank generator.

**Execution principle:** SwarmCloud owns heavyweight agent work; Oracle owns company knowledge, durable workflow and review state, template semantics, source access controls, payments/cost decisions (as implemented), permissions, document publication and artifact provenance. Preserve Oracle's existing small Claude-account-pool jobs for review/classification/reporting unless there is a demonstrated benefit, safe replacement and explicit approval. Do not create a second general agent runtime inside Oracle.

**Definition of success:** a real internal user can go from a high-level brief and existing company sources to an appropriate modular PRD, see and resolve the most important blockers and assumptions, review and approve it with colleagues, publish a brief/full artifact, and generate at least one requirements-linked downstream artifact, all through the existing web, REST and MCP entry points. The codebase remains deployable, tested and backwards-compatible.

---

## 1. READ AND RESPECT THE CURRENT REPOSITORY BEFORE CODING

Your first action is to inspect the *actual checkout HEAD*, using these source-of-truth files:

1. `docs/questions.md` — the decision log. **Owner decisions here take precedence over suggestions in this prompt**. If a new requirement conflicts with a prior decision, record a change request and request owner approval rather than silently overriding it.
2. `docs/build-brief.md` — reuse catalogue, documented maturity, code locations, feature inventory and build process.
3. `docs/design.md`, `docs/v1-plan.md`, `docs/mvp-app.md`, `docs/brief-and-full.md`, `docs/roadmap-from-prd.md`, `docs/llm-jobs.md` — established product/workflow contracts.
4. `docs/swarmcloud-interface.md` and `docs/swarmcloud-requests.md` — SwarmCloud feature gates and exact payload contracts.
5. `api/oracle/tenancy.py`, `models.py`, `authz.py`, `sources/`, `connections/`, `baseline/`, `priorities/`, `docs/`, `templates/`, `review/`, `runs/`, `swarm/`, `jobs/`, `llm/`, `export/`, `mcp/`, `cli/`.
6. `web/app/`, `web/components/`, `web/lib/api/`, OpenAPI generation and Playwright mock fixtures.
7. Alembic revision history, current PRs, `ops/*.lane.md`, workflow examples, `Makefile`, tests and operational/deployment instructions.

At the pinned public baseline, the repo documented a mature Python/FastAPI + SQLAlchemy 2 async + Alembic + PostgreSQL backend, Next.js 16/React 19 frontend, twelve built-in document templates (seven PRD + five roadmap), six themes, a source/baseline graph, review/diff/export workflows, REST/MCP/CLI, and a SwarmCloud adapter. These are assets to retain. **Do not replace them with a new TypeScript API, Prisma schema, generic Next.js starter or new auth product.**

Create `docs/product-oracle-v2/00-baseline-and-delta.md` recording:
- checked-out SHA versus pinned reference SHA; recent changes and conflicting PRs;
- current capabilities classified `working / tested / partial / spec / blocked` based on code and tests, not only descriptions;
- tables/routes/UI pages/test suites to reuse and to extend;
- decisions already made, decisions still open, migration risk and backward compatibility;
- commands/test results and capability gates observed in the environment.

Do not claim live SwarmCloud MCP, await-input, Figma authoring, per-user external source ACL mirroring or SaaS onboarding works merely because code or specs mention it. Show verified status.

### Non-negotiable inherited decisions

- One company per currently deployed Oracle instance, with `tenant_id`/company scoping in tables. Multi-company SaaS may follow; **do not implement SaaS self-service signup/billing in this phase**.
- Preserve IAP, session cookie, API token, OAuth for MCP, run tokens, and role hierarchy `viewer < commenter < approver < owner`. Use existing invite/member facilities.
- Product terminology is **company, user, project/product/feature, PRD, roadmap**. Do not expose SwarmCloud tenant/workspace jargon in Oracle's product UX.
- Confidential source data stays outside the public code repository, as configured by `private/` and production storage. Prompts should reference source IDs and Oracle MCP tools rather than embedding sensitive company data into committed prompt templates or GitHub workflows.
- Source connector identities are **per user**, with organization/company-wide visibility of admin-allowlisted ingested content under the current internal deployment policy. Do not ingest Slack DMs; retain source ACL metadata and prepare per-user source access mirroring before external sale.
- Render evidence in the final **“Sources and data points”** section and a UI evidence inspector, **not citation prose/chips in the document narrative body**. The internal representation must still have per-claim/section source links and precision.
- Every document retains **brief and full layers**, Present mode, presenter notes only from `notes` blocks, current themes, slide styling and deck exports. Do not break parser/import conventions.
- Preserve seven PRD templates, five roadmap templates, company-edited variants, and existing template/theme upgrade behavior. New modularity extends the system; it must not discard or invalidate those templates.
- Preserve code-defined flows and toggleable human checkpoints. No visual agent workflow builder in this scope.
- Founder/decider has final approval; Oracle may offer evidence-based pushback once, then log an authorized override. Others may comment/review in parallel.
- Show run cost estimate. Existing rules: estimates above **$50 require owner approval**; >**1.5× estimated spend** pauses after the current segment and requests a decision. Preserve semantics and test them.
- Maintain REST, OpenAPI-derived MCP tool parity, typed frontend API generation and CLI compatibility where relevant.
- PR review before merges; write failing tests first; changes pass `make test`, `make lint`, `make openapi`, web TS/ESLint and Playwright. Keep Alembic migrations linear and deploy migrations **through new API image startup**, not ahead of it.

**Deployment reconciliation:** `docs/questions.md` originally specified GKE; the pinned `docs/build-brief.md` documents *actual current Cloud Run deployment*. Respect current deployed architecture for implementation. Do not initiate a platform migration without an explicit new decision.

---

## 2. IMPLEMENTATION STRATEGY: EXTENSIONS, NOT REPLACEMENTS

Organize work as coherent, testable change requests with separate reviewed PRs. See the full `product_oracle_repo_assessment.md` companion. Implement:

- **CR-00:** baseline and compatibility audit;
- **CR-01:** modular composition atop existing templates;
- **CR-02:** reusable standard-startup and AI-agent-*platform* module packs;
- **CR-03:** evidence-aware intake, question and gap engine;
- **CR-04:** blockers, alternatives, feasibility and scaling strategy;
- **CR-05:** baseline → requirement → document → artifact trace links;
- **CR-06:** review and publication invariants for module revisions;
- **CR-07:** SwarmCloud v2 guarded adapter;
- **CR-08:** PRD quality/readiness evaluation;
- **CR-09:** engineering specs, flows and wireframes;
- **CR-10:** isolated prototypes and optional Figma output;
- **CR-11:** roadmap and engineering tracker alignment enhancements;
- **CR-12:** source freshness, ACL and code understanding enhancements;
- **CR-13:** contextual head-of-product chat and review notifications;
- **CR-14:** operational resilience and costs;
- **CR-15:** external SaaS preparation (later; do not front-load).

Prioritize a full end-to-end slice over a dozen unfinished stubs. Tests must prove transitions and artifacts, not just UI renderings. Every completed change request gets an API, UI, data migration and test impact checklist, as applicable.

---

## 3. SYSTEM ARCHITECTURE AND OWNERSHIP

Keep the existing shape:

```text
Browser / External MCP client / Oracle CLI
             |
     Existing Next.js web
             |
     FastAPI /v1 and MCP
             |
  Authz + company-scoped Postgres
   |       |        |         |
Sources   Baseline   Templates Docs/Review/Artifacts
   |       |         |          |
   +-------+---- Oracle runs/orchestrator
                         |
             api/oracle/swarm Runtime protocol
                         |
                       SwarmCloud
             (research/draft/critique/design/code)
                         |
                 named results/artifacts
                         |
           validate -> proposed changes -> Oracle state
```

Do not store authoritative company records, draft review approvals or product decisions in ephemeral SwarmCloud task storage. SwarmCloud tasks operate on restricted context and return candidate results. Oracle validates and stores results transactionally, with provenance and audit.

Extend `api/oracle/swarm/runtime.py` rather than replacing it. Preserve the deterministic fake for tests and an explicit unavailable/unconfigured state. Add capability introspection if the real runtime needs MCP, staged artifacts, longer workflow waits or allowed models. Use provider-defined profiles, not arbitrary end-user model strings or commands.

Work in the current Python and TypeScript conventions. Use Pydantic schemas, SQLAlchemy async sessions, Alembic, current FastAPI routes, OpenAPI clients and consistent `web/lib/api/mock` fixtures. Extend current UX rather than introducing a separate competing application or database.

---

## 4. THE NEW MODULAR TEMPLATE ENGINE (CR-01, CR-02)

### 4.1 Preserve style, separate semantic composition

Existing templates define document *format/style* and brief/full/presentation behavior. Add **semantic module definitions** as a separate versioned layer. A module can represent Problem/Evidence, Goals, Users, Requirements, Constraints/Blockers, Feasibility, Risks, Unit Economics, AI Evaluation, Multi-Tenant Configuration, Fleet Operations, Relationship/Memory Controls, etc. A rendered PRD is an ordered composition of modules using an existing PRD template and theme.

Template selection remains available and overrideable. Do not rewrite the seven built-in templates. Instead, attach module manifests to the templates, convert legacy sections to default module IDs where unambiguous, and preserve unknown custom section content.

### 4.2 Versioned module contract

Store modules in a validated, importable Python/Pydantic schema and persisted company-overridable version entries. Example (illustrative schema, not a product requirement):

```json
{
  "id": "constraints.solutions",
  "version": "1.0.0",
  "title": "Constraints, Blockers & Solution Strategy",
  "applies_to": ["startup.standard", "ai-agent.platform"],
  "policy": "required",
  "condition": {"op": "true"},
  "depends_on": ["goals.outcomes"],
  "conflicts_with": [],
  "display_order": 60,
  "fields_schema": {"type": "object", "properties": {}},
  "instructions": "Identify and prioritize current/potential limitations, evidence, viable solutions, feasibility tests, fallbacks, scaling triggers and ownership.",
  "evidence_policy": "record_provenance_in_appendix",
  "brief_layer": true,
  "full_layer": true,
  "required_review_role": "approver",
  "outputs": ["prd"]
}
```

The true schema must define: stable semantic IDs, module release versions, applicability AST (AND/OR/NOT, presence, thresholds, typed comparisons; no arbitrary code eval), required/conditional/optional selection, prerequisites, mutual exclusions, ordering constraints, reusable field definitions, validators, question prompts, agent role instructions, evidence expectations, section IDs, brief/full presentation mapping, ownership, approval policy and output mappings.

### 4.3 Composition algorithm

1. Take existing PRD template selection, draft brief, confirmed baseline/goal graph, known source data, user-defined scope, target stakeholders, output requests, blockers and product category.
2. Apply company policy to include mandatory modules. Fail clearly if a required dependency cannot be satisfied.
3. Score conditional modules with AI analysis or existing priority/confidence functions **as advisory signals**; explain each inclusion/omission.
4. Perform deterministic dependency closure, conflict checks, order and field validation. Show why modules were included.
5. Let an authorized user add/remove allowed modules, reorder within constraints, and confirm a **composition revision**; record who decided and why.
6. Keep existing heading `{#id}`, YAML front matter, brief/full markers, citation and `resolutions` conventions compatible. Mapping must provide stable IDs under rename/reorder and across re-imports.
7. A material composition change creates a new working revision and invalidates affected approvals; published snapshots remain unchanged.
8. Published PRD records template version, module IDs/versions, company overrides, composition inputs, theme and rendered source appendix.

### 4.4 Seed reusable module packs (placeholders only)

**Pack A: General Tech Startup** core modules: executive decision, strategic alignment, opportunity/problem, evidence & assumptions, users/JTBD, intended outcomes/success metrics, alternatives/tradeoffs, scope/non-goals, functional requirements/acceptance, constraints/blockers and mitigation, nonfunctional requirements, value/cost economics, risks, validation, release, decision/change history, sources/data points.

**Pack B: Multi-tenant AI Agent *Platform***: same shared core plus conditional modules for customer/onboarding/workspaces, multi-tenant isolation, configuration precedence/versioning, agent archetypes and behavior configuration, tool policies, knowledge/memory/state contracts, testing/simulation/evaluation, rollout/version migration, fleet operations/observability, cost/quotas, external social/API channel constraints, human-agent interaction policy configurability, customer-brand governance, continuous agent improvement and capability portability.

This is a PRD for a *reusable platform capability* serving many customers and agent types—not an individual fictional character. Never prepopulate example brand/character requirements. A character contract, persona, relationship mode or brand canon belongs in a linked **configuration artifact/schema**, if relevant, not hard-coded into every platform PRD.

**Do not require every specialized module for every PRD.** Make them conditional based on capability scope and organizational policy.

### 4.5 UI deliverables

Enhance existing template picker with recommended composition inspector: which modules are mandatory, suggested or optional; reason; source/assumption driving selection; missing info; impact on brief/full layout; conflicts and dependencies; version/change history. Keep template/theme preview and existing presentation flows.

---

## 5. SOURCE-GROUNDED PRODUCT DISCOVERY AND ADAPTIVE INTERVIEW (CR-03, CR-12)

### Reuse rather than reimplement

Build on `oracle/sources/`, `oracle/connections/`, `oracle/confidence.py` and `oracle/baseline/`. Reuse installed GitHub, Slack, Notion, Fireflies, Google Docs, uploads, public-links ingestion and snapshot support. Do not create a new generic connector framework unless the current one lacks a required interface that cannot be extended.

Implement a **Gap Registry** and **Question/Answer Ledger**, connected to baseline entities and document sections. Each gap captures: category, impact, importance, evidence IDs, confidence, status (`unknown`, `under_investigation`, `asked`, `answered`, `validated`, `deferred`, `accepted_risk`), deciding owner, related modules, and stop condition.

Start from a brief as short as a couple of sentences. Reconcile existing sources and ask **only missing material questions**. The algorithm should:

1. Extract the intended user/customer, problem, outcomes, strategic goal links, initial scope/non-goals, dependencies, blockers and context from the brief and selected pinned source snapshot.
2. Check existing baseline decisions/locked data first; do not re-ask already-answered questions.
3. Distinguish **verified source fact**, **user-confirmed decision**, **AI inference**, **hypothesis** and **unknown**. Avoid presenting confidence heuristics as factual proof.
4. Detect material conflicts and staleness; surface conflicting source links and recommend a resolution, respecting existing source-precedence rules.
5. Rank missing questions by their expected effect on goals, feasibility, scope, economics, risks and correct module selection.
6. Ask in short prioritized batches, preserving “I don’t know”, defer, request another person's answer, and “Research this” paths.
7. Generate researched *proposals* (not automatic approvals). Answers revise gaps, template recommendations and candidate PRD patches, preserving approved user text.
8. Record unresolved critical decisions in the review gate, with authorized, explicit risk-acceptance when policy permits.

**Required question categories:** customer/user, pain evidence, company-goal alignment, success metric and baseline, strategic differentiation, alternatives, current/future constraints, blockers, expected economic benefit, effort/cost, security/privacy, team ownership, non-goals, release/rollout, evaluation criteria, third-party policy/API limitations, configurability and scaling.

For company knowledge: preserve per-user connector credentials and the admin allowlist. Never ingest DMs. Future external SaaS requires per-user source ACL enforcement before launch. Lock every agent run to a known source snapshot; later sources must not silently rewrite in-progress decisions. Build incremental sync/webhooks when relevant and display “new evidence since version X” before a redraft.

Do not paste arbitrary untrusted web/repo/chat instructions into system-level agent context. Agents access Oracle facts through a least-privilege read-only MCP/retrieval tool, with source-data clearly separated from instructions and query auditing. Do not leak source credentials into GitHub, prompt templates, logs, or workflow metadata.

---

## 6. BLOCKERS, SOLUTION INNOVATION AND SCALING (CR-04)

Add a structured **Constraints, Blockers & Solution Strategy** module that can be used in both PRD packs, linked to existing baseline constraint/decision nodes. Treat blocker resolution as a first-class decision, not merely a risk paragraph.

For each significant known or potential blocker, support:
- stable blocker ID, statement, type (`hard`, `soft`, `unknown`, `temporary`), evidence and confidence;
- impacted outcomes/requirements/users, severity, timing and measurable threshold;
- possible solution approaches: direct remedy, alternative UX/workflow, architecture optimization, approved partnership/commercial path, operations/process, alternate distribution/integration;
- estimated outcome/cost/effort, technical and policy feasibility, risk and residual limitations;
- proposed experiment or validation, owner, timeline/decision gate, selected option and reason;
- fallback/contingency, monitoring signal, scaling trigger, corrective action and review date.

**Important safety and reliability distinction:** distinguish throughput/capacity limits from permission/eligibility limits and policies set by third parties. Seek compliant ways to accomplish user outcomes: efficiency, queueing within permitted limits, opt-in interactions, approved APIs/entitlements, new workflows, channel diversification, negotiated access. Do not propose evading platform restrictions, identity/account abuse, unauthorized outbound messaging or other policy violations.

PRD readiness should treat a critical unresolved hard blocker as a stop unless approved as a scoped *feasibility experiment* or valid risk acceptance. Fallback solutions must be achievable and reviewable. Include scaling characteristics across tenants, agents, channels, quotas, cost and fleet blast radius when applicable.

---

## 7. EVOLVE THE BASELINE GRAPH INTO TRACEABILITY (CR-05)

**Do not create a redundant “Product Definition Graph” beside `oracle/baseline/`.** Extend the current typed nodes/edges with minimal additive relationship types and revision-safe references linking:

`Source snapshot / evidence -> goal -> desired outcome -> feature -> requirement -> acceptance criteria / test -> document section -> derived artifact -> roadmap item / engineering issue`.

Also link `assumption`, `blocker`, `alternative`, `experiment`, `decision`, `owner` and `risk` to affected requirements. Preserve locked/confirmed graph node protections, source ranking and existing traceability/priorities.

Prefer one authoritative baseline graph plus lightweight revision-aware **document-section and artifact dependency links** rather than duplicating every graph entity in new tables. Propose migrations only after documenting existing models. Use stable IDs and version anchors:

- `source_snapshot_id`, `baseline_snapshot_id`, `template_version`, `composition_revision`, `doc_id`, `doc_version`, `section_id`, `section_hash/revision`, `requirement_id`, `artifact_version`.
- Internal claims link to sources/decisions even though rendered body citations are omitted under O1c.
- A changed requirement, decision, source permission, blocker status or template composition marks downstream artifacts as `potentially_stale`, requiring review or deliberate confirmation.
- Provide an impact explorer and targeted regeneration plan: show which engineering specs, wireframes, roadmaps, prototypes and acceptance tests may need updating, and why.
- Never rewrite approved downstream artifacts automatically. Human acceptance of proposed changes is auditable.

---

## 8. AGENTS, WORKFLOWS AND SWARMCLOUD v2 (CR-07, CR-14)

### Existing contract to reuse

`api/oracle/swarm/runtime.py` defines `AgentRuntime`, `WorkflowSpec`, `StepSpec`, `McpAccess`, status/cost/artifact/cancel methods; `swarmcloud.py` submits workflows, polls and retrieves text artifacts. At pinned code, the adapter deliberately *does not send the MCP credentials* and `can_reach_oracle` is `False`. The external specification `docs/swarmcloud-interface.md` describes supported/disabled future calls, service tenant bootstrap, credential expiration and `await-input` details. Use this reality.

### Recommended logical agent specialties

Source investigator, evidence reconciler, goals analyst, gap interviewer, product strategist, blocker investigator, template/module recommender, PRD section drafter, independent PRD critic, acceptance-test critic, economics/scale analyst, technical spec author, UX flow/wireframe author, prototype agent, roadmap planner, cross-artifact consistency auditor and change-impact analyst. These are task roles within SwarmCloud DAGs, *not* permanent autonomous services. Each step gets typed input/output, budget, versioned instructions, scope, expected artifact names and validation.

### Runtime implementation rules

1. Implement capability checks and visibly gate unavailable features. Do not guess if #1433/#1436 are enabled; probe documented interfaces and capture exact statuses.
2. Respect SwarmCloud service-tenant bootstrap: use the Oracle service account's **Google ID token for the confirmed audience** only after owner provisioning and a successful probe. Do not substitute an OAuth access token against an ID-token audience, nor forge user identities.
3. Register Oracle MCP through the documented `/v1/mcp-servers` contract once allowed; enforce approved server/profile/tool lists and `auth.mode=dispatch` credential handling. Never place run tokens in prompt bodies, task labels or artifacts.
4. Issue purpose-scoped short-lived Oracle run tokens, attach via SwarmCloud's protected credentials map when the feature is actually on, restrict agent reads/writes to allowed Oracle MCP operations, revoke after run and restrict run-token network source as previously decided (but do not restrict normal user OAuth/API-token clients).
5. Use named artifacts, validated sizes/checksums/types and stable IDs. Verify `result.json`/Markdown/YAML before importing. Map outputs to **candidate patches**, not automatic truth or publication.
6. **Submission de-duplication:** SwarmCloud `POST /v1/workflows` lacks native idempotency in the pinned interface. Use an Oracle persisted submission record, unique logical run+segment+attempt label, correlation IDs and check existing workflow labels before retry. Beware timeouts after submission and reconcile before repeating.
7. Keep **one workflow per segment** with Oracle-owned Inbox checkpoints as a fully functioning fallback until `await-input` is verifiably available. Human reviews lasting weeks must stay in Oracle DB regardless. Even enabled `await-input` has finite TTL and workflow scope.
8. Implement `await-input` only as an optional optimization after verifying that the Oracle service principal can answer its own steps. Map stable answer IDs and handle accepted/replayed/already-answered/expired states. Do not enable before feature flags and security approval.
9. Preserve budget semantics: estimate and >$50 approval, >1.5x pause after segment, owner resume/cancel, cost and status audit, rate/capacity controls.
10. For general content work, start from allowed `claude-code`/existing runner profiles. If a specialized artifact/profile is needed, propose a **separate reviewed SwarmCloud change request**; never submit arbitrary Docker images or shell commands based on user briefs.
11. Keep robust failure status: unavailable/blocked/failed/retryable/partial/succeeded. Cancel and resume must be visible and idempotent. A missing model/run result is not a successful draft.
12. Use SwarmCloud for large source research, drafting, critiquing, code map, design/code generation and evaluations once authenticated MCP access works. Keep short local review-comment/refinement/reporting jobs on existing pool until a deliberate migration passes tests.

### Run DAG example (logical stages, not invented API payload)

`Intake -> source research (parallel) -> reconcile baseline -> gap questions (Oracle wait) -> approve module composition -> draft per section (parallel) -> critique/evaluate -> import candidate patches -> human review (Oracle wait) -> targeted revision -> publish -> downstream artifact jobs`.

Avoid idle runtime charges for human waits; batch tiny interactive tasks to reduce SwarmCloud startup overhead. Every decision to delegate externally must pass source access and runtime approval gates.

---

## 9. REVIEW, COLLABORATION AND IMMUTABLE PUBLISH (CR-06, CR-13)

**Enhance existing `oracle/review/`, `oracle/docs/` and web documents UI. Do not reimplement a second editor/approval system.** Preserve comments, section verdicts, locked approved sections, feedback packages, resolutions, diff, document versions, export and present mode.

Add/verify:

- module/section owner, optional reviewer assignees, due date, organizational feedback campaign and comment notifications;
- review status per stable section ID and content revision/hash;
- approvals tied to exact section revision plus the final designated decider/approver stop;
- a substantive edit or accepted AI patch invalidates the prior approval *of the affected section*, requests re-review where policy requires and marks linked derivative artifacts stale;
- independent reviewers can comment in parallel on different sections; concurrent updates to same section detect version conflicts (optimistic concurrency; no silent last-write-wins);
- change requests classified with severity, tracked resolutions and evidence attached in an interactive inspector;
- the existing one-time evidence-grounded pushback policy and override decision log;
- a final publish transaction that rejects missing required sections, stale mandatory approvals, critical unresolved blocker gates, and invalidated source permissions;
- immutable publication and exported artifacts with document version, template/composition version, last approval/decider and sources/data appendix;
- audit trails and company-scoped permissions, including MCP parity;
- no mandatory unanimity: organization-wide comments can be gathered while the designated decider remains the approval authority, unless the company configures additional mandatory reviewers.

An AI suggestion must always be reviewable as a *targeted patch/diff* before replacing accepted human content. Avoid wholesale regeneration that resets approved sections or loses anchored comments.

Implement the deferred **Head of Product chat** as a contextual UI panel: it can answer questions about the current document, explain priorities/constraints, turn a conversation into explicit structured feedback or suggested edits, and respectfully challenge unsupported decisions; it must not silently publish or override locked sections.

---

## 10. PRD QUALITY, READINESS AND ORGANIZATIONAL LEARNING (CR-08)

A PRD is useful when it supports sound decisions and prevents waste, not just when every heading has words. Reuse the baseline's goal traceability, confidence and priority logic. Add an explainable evaluation and soft readiness dashboard covering:

1. Problem and user clarity;
2. Business goal alignment and strategic value;
3. Source evidence, provenance and stale/conflicting claims;
4. Alternatives explored and trade-offs;
5. Blocker/feasibility resolution;
6. Scope, non-goals and testable requirements;
7. Economic/scaling assumptions;
8. Validation plan, success metrics and decision thresholds;
9. Ownership, review and operational readiness;
10. Downstream design/engineering consistency, where relevant.

Each criterion has a rationale, evidence references, owner and clear `pass / warning / critical / not_applicable` status. **Do not invent an arbitrary universal numeric publish score as a hard rule** while T2 remains undecided. Start advisory, with hard blocks only for established approvals, failed critical security/policy requirements, unsupported third-party operation, and unresolved critical blocker policies. Offer a proposed T2 quality-policy decision for the owner.

Create a small reproducible evaluation corpus using redacted/synthetic data: good/bad PRD section fixtures, conflicting evidence, uncertain claims, missing goals, untestable acceptance criteria, blockers with no workable mitigation, policy-sensitive social API constraints, tenant-configurability leakage and stale derived specs. Include human-rater comparison where available; do not present LLM judge output as independent objective ground truth.

Post-publish outcome tracking: link launched roadmap items and validation experiments back to goals, assess whether predictions held, and record learnings that update future module/question recommendations without altering already published documents.

---

## 11. DOWNSTREAM ARTIFACTS (CR-09, CR-10, CR-11)

All outputs inherit the current Oracle document/version model where practical. They must cite internal provenance and source PRD version. Build artifact lineage and review status, not disjoint generated files with no relationship to decisions.

### 11.1 Engineering specs and implementation handoff

Produce a technical brief per feature and, optionally, a full engineering specification: user flows, requirement IDs, acceptance criteria, inputs/outputs, proposed architecture, APIs/data models, dependencies, failure modes, security/privacy/performance, test strategy, release flags, migration/rollback and open engineering decisions. Distinguish **product requirement** from **proposed engineering approach**; architecture should not be treated as decided until engineering approves. Use a code capability map where available; when the indexer is not enabled, label assumptions clearly.

Integrate Linear/Jira later through an explicit two-way tracker connector: reviewed PRD -> epics/issues, read-back actual estimates/progress and drift flags. No unattended external writes or invented milestones. Keep read-only alignment report path for when permissions are unavailable.

### 11.2 User flows, low-fi wireframes and prototype

Per O2, support default **SVG flow diagrams and grayscale low-fidelity HTML wireframes for 2–4 key screens**, selected from approved requirements; let users review annotations and exact section links. Optional hi-fi/clickable prototype is a later feature flag; do not make it a precondition for the PRD core.

For interactive HTML prototypes, generate constrained static frontend assets in an isolated build/preview environment. Use a strict iframe sandbox/origin separation, no application production tokens, no unconstrained network, CSP, build resource ceilings, bounded runtime, malware/secret scanning, and Playwright interaction/accessibility tests. Mark mocked behavior visibly. Track code/artifact hashes and provenance.

### 11.3 Figma

Figma read through approved OAuth/access and supported APIs. To author real editable frames, **first test the previously selected Figma remote MCP `use_figma` path under the actual connected account and supported runtime**, including permissions/plan, write scope, quotas and headless viability. If verified, build reviewed Figma export flow with explicit user approval, stable file/node references and conflict handling. If unsupported, propose an official companion Figma plugin importing versioned design-interchange JSON (the Plugin API can create nodes), as a separate work item. Never show a fake Figma link or claim REST can author arbitrary design layers.

### 11.4 Roadmap and alignment

**Preserve the existing `prd_to_roadmap` workflow and five roadmap templates.** Add better traceability of items to exact approved PRD version/feature/requirement IDs, blocker dependencies, validation gates, economics and drift from current engineering status. Default Now/Next/Later and planning horizons remain. Dated milestones require actual verified estimates/capacity/commitments; never invent dates. Provide brief/full views, existing themed decks/exports, audience variants as decided, and an approval loop.

### 11.5 Staleness and targeted regeneration

When PRD section/requirement/composition changes, compute affected outputs. Show users a focused impact diff and optional regeneration task per artifact. Never silently overwrite previously approved engineering, design or roadmap artifacts. Maintain `fresh / potentially_stale / under_review / reconciled` state and a trace to the causing change.

---

## 12. PRIVACY, SECURITY, ACCESS AND SAFETY (ALL CRs)

Build against the current internal source-sharing model, but prepare the security gates necessary before sale:

- Every API route, MCP tool, source retrieval, artifact, comment and background run must use existing company/role scoping. Test negative IDOR and cross-company record access.
- Restore/retain per-user connector OAuth scopes, encrypted credentials, revocation behavior, admin source allowlists and source snapshots. No connector credential passed to an LLM or user-generated prototype.
- Ensure a source revoked after a run was queued cannot be retrieved after revocation; document run snapshots and retention semantics.
- Validate URLs of public-link inputs against SSRF, redirects, metadata IP ranges, decompression bombs and hostile MIME types. Sanitize rendered Markdown/HTML and attachments.
- Treat all ingested files/Slack posts/web pages/repos as untrusted *data*, never execution instructions. Restrict agent MCP tools to task-appropriate read and narrowly authorized change proposals.
- For SwarmCloud, attest and log credential scope, service identity, approved runner profile, approved tool list, expected artifacts and lifespan, without leaking credential values.
- Generated designs/code must not have production database, source connectors or unrestricted network capabilities.
- Add audit events for module composition, questions/answers, assumption acceptance, review approvals, external writes, artifact publication, run dispatch, spend and deletions.
- Use existing cost approval defaults and show projected/actual cost per run and phase; prevent duplicate dispatch charges as described by the interface contract.
- External SaaS is gated on per-user source ACL mirroring, tenant-isolated authorization/retention, runtime customer attribution/isolation, deletion/export workflows, data classification and compliance policy (T1 remains an owner decision).

---

## 13. UX AND PUBLIC INTERFACES

Extend the existing screen navigation; do not replace it. The recommended user journey:

1. From Baseline or PRDs, choose **New product idea** and enter a short plain-language brief.
2. Choose relevant source snapshots/allowlisted connected systems; inspect existing goals/related features and evidence confidence.
3. View an **Opportunity and Gaps** summary, with conflicts, missing goals, assumptions and top blocking uncertainties.
4. Review a recommended existing PRD template/theme plus explainable module composition (core + conditional); override permitted options.
5. Answer a few high-impact questions or delegate investigation to SwarmCloud and see results as proposals.
6. Review the **blocker strategy** and alternative design paths before locking major scope.
7. Start the existing baseline-to-PRD flow, monitor task roles, costs and outputs in Runs/Inbox.
8. Review section by section, compare changes, see linked evidence in an inspector, collect organization-wide comments and assign required approvals.
9. Verify quality/readiness and publish brief/full immutable PRD with current version and appendix.
10. Generate or update roadmap, engineering specs, flows/wireframes and optional prototypes; see staleness when PRD changes.

Continue supporting old `oracle push/pull` drafts, previous template/theme versions, existing document URLs, exported PDFs/decks and `api/oracle/cli` flows.

**New REST surface**: Add to existing `/v1/...` routes (names are guidance; inspect current routes before choosing) operations for brief creation/analysis, gaps/questions, module catalog/compositions, blocker alternatives/experiments, traceability/impact, evaluation/readiness, artifact requests/status/versions, and run capability diagnostics. Every route needs Pydantic request/response schema, role guard, company context, `audit_event` where relevant, OpenAPI spec and automatically derived MCP tool. Update generated web client and mock API. CLI adds only useful user/operator commands; preserve existing commands.

---

## 14. DATA CHANGES (ADDITIVE, NON-DESTRUCTIVE)

Investigate existing models before creating anything. Candidate additions (names subject to model inspection):

- `template_module_definitions`, `template_module_versions`, `template_module_assignments`, `document_compositions`, `composition_revisions`;
- `product_intakes`/opportunity briefs if no suitable intake model exists;
- `knowledge_gaps`, `stakeholder_questions`, `stakeholder_answers`, `assumption_decisions`;
- `blocker_options`, `feasibility_experiments`, `blocker_resolution_events` (link existing baseline constraint entities);
- `document_section_links` / `requirement_trace_edges`, `artifact_dependencies` (reuse baseline edges where possible);
- `evaluation_reports`, `evaluation_findings`, optional evaluation-fixture metadata;
- `artifact_requests`, `artifact_versions`, `artifact_outputs`, `artifact_review_events`;
- `runtime_submission_reconciliation`/outbox or equivalent for deduplicated dispatch.

All new models follow existing `TenantScoped`, permission and audit conventions. Use stable IDs, template/module version pins and snapshot-specific references. Avoid storing a new canonical Markdown text competing with existing immutable draft versions.

Migration rules:
- Preserve all prior document and template data; do not overwrite company-modified/archived templates.
- Old drafts without module manifests remain readable/exportable/reviewable. On edit, propose an explicit migration of section headings to semantic modules; do not backfill previously published brief layers contrary to O1g.
- Store a minimal manifest/reference in existing draft front matter or sidecar table with format version; parser must accept legacy documents.
- Maintain `resolutions` semantics and source appendix structure.
- Use linear Alembic revisions with reviewed indexes and reversible safe changes. API image startup performs migrations as current deployment requires.

---

## 15. BUILD ORDER, TEAM LANES AND TEST-FIRST APPROACH

**CR-00 / Phase 0 — Baseline and test protection**
- Inspect actual SHA and PRs; run existing `make test`, `make lint`, `make openapi`, Next ESLint/typecheck and both realistic/mock Playwright where supported. Identify environmental blockers.
- Add fixtures representing legacy documents/templates, source appendix, locked sections, roadmap provenance and actor roles.
- Produce precise implementation plan and threat/impact assessment. No speculative replatform work.

**CR-01/02/04 / Phase 1 — Modular documents and blocker strategy**
- Extend existing templates with semantic registry, composer and two template packs. Add UI. Preserve 7 PRD/5 roadmap legacy formats and all themes/exports.
- Integrate blocker module with existing baseline constraint graph and readiness. Test dependency closure and no imaginary agent features.

**CR-03/05 / Phase 2 — Intelligent intake and traceability**
- Short brief + source/goal extraction + adaptive questions with evidence; approved answers feed graph/composition/PRD patches.
- Add revision-sensitive trace links, UI impact inspector and source reconciliation. Test permissioned retrieval and conflict handling.

**CR-06/08 / Phase 3 — Review correctness and quality**
- Add section-version approval checks, owner/approver review policy, org-wide commenting, publish gates, reasoning and quality report.
- Ensure all previously supported review/import/export flows continue to work, including CLI.

**CR-07/14 / Phase 4 — SwarmCloud v2**
- First verify provisioning/ID-token audience and external flags. Implement guarded MCP step context, run token lifecycle, label dedup and status/error handling; optional await-input when enabled.
- Preserve single-workflow-per-segment fallback and deterministic fake. Test with mocked contract failures and actual runtime only when authorized.

**CR-09/11 / Phase 5 — Linked engineering and roadmap artifacts**
- Build engineering specs and SVG/low-fi wireframes; connect to approved PRD. Enhance existing roadmap generator and engineering handoff. Add staleness tests.

**CR-10/12/13 / Phase 6 — Rich deliverables and proactive workflows**
- Prototype isolated preview, Figma proof of feasibility, full code understanding, source freshness, Head of Product chat, Slack review notifications. Keep every unverified integration behind a disabled feature gate.

**CR-15 / Later — External SaaS readiness**
- Security policy decisions, per-user ACL source mirroring, runtime customer attribution, enterprise auth/deletion requirements. Do not let this consume internal-dogfood priority.

Parallel agent lanes: one lane per change request group (templates; knowledge/intake; approval/quality; SwarmCloud; downstream artifacts; UI/testing), each creates a reviewed PR. Coordinate shared model/API changes and Alembic revision numbering; no direct independent commits to one common migration head.

---

## 16. ACCEPTANCE / REGRESSION TEST CONTRACT

Minimum tests, using the repository's pytest/Postgres, web Playwright/mock and current CI infrastructure:

1. Existing PRD/roadmap drafts import through CLI/API/MCP with `{#id}`, YAML `resolutions`, evidence appendix, brief/full, section diffs and PDF/deck exports unchanged.
2. Existing company-edited/archived template and theme are untouched by builtin module upgrades.
3. A short brief plus one source can create an intake, evidence/gap analysis and recommended existing PRD template with mandatory and conditional modules.
4. A required module or dependency cannot be silently removed; valid conditional rules and company policies explain why modules are suggested.
5. Both seeded template packs are *templates only*—no prewritten imagined platform features or character requirements.
6. Company-goal-to-feature traceability remains functional; a feature serving no confirmed goal is flagged and its prioritization rationale shown.
7. Answers to questions update tracked gaps; known answers are not repeatedly asked; unknown critical blockers produce feasible research/decision actions.
8. Third-party limitations are separated into rate/capacity, API eligibility, permissions and policies; recommended options remain compliant.
9. A section's internal evidence references can be inspected and exported in the appendix, while its rendered main body obeys O1c (no inline citations).
10. Existing review feedback/comments/resolution imports work; two reviewers can comment concurrently; an edit invalidates prior approval on its revision; final decider approves current versions only.
11. A critical unresolved blocker prevents publication unless authorized policy explicitly accepts a feasibility-only path or risk; an ordinary advisory quality score alone does not silently block.
12. A source/review approval or artifact cannot be accessed outside company/role scope, including via MCP tools or run tokens.
13. Runtime unconfigured/MCP-off/await-input-off leads to accurate status and working one-segment flow, never fake completion or exposed tokens.
14. After feature enablement, SwarmCloud job receives Oracle MCP as documented; workflow output returns as validated proposed patch; expired credentials and retry labels are handled safely.
15. A submit timeout followed by retry does not create two accepted document proposals or double-charge silently; reconciliation is observable.
16. The >$50 owner approval and >1.5× estimated-cost pause survive the new workflows.
17. Publishing pins approved PRD revision, module composition and evidence snapshot; later source updates or draft changes do not mutate it.
18. Roadmap remains sourced from an approved PRD and preserves existing Now/Next/Later brief/full PDF/HTML/deck flows; dates require real estimates.
19. Engineering spec, flow and wireframe point to source PRD/requirement IDs and display stale state if these change.
20. Any preview code is isolated from application cookies, credentials and network by policy; no private source exposure in public exports.
21. Figma authoring remains disabled unless a real editable-frame write and link has been verified end to end on an authorized account.
22. All new `/v1` routes have equivalent generated MCP tools, permissions, OpenAPI clients and test fixtures.
23. Existing `make test`, `make lint`, `make openapi`, web TypeScript, Playwright (mock and real where configured) and Alembic startup migration pass, or environment blockers are documented precisely.
24. Run provenance captures source snapshot, prompt/tool/runner version, cost, status, reviewer actions and final artifact version without exposing secrets.
25. Internal beta uses only allowed company sources and does not require SaaS signup, billing or unrelated platform refactors.

Where true integrations cannot be exercised for missing credentials/feature switches, provide contract tests, a clearly marked disabled state, the exact manual verification path and a blocker issue. Do **not** report those integrations as done.

---

## 17. COMPLETION ARTIFACTS AND EXECUTION REPORT

Deliver code and reviewed PRs, not just plans. Within the repo add (unless equivalent current docs already exist):

- `docs/product-oracle-v2/00-baseline-and-delta.md`
- `docs/product-oracle-v2/01-solution-architecture.md`
- `docs/product-oracle-v2/02-template-modules.md` (schemas, module packs, composition rules, migration notes)
- `docs/product-oracle-v2/03-discovery-and-quality.md`
- `docs/product-oracle-v2/04-swarmcloud-integration.md` (live capability matrix, bootstrap checks, fallback)
- `docs/product-oracle-v2/05-artifact-contracts.md`
- `docs/product-oracle-v2/06-security-and-threat-model.md`
- `docs/product-oracle-v2/07-release-and-dogfood-checklist.md`

After each coherent PR, report: changed paths, migrations, assumptions, user-visible changes, tests run and results, artifacts/screenshots where helpful, open risks, exact SwarmCloud feature status, and any action the owner must take. Keep `docs/questions.md` decision IDs linked to any new proposed owner decisions—do not silently rewrite answers.

**Stop conditions:** Do not deploy to production, modify shared SwarmCloud resources, push code to third-party products, or expose a new customer-facing public app without the normal permissions, PR review and release gate. On genuine external capability blockers, make the rest of the vertical slice demonstrably functional and report the missing verified contract.

**Expected outcome:** The existing AI Head of Product becomes a modular, evidence-driven product decision and artifact system, still grounded in company goals, still using its existing PRD/roadmap review flows, with much richer questioning, blocker strategy, cross-artifact continuity and trustworthy SwarmCloud execution.

---

## 18. OWNER DECISIONS TO REQUEST (DO NOT BLOCK SAFE DEVELOPMENT)

The repository already contains answers to most architectural questions. Ask only these unresolved decisions when they become relevant:

- **T2 PRD quality policy:** advisory evaluations vs. hard scoring thresholds? Suggested: advisory score; gate only critical failures, approved evidence requirements, and review/publish invariants.
- **X3 future SwarmCloud commercial coupling:** bundled as part of Oracle or customer-supplied execution capacity? Suggested: defer monetization; keep attribution/segregation design extensible.
- **I3 UI visual language:** preserve existing theme/UI conventions vs. refresh; suggested: preserve and incrementally improve, do not redesign while building core value.
- **T1 enterprise privacy/compliance:** target residency/deletion/retention and model data handling for external sales; suggested: decide before SaaS rollout.
- **Figma authoring:** try current remote MCP `use_figma` approach first (per O6) then commission plugin fallback if needed.

No need to re-ask decided items such as framework choice, baseline model, source policies, PRD appendix evidence, approver hierarchy, roadmap-from-approved-PRD requirement, cost gate or SwarmCloud-first orchestration.

## SOURCE DOCUMENTS

- [Build brief at pinned commit](https://github.com/bogdan-alexandrescu/product-oracle/blob/869d3b78e1a8a2e9fa98f8640abd7c79e4741fbc/docs/build-brief.md)
- [Owner decision log](https://github.com/bogdan-alexandrescu/product-oracle/blob/869d3b78e1a8a2e9fa98f8640abd7c79e4741fbc/docs/questions.md)
- [Founding design](https://github.com/bogdan-alexandrescu/product-oracle/blob/869d3b78e1a8a2e9fa98f8640abd7c79e4741fbc/docs/design.md)
- [SwarmCloud interface](https://github.com/bogdan-alexandrescu/product-oracle/blob/869d3b78e1a8a2e9fa98f8640abd7c79e4741fbc/docs/swarmcloud-interface.md)
- [Runtime protocol](https://github.com/bogdan-alexandrescu/product-oracle/blob/869d3b78e1a8a2e9fa98f8640abd7c79e4741fbc/api/oracle/swarm/runtime.py)
- [SwarmCloud adapter](https://github.com/bogdan-alexandrescu/product-oracle/blob/869d3b78e1a8a2e9fa98f8640abd7c79e4741fbc/api/oracle/swarm/swarmcloud.py)
