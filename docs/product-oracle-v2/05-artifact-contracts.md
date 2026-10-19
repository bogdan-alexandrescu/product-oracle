# Product Oracle v2: artifact contracts (lineage and staleness)

Lane `v2-trace`, CR-05 and §11.5 of [build-prompt.md](build-prompt.md), wave plan
[waves.md](waves.md). This page covers how a downstream output (an engineering spec, a flow
or wireframe, a prototype, acceptance tests, a roadmap) records what it was made from, how a
change upstream makes it `potentially_stale`, how a person settles that, and the trace,
impact and evidence views. Wave 2 lanes (`v2-specs`, `v2-roadmap`, `v2-prototypes`) add their
own sections for artifact content. Owner decisions in [docs/questions.md](../questions.md)
take precedence. Row TRC-1 in [change-requests.md](change-requests.md) records the one point
where this lane built the version that is compatible with an open decision (AUD-9).

The code is in `api/oracle/trace/`. No migration: the lane uses the foundation's tables
(`document_section_links`, `artifact_dependencies`, `change_events`, `artifact_versions`,
`artifact_review_events`) and the baseline graph.

## 1. The chain and where each link lives

```text
source snapshot / evidence -> goal -> outcome -> feature -> requirement -> acceptance criterion
        (baseline graph: entities, edges, evidence; locked/confirmed protections unchanged)
                                                       |
                         document_section_links (doc, version, section, section hash, claim)
                                                       |
                         artifact_dependencies (downstream output -> upstream anchor, freshness)
                                                       |
                    artifact version (spec, flow, wireframe, prototype, tests) | roadmap version
```

| Link | Stored as | Direction |
|---|---|---|
| outcome → goal, requirement → outcome | edge `derived_from` | src is downstream of dst |
| feature → goal or outcome | edge `supports` (contribution 0-3) | src is downstream |
| requirement → feature, feature → product | edge `part_of` | src is downstream |
| acceptance criterion → requirement | edge `verifies` | src is downstream |
| A → B | edge `depends_on` | A is downstream |
| assumption, risk, decision, blocker → requirement or feature | edge `affects` | dst is downstream |
| blocker (constraint) → feature or requirement | edge `blocks` | dst is downstream |
| decision → risk or blocker | edge `mitigates` | dst is downstream |
| requirement → owner | edge `owned_by` | never propagates (a person is not content) |
| alternatives, experiments | `blocker_options`, `feasibility_experiments` on the blocker entity | shown with the requirement |
| assumption decisions | `assumption_decisions.entity_id` | shown with the requirement and its assumptions |
| section → entity, evidence or source item | `document_section_links` | the section depends on what it links |
| output → section at a hash, a whole version, or an entity | `artifact_dependencies` | the output depends on its upstream |

Walks skip rejected entities and edges, except their own roots (an entity just rejected,
or about to be deleted, still reaches what was built on it), and stop at depth 8 or 2000
nodes (`oracle/trace/graph.py`). Nothing loads the whole graph: `load_around` loads the
roots' neighbourhood one query per level and direction. A load or walk that stops at a bound
sets `truncated`, which the change event (`data.trace.truncated`), the impact report and
both trace views carry. Trace views only read: they never unlock, confirm or rewrite a
graph item, and a write to a locked item still becomes a proposal, as before.

### Version anchors (§7)

| Anchor | Where |
|---|---|
| `source_snapshot_id` | `composition_revisions.inputs.source_snapshot_ids`; the draft's front-matter `snapshot` |
| `baseline_snapshot_id` | `composition_revisions.inputs.baseline_snapshot_id` |
| `template_version` | `document_compositions.template_version`, else `documents.template_version` |
| `composition_revision` | the revision published with the version, else the current one |
| `doc_id`, `doc_version` | `document_versions.document_id`, `number` (and the version id) |
| `section_id`, `section_hash` | `sections.section_key`, `sections.content_hash` |
| `requirement_id` | baseline entity id (`entities.id`) |
| `artifact_version` | `artifact_versions.id`, `number` |

`GET /v1/documents/{doc}/versions/{n}/trace` returns them as `anchors`.

## 2. Recording what an output was made from

A wave 2 lane that imports an artifact version calls
`oracle.trace.staleness.add_dependencies(...)` (or `POST /v1/trace/dependencies`) with its
upstream: document sections (`version_id` + `section_key`, anchored at the section's current
hash), whole document versions, or baseline entities (requirements, acceptance criteria).
It is idempotent per anchor. Each row starts `fresh`. Requirements an artifact request lists
in `requirement_ids` need an entity dependency each; the helper does not add them implicitly.

A document version built from another one (a roadmap from its PRD, O4b, through
`import_draft(..., source_version_id=...)`) gets its dependencies derived automatically when
it is imported. There is one per linked section (`/documents/<slug>/v/<n>#<section>` in its
body), or one on the whole source version when it links none. A version that already has
dependencies (a lane recorded its own) is left alone.

