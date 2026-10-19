# Product Oracle v2: the wave plan

How [build-prompt.md](build-prompt.md) is built (Bogdan, 2026-10-19: "start implementing it
in waves organized to build as much as possible in parallel, dispatching the work in
SwarmCloud workflows"). Each wave is one SwarmCloud workflow. Each step is one lane: one
`claude-code` task and one reviewed PR. Owner decisions in [docs/questions.md](../questions.md)
take precedence over the build prompt. A lane that would conflict with one builds the
compatible version and records a proposed change in [change-requests.md](change-requests.md).

## Wave 1: foundation, then six lanes in parallel (API and logic)

The six lanes build API and logic only (I3, 2026-10-19: the UI is redesigned first). They
run as a second workflow on the foundation's branch (`ops/v2-wave1-lanes.workflow.json`),
and each lane's report lists the screens its feature needs for the UI wave.

| Step | Change requests | Build prompt | Owns (new code goes here) | Writes |
|---|---|---|---|---|
| `v2-foundation` | shared schema, contracts, hooks | §3, §4.2, §7, §9, §14 | migration `0013`, `oracle/models.py` additions, `oracle/v2/` schemas, `oracle/changes.py`, `oracle/readiness.py`, thin `/v1` read routes | `01-solution-architecture.md` |
| `v2-audit` (parallel with the foundation) | CR-00 | §1, §15 Phase 0, §16 | new regression tests under `api/tests/legacy/` and `web/e2e/legacy/` only | `00-baseline-and-delta.md`, `06-security-and-threat-model.md` |
| `v2-modules` | CR-01, CR-02 | §4 | `oracle/modules/`, template manifests, composition routes | `02-template-modules.md` |
| `v2-blockers` | CR-04 | §6 | `oracle/blockers/`, blocker routes | `02a-blocker-strategy.md` |
| `v2-intake` | CR-03 (+ snapshot lock from CR-12) | §5, §13 steps 1-6 | `oracle/intake/`, gap and question routes | `03-discovery-and-quality.md` |
| `v2-trace` | CR-05 (+ staleness, §11.5) | §7, §11.5 | `oracle/trace/`, trace, impact and evidence-inspector routes | `05-artifact-contracts.md` (lineage and staleness) |
| `v2-review` | CR-06 | §9 (not the chat) | `oracle/review/` extensions, publish transaction, assignees and due dates (API) | `08-review-and-publish.md` |
| `v2-quality` | CR-08 | §10 | `oracle/quality/`, evaluation corpus under `api/tests/fixtures/eval/`, readiness routes | `03b-quality-and-readiness.md` |

In flight before wave 1: **CR-07 SwarmCloud v2**, the adapter v2 lane
(`ops/swarmcloud-adapter-v2.lane.md`, task `task_d6ae4b64dac44ba9b508`). The foundation
leaves runs and swarm tables to it. Its PR merges before or beside wave 1, and it writes
`04-swarmcloud-integration.md` at integration.

### The two hooks (owned by the foundation, used by the lanes)

Lanes never call another lane's code. They meet at two small registries:

- **`oracle/changes.py`**: `record_change(...)` stores a change event and calls the
  registered handlers. The subject is a document section, a requirement, a decision, a
  source permission, a blocker status or a composition revision; the event carries its
  cause and actor. `v2-trace` registers the handler that marks downstream artifacts
  `potentially_stale`. `v2-review` registers the one that invalidates approvals of
  affected sections. `v2-modules`, `v2-blockers` and `v2-intake` record changes.
- **`oracle/readiness.py`**: `register_check(key, fn, hard=...)` and `evaluate(...)` return
  results of `pass / warning / critical / not_applicable` with a rationale, evidence ids
  and an owner. `v2-blockers` registers the critical-hard-blocker check (hard).
  `v2-quality` registers the ten quality criteria (advisory, per T2) and the hard
  security and policy checks. `v2-review`'s publish transaction refuses a publish when a
  hard check is critical.

### Shared rules for every lane

- Extend, never replace (§2). Oracle's words only: company, user, project, product,
  feature, PRD, roadmap.
- No real company data anywhere: code, fixtures, prompts and docs use synthetic
  placeholders.
- Tests first. Before finishing, run the full API suite, `make lint`, `make openapi`
  (commit the regenerated OpenAPI and web client), web lint, tsc and build, and Playwright
  against the mock.
- Every new `/v1` route gets a Pydantic request and response, a role guard, company
  scoping, an audit event when it changes state, and a negative cross-company test. MCP
  tools derive from OpenAPI.
- **Migrations:** the foundation owns `0013`. A lane that truly needs more schema adds ONE
  additive migration, revision `0014_<lane key>`, with down_revision = the foundation's
  revision. The integrator re-chains them in merge order. Nobody edits `0013` or earlier.
- Shared files take small additive edits only: navigation, router registration in
  `main.py`, mock API fixtures, the generated client (regenerated at merge).
- Never touch `.github/`, deployment files or `private/`. Never call real external
  services (SwarmCloud, Figma, trackers); use the fakes. An unverified integration stays
  behind a disabled feature gate and is reported as not done.
- Each lane writes `$SWARM_ARTIFACTS_DIR/<lane>-report.md`: changed paths, migrations,
  assumptions, user-visible changes, tests and results, open risks, owner decisions
  needed (with `docs/questions.md` ids), and what other lanes must know.

### Merging wave 1

1. Review and merge `v2-foundation` first. Then merge `v2-audit` (docs and tests only).
2. Merge lanes in order: modules, blockers, intake, trace, review, quality. For each:
   rebase onto main, re-chain its `0014_*` migration onto the head, regenerate OpenAPI
   and the client, and run the full suite.
3. Merge adapter v2 when its review passes. Deploy follows the owner's cadence.

## Design track (I3: redesign now), in parallel with wave 1

1. `v2-design-directions`: three distinct visual directions for Oracle's app UI (not the
   document themes), as rendered mockups of five screens in light and dark, desktop and
   mobile. The orchestrator reviews every frame, publishes an options page, and the owner
   picks.
