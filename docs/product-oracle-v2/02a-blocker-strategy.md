# Product Oracle v2: blockers, solution strategy and scaling (CR-04)

Lane `v2-blockers`, build prompt §6 and §16 items 8 and 11, wave plan [waves.md](waves.md).
API and logic only (I3: the UI is redesigned first). Owner decisions in
[docs/questions.md](../questions.md) take precedence; this lane found no conflict with them,
so it added no row to [change-requests.md](change-requests.md). It added no migration: the
foundation's tables and JSONB payloads were enough.

## 1. What a blocker is

A blocker is an **existing baseline `constraint` entity** with a strategy in
`attrs["blocker"]`. Nothing is duplicated beside the graph (§7):

| §6 asks for | Where it lives |
|---|---|
| Stable id, statement, evidence, confidence | The entity: `id` and `key`, `title` (the statement), `body` (detail), its baseline evidence rows and their aggregate `confidence` |
| Type (`hard`, `soft`, `unknown`, `temporary`), severity, timing, threshold, status, owner, review date | `attrs.blocker` (`BlockerSpec`: the foundation's `BlockerAttrs` plus the fields below) |
| Third-party limit class (§16.8) | `limit_kind`: `capacity` (rate or capacity), `eligibility` (API eligibility), `permission`, `policy`, or `other`; and `third_party`, the party that sets it. A third-party limit must be one of the four classes. |
| Impacted outcomes, requirements, users | `impacted_entity_ids` (goal, outcome, product, feature, requirement, acceptance criterion, person) and `impacted_users` (segments in words). Requirements and features also get an `affects` edge from the constraint. |
| Scaling across companies, agents, channels, quotas, cost, blast radius | `scaling` |
| Documents it gates | `document_ids`, plus any `document_section_links` row that points at the entity |
| Selected option | `selected_option_id` (and the option's `status = selected` with `selected_reason`) |
| Solution options with outcome, cost, effort, technical and policy feasibility, risk, residual limits, fallback, monitoring signal, scaling trigger, corrective action, review date | `blocker_options` (the six §6 approaches), `details` typed by `BlockerOptionDetails` |
| Experiment, owner, decision gate | `feasibility_experiments` |
| Resolution history | `blocker_resolution_events`, append-only |
| Risk acceptance (who and why) | `assumption_decisions` (`decision = accept_risk`, `decided_by`, `rationale`, `review_at`) |

`revision` in `attrs.blocker` gives PATCH optimistic concurrency without a schema change;
options and experiments use the foundation's `lock_version`. Every write also locks the
row for update.

### The constraint-only rule

`blocker_options`, `feasibility_experiments` and `blocker_resolution_events` reference any
`entities.id`; the database cannot require `type = 'constraint'`. `oracle.blockers.service`
does: every path goes through `require_constraint()`, which raises `NotAConstraintError`
(422) for any other type, and `spec_of()`, which raises `NotABlockerError` (409) for a
constraint without a strategy yet. `test_a_non_constraint_entity_is_refused_everywhere`
covers every route and the service functions directly, and checks that no row was written.

## 2. Status, events and the change hook

Statuses: `open`, `mitigating`, `resolved`, `accepted_risk`, `feasibility_only`.

| Transition | Route | Rule |
|---|---|---|
| open, mitigating, resolved | `POST /v1/blockers/{id}/status` | resolving needs a reason; back to `open` from a closed state is a `reopened` event |
| accepted_risk | `POST /v1/blockers/{id}/accept-risk` | reason and a review date required, in the future and within `blocker_risk_review_max_days` (B4, default 90); for a critical hard blocker only `blocker_risk_acceptance_role` and above (B4, default `owner`), otherwise approvers too; writes an `AssumptionDecision`, a `risk_accepted` event and one audit event, `blocker.risk_accepted` |
| feasibility_only | `POST /v1/blockers/{id}/feasibility-scope` | the experiment belongs to the blocker, is planned or running, and has an owner, a success threshold and a decision gate date in the future; for a critical hard blocker only `blocker_risk_acceptance_role` and above (B4); one audit event, `blocker.feasibility_scope_approved` |
| open → mitigating | selecting an option | `option_selected` event |
| feasibility_only → open | the scope's experiment fails, is cancelled or is inconclusive | automatic, `status_changed` event |

Every status change appends a resolution event, writes the entity through
`oracle.baseline.service` (revision and lock), audits, and calls
`oracle.changes.record_change(db, "blocker_status", ...)` **once per document the blocker
gates** (once with no document when it gates none), with `from_status`, `to_status`,
`reason`, `kind` and the option or experiment. Selecting or rejecting the selected option,
and changing a blocker's type or severity, record a `blocker_status` change too (causes
`option_selected`, `option_rejected`, `blocker_reclassified`). A handler that raises
aborts the whole change.

### Only the blocker routes write `attrs.blocker`

`attrs.blocker` is a managed attrs key (`oracle.baseline.service.MANAGED_ATTRS`). Only a
`Writer` that names it in `manages` (the blocker service's) may set, change or remove it.
Every other baseline write path refuses (422, naming `/v1/blockers`): `POST` and `PATCH
/v1/baseline/entities`, proposals (`POST /v1/baseline/proposals`, the MCP
`propose_change` tool, agent writes that would become proposals) and accepting one made
before this rule, conflict resolution, and YAML imports. A YAML file that leaves
`attrs.blocker` out keeps it (it is not dropped with the other missing keys); a file
that changes it is rejected. Other attrs, the title and the body stay editable. Rejecting
(archiving) or deleting the constraint entity stays possible through the baseline, and
then it no longer gates (§3).

Each write that changes what the gate reads (type, severity, status, gated documents)
records it on a resolution event as `data.gate`. A status change does it on its own event.
A type, severity or documents edit through `PATCH /v1/blockers/{id}` appends a
`status_changed` event with no from or to status and `data.change = "reclassified"` (a
new event kind would need a migration).

## 3. The hard readiness check

`oracle/blockers/readiness.py` registers `critical_blockers` with `hard=True` when
`oracle.main` imports the router. For a document:

- no blocker linked: `not_applicable`. A blocker gates a document listed in its
  `document_ids`, linked from one of its sections, or listed in its last recorded gate
  snapshot. An archived (rejected) or deleted constraint no longer gates;
- **fails closed** first: a strategy whose type, severity, status or documents differ
  from the last recorded `data.gate` snapshot (or that has none) is `critical`, whatever
  it says, so a strategy edited straight in the database never clears the gate;
- a **critical, hard** blocker is `critical` while it is `open` or `mitigating`. It passes
  only when its status rests on a **recorded** decision:
  - `resolved` by a status event;
  - `accepted_risk` by a `risk_accepted` event whose `AssumptionDecision` exists and is
    before its review date (past it, the blocker is critical again);
  - `feasibility_only` by a `feasibility_scope_approved` event whose experiment is still
    planned, running or succeeded, still has its owner and success threshold, and has
    not reached its decision gate. The gate date is the earlier of the one approved with
    the scope and the experiment's current one: moving it later needs a new approval. A
    succeeded experiment does not pass on its own. It is time-boxed to its gate date,
    and after that the blocker must be resolved (or get a new decision);
- a status written around these routes (a generic baseline edit of `attrs`) does not match
  the last recorded event, so it stays `critical` with a rationale that says so;
- an unreadable strategy fails closed (`critical`);
- lesser unresolved blockers (hard but not critical; critical but soft, unknown or
  temporary; unknown types) are a `warning`. A warning never blocks (T2).

The outcome carries a rationale per blocker, the blocker entity ids, the first owner, and
the section ids (`constraints-solutions`, `blocker-<key>`). `v2-review`'s publish
transaction refuses a publish when it is critical.

## 4. Third-party limits and compliance (§6, §16.8)

`oracle/blockers/policy.py`:

- `LIMIT_KIND_LABELS` and `compliant_paths(kind)`: the compliant ways to reach the user
  outcome per class. Capacity: efficiency, queueing within the permitted rate, a higher
  tier, fewer calls by design. Eligibility: the approved program, a workflow without the
  gated API, another channel. Permission: explicit opt-in or OAuth consent, a permission
  request, an assisted step. Policy: opt-in interactions, negotiated or sanctioned access,
  another channel. Efficiency is never offered for a permission, eligibility or policy
  limit.
- `screen(*texts)`: a deterministic check of an option's title, description and every
  detail for three categories: `evasion` (bypassing limits, rotating proxies, spoofing,
  avoiding detection, scraping against terms), `identity_abuse` (fake, bought or extra
  accounts, impersonation, shared logins) and `unauthorized_messaging` (unsolicited or
  mass messages, messaging without consent, auto-DM, scraped contacts). Synonyms include
  cycling or rotating accounts, mass DMs, scraping (any), and bypassing, evading or
  skirting a limit, cap or threshold. A tactic named only to rule it out ("instead of
  bypassing the limit", "never scrape") is not flagged, but only when the negation
  governs it: same clause, at most two words before it, "without" directly before it.
  "Without delay, bypass the limit" is flagged, and a negated tactic never hides a later
  one. The screen is a first filter: an unflagged option still needs a person's
  compliance review before it can be chosen.

Rules: a new option starts `needs_review`. A flagged one is stored `non_compliant`,
`rejected`, policy feasibility `low`, with its flags, so the record of the idea stays but
it can never be selected, kept as a fallback, recommended or marked compliant (no role can
override the screen; rewording is the way out). Only approvers record the compliance
review. Editing a reviewed option's text resets it to `needs_review`; the selected or
fallback option's title, approach and description cannot be rewritten (add another option
instead), and its details cannot gain a flagged tactic. The database's `compliant` check constraint is
the last line. `recommended_option_id` is the best compliant, reviewed, unflagged,
non-rejected option by technical plus policy feasibility, never a flagged one.

## 5. The `constraints.solutions` module rendering

`GET /v1/documents/{doc}/blocker-strategy/render` returns `BlockerModuleRender`, built by
`oracle/blockers/render.py` (pure functions):

- `brief_markdown`: `## Blockers and solution strategy {#constraints-solutions}`, one
  slide: a row per blocker (most severe first, six at most) with type and class, severity,
  status and the path taken, each linking to its full sub-section;
- `full_markdown`: `## Constraints, blockers and solution strategy
  {#constraints-solutions-detail}`, then `### <statement> {#blocker-<key>}` per blocker
  with classification, timing, threshold, impacts, owner, review date, the options table,
  the decision (selected option, reason, fallback, monitoring signal, scaling trigger,
  corrective action, review date), validation experiments and scaling notes. Options
  ruled out by the policy screen are counted, never spelled out;
- `citations` for the front matter, `evidence_by_section`, `data_points` and
  `appendix_markdown` for Sources and data points. **No body carries a citation marker or
  evidence prose (O1c)**; the response model refuses one. User text is flattened to one
  line with `[c:…]` markers and `{#…}` anchors removed, so it cannot add sections or
  citations.

Proposed contract values for `v2-modules`: `section_ids: [constraints-solutions,
constraints-solutions-detail]`, `brief_section_ids: [constraints-solutions]`,
`evidence_policy: record_provenance_in_appendix`. The per-blocker `blocker-<key>` ids are
level-3 children of the full section. `test_the_rendering_imports_as_a_draft_with_brief_and_full_layers`
assembles a draft from the output and imports it through `parse_draft`.

## 6. Routes

All `/v1`, Pydantic in and out, company-scoped, MCP tools generated from OpenAPI.

| Method and path | Role | What |
|---|---|---|
| `GET /blockers` | viewer | Summaries; filters `document_id`, `status`, `type`, `severity`, `limit_kind` |
| `POST /blockers` | approver | Make an existing constraint a blocker (`entity_id`) or create one (`key`, `statement`) |
| `GET /blockers/{id}` | viewer | The strategy view: blocker, gate, evidence, options (flags, recommended), compliant paths, experiments, events, risk acceptance, documents |
| `PATCH /blockers/{id}` | approver | Edit; `revision` required (409 when stale); no status |
| `POST /blockers/{id}/status` | approver | open, mitigating, resolved |
| `POST /blockers/{id}/accept-risk` | approver; owner for a critical hard blocker (B4 setting) | Reason and review date (within the B4 horizon) |
| `POST /blockers/{id}/feasibility-scope` | approver; owner for a critical hard blocker (B4 setting) | Experiment id and reason |
| `POST /blockers/{id}/options` | commenter | Propose an option (screened) |
| `PATCH /blocker-options/{id}` | approver | Edit or record the compliance review; `lock_version` |
| `POST /blocker-options/{id}/select` | approver | Select with a reason |
| `POST /blocker-options/{id}/fallback` | approver | Keep as the fallback |
| `POST /blocker-options/{id}/reject` | approver | Reject with a reason |
| `POST /blockers/{id}/experiments` | approver | Plan an experiment |
| `PATCH /feasibility-experiments/{id}` | approver | Edit, start, conclude (a result is required) |
| `GET /documents/{doc}/blocker-strategy` | viewer | Every blocker gating the document, with the readiness outcome |
| `GET /documents/{doc}/blocker-strategy/render` | viewer | The module rendering |

The foundation's reads (`/blocker-options`, `/feasibility-experiments`, `/blocker-events`)
are unchanged. Run tokens may read blockers under `read:baseline` (and the document routes
under `read:documents`); no run-token scope allows a blocker write.

Mock API: `web/lib/api/mock/blockers.ts` serves every route above on the v2 mock rows, with
one seeded critical hard blocker on the mock PRD.
