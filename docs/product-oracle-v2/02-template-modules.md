# Product Oracle v2: template modules and composition (CR-01, CR-02)

Lane `v2-modules`, build prompt §4, wave plan [waves.md](waves.md). This page covers the
module contract as Oracle uses it, the two seeded packs, the template manifests, the
composition rules, the API, and migration notes. Owner decisions in
[docs/questions.md](../questions.md) take precedence. The one conflict found is row
MOD-1 in [change-requests.md](change-requests.md).

API and logic only (I3, 2026-10-19). The screens are listed in §9 for the UI wave.

## 1. Where the code is

| Path | What |
|---|---|
| `api/oracle/modules/builtin/core.yaml` | The 17 shared-core modules (Pack A, also the core of Pack B), one release each. |
| `api/oracle/modules/builtin/platform.yaml` | The 15 Pack B specialised modules, all conditional. |
| `api/oracle/modules/builtin/packs.yaml` | The two packs: ordered module lists, and the categories that select a pack. |
| `api/oracle/modules/builtin/manifests.yaml` | Module manifests of the seven built-in PRD templates. |
| `api/oracle/modules/catalog.py` | Loads and validates the packaged data (pure). |
| `api/oracle/modules/evaluator.py` | The applicability evaluator (pure, no eval, typed errors). |
| `api/oracle/modules/composer.py` | The composer (pure, deterministic), field validation, the outline. |
| `api/oracle/modules/skeleton.py` | Renders a composition onto a template body (new module sections). |
| `api/oracle/modules/registry.py` | Seeding, company overrides and modules, company module policy, manifests. |
| `api/oracle/modules/service.py` | Context building (document, intake, template), recommend, confirm, publish, inspector. |
| `api/oracle/modules/router.py`, `schemas.py` | The routes and their Pydantic schemas. |
| `web/lib/api/mock/modules.ts` | Mock API fixtures for every new route. |
| `api/tests/modules/` | 126 tests (§10). |

No migration. Everything fits the foundation's `0013` tables: `module_definitions`,
`module_versions`, `template_module_assignments`, `document_compositions`,
`composition_revisions`. The company module policy is the `module_policy` company
setting (`tenant_settings`, the table that holds `draft_defaults`).

## 2. Modules as versioned data

A module is a `oracle.v2.contract.ModuleContract` (the foundation's schema, §4.2 of the
build prompt): stable id, semver release, title, applicability expression, policy
(`required`, `conditional`, `optional`), `depends_on`, `conflicts_with`,
`display_order` with `order_after` and `order_before`, typed fields and declarative
validators, question prompts, drafting and agent-role instructions, evidence
expectations, section ids and brief/full mapping, owner and review role, and outputs.

Built-ins ship as YAML in the package and are validated when first loaded; a broken
file fails the test suite, never a request. Releasing a change is bumping `version`.

**Seeding** (`registry.ensure_builtin_modules`, called by every catalogue and composition
route after the template seeding) follows the rule for built-in templates in
`templates/builtins.py`: an upgrade never overwrites what a company changed.

| Company state of a built-in module | A new packaged release |
|---|---|
| Untouched (newest version has origin `builtin`) | Added as a new `module_versions` row; it becomes effective. |
| Overridden (newest version has origin `company`) | Not added. Shown as `upgrade_available` in the catalogue and the inspector. |
| Archived | Not added; the module is not offered in compositions. |
| A company module took the key first | Not seeded for that company. |

Rows are never updated or deleted. A company override is `POST
/v1/module-catalog/{key}/versions` (owner) with a contract newer than every existing
release. A company module is `POST /v1/module-catalog` (owner). References
(`depends_on`, `conflicts_with`, ordering) must name known modules.

## 3. The applicability evaluator

`evaluator.evaluate(condition, inputs)` walks the foundation's typed tree. Nothing is
evaluated as code; the tree is validated first (depth ≤ 12, ≤ 200 nodes, known roots).

- `and`, `or`, `not`, `at_least` (k of n); `present`, `absent`; `eq`, `ne`, `lt`, `lte`,
  `gt`, `gte`, `in`, `contains`.
- Every branch is evaluated (no short-circuit), so the explanation and the missing
  information are complete and independent of argument order.
- A comparison against a missing path is false and the path is reported as missing
  information. `present` treats `None`, `""`, `[]` and `{}` as absent.
