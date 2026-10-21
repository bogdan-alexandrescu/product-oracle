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
reviewed or reconciled like any other. The dependencies on the sections that link it are
marked first and stay.

**Deleted links.** Deleting an entity or an edge (directly, over MCP, or by accepting a
delete proposal) also deletes its evidence, and an entity its edges and their evidence.
The section links that name the entity or cite that evidence are released before the
delete as for removed evidence (`oracle.v2.links.release`): a link that keeps another
target (another entity, other evidence, a source item) only drops the deleted one and
keeps tracing the section to the rest; a link left with no target is deleted, and the
change keeps what it was (`data.trace.links`). The sections whose links cite the deleted
evidence are marked potentially stale ("cites evidence that was deleted"): for an entity
through its `entity_deleted` change (`data.evidence_ids`), for an edge through an
`evidence_deleted` change (subject `source_permission`, `data.evidence_ids` and
`data.edge`) recorded only when a section link cites its evidence, whether or not the edge
was confirmed. A YAML import never deletes: items not in the file are left alone.

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

## 8. Roadmaps, tracker alignment and product tracks (lane `v2-roadmap`, CR-11)

Build prompt §11.4, §11.1 (tracker part), §11.5 and V2b. Code in `api/oracle/roadmap/`,
migration `0016_roadmap` (down revision `0014_blockers_snapshot`). The existing
`prd_to_roadmap` flow, the five roadmap templates, the `roadmap_review` loop, brief/full,
Present, themed decks and exports are unchanged ([roadmap-from-prd.md](../roadmap-from-prd.md)).
The roadmap is still a document; its version keeps the trace lane's derived
dependencies (§2). This lane adds rows per item.

### 8.1 Tables

| Table | What |
|---|---|
| `roadmap_items` | one row per item of a roadmap version: key, title, outcome, horizon, position; the exact PRD document, version, section key and section hash; `feature_id`, `requirement_ids`, `blocker_ids`, `depends_on`; `trace` (how each link was made); `milestone` (`date` only with `basis_ids`); `validation_gates`; `economics`; `priority`; `confidence`; freshness columns (`freshness`, `caused_by_change_id`, `stale_since`, `stale_reasons`, `reconciled_*`, `note`) |
| `schedule_bases` | verified estimates, capacity figures and commitments: kind, `reference` (what a `date_source` names), `supports_date`, optional PRD scope and tracker record, `verified_by/at`, `status` verified or withdrawn |
| `product_tracks` | one per PRD: started and current (latest approved) PRD version, the roadmap it follows, status (active, paused, closed), owner, the last monitoring snapshot |
| `track_milestones` | name, horizon, `target_date` (a check constraint: no date without bases), `basis_ids`, `item_keys`, status |
| `tracker_records` | engineering status read back (latest per tracker and issue key): state (todo, in_progress, done, cancelled, unknown), raw status, estimate, target date, observed at, the track and item key it belongs to |