1b. `v2-design-blend` (owner, 2026-10-19, I3): one direction blending Atlas and Ledger,
   light and breathable, helper text in tooltips, fewer consolidated indicator cards. It
   draws V2b's whole loop in nine screens (home, requests, baseline, idea interview, PRD
   review, priorities, roadmap and tracks, runs, publish). The sources are in
   `design/directions/`.
2. `v2-design-system`: the chosen direction as tokens and components, restyling every
   existing screen without changing behaviour or the Playwright contracts.
3. `v2-ui`: the screens wave 1 needs, on the design system, from the lanes' screen lists:
   New product idea, Opportunity and Gaps, question batches, the composition inspector,
   blocker strategy, impact explorer, evidence inspector, section review status, the
   publish check and the readiness dashboard.

In every screen, cost is a secondary detail (P3d): one small line on a run, and prominent only in the Inbox's approval and overrun items.

Deploys (V2a): one per wave, after the merged wave passes the full suite and a smoke check.

## Wave 2: linked artifacts and proactive work (after wave 1 merges)

- `v2-specs`: CR-09, engineering specs, SVG flows and low-fidelity wireframes linked to
  requirement ids, with staleness through `oracle/changes.py` (§11.1, §11.2).
- `v2-roadmap`: CR-11, roadmap items traced to approved PRD versions and requirement ids,
  blocker dependencies and validation gates, never invented dates (§11.4).
- `v2-chat`: CR-13, the Head of Product chat panel and review notifications (§9, last
  part). It records a change request against I4 first: chat was deferred.
- `v2-sources`: CR-12, source freshness, "new evidence since version X", ACL metadata and
  the code capability map (§5, §12).
- `v2-prototypes`: CR-10, isolated prototype preview behind a disabled gate, plus the
  Figma `use_figma` feasibility probe as a runbook. It needs an owner decision first.
- `v2-ops`: CR-14, cost per run and phase, budget semantics across the new flows, and
  resilience.

Added by V2b and V2c (owner, 2026-10-19):
- `v2-requests`: feature requests and feedback in one inbox, from every source, with
  duplicates merged, linked to goals, and qualified or disqualified with a reason.
- `v2-interviews`: interactive interviews instead of forms: team members during intake
  and review, and customers. They are real-time, so they run on Oracle's own model
  configuration (V2c), not SwarmCloud.
- `v2-roadmap` also builds product tracks: an accepted PRD starts a track, whose roadmap
  is monitored (status, drift, next milestone, items at risk).
- V2c applies to every lane: agent work runs in SwarmCloud, and only real-time,
  on-demand work uses Oracle's own model configuration.

## Wave 3: the vertical slice

One integration step proves §0's definition of success end to end. It runs a short brief
→ gaps and questions → composition → PRD draft → review and approve → publish → a roadmap
or spec, on synthetic data. It writes `07-release-and-dogfood-checklist.md`. After
SwarmCloud's answering ships and the owner authorizes it, it also runs the live
SwarmCloud end-to-end check from `docs/swarmcloud-interface.md`.

## Owner decisions (build prompt §18) and when they are asked

| Id | Decision | Asked | Lanes build meanwhile with |
|---|---|---|---|
| T2 | PRD quality policy | answered 2026-10-19 | advisory; gate criticals only |
| I3 | UI visual language | answered 2026-10-19 | redesign now: design track first, lanes API-only |
| X3 | SwarmCloud bundled when Oracle is sold | before CR-15 | nothing (deferred) |
| T1 | Enterprise privacy and compliance | before CR-15 | nothing (deferred) |
| O6 | Figma authoring path | before `v2-prototypes` | Figma disabled |
