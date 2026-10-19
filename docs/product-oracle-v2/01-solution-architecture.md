# Product Oracle v2: solution architecture as built (wave 1 foundation)

Lane `v2-foundation`, build prompt §3, §4.2, §7, §9 and §14, wave plan
[waves.md](waves.md). This page describes the shared layer every v2 lane builds on: what
exists, where it lives, why each table exists, how the two hooks work, and how a lane adds
schema. Owner decisions in [docs/questions.md](../questions.md) take precedence. This lane
found no conflict with them, so it added no row to [change-requests.md](change-requests.md).

## 1. The shape is unchanged (§3)

```text
Browser / external MCP client / oracle CLI
             |
     Next.js web (web/)  -- typed client from OpenAPI, mock API for Playwright
             |
     FastAPI /v1 + MCP (one tool per operation, oracle/mcp)
             |
  auth (oracle/auth) -> role guard (oracle/authz) -> tenant-scoped session (oracle/tenancy)
   |          |              |                 |                       |
sources   baseline graph   templates   documents/review/export   v2 foundation (oracle/v2)
   |      (+ trace types)      |                 |               modules, compositions,
   |          |                |                 |               intake/gaps/questions,
   |          |                |                 |               blockers, trace links,
   |          |                |                 |               evaluation, artifacts
   +----------+----------------+------- runs / orchestrator (oracle/runs) ----+
                                                  |
                                   oracle/swarm Runtime protocol (adapter v2 lane, CR-07)
                                                  |
                                              SwarmCloud
```

Nothing was replaced. The v2 foundation is one more company-scoped package next to the
existing ones. It uses the same `TenantScoped` base, the same `require_role` guard, the same
audit module and the same OpenAPI → MCP → web client pipeline. Authoritative state (gaps,
decisions, compositions, approvals, artifact lineage) lives in Oracle's Postgres, never in
SwarmCloud task storage. SwarmCloud results arrive as candidates that a lane validates and
stores (§3, §8). This lane did not touch runs or swarm tables: the adapter v2 lane (CR-07) owns
them, and the `runtime_submission_reconciliation` outbox from §14 is theirs too.

## 2. Where the code is

| Path | What |
|---|---|
| `api/oracle/v2/models.py` | The 22 new tables (SQLAlchemy). Registered in `oracle/models.py`, so Alembic and the tests see them. |
| `api/oracle/v2/contract.py` | The versioned module contract (§4.2) and the applicability expression, as Pydantic. Validation only. |
| `api/oracle/v2/schemas.py` | `*Out` schemas for every table, plus typed JSON payloads: `CompositionModule`, `CompositionInputs`, `IntakeAnalysis`, `BlockerAttrs`, `BlockerOptionDetails`. |
| `api/oracle/v2/router.py` | Thin read routes: a list and a get per table. |
| `api/oracle/v2/concurrency.py` | Optimistic concurrency helpers (`expect_version`, `flush_or_conflict` → 409). |
| `api/oracle/changes.py` | Hook 1: `record_change()` and the handler registry. |
| `api/oracle/readiness.py` | Hook 2: `register_check()` and `evaluate()`. |
| `api/migrations/versions/0013_v2_foundation.py` | The one additive migration. |
| `web/lib/api/mock/v2.ts` | Mock API fixtures and read routes for the new entities. |

## 3. The tables, and why each exists

Rules for every table: `TenantScoped` (`tenant_id` FK, filtered and stamped by the session),
a UUID `id` and `created_at`, `Text` columns with named check constraints for value sets,
which `oracle.v2.schemas` mirrors as `Literal`s, and `*_by` columns that hold a user or
API-token id without an FK, as elsewhere in the codebase. JSONB columns are typed by a Pydantic
model in `oracle/v2/schemas.py`. Deleting a document cascades to its compositions, links,
evaluations and artifacts. Change events and intakes outlive it, and their `document_id` is
set to null.

### Reused instead of added

| Need (§14 candidate) | Reused | How |
|---|---|---|
| Blocker entity | baseline `entities` with `type = 'constraint'` | The blocker itself (type, limit kind, severity, status, threshold, impacted entities) lives in `attrs["blocker"]`, typed by `BlockerAttrs`. Options, experiments and events point at the entity. |
| `requirement_trace_edges` | baseline `edges` | New edge types instead of a second graph (§7). |
| Assumptions, risks, outcomes, acceptance criteria as nodes | baseline `entities` | New entity types, with the graph's existing evidence, locking, proposals, revisions and conflict handling. |
| Document and section text | `document_versions`, `sections` | Compositions record which modules a version uses. They never hold a second copy of the Markdown (§14). |
| Section revision for approvals | `sections.content_hash` | Verdicts now record the hash they were given on. |
| Audit | `audit_events` via `oracle.audit.record` | Lanes audit every state change they make. |