Section links are made per version (`POST /v1/documents/{doc}/versions/{n}/section-links`,
approver). They are pinned to the section's hash. When a new version is imported, links of
sections whose hash did not change are carried forward to it. A changed section's links stay
on the version they were made on. A link made on version *k* still ties dependencies anchored
on *k* or later to what it links, so a reconciled dependency keeps reaching its requirement.
An approved version's links cannot be added or removed (409): publishing pins them (§16.17).

## 3. Staleness (§11.5)

### States, per dependency (an artifact version's `freshness` is the worst of its rows)

| State | Set by | Meaning |
|---|---|---|
| `fresh` | creation | nothing upstream changed since it was made or confirmed |
| `potentially_stale` | the `trace.mark_stale` handler | an upstream change may affect it. `caused_by_change_id` and `stale_since` are set |
| `under_review` | a person: `review` or `accept_regeneration` | someone is checking it, or its regeneration proposal was accepted |
| `reconciled` | a person: `reconcile` (needs a reason) | confirmed still valid against the current upstream. The dependency is re-anchored on the upstream document's latest version and that section's hash |

Order, worst first: potentially_stale > under_review > reconciled > fresh. A new change makes
any of them `potentially_stale` again.

### The handler (`oracle/changes.py` hook)

`oracle/trace/router.py` registers `trace.mark_stale` for the subjects below. It runs in the
caller's transaction. If it raises, the change rolls back.

| Subject | Recorded by | Marks |
|---|---|---|
| `document_version` | `docs.service.import_draft` (this lane), on every new version | dependencies on the document whose section hash differs in the new version (or whose section is gone), and dependencies on a whole earlier version |
| `document_section` | `v2-review` and others (`data.section_key`, optional `after_hash`) | dependencies on that section, and on the whole document |
| `requirement`, `decision`, `entity` | `baseline.service` (this lane): an applied update, confirm, reject or delete (not a proposal), and an edge created, removed or changed (recorded against its downstream end; `owned_by` records nothing) | the entity and everything downstream of it in the graph: dependencies on those entities and on the sections that link them. A rejected or deleted entity also reaches the wholes it was `part_of` or `verifies`, and an edge change the whole it joins or leaves (`data.wholes`) |
| `blocker_status` | `baseline.service` when `attrs.blocker.status` changes; `v2-blockers` on its own transitions | the same, from the blocker |
| `source_permission` | `v2-sources` (wave 2): `subject_id` is a source or source item, `data.source_item_ids` optional | the evidence from those items, the entities it supports, and the sections that link either |
| `composition_revision` | `v2-modules` | dependencies on sections of modules whose inclusion, version, sections or policy changed since the parent revision (`data.section_keys` adds more), and on the whole document. With no parent revision, everything |

**Bulk writes.** A YAML import (a person's file or a run's `baseline.yaml`) runs inside
`baseline.service.batched_changes`: changes are collected per entity and recorded when the
import ends, one change event per subject kind. A single entity's change is recorded as
usual. Several go in one event with `subject_id` null, `subject_ref` "<n> baseline items",
`data.entity_ids` and `data.roots` (each with its id, ref, cause, fields, edge and wholes).
The handler walks the graph once per event. Other lanes' handlers for these subjects must
read `data.roots` when `subject_id` is null. Deletions are never batched: they are recorded
while the entity and its edges still exist.

**Deleted upstream.** `artifact_dependencies.upstream_entity_id` is `ON DELETE SET NULL`
(migration `0014_trace`). When an entity is deleted, the handler marks its dependants
potentially stale with an "… was deleted" reason, then nulls the reference and keeps
`upstream_snapshot` (id, type, key, title, status) and `upstream_deleted_at`. The output
stays potentially stale, lists the deleted entity (`upstream.deleted: true`), and can be
reviewed or reconciled like any other. Section links to the deleted entity go with it. The
dependencies on those sections are marked first and stay.

What the handler writes, and nothing else:

- the dependency's `freshness`, `caused_by_change_id` and `stale_since` (kept from the first
  time it went stale), and for a deleted upstream entity its snapshot (above);
- the artifact version's aggregate `freshness`;
- one `artifact_review_events` row of kind `marked_stale` per artifact version, with actor
  `system`, the reasons, the change id and the change's actor;
- `change_events.data["trace"]`: exactly which dependencies it marked, their previous state,
  the reasons, the downstream entities and the outputs. The impact explorer reads this, so a
  change's impact stays exact even after the graph changes;
- an audit event `trace.marked_stale` when it marked anything.

**Never rewritten:** an artifact's content, outputs, status, approval and provenance, and a
document version's markdown and approval, are never touched. Regeneration is a proposal. When
someone runs it, it makes a new version for review, and the old one stays until a reviewer
approves the new one (§11.5, CR-09 to CR-11 build the generators).

### Human actions