`change_events.subject_kind` gains `product_track` (a track's monitoring).

### 8.2 How an item is traced

| Link | Made from, in order (`trace[].via`) |
|---|---|
| PRD version and section | the run's source version (`document_versions.source_version_id`) and the item's `prd_section`, at that section's content hash |
| feature | `feature:` in the file (`declared`); else a feature the PRD section links on that version (`section_link`, kinds implements, claims, evidences, tests); else the feature whose key is the item id (`key_match`) |
| requirements | declared; section links; requirements `part_of` the feature (`graph`) |
| blockers | declared; section links; constraints that `affects` or `blocks` the feature or its requirements (`graph`). Views add blockers linked later, live |
| validation gates | declared; acceptance criteria that `verifies` the requirements; the blockers' planned or running feasibility experiments with their decision gate |
| economics | declared; the feature's `effort`, `confidence`, `value`, `cost`; the priority score |

An unknown declared key stays in `trace` with `unresolved: true`. Items arrive with the
`roadmap.md` import (the `roadmap.items` change handler reads the run's
`roadmap_items.yaml`); `PUT /v1/roadmaps/{doc}/versions/{n}/items` imports a file for a
version by hand (refused whole on any problem, and for a version built from no PRD
version; an approved version's items are pinned, 409). A version imported without a file (the feedback loop, `oracle push`) carries forward
the previous version's items that its text still names.

### 8.3 Dates (O4)

Now/Next/Later on the B2 horizons is the default and needs no date. A date is accepted
only on verified bases that support exactly that date:

- item milestones: `date_source` must name a basis's `reference` (whole token, any case)
  whose `supports_date` is the date. Otherwise `unverified_date`: the run's `items_check`
  reports it (checkpoint on: the reviewer sees it; off: the run fails), a manual import is
  refused, and a stored item keeps `refused_date` and never `date`;
- track milestones: a date only in Now, with `basis_ids` that are verified, of this
  company, for this PRD or company-wide, and support that date (422 otherwise);
- a withdrawn basis supports nothing: milestones lose a date no other basis supports, and
  items whose date rested on it go potentially stale.

### 8.4 Item staleness

The `roadmap.items` handler (registered after `trace.mark_stale`, whose
`data.trace.entity_ids` it reads) marks items `potentially_stale` and records
`change_events.data.roadmap` (item ids and reasons):

| Change | Items marked |
|---|---|
| `document_version` (a PRD version imported) | traced to an earlier version of that PRD whose section hash differs or is gone (no section: any new version) |
| `document_section` | traced to that section |
| `requirement`, `decision`, `entity`, `blocker_status` | whose feature, requirements or blockers include the subject, a batch root, or what the trace walk found downstream; and whose PRD section links one of them |

Content and trace are never rewritten. `POST /v1/roadmaps/{doc}/items/staleness`
(approver): `review` (to `under_review`) or `reconcile` (reason required). Reconciling
records the PRD's latest *approved* version and that section's hash as what the item was
reconciled against (`reconciled_version_id`, `reconciled_section_hash`; never an older
version than the item's anchor). Later PRD versions are judged against it; the PRD
version the item was built from stays as built. The anchor before is audited. A run's
file that cannot be stored (a malformed optional field) never aborts the roadmap version's
import: the items are left out and the error is logged, and the checkpoint has already
shown the problem. A carried-forward milestone keeps its date only while a verified basis
still supports it.

### 8.5 Tracker alignment (E1, read-only)

`POST /v1/tracker/records` (approver) stores what was read from a tracker; Oracle writes
nothing back. `GET /v1/roadmaps/{doc}/alignment` reports per item `aligned`, `drift`,
`untracked` or `done`, with drift both ways: `ahead` (work started on a Next or Later
item), `date_slip` (a tracker target after the item's earliest verified date),
`overdue`, `cancelled`, and `unplanned` tracker work no item names. Two-way sync is behind
`ORACLE_TRACKER_TWO_WAY_ENABLED` (default off): `POST /v1/tracks/{id}/tracker-push` is
409 off, 501 on (no connector is verified). `GET /v1/tracks/{id}/tracker-plan` previews
the epics and issues a connector would write (`would_write: false`).

### 8.6 Product tracks (V2b)

Started by the review lane's publish (`document_version`, cause `published`, handler
`roadmap.start_track`), by storing a roadmap's items from an approved PRD version, or by
`POST /v1/tracks`. `GET /v1/tracks/{id}` is the overview: `health` (on_track, at_risk,
off_track, no_roadmap, paused, closed), a one-line `headline`, `counts`, `next_milestone`,
`at_risk` (blocked, stale, slipping, with reasons), `drift`, `engineering_known`,
`prd_moved` (a later approved PRD version than the roadmap's) and the milestones. Off track:
a critical hard unresolved blocker on a Now item, or a slipping item of the next
milestone. `POST /v1/tracks/{id}/monitor` and the ticker (hourly per active track) store the
snapshot and record a `product_track` change (cause `track_monitored`, before and after)
only when health, at-risk items, the next milestone or `prd_moved` changed. Monitoring is
deterministic, with no model call. Re-deriving a roadmap is a `prd_to_roadmap` run in
SwarmCloud (`POST /v1/tracks/{id}/roadmap-run` drafts it; cost gates apply).

### 8.7 Routes

| Operation (MCP tool) | Method and path | Role |
|---|---|---|
| `list_roadmap_items` | GET `/v1/roadmaps/{doc}/items` | viewer |
| `import_roadmap_items` | PUT `/v1/roadmaps/{doc}/versions/{n}/items` | approver |
| `act_on_roadmap_item_staleness` | POST `/v1/roadmaps/{doc}/items/staleness` | approver |
| `get_roadmap_alignment` | GET `/v1/roadmaps/{doc}/alignment` | viewer |
| `list_schedule_bases`, `create_schedule_basis` | GET, POST `/v1/schedule-bases` | viewer, approver |
| `withdraw_schedule_basis` | POST `/v1/schedule-bases/{id}/withdraw` | approver |
| `get_tracker_connector` | GET `/v1/tracker/connector` | viewer |
| `list_tracker_records`, `import_tracker_records` | GET, POST `/v1/tracker/records` | viewer, approver |
| `list_tracks`, `create_track` | GET, POST `/v1/tracks` | viewer, approver |
| `get_track`, `update_track` | GET, PATCH `/v1/tracks/{id}` | viewer, approver |
| `monitor_track` | POST `/v1/tracks/{id}/monitor` | approver |
| `list_track_changes` | GET `/v1/tracks/{id}/changes` | viewer |
| `create_track_roadmap_run` | POST `/v1/tracks/{id}/roadmap-run` | approver |
| `get_track_tracker_plan` | GET `/v1/tracks/{id}/tracker-plan` | viewer |
| `push_track_to_tracker` | POST `/v1/tracks/{id}/tracker-push` | approver (always refused) |
| `list_track_milestones`, `create_track_milestone` | GET, POST `/v1/tracks/{id}/milestones` | viewer, approver |
| `update_milestone` | PATCH `/v1/milestones/{id}` | approver |

Every route is company-scoped (another company's id is 404, tested for each); writes are
audited (`roadmap.items_imported`, `roadmap.items.<action>`, `schedule_basis.verified`,
`schedule_basis.withdrawn`, `tracker.records_imported`, `track.started`, `track.updated`,
`milestone.created`, `milestone.updated`; the handlers `roadmap.items_marked_stale`). Run
tokens reach none of these routes. The mock API is `web/lib/api/mock/roadmap.ts`.

## 9. Engineering specs, flows and wireframes (lane `v2-specs`, CR-09, §11.1-§11.2)

The code is in `api/oracle/specs/`. Migration `0015_specs` (after `0016_roadmap`) widens two
check constraints: `documents.kind` accepts `spec`, `runs.flow` accepts `prd_to_spec`.
Everything else uses the foundation's artifact tables.

### What is stored where

| Thing | Stored as |
|---|---|
| A spec request | `artifact_requests` of kind `tech_brief` (depth `brief`) or `engineering_spec` (`full`): the approved PRD version, the requirement ids, the PRD sections, `params` (document slug and id, depth, design on or off, screens 2-4, engineering approver ids, feature) |
| Its flows and wireframes | two child requests, kinds `user_flow` and `wireframe` (`params.parent_request_id`) |
| A spec version | a document of kind `spec` (brief and full layers, versions, diffs, section reviews, comments, exports: the PRD machinery) **and** one `artifact_versions` row per document version, with the provenance and the dependencies. The markdown lives once, in the document version; the artifact output `spec.md` points at it (`storage_ref: document_versions/<id>`) |
| A flow or wireframe version | `artifact_versions` with one `artifact_outputs` row per file (`image/svg+xml` or `text/html`, size, sha256, sanitised content inline; `meta`: title, screen, PRD section keys, requirement ids, annotations, what the sanitiser removed) |
| Reviews | the PRD review routes for a spec version; `artifact_review_events` for flows, wireframes and their annotations (`data.output`, `data.annotation_id`) |

### Product requirement apart from proposed engineering approach

Oracle composes every spec version (`oracle.specs.contract.compose`). The agents write the
engineering sections of `spec.md`; Oracle writes the front matter, the **Product
requirements** section (each requirement by id, key, title and statement, with links to
the PRD sections that state it), the decided acceptance criteria from the baseline
(`verifies` edges; the agents' extra criteria are listed as proposals), and Sources and data
points (PRD version, requirement ids, run, code capability map). Every section has a part:
`product_requirement`, `engineering_approach`, `open_decision`, `assumption` or `context`.
Each engineering approach section opens with a "proposed" label. The view
(`GET /v1/spec-requests/{id}`) returns each section's part and whether it is decided: product
requirements always are, the rest only once an engineering approver approves the version.

Brief layer (the technical brief): summary, product requirements, proposed engineering
approach, open engineering decisions. Full layer adds acceptance criteria, user flows,
inputs and outputs, proposed architecture, APIs and data models, dependencies, failure
modes, security/privacy/performance, test strategy, release flags, migration and rollback,
assumptions. A tech brief needs only the brief sections plus acceptance criteria and
assumptions.

**No code capability map yet** (S2 and CR-12 belong to `v2-sources`):
`oracle.specs.capabilities.capability_map()` returns None, so every spec says so, labels its
approach "based on assumptions", and needs a non-empty Assumptions section. When the map
lands, only that function changes.

### What a section body may hold (E1, owner, 2026-10-20)

An edit and a run's import are refused (422, every problem at once,
`oracle.specs.contract.structure_problems`) when a section's heading or body holds raw HTML
(an HTML block or inline tag, including one a backslash escapes, `\<span>`), HTML comment
syntax (`<!--` or `-->`, code included), or a data:, javascript: or vbscript: URL in any
spelling a reader of the raw markdown may follow (`script_url`, `data_url`): every link,
image, autolink (`<javascript:...>`) and reference definition (in a quote or a list too,
with an escaped or multi-line label) as markdown-it reads it, entities and escapes decoded
(`&#106;avascript:`), the scheme read as a browser reads it (control characters and spaces
in it ignored), plus the decoded raw text (an unescaped `](`, `]:` or `<` right before such a
scheme, after any spaces or control characters). Text escaped as entities
(`&lt;script&gt;`) or with a backslash (`\[x\](javascript:...)`) is not refused: it renders
literally. The web renders a link only for http, https, mailto and relative or anchor
destinations; any other scheme shows as plain text. Images load only when Oracle stores
them: a path of the app under `/uploads/` (no backslash, control character, other origin or
dot segment: a browser reads `/\evil.com/p.png` as evil.com). A remote http(s) image, in the
web and in exports, is a link showing its alt text and host (`chart (example.com)`), never
an `<img>`; any other image shows its alt text (owner, 2026-10-20); data: images stay
refused at import.

Every parse of a draft or edit is bounded (r7 re-review, 2026-10-20). A line over 20,000
characters (`line_too_long`, any draft's body, not only a spec's) is refused by one linear
check before any markdown parse (markdown-it's parse is quadratic on one long line of
tag-like text). A paragraph that leaves more than 20 `[` open (`too_many_open_brackets`,
markdown-it's own nesting limit) is refused before its inline parse: open brackets are
what makes markdown-it's link scan slow, about 15 µs per character, whatever the paragraph
size. Anything else is bounded by the parse cap (`too_slow`, `oracle.parse_budget`): each
parse may use `PARSE_SECONDS` (5 s) of CPU time in markdown-it from the moment it starts,
checked as it runs, and stops there, freeing its worker of the parse pool; a wait for a free
worker does not count. A spec version is at most 200,000 bytes (`too_large`,
`MAX_SPEC_BYTES`): an edit as submitted, and a version a run composes as it is served. The
label check reads each
block as it renders in every output: the body, the body without citation markers, and
`layers.slide_body(body)` with and without them. Images are no visible text; a task-list
box or footnote marker before a label, emphasis ending right after 'Decided' or 'Proposed',
a bare 'Decided', and a label split by a hard break are refused. Citation markers are
dropped before a heading is compared with a PRD part's title. The request title is one
escaped line in `# {title} {#spec}` and may not read as a label. The checks never parse
with markdown-it's HTML rule on (it is quadratic on many unclosed `<!--`), and the comment
check is one linear pass. The web's `lib/markdown` follows CommonMark where the check
depends on it: an ordered list interrupts a paragraph only from 1, a line indented four
spaces stays paragraph text, and a table needs a delimiter row with as many cells as its
header (rows are cut or padded to that width).

### Generation: the `prd_to_spec` flow

`POST /v1/spec-requests` (approver) checks that the PRD version is approved, that every id is
a baseline requirement (not rejected), that named sections exist in that version, and that
engineering approvers are approvers. It adds the sections that link the requirements
(`document_section_links`), creates the requests and a **draft** run of the code-defined
flow `prd_to_spec`. The run is estimated and started through the runs routes, so the >$50
owner approval and the 1.5x overrun pause apply unchanged (`POST /v1/runs` refuses this
flow: it needs its request). One segment, `spec_draft` (architect, designer, critic; the
designer is left out when design is off), read-only scopes, writes `spec.md` and
`design.json`, and stops at the toggleable `eng_review` checkpoint (E1).

When the segment succeeds, the registered importer (`oracle.runs.extensions`) composes and
checks `spec.md`, imports it as the spec's next version, checks and sanitises `design.json`
(names, sizes, types, section and requirement links, annotation targets) and stores the flows
and wireframes. Any design error refuses the whole bundle; the request is then `partial`.
Provenance on every artifact version: run, flow, runner profile, runtime, prompt version
(`prd_to_spec/1`), PRD document, version and version id, requirement ids, section keys, source
snapshot. Never a credential.

### Lineage and staleness

Each spec version depends on its PRD sections (anchored at their hashes) and on every
requirement entity; each flow or wireframe version on the sections and requirements its
files link. `oracle.trace`'s handler marks them `potentially_stale` when a section changes in
a new PRD version or a requirement changes (also through the PRD sections that link it).
The `specs.lineage` change handler gives every new spec document version its artifact
version: a run's import records fresh dependencies; a person's edit (`oracle push`, the API)
copies the previous version's dependencies as they are, so an edit never makes a stale spec
fresh. A spec document no request owns is refused (`spec_without_request`).

Nothing is rewritten. `POST /v1/spec-requests/{id}/regenerate` (approver) proposes a
regeneration: a draft run on the latest approved PRD version (or a named one), with the
stale reasons in its prompt. It writes new versions for review; older unapproved versions
are superseded, and an approved one stays until a newer one is approved. A version that is
`potentially_stale` cannot be approved until someone reviews, reconciles
(`POST /v1/trace/staleness/actions`) or regenerates it.

### Engineering approval

`POST /v1/documents/{spec}/versions/{n}/approve` on a spec is the engineering approval of its
approach: only the request's engineering approvers may (any approver when none is named; an
owner always may). Named approvers approve in their own session: an API token's id is not a
user id, so only an owner token can approve a spec with named approvers. It refuses a
superseded or stale version, then applies the PRD approval, marks the artifact version
approved and supersedes the earlier ones (never a newer one). Flows and wireframes are approved, rejected or sent back with
`POST /v1/design-artifacts/{id}/reviews` under the same rule; commenters comment on a version
or an annotation.

### Static, offline design outputs (§16.20)

`oracle.specs.sanitize` rebuilds every SVG and HTML file from an allowlist. A script, an
event handler, a `javascript:` or external URL, an image, frame, object, stylesheet link,
`base`, refresh, form target, CSS `url()` (SVG keeps `url(#id)`), `@import` or escape is a
refusal, not a silent fix. Wireframes get a Content-Security-Policy meta tag and a grayscale
stylesheet after the agents' CSS; flows get a grayscale filter. Buttons never submit.
`GET /v1/design-artifacts/{id}/outputs/{name}` serves them with `default-src 'none'` and
`sandbox` (an opaque origin: no scripts, no network, no access to Oracle's cookies or API),
`nosniff` and `no-store`.

### Routes

| Operation (MCP tool) | Method and path | Role |
|---|---|---|
| `create_spec_request` | POST `/v1/spec-requests` | approver |
| `list_spec_requests` | GET `/v1/spec-requests[?prd=]` | viewer |
| `get_spec_request` | GET `/v1/spec-requests/{id}` | viewer |
| `regenerate_spec` | POST `/v1/spec-requests/{id}/regenerate` | approver |
| `get_design_artifact` | GET `/v1/design-artifacts/{version_id}` | viewer |
| `get_design_output` | GET `/v1/design-artifacts/{version_id}/outputs/{name}` | viewer |
| `review_design_artifact` | POST `/v1/design-artifacts/{version_id}/reviews` | commenter (verdicts: engineering approvers, owner) |

All are company-scoped (another company's ids are 404) and every write is audited
(`spec.requested`, `spec.version_recorded`, `spec.design_recorded`, `spec.design_<kind>`,
`spec.approach_approved`, `spec.regeneration_proposed`). The mock API serves them from
`web/lib/api/mock/specs.ts`.