### Baseline graph extensions (§7: prefer one graph)

- Entity types `outcome`, `acceptance_criterion`, `assumption` and `risk` join goal, product,
  feature, requirement, constraint, decision and person.
- Edge types `derived_from` (requirement → outcome → goal), `verifies` (acceptance criterion
  → requirement), `affects` (assumption, risk or constraint → requirement or feature) and
  `mitigates` (decision, option or feature → risk or constraint) join supports, depends_on,
  blocks, part_of and owned_by.

This carries the chain *source evidence → goal → outcome → feature → requirement →
acceptance criterion* inside the existing graph. The rest of the chain (*→ document section →
derived artifact → roadmap item*) needs revision anchors the graph doesn't have, so it lives
in the two link tables below. Locked items, proposals, YAML import and export and the
traceability report work for the new types without code changes.

### Semantic modules (§4)

| Table | Why |
|---|---|
| `module_definitions` | A module's stable semantic key (`constraints.solutions`), unique per company. Built-ins are copied into each company like templates, so company edits never touch a built-in row. |
| `module_versions` | Immutable releases: semver `version` (check constraint), the validated `ModuleContract` as JSON, a `contract_hash` (sha256 of canonical JSON) to detect no-op re-imports, and `origin` (`builtin` or `company`) for company overrides. |
| `template_module_assignments` | The module manifest attached to an existing template: module key, optional pinned version, policy, order, the legacy `{#id}` sections it maps to, `since_template_version`, `manifest_format`. **A template with no rows has no manifest and behaves exactly as before.** |
| `document_compositions` | One per document, pointing at its `current_revision`. A document with none is a legacy document and reads, reviews and exports as before. |
| `composition_revisions` | The decided composition: `modules` (`CompositionModule`: key, version, policy, included, reason, order, sections, what drove it, advisory score, override), `inputs` (`CompositionInputs`: the roots conditions read, pinned snapshots), `decided_by`, `decided_at`, `reason`, `status` (`working → confirmed → published`, or `superseded`) and the document version it was published with. A material change makes a new working revision, and a published one is never edited (§4.3 steps 7–8). |

### Intake, gaps, questions (§5)

| Table | Why |
|---|---|
| `product_intakes` | The short brief, its author, the pinned `source_snapshot_ids` (S4: later sources never rewrite it), a status, the `IntakeAnalysis` and the linked document. No existing model fitted. |
| `knowledge_gaps` | The Gap Registry: category (the 17 §5 categories), statement, impact areas (array checked against six areas), importance, evidence ids, confidence, `knowledge_state` (verified fact, user decision, AI inference, hypothesis or unknown: §5 step 3), status (the seven §5 statuses), deciding owner, related modules, stop condition, and links to baseline entity ids and section keys. It belongs to an intake or a document (check constraint). |
| `stakeholder_questions` | The Question Ledger: prompt, rationale, priority and batch (short prioritized batches), who it was asked to and by, module and section, status. |
| `stakeholder_answers` | Answers and non-answers: `answer`, `dont_know`, `defer`, `delegate` (with `delegated_to`), `research` (§5 step 6), with evidence and knowledge state. |
| `assumption_decisions` | Explicit, authorized decisions to proceed on an assumption or accept a risk, with rationale, decider and review date (§5 step 8, §9 risk acceptance). |

### Blockers (§6), on the existing constraint entity

| Table | Why |
|---|---|
| `blocker_options` | Candidate solutions: approach (the six §6 approaches), technical and policy feasibility, `compliance`, status, `BlockerOptionDetails` (outcome, cost, effort, risk, residual limits, fallback, monitoring signal, scaling trigger, corrective action, review date), evidence and owner. **A check constraint refuses a `selected` option that is not `compliant`** (§6: never propose evading platform rules). |
| `feasibility_experiments` | Scoped validation with hypothesis, method, threshold, owner, decision gate and result. A critical hard blocker may proceed only as such an experiment or as an accepted risk. |
| `blocker_resolution_events` | Append-only history of status changes, selections, experiments and risk acceptances. Blocker resolution is a first-class decision. |

### Trace (§7, §11.5)

| Table | Why |
|---|---|
| `document_section_links` | A revision-aware link from a section (`document_id`, `version_id`, `section_key`, `section_hash`, `composition_revision`, `module_key`) to an entity, a piece of evidence or a source item, with kind, precision (section, paragraph or claim) and the claim. This is the internal per-claim evidence behind O1c: bodies carry no citations, while the appendix and the evidence inspector read these links. |
| `artifact_dependencies` | Downstream (an artifact version, or a document version such as a roadmap) depends on upstream (a section at a hash, a whole document version, or an entity). Each row carries `freshness` (`fresh`, `potentially_stale`, `under_review` or `reconciled`), `caused_by_change_id`, `stale_since` and who reconciled it. Approved outputs are never rewritten. |
| `change_events` | The store behind `oracle/changes.py`: subject kind, id and stable ref, document, cause, actor, data (before and after), and the names of the handlers that ran. |