- Comparisons are typed: a number is never compared with a string, a boolean is not a
  number. A mismatch raises `ConditionTypeError`; walking through a non-object raises
  `ConditionPathError`; an invalid tree raises `ConditionInvalidError`. All are
  `ConditionError` with a stable `code`. The composer catches them per module: the
  module is not suggested and the error is shown.
- The advisory score is the share of leaves that hold.

**Input vocabulary** the built-in conditions read (composition inputs,
`oracle.v2.schemas.CompositionInputs`):

| Path | Type | Read by |
|---|---|---|
| `category` | string; `ai_agent_platform` selects Pack B | tenant isolation, archetypes, evaluation |
| `brief.decision`, `brief.size`, `brief.model_driven` | the template picker's answers (O1d) | alternatives, economics, evaluation |
| `scope.capabilities` | list of tags: `multi_tenant`, `customer_onboarding`, `organisation_model`, `configuration`, `agent_configuration`, `tool_use`, `memory`, `knowledge`, `evaluation`, `versioning`, `fleet_operations`, `quotas`, `usage_billing`, `external_channels`, `human_interaction`, `customer_branding`, `continuous_improvement`, `portability` | Pack B modules, economics |
| `signals.*` | `tenant_count`, `option_count`, `configuration_levels`, `agent_archetype_count`, `tool_count`, `deployed_version_count`, `agent_instance_count`, `external_channel_count`, `target_runtime_count` (numbers); `monetized`, `persistent_state`, `breaking_change`, `metered_usage`, `end_user_facing`, `customer_branded`, `learns_from_feedback` (booleans); `cost_drivers` | as named |

From an intake, `service._intake_inputs` derives `brief`, `scope.items`,
`baseline.goal_count`, `blockers.count`, `sources.snapshot_count` and `category` from
the intake's analysis, and infers `scope.capabilities` from the brief's wording
(`CAPABILITY_HINTS`). Inferred inputs carry knowledge state `ai_inference` and their
source, so the inspector never presents them as facts (§5 step 3). A person's own
inputs replace derived ones, root by root, and are `user_decision`.

## 4. The packs (§4.4), templates only

**Pack A, General Tech Startup** (`startup.standard`), in order:
`decision.executive`, `strategy.alignment`, `problem.opportunity`,
`evidence.assumptions`, `users.jtbd`, `goals.outcomes`, `solution.alternatives`
(conditional), `scope.non-goals`, `requirements.functional`, `constraints.solutions`,
`requirements.nonfunctional`, `economics.value` (conditional), `risks.register`,
`validation.plan`, `release.rollout`, `decision.history`, `sources.data-points`.

**Pack B, Multi-tenant AI Agent Platform** (`ai-agent.platform`): the same core plus 15
conditional modules: `platform.customer-onboarding`, `platform.tenant-isolation`,
`platform.config-precedence`, `agents.archetypes`, `agents.tool-policies`,
`agents.knowledge-memory`, `agents.evaluation`, `platform.rollout-migration`,
`platform.fleet-operations`, `platform.cost-quotas`, `agents.external-channels`,
`agents.human-interaction`, `platform.brand-governance`,
`agents.continuous-improvement`, `agents.capability-portability`.

Rules the tests pin (`tests/modules/test_catalog.py`):

- Titles, instructions, typed fields, question prompts and evidence expectations only.
  No examples, no default values, no named products, brands, characters or personas.
- Persona, character, relationship mode and brand canon appear only to say they belong
  in a linked configuration artifact; the archetype, configuration and brand modules
  carry a field for that artifact's reference.
- Every specialised Pack B module is conditional. A platform PRD gets only the ones its
  capability scope or company policy calls for.
- Every module records evidence in the appendix (`record_provenance_in_appendix`, O1c);
  `sources.data-points` owns the final `{#sources}` section.
- `constraints.solutions` is a module definition (required, depends on
  `goals.outcomes`); the blockers lane fills its behaviour.

## 5. Template manifests (§4.1, AUD-3)

