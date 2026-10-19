# Product Oracle v2: template modules and composition (CR-01, CR-02)

Lane `v2-modules`, build prompt §4, wave plan [waves.md](waves.md). This page covers the
module contract as Oracle uses it, the eight built-in packs (the two of §4.4 and the six
industry packs of O1h), the template manifests, the composition rules, the API, and
migration notes. Owner decisions in
[docs/questions.md](../questions.md) take precedence. The one conflict found is row
MOD-1 in [change-requests.md](change-requests.md).

API and logic only (I3, 2026-10-19). The screens are listed in §9 for the UI wave.

## 1. Where the code is

| Path | What |
|---|---|
| `api/oracle/modules/builtin/core.yaml` | The 17 shared-core modules (Pack A, also the core of Pack B), one release each. |
| `api/oracle/modules/builtin/platform.yaml` | The 15 Pack B specialised modules, all conditional. |
| `api/oracle/modules/builtin/marketplace.yaml`, `fintech.yaml`, `hardware.yaml`, `saas.yaml`, `smb.yaml`, `enterprise.yaml` | The industry packs' own modules (O1h), required, conditional and optional (§4). |
| `api/oracle/modules/builtin/packs.yaml` | The eight packs: ordered module lists, the shared core an industry pack reuses (`core`), and the categories that select a pack. |
| `api/oracle/modules/builtin/manifests.yaml` | Module manifests of the seven built-in PRD templates. |
| `api/oracle/modules/catalog.py` | Loads and validates the packaged data (pure). |
| `api/oracle/modules/evaluator.py` | The applicability evaluator (pure, no eval, typed errors). |
| `api/oracle/modules/composer.py` | The composer (pure, deterministic), field validation, the outline. |
| `api/oracle/modules/skeleton.py` | Renders a composition onto a template body (new module sections). |
| `api/oracle/modules/registry.py` | Seeding, company overrides and modules, company module policy, manifests. |
| `api/oracle/modules/service.py` | Context building (document, intake, template), recommend, confirm, publish, inspector. |
| `api/oracle/modules/router.py`, `schemas.py` | The routes and their Pydantic schemas. |
| `web/lib/api/mock/modules.ts` | Mock API fixtures for every new route. |
| `api/tests/modules/` | The tests (§10); the pure ones are in `unit/` and run without Postgres. |

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

**Seeding** (`registry.ensure_builtin_modules`, after the template seeding) runs at API
startup for every company (`service.seed_all_companies`, so a release's new or upgraded
built-ins reach everyone before anyone reads), when a company is created (`oracle.seed`),
and on the write paths (confirming a revision, manifest, policy and module writes).
At startup each company is seeded in its own transaction: one that fails (another
replica seeding it at the same time, say) is retried once after the others, then logged
by company id (never by name) and left to its next write or the next startup; the other
companies are seeded and the API starts. Built-in templates and themes follow the same
rule: startup, company creation and the template, theme and draft write paths seed
them; no template or theme read does. Reads never write: the catalogue, packs, policy, manifest, recommend and inspector routes
only read, so a viewer changes nothing. Seeding follows the rule for built-in templates in
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
| `category` | string; selects a pack when none is chosen: `ai_agent_platform` Pack B, and each industry pack's categories (§4) | tenant isolation, archetypes, evaluation |
| `brief.decision`, `brief.size`, `brief.model_driven` | the template picker's answers (O1d) | alternatives, economics, evaluation |
| `scope.capabilities` | list of tags: `multi_tenant`, `customer_onboarding`, `organisation_model`, `configuration`, `agent_configuration`, `tool_use`, `memory`, `knowledge`, `evaluation`, `versioning`, `fleet_operations`, `quotas`, `usage_billing`, `external_channels`, `human_interaction`, `customer_branding`, `continuous_improvement`, `portability`; and the industry packs' tags (§4) | Pack B and industry modules, economics |
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

### Industry packs (O1h, owner, 2026-10-19)