### Evaluation (§10)

`evaluation_reports` (document, version, composition revision, evaluator, `policy` defaulting
to `advisory` while T2 is open, status, summary) and `evaluation_findings` (criterion, status
`pass`, `warning`, `critical` or `not_applicable`, `hard`, rationale, evidence ids, owner,
sections, module). Readiness results from `oracle/readiness.py` can be stored as findings.

### Downstream artifacts (§11; created now so wave 2 needs no foundation)

`artifact_requests` (kind, source document and version, requirement ids, sections, params,
status in the §8 vocabulary, optional run), `artifact_versions` (number, review status, an
aggregate freshness, source version, composition revision, content hash, and `provenance` for
run, profile, prompt version and cost, never a credential), `artifact_outputs` (named files
with media type, size, sha256, inline content or a storage ref; the read routes return
metadata only) and `artifact_review_events`.

### Review correctness (§9)

- `section_reviews.section_hash`: the section content hash a verdict was given on.
  `review_section` now sets it, so an approval is tied to an exact section revision. Older
  verdicts have null.
- `document_versions.approved_by`: who approved the version. `approve_version` now sets it.
- `document_versions.base_number`: the version an edit started from. It is the anchor the
  review lane uses to refuse a concurrent edit of the same section (409) instead of letting
  the last write win. Null on every import so far.
- `lock_version` on every row people edit in place (compositions and their revisions,
  intakes, gaps, blocker options, experiments, artifact requests) is mapped as SQLAlchemy's
  `version_id_col`. Every ORM `UPDATE` carries `WHERE lock_version = <loaded>`, so a lost race
  raises instead of overwriting. `oracle.v2.concurrency` turns both a stale client version and
  a lost race into a 409.

## 4. The module contract (§4.2)

`oracle.v2.contract.ModuleContract` is strict (`extra="forbid"`) and covers every concern
§4.2 lists:

| Concern | Field(s) |
|---|---|
| Stable semantic id, release | `id`, `version` (semver) |
| Applicability | `condition` (typed tree, below) |
| Selection | `policy`: required, conditional (needs a condition) or optional (no condition) |
| Prerequisites, exclusions, ordering | `depends_on`, `conflicts_with`, `display_order`, `order_after`, `order_before` |
| Reusable field definitions | `fields` (text, markdown, number, integer, boolean, date, enum, list, reference to a baseline type); `fields_schema` accepts the illustrative JSON-Schema form |
| Validators | `validators`: declarative (required, min/max length, pattern (compiled and length-bounded), min/max, one_of, requires_evidence), each naming a defined field |
| Question prompts | `question_prompts`: category, importance, fields it fills, optional `when` condition |
| Agent role instructions | `instructions`, `agent_instructions` (one per role) |
| Evidence expectations | `evidence_policy` (default `record_provenance_in_appendix`, O1c), `evidence_expectations` |
| Section ids, brief/full mapping | `section_ids` (default: id with dots as dashes), `brief_layer`, `full_layer`, `brief_section_ids` |
| Ownership, approval | `owner_role`, `required_review_role`, `approval_policy` |
| Output mappings | `outputs`, `output_mappings` (output → fields or sections) |

Cross-field rules are enforced: no self-references or duplicates, no module both depended on
and conflicting, no contradictory ordering, validators and questions only name defined fields,
at least one layer, and brief sections drawn from the module's sections.

**The applicability expression** is a discriminated union on `op`: `true` and `false`, `and`
and `or` (`args`), `not` (`arg`), `at_least` (k of n), `present` and `absent` (path), `eq` and
`ne` (strict scalar), `lt`, `lte`, `gt` and `gte` (strict number), `in` (a list of one
type), and `contains`. Paths are lowercase dotted names under fixed roots that match
`CompositionInputs` (brief, category, scope, signals, baseline, sources, stakeholders, outputs,
blockers, policy, template). Depth (12), size (200 nodes) and path length are bounded. Nothing
is ever evaluated as code. Evaluating a condition is the modules lane's job.

## 5. The two hooks

Lanes never call each other's code. They meet at two registries this lane owns. A lane
registers at import time of a module that `oracle.main` imports (its router module).

### `oracle/changes.py`