The seven built-in PRD templates are not rewritten. Each gets a manifest in the
`template_module_assignments` sidecar mapping modules to the template's existing `{#id}`
sections, only where unambiguous. Examples: `top-risks` and `risks` →
`risks.register`; `non-goals`, `not-doing` and `no-gos` → `scope.non-goals`;
`sources*` → `sources.data-points`. Container and mixed sections (`problem-alignment`,
prd-rfc's "Goals and non-goals"), features, milestones and template-specific sections
stay template-owned and are preserved as-is.

- A mapping's policy is derived from the template: `required` when a mapped section is a
  level 1-2 heading (the template's spine), else `optional`.
- Manifests never write `templates` or `template_versions`, so O1g's "no brief
  sections" refusal is never triggered implicitly. An archived built-in gets no
  manifest. An edited built-in keeps its manifest; sections its newer version dropped
  resolve as absent (`sections_absent`).
- A company may replace a template's manifest (`PUT /v1/template-manifests/{template}`,
  approver). Its rows carry `created_by` and a packaged manifest never replaces them.
- A template with no manifest (any company template) composes exactly as before: every
  module renders as a new section.

## 6. Composition (§4.3)

`composer.compose(Context, Changes | None)` is pure and deterministic.

1. **Candidates**: the chosen packs' modules (company modules join a pack through
   `applies_to`), the template manifest, the company's mandatory modules, and modules a
   person adds. Packs: the request's, else the company default, else by `category`.
2. **Policy**: the company module policy first (`required`, `optional`, `disabled`),
   else the strongest of the pack contract's and the manifest's
   (required > conditional > optional).
3. **Selection**: required is *mandatory*; a conditional module whose condition holds
   is *suggested*; everything else is *optional*. A module the template already
   renders stays included by default, so the template keeps its shape. Each module has
   a reason, an explanation, its `basis` (every condition leaf with the value read, the
   knowledge state and evidence ids), missing information, and question prompts. An
   advisory signal (AI analysis or a priority score, `advisory` in the request) is shown
   as the score and never decides alone.
4. **A person's changes** (`changes`: add, remove, order):
   - removing a mandatory module is refused (`required_module`), naming who requires it;
   - removing a module an included module depends on is refused
     (`required_dependency`) unless the dependents are removed in the same change;
   - adding pulls in its dependencies, each explained as "needed by";
   - a module whose contract asks for the owner role needs an owner (`role_required`);
   - a disabled or unknown module cannot be added.
5. **Closure and conflicts**, to a fixpoint: a required dependency that cannot be
   satisfied fails clearly (`unsatisfied_dependency`); a conflict drops the weaker
   module (mandatory, then a person's choice, then the template, then suggested, then
   score), and fails when both are mandatory (`required_conflict`) or a person added
   one without removing the other (`conflict`).
6. **Order**: topological over `order_after` / `order_before`, ties by
   `display_order` then id; Sources and data points is always last (O1c). A person's
   order must list every included module and respect the constraints
   (`order_violation`, `order_mismatch`).
7. **Validation**: new section ids must not collide (`section_collision`); supplied
   field values are checked against the module's types and validators.

Problems are returned with a stable `code` and `fatal` flag: a recommendation shows
them, confirming refuses (422) while any is fatal.

**Revisions.** `POST /v1/documents/{doc}/composition/revisions` (approver) recomputes
from the same inputs, applies the changes and stores a revision with `decided_by`,
`decided_at`, `reason` and `parent_number`; the previous working or confirmed revision
becomes `superseded`, a published one stays published. `base_revision` must be the
current number (409 otherwise, never last-write-wins). Each revision records a
`composition_revision` change event. A **material** change (a module added, removed or
re-versioned) also records one `document_section` change event per affected section
(`subject_ref` `<slug>#<section>`, cause `composition_changed`): the review lane
invalidates approvals there, the trace lane marks artifacts stale. Reordering alone is
not material.

**Publishing.** `POST /v1/documents/{doc}/composition/publish` (approver) pins the
confirmed revision to an approved document version: the revision already holds the
template key and version, every module id and version with its origin (company
override or built-in) and any person's override with its reason, the packs, the company
policy snapshot and the inputs. A published revision is never changed. The modules lane
also registers the `oracle.changes` handler `modules.pin_published_composition`: when the
review lane's publish transaction records `document_version` with cause `published`,
the confirmed composition is pinned in the same transaction.

**Drafts stay compatible.** `skeleton.render_body` renders a composition onto a template
body: every template section stays, in order; new module sections are inserted (brief
ones before `{#full}` and added to `brief: [...]`, full ones before `{#sources}`) with
the module's instructions as guidance. `templates.service.draft_skeleton` and
`docs.parser.parse_draft` accept the result for all seven templates and both packs. The
composition lives in the sidecar tables, so drafts carry no new front matter; `{#id}`,
`resolutions`, brief/full markers and the appendix work unchanged. Module mapping is by
section id, so it holds under heading renames, reordering and re-imports; sections no
module claims are listed as `unmapped` and kept as written.