Six packs beside the two above. Each reuses the shared core (`core: startup.standard`
in `packs.yaml`: the 17 core modules first, unchanged, then its own) and adds its own
modules in all three tiers: **required** (in every PRD of the pack), **conditional**
(suggested when its applicability condition holds; each condition reads
`scope.capabilities` tags, and some a numeric `signals.*` threshold) and **optional**
(never suggested; a person adds it). Each module is versioned (`1.0.0`), has a stable id
and section id (prefixed with the pack's name), and is company-overridable like any
built-in. A company module whose `applies_to` names `startup.standard` joins every pack
that reuses that core.

| Pack (id, categories) | Required | Conditional (capability tags) | Optional |
|---|---|---|---|
| Marketplace and e-commerce (`marketplace.ecommerce`; `marketplace`, `ecommerce`) | two-sided users and jobs, trust and safety, take rate and unit economics | payouts (`seller_payouts`, `split_payments`), fulfilment and logistics (`physical_fulfilment`, `shipping_logistics`, `returns_handling`), catalogue quality (`catalogue_listings`, `listing_moderation`) | seller tools, liquidity and growth |
| Fintech and payments (`fintech.payments`; `fintech`, `payments`) | regulatory and licensing scope (owner review), money movement and reconciliation, fraud and abuse | KYC/AML (`kyc_aml`, `identity_verification`, `stored_value_accounts`), payment card compliance (`card_data`, `card_issuing`, `card_acceptance`; owner review), cross-border (`cross_border_payments`, `multi_currency`) | partner bank or processor dependencies, regulator reporting |
| Hardware and IoT (`hardware.iot`; `hardware`, `iot`) | physical constraints, manufacturing and supply chain | certification (`radio_hardware`, `safety_certification`, `mains_powered`; owner review), firmware and OTA updates (`ota_updates`, `embedded_firmware`), companion app (`companion_app`, `device_pairing`, `device_cloud`) | field service, end of life |
| SaaS and B2B products (`saas.b2b`; `saas`, `b2b_saas`) | buyer and user roles, onboarding and activation | admin and permissions (`role_permissions`, `admin_console`), integrations (`saas_integrations`, `public_api`, `webhooks`), pricing and packaging (`plan_packaging`, `seat_pricing`, `self_serve_billing`), migration (`data_import`, `data_migration`) | usage analytics, expansion and retention |
| SMB services (`smb.services`; `smb_services`) | owner-operator workflows, setup with no IT staff, affordability | local or vertical regulations (`local_regulation`, `trade_licensing`, `tax_records`), offline and low-tech use (`offline_use`, `shared_devices`, `low_connectivity`), customer touchpoints (`appointment_booking`, `customer_messaging`, `in_person_payments`) | support model, switching from current tools |
| Enterprise software (`enterprise.software`; `enterprise_software`) | security review and attestations (owner review), procurement and contracts | SSO/SCIM (`sso`, `scim_provisioning`), data residency and retention (`data_residency`, `retention_controls`), deployment model (`self_hosted`, `dedicated_deployment`, `air_gapped`), audit logging (`audit_logging`, `siem_export`) | SLAs, change management |

Every tag has advisory keyword hints (`service.CAPABILITY_HINTS`), so an intake's brief
can suggest them as AI inferences. Adding the packs changed no core or platform module
contract, so no company gets a new release of those and existing compositions are
unchanged (`test_existing_pack_compositions_are_unchanged` compares against compositions
captured before the packs). The category `b2b_saas` now selects SaaS and B2B products
for a new composition; an existing composition keeps the packs it was confirmed with.

Rules the tests pin (`tests/modules/unit/test_catalog.py`, `test_industry_packs.py`):

- Titles, instructions, typed fields, question prompts and evidence expectations only.
  No examples, no default values, no named products, brands, characters or personas.
- Persona, character, relationship mode and brand canon appear only to say they belong
  in a linked configuration artifact; the archetype, configuration and brand modules
  carry a field for that artifact's reference.
- Every specialised Pack B module is conditional. A platform PRD gets only the ones its
  capability scope or company policy calls for.
- Every industry pack uses all three tiers; each composes a valid, explained composition
  with every built-in PRD template; a lint over the YAML refuses example content
  (examples, brands, vendors, regulators, places, people, amounts, links, quoted names)
  and fields carry no defaults, options or help text.
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
   person adds. Packs: the request's, else the previous revision's when a person chose
   them there, else the company default, else by `category`. Each revision records how
   (`inputs.policy.packs_source`: `chosen`, `default` or `category`); default and
   category packs are recomputed every revision, so a `default_packs` or category
   change applies on the next one, and only a chosen pack carries.
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
4. **A person's decisions.** Earlier ones first: each revision starts from the newest
   revision's decisions (`decided_by: user`, with the reason, who, and the order if a
   person set it, `ordered_by_user`), so a module a person removed stays out, one added
   stays in, and a custom order holds (modules new since then slot in after their
   default predecessor). An earlier decision that no longer fits is set aside with a
   non-fatal problem: a removed module that became mandatory or that a module now
   depends on comes back (`decision_superseded`); an added module now disabled or gone
   is dropped (`decision_dropped`). These problems come back in the confirm response's
   `problems`, so the person confirming sees what was set aside. Then this change (`changes`: add, remove, order),
   which wins over an earlier decision on the same module:
   - removing a mandatory module is refused (`required_module`), naming who requires it;
   - removing a module an included module depends on is refused
     (`required_dependency`) unless the dependents are removed in the same change;
   - removing a module an earlier revision already removed is not an error: it stays
     out with this change's reason and decider;
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
from the newest revision's inputs and decisions, applies the changes and stores a
revision with `decided_by`, `decided_at` and `reason`. `base_revision` must be the newest
revision's number, working or not (`head_revision` in the inspector; 409 otherwise,
never last-write-wins).

