# Lane: roadmap from an approved PRD (O4b)

Dispatch from `main` after 16e3916. One SwarmCloud `claude-code` task, strategy
`direct-pr`. Runs in parallel with the O1g follow-ups lane.

## Prompt

ROADMAP FROM AN APPROVED PRD for Product Oracle (decision O4b in docs/questions.md;
read it, O4, O5, O1c, O1d, O1f, B2, W1, W2 and P3 first, then api/oracle/runs/
(flows.py, service.py), api/oracle/docs/, api/oracle/templates/, the roadmap
templates in docs/research/templates/roadmap/, api/oracle/mcp/ and web/app/).

Today a roadmap document can only be written by hand from a roadmap template; the
Roadmap screen is marked "v1.1". Build the flow that turns an approved PRD into a
roadmap draft.

1. Flow `prd_to_roadmap` in api/oracle/runs/flows.py, beside `baseline_to_prd`:
   - Input: an approved PRD version (the document's latest approved version by
     default, or a named one); refuse with 422 when the PRD has no approved version.
     Also the target roadmap document (new or existing, kind `roadmap`), its roadmap
     template (default `now-next-later`, per O4) and theme (default `roadmap-board`),
     and the usual knobs (depth, roles, checkpoints, budget).
   - Segment `roadmap_items` (roles analyst, prioritizer; checkpoint `roadmap_items`):
     read the PRD version, the baseline (confirmed goals and the B2 horizons), the
     priorities and the depends_on / blocks edges; write `roadmap_items.yaml`: one item
     per PRD feature or milestone with title, outcome, horizon (now / next / later),
     milestone, dependencies, priority score with its explanation, confidence, and the
     PRD section id it comes from. Order respects dependencies. Dated milestones only
     in Now and only when a source gives a date or estimate (O4).
   - Segment `roadmap_draft` (roles writer, critic; checkpoint `roadmap_review`): write
     `roadmap.md` in the chosen roadmap template, brief markers included (O1f), no
     evidence in the body and a final Sources and data points section (O1c). Each item
     links back to its PRD section with a cross-document link that the app resolves to
     the PRD view and exports resolve to absolute URLs.
   - The draft imports as the roadmap document's next version. Generalise
     `imports_prd` / `_import_prd` to import a document draft of the target's kind.
   - Cost table entries and estimate as for the other flows; runs over the approval
     threshold wait for an owner (P3).
2. Provenance: a roadmap version records the PRD document and version it came from.
   Shown in the app ("From <PRD title> v<n>", linking to it), in the API and MCP, and
   in the exports' version banner. If this needs a migration, use revision `0011`,
   down_revision `0010` (another lane may also add a `0011`; the integrator renumbers).
3. Feedback loop: the existing `feedback_loop` flow works on roadmap documents too
   (the next draft is a roadmap of the same template), with tests.
4. App: the Roadmap screen replaces "v1.1": it lists roadmap documents with their
   status and source PRD. An approved PRD gets "Build roadmap" (approver and above),
   which asks for the roadmap template and theme (the existing new-draft picker),
   shows the estimate, and starts the run. A roadmap document opens in the existing
   document view, so brief/full, Expand, Present, comments, verdicts, diffs and the
   Brief / Full / Deck exports work unchanged.
5. API and MCP: the flow appears in list_flows; create_run / start_run accept it with
   the source PRD; documents and versions return provenance.
6. Tests: the flow definition and knobs; refusal for an unapproved PRD; segment prompts
   carry the PRD version, priorities and edges; roadmap_items.yaml validation;
   roadmap.md import with provenance and resolved PRD links; the feedback loop on a
   roadmap; role checks; an end-to-end run against the fake SwarmCloud like the
   existing run tests; Playwright mock tests for Build roadmap and the Roadmap screen.

Agents run in SwarmCloud and reach Oracle only through its MCP server with run tokens;
do not change anything about SwarmCloud. Product Oracle words only (users, roles;
never "workspace"). Never touch .github/. Run the full API suite, ruff, make openapi,
web lint/tsc/build, Playwright. Commit. Write `$SWARM_ARTIFACTS_DIR/roadmap-report.md`.