```python
await changes.record_change(
    db, "document_section", cause="section_edited", actor=principal,
    subject_ref="checkout-redesign@4#goal-trace", document_id=doc.id,
    data={"before_hash": old, "after_hash": new},
)
changes.register_handler("trace.mark_stale", mark_stale)                       # v2-trace
changes.register_handler("review.invalidate", invalidate, subjects={"document_section"})  # v2-review
```

- The subjects are `document_section`, `requirement`, `decision`, `source_permission`,
  `blocker_status`, `composition_revision`, `document_version`, `entity` and
  `artifact_version`. An unknown subject is refused.
- `record_change` stores a `ChangeEvent`, flushes it so handlers can reference its id, and
  awaits each matching handler in registration order, **in the caller's session and
  transaction**. It records the names of the handlers that ran in `handled_by`.
- A handler that raises aborts the change. The caller's transaction rolls back, so a change
  never commits without its consequences (stale marks, invalidated approvals).
- Handlers must not commit. The caller audits and commits.

### `oracle/readiness.py`

```python
readiness.register_check("critical_blockers", critical_blockers, hard=True)   # v2-blockers
readiness.register_check("problem_clarity", problem_clarity)                   # v2-quality (advisory)
report = await readiness.evaluate(ReadinessContext(db, document_id, version_id, purpose="publish"))
if report.blocked: ...                                                          # v2-review's publish
```

- A check returns `CheckOutcome(status, rationale, evidence_ids, owner_id, section_keys)` with
  status `pass`, `warning`, `critical` or `not_applicable`.
- `report.blocked` is true only when a **hard** check is critical. While T2 is open, quality
  criteria are advisory, and hard checks are the review and publish invariants, critical
  blockers and failed security or policy checks.
- A hard check that raises, or returns the wrong type, counts as critical (fail closed). An
  advisory one counts as a warning. Each check runs in a savepoint, so one failing query
  cannot poison the session for the checks after it.

Both registries offer `isolated_handlers()` and `isolated_checks()` for tests.

## 6. Read routes, MCP and the web client

Every table has `GET /v1/<path>` (filters, `limit` ≤ 500, `offset`, newest first) and
`GET /v1/<path>/{item_id}`. The paths are `modules`, `module-versions`,
`template-module-assignments`, `compositions`, `composition-revisions`, `intakes`, `gaps`,
`questions`, `answers`, `assumption-decisions`, `blocker-options`, `feasibility-experiments`,
`blocker-events`, `change-events`, `section-links`, `artifact-dependencies`,
`evaluation-reports` (the get includes findings), `evaluation-findings`, `artifact-requests`,
`artifact-versions`, `artifact-outputs` and `artifact-review-events`.

- All of them need the viewer role. Another company's id is a 404, enforced by the
  tenant-scoped session and covered by a test of every route.
- Operation ids are `list_<plural>` and `get_<singular>`, so the MCP tools are
  `list_knowledge_gaps`, `get_knowledge_gap` and so on, generated automatically.
- Run tokens cannot read these areas yet. `oracle/mcp/scopes.py` maps areas to run-token
  scopes, and a lane that needs agents to read its area adds it there.
- Write routes belong to the lanes, under the same paths, with Pydantic request bodies, a role
  guard, an audit event and a cross-company test. A lane that needs a richer read edits its
  `Resource` entry in `oracle/v2/router.py` or replaces the generated route with its own.
- `web/lib/api/mock/v2.ts` serves one linked, synthetic row per table. Lanes add their mock
  writes there.

## 7. Legacy compatibility

- No existing column, constraint or row changes meaning. New columns are nullable, and the
  entity and edge type constraints only widen.
- Documents without a composition and templates without a manifest load, review and export
  exactly as before (covered by `test_legacy_documents_and_templates_load_as_before`). The
  draft format is unchanged: `{#id}` headings, front matter, `resolutions` and the appendix.
- The downgrade removes graph items of the new types, then restores the old constraints.
- The whole existing suite passes unchanged: 1157 tests before, 1274 after (117 new), with the
  same 7 skips. The 96 Playwright tests pass against the mock.

## 8. How a lane adds schema

1. Prefer the foundation's tables and JSONB payloads first. Most lanes need none.
2. If a lane truly needs more, it adds **one** additive migration
   `api/migrations/versions/0014_<lane key>.py` with `revision = "0014_<lane key>"` and
   `down_revision = "0013"`. Models go in the lane's package and are imported in
   `oracle/models.py`, so `test_models_match_migrations` sees them.
3. Nobody edits `0013` or earlier.
4. At merge, the integrator re-chains the `0014_*` revisions in merge order (modules,
   blockers, intake, trace, review, quality). Each `down_revision` becomes the previous
   lane's revision, so Alembic stays linear with one head. The suite and `make openapi` run
   after each re-chain.
5. The API image still migrates itself at startup (`alembic upgrade head`). Never migrate
   ahead of the image.