`POST /v1/trace/staleness/actions` (approver) with `action` = `review` | `accept_regeneration`
| `reconcile`, exactly one of `artifact_version_id` or `document_version_id`, optional
`dependency_ids` and a `reason` (required to reconcile). It returns 409 when nothing is in a
state the action applies to, 404 for another company's output, and 422 for a dependency id
that is not the output's. `GET /v1/trace/staleness` lists outputs that are not fresh, a page
at a time (`limit` 1-200, default 50, and `offset`; it returns `items`, `total` and
`next_offset`), stalest first, each with its dependencies and the reasons recorded by the
change that marked them. Each action records an audit event `trace.staleness.<action>` (from
and to states, the anchor before re-anchoring, the reason) and, for artifacts, an
`artifact_review_events` row (`comment` for review and acceptance, `reconciled` for
reconciliation).

## 4. The impact explorer and the regeneration plan

| Route | What |
|---|---|
| `GET /v1/trace/changes/{change_id}/impact` | a recorded change: what it marked and why |
| `GET /v1/documents/{doc}/versions/{n}/impact` | what version *n* changes for outputs built on earlier versions, plus the change events recorded for it |
| `GET /v1/baseline/entities/{entity_id}/impact` | a preview: what a change to this node would reach; nothing is marked |

`ImpactReport` holds `affected` (one `TraceOutput` per output, with `category`:
`engineering_spec` (tech briefs too), `wireframe` (flows and Figma designs too),
`prototype`, `acceptance_tests`, `roadmap`, `document`), its dependencies and reasons, the
baseline entities downstream (`affected_entities`, acceptance criteria included), `counts` by
category, and `plan`. Each `RegenerationProposal` is targeted: it names the action
(`regenerate`, or `review` for a source-permission change), only the changed sections and
baseline items, and how to run it: a new artifact version, or a `prd_to_roadmap` run for a
roadmap. `keeps_approved_version` is always true. Superseded and rejected versions get no
proposal.

## 5. The evidence inspector (§16.9, O1c)

`GET /v1/documents/{doc}/versions/{n}/evidence[?section=]` returns, per section, its links
(strongest source first: by confidence, unscored last) and the draft's own `[c:id]`
citations. Each link carries its kind, precision, claim, module, composition revision, whether
it was made on this exact section revision (`current`), and its target:

- baseline evidence: ref, url, excerpt, confidence (company-visible, as today);
- a baseline entity (a decision, a requirement): type, title, status, locked;
- a source item: title and URL **only for the user whose source it is** (AUD-9). Everyone else
  sees `restricted: true` and the source kind. Linking someone else's source item is refused
  as unknown (422).

Exports: themed and unthemed HTML (and the PDF from it) gain an **Evidence links by section**
list inside the Sources and data points appendix: the claim, the source and its confidence.
Source items appear as "<kind> source item", since an export has no single reader.
Rejected or superseded baseline items are left out. A document-wide link (no version) goes
under the section it names, also when it names it by stable reference (`<slug>#<key>`), in
another case, or through its module. The
narrative body is unchanged: no citations, chips or claims (O1c). A version without links
exports byte-for-byte as before. The markdown export stays the stored draft, as today (AUD-2).

## 6. Routes, roles and MCP

| Operation (MCP tool) | Method and path | Role |
|---|---|---|
| `get_version_trace` | GET `/v1/documents/{doc}/versions/{n}/trace` | viewer |
| `get_version_evidence` | GET `/v1/documents/{doc}/versions/{n}/evidence` | viewer |
| `get_version_impact` | GET `/v1/documents/{doc}/versions/{n}/impact` | viewer |
| `create_section_links` | POST `/v1/documents/{doc}/versions/{n}/section-links` | approver |
| `delete_section_link` | DELETE `/v1/section-links/{item_id}` | approver |
| `get_entity_trace` | GET `/v1/baseline/entities/{entity_id}/trace` | viewer |
| `get_entity_impact` | GET `/v1/baseline/entities/{entity_id}/impact` | viewer |
| `get_change_impact` | GET `/v1/trace/changes/{change_id}/impact` | viewer |
| `list_stale_outputs` | GET `/v1/trace/staleness` | viewer |
| `act_on_staleness` | POST `/v1/trace/staleness/actions` | approver |
| `create_artifact_dependencies` | POST `/v1/trace/dependencies` | approver |

Every route is company-scoped (another company's id is a 404, tested for each), and every
write is audited. Run tokens can read the document and baseline routes through
`read:documents` and `read:baseline`, as for the routes beside them. They cannot read
`/v1/trace/*` or write any of these. The mock API (`web/lib/api/mock/trace.ts`) serves every
route from the v2 mock rows.

## 7. Not done here, and why

- **Engineering issues** (the chain's last hop): there is no tracker integration yet (E1, CR-11).
  When `v2-roadmap` or a tracker lane imports issues, it records them as artifact versions
  or document versions with dependencies, and staleness covers them unchanged.
- **Edges:** creating or removing an edge records no change. Only entity changes do. A new
  `affects` edge is picked up by the next change to either end.
- **UI:** none in wave 1 (I3). The screens are listed in the lane report.