## 7. Routes (all under `/v1`, MCP tools from OpenAPI)

| Route | Role | MCP tool |
|---|---|---|
| `GET /module-catalog` (`pack`, `include_archived`) | viewer | `list_module_catalog` |
| `GET /module-catalog/{key}` | viewer | `get_module_catalog_entry` |
| `POST /module-catalog` | owner, audited | `create_company_module` |
| `POST /module-catalog/{key}/versions` | owner, audited | `create_module_override` |
| `GET /module-packs` | viewer | `list_module_packs` |
| `GET /module-policy`, `PUT /module-policy` | viewer, owner (audited) | `get_module_policy`, `put_module_policy` |
| `GET /template-manifests/{template}`, `PUT` | viewer, approver (audited) | `get_template_manifest`, `put_template_manifest` |
| `POST /compositions/recommend` | viewer (changes nothing) | `recommend_composition` |
| `GET /documents/{doc}/composition` | viewer | `get_document_composition` |
| `POST /documents/{doc}/composition/revisions` | approver, audited, change events | `confirm_composition_revision` |
| `POST /documents/{doc}/composition/publish` | approver, audited | `publish_composition` |

Refusals are 422 `ProblemsOut` (`detail`, `problems[]` with `code`, `message`,
`module`, `fatal`). Another company's document, intake or module is a 404. Run tokens
with `read:documents` can read `GET /documents/{doc}/composition`; every other new route
refuses run tokens (`oracle/mcp/scopes.py` unchanged).

The thin foundation read routes (`/modules`, `/module-versions`,
`/template-module-assignments`, `/compositions`, `/composition-revisions`) are unchanged.

## 8. Migration notes

- No schema change, no backfill. Documents without a composition are legacy: they
  read, review and export exactly as before, and the inspector offers a
  recommendation without writing anything.
- Templates and themes are never written by this lane (§16 item 2,
  `test_edited_and_archived_templates_and_themes_are_untouched`).
- On a document's first confirmed composition no section changes, so no section event
  is recorded (approvals stand). Later material changes record them.
- At merge, nothing to re-chain (no `0014_modules`).

## 9. Screens the UI wave needs

1. **Composition inspector** (inside the new-PRD flow and on the PRD view). Data:
   `GET /documents/{doc}/composition` or `POST /compositions/recommend`.
   - States: legacy (no composition: show the recommendation, a "Confirm composition"
     call to action); confirmed; working; published (read-only, pinned version shown);
     invalid recommendation (fatal problems listed, confirm disabled); loading; error.
   - Per module: mandatory / suggested / optional badge; included or not; reason;
     `policy_source` (company, pack, template); the basis (each condition input, value
     read, knowledge state chip: verified fact, user decision, AI inference, hypothesis,
     unknown; evidence ids linking to the evidence inspector); missing information;
     questions it would ask; brief/full impact (brief sections, full sections, new
     sections, sections absent from the template); depends on / required by /
     conflicts with; version, origin (built-in or company override), version history,
     upgrade available; the person who overrode it and why.
   - Actions (approver): add, remove, drag to reorder; each refusal shows the problem's
     message inline (required module, required dependency, conflict, order violation,
     role required); preview through `recommend` with `changes`; confirm with a
     required reason, or save as working; publish with an approved version.
   - Revision history: number, status, who, when, reason, diff (added, removed,
     version changes, reordered, material, affected sections).
2. **Outline preview** (next to the template/theme preview): `outline` entries, brief
   then full, each marked template-owned or module-added, with the module title.
3. **Module catalogue** (settings): list with pack filter and archived toggle; detail
   with the effective contract (fields, validators, questions, instructions, evidence
   expectations), release history and upgrade available. Owner actions: new company
   module, new company release (override), each with validation problems inline.
4. **Packs** (settings, read-only): the two packs with their modules and policies.
5. **Company module policy** (settings, owner edits): required, optional and disabled
   lists and default packs; validation problems inline.
6. **Template manifest** (on the template detail page): mapped modules with present and
   absent sections, unmapped template sections, edited flag; approver edits the
   mapping.

## 10. Tests

`api/tests/modules/`: evaluator (40), catalogue and packs including §16.5 templates-only
(13), registry and seeding including §16.2 (9), composer including §16.4 (23), parser
compatibility for §16.1 (17), routes including roles, 401s, negative cross-company, audit,
change events, publishing and MCP parity (24).