- `status: "working"` saves a draft. It supersedes nothing, does not become the revision
  in force, and records no change event at all; its `parent_number` is the revision it
  started from.
- `status: "confirmed"` (the default) puts the revision in force: the confirmed revision
  it replaces becomes `superseded` (a published one stays published), as do drafts saved
  since. Its `parent_number` and diff are against the revision it replaces, and it
  records a `composition_revision` change event. A **material** change (a module added,
  removed or re-versioned) also records one `document_section` change event per
  affected section (`subject_ref` `<slug>#<section>`, cause `composition_changed`): the
  review lane invalidates approvals there, the trace lane marks artifacts stale.
  Reordering alone is not material.

A company module policy change (`PUT /module-policy`) records one `composition_revision`
change event (cause `module_policy_changed`, with what was added to or removed from each
list) for every document's composition in force; a person re-confirms to apply it.

**Publishing.** `POST /v1/documents/{doc}/composition/publish` (approver) pins the
latest confirmed revision (never a working draft) to an approved document version: the revision already holds the
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
| `GET /module-packs` (all eight, core modules first) | viewer | `list_module_packs` |
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
- Deploying this release seeds the industry pack modules for every company at startup
  (new `module_definitions` and `module_versions` rows only; nothing existing changes).
- Revisions saved before `ordered_by_user` existed read it as false: an order a person
  set then is not carried (their removals and additions are).
- Templates and themes are never written by this lane (§16 item 2,
  `test_edited_and_archived_templates_and_themes_are_untouched`).
- On a document's first confirmed composition no section changes, so no section event
  is recorded (approvals stand). Later material changes record them.
- At merge, nothing to re-chain (no `0014_modules`).

## 9. Screens the UI wave needs

1. **Composition inspector** (inside the new-PRD flow and on the PRD view). Data:
   `GET /documents/{doc}/composition` or `POST /compositions/recommend`.
   - States: legacy (no composition: show the recommendation, a "Confirm composition"
     call to action); confirmed; a working draft beside the revision in force (`working`,
     with "Confirm draft" and its diff against the revision in force); published
     (read-only, pinned version shown);
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
4. **Packs** (settings, read-only): the eight packs with their categories, the shared
   core and each pack's own modules grouped by tier (required, conditional with the
   capability tags that suggest it, optional).
5. **Company module policy** (settings, owner edits): required, optional and disabled
   lists and default packs; validation problems inline.
6. **Template manifest** (on the template detail page): mapped modules with present and
   absent sections, unmapped template sections, edited flag; approver edits the
   mapping.

## 10. Tests

`api/tests/modules/`: evaluator, catalogue and packs including §16.5 templates-only,
registry and seeding including §16.2, composer including §16.4, carried decisions
(`unit/test_prior_decisions.py`), industry packs with the YAML lint and the unchanged
existing compositions (`unit/test_industry_packs.py`), parser compatibility for §16.1,
routes including roles, 401s, negative cross-company, audit, change events, publishing and
MCP parity, and the review fixes (`test_review_fixes.py`: cumulative decisions, working
drafts, read-only reads, manifest refusals, policy change events).
