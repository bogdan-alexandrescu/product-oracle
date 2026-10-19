# 00 — Baseline and delta (CR-00)

The `v2-audit` lane wrote this from the code and tests at the checkout, not from the
descriptions of them. It covers build prompt §1, §15 Phase 0 and §16, and records what
v2 must keep, reuse and not break. Companion documents:
[06-security-and-threat-model.md](06-security-and-threat-model.md), and the regression
tests under `api/tests/legacy/`.

Maturity key used below:
- **working:** exercised end to end by the test suites and used in the deployed app;
- **tested:** built, with tests that prove it, but not exercised live;
- **partial:** works with known gaps, which are listed;
- **spec:** designed or decided, not built;
- **blocked:** cannot proceed without an outside switch or an owner step.

## 1. Checkout and what changed since the pinned baseline

| | SHA | Date | What it is |
|---|---|---|---|
| Pinned review baseline (build prompt header) | `869d3b78e1a8a2e9fa98f8640abd7c79e4741fbc` | 2026-10-18 16:55 -0700 | "docs: build brief and reuse catalogue" |
| This lane's checkout (wave 1 is pinned to it) | `b1bc1cfd149031f85b9c7856ce75767abfe4d0ce` | 2026-10-19 | "docs: Product Oracle v2 build prompt, wave plan and wave 1 workflow (V2)" |
| `origin/main` when this was written | `5a84ac1` | 2026-10-18 20:27 -0700 | 6 commits ahead of the checkout (below) |

The checkout came as a one-commit shallow clone. History was fetched with
`git fetch --deepen=300` to compare against the pinned SHA.

**869d3b7 → b1bc1cf (12 commits, 19 files, +1413/−17):**
- **Export:** the Roadmap board PDF footer is filled, and the repeated-header detection
  is linear (PR #7, `export/render.py`, `themed.html.j2`, `themed.css`). The build brief's
  "pending PR #7" note is now out of date.
- **Runtime:** a new route, `GET /v1/runtime/status`, reports who SwarmCloud says Oracle is
  (PR #8). It touches `runs/router.py`, `runs/schemas.py`, `swarm/runtime.py`,
  `swarm/swarmcloud.py` and `swarm/fake.py`, and adds 95 lines to OpenAPI. The build
  brief's "~115 REST routes" now reads 167 operations on 135 paths.
- **Docs and ops:** W2b (a checkpoint waits 20 h), the adapter v2 lane spec
  (`ops/swarmcloud-adapter-v2.lane.md`), and the v2 build prompt, wave plan and wave 1
  workflow.

**b1bc1cf → origin/main 5a84ac1 (6 commits, after this lane was dispatched):**
- **Code:** `fix(swarm)` changes how error details and failed-task errors are redacted
  (PR #9, `swarm/swarmcloud.py`, plus 86 lines in `tests/test_swarm.py`). No schema or
  route change.
- **New decisions in `docs/questions.md`:**
  - **T2 answered:** evaluation is advisory; only criticals gate a publish.
  - **I3 answered:** the UI is redesigned now, so wave 1 lanes are API-only and a design
    track runs first.
  - **V2a answered:** deploy once per wave.
- **Ops:** `waves.md` says the wave 1 lanes are API-only. New files:
  `ops/v2-wave1-lanes.workflow.json`, `ops/v2-design-directions.lane.md` and
  `ops/v2-wave2.workflow.json`.
- **This lane is not affected:** it adds docs and tests only, which rebase cleanly. The
  decisions table in §5 uses the answers from `origin/main`.

**Unmerged branches seen on origin:**
- `lane/b1-sources`, `lane/c-baseline`, `lane/d1-mcp`, `lane/d2-mcp-oauth`, `lane/e-runs`,
  `lane/f-templates` and `lane/k-connections` each hold one "raw patch" commit from
  2026-10-17. They were integrated through `swarm/task_20e4e17…` and are stale; nothing in
  them is pending.
- The adapter v2 lane (`task_d6ae4b64dac44ba9b508`, CR-07) had no branch on origin when
  this was written.
- No open PR conflicts with this lane's paths.

## 2. Commands and results in this environment

Environment:
- Debian 12 container with no root, no Docker and no system Postgres. Python 3.11 is on
  the host, and uv provides Python 3.12 for the API. Node 24.21.
- Postgres 16.2 came from the `pgserver` wheel in a throwaway venv under `/tmp`, run on
  `127.0.0.1:5432` with user `oracle`.
- WeasyPrint (Pango) and Chromium need system libraries the image lacks, such as
  `libglib-2.0.so.0` and `libpango-1.0`. They were supplied without root: Debian bookworm
  `.deb` packages were downloaded with `apt-get download` into a private apt state dir
  and extracted into `/tmp/sysroot`, then used through `LD_LIBRARY_PATH` and a private
  `FONTCONFIG_FILE`. Nothing was installed system-wide, and none of this is in the repo.

| Command | Result | Notes |
|---|---|---|
| `make test` (as written, serial, no PDF libraries) | **1157 passed, 7 skipped, exit 0** (13m38s) | The 7 skips are PDF tests gated on `ORACLE_REQUIRE_PDF` / `pdf_available()`. |
| `ORACLE_REQUIRE_PDF=1 make test` with the sysroot libraries, including `tests/legacy/` | **1206 passed, 0 skipped, exit 0** | |
| `make lint`: `ruff check .` and `ruff format --check .` | **pass** (264 files formatted) | The web half is the eslint row. |
| `make openapi` | **no drift**: regenerating `openapi.json` and `schema.d.ts` changes nothing | |
| `cd web && npx eslint` | **pass** | |
| `cd web && npx tsc --noEmit` | **pass after `next build`**; before it, 15 × TS2304 "Cannot find name 'PageProps' / 'LayoutProps'" | Next 16 generates those route types during `next build` (or `next typegen`), so run tsc after the build in CI and locally. This is an ordering issue, not a defect. |
| `cd web && npm run build` | **pass** | |
| Playwright against the mock (`E2E_PORT=3117 npx playwright test`) without the sysroot | 96/96 failed at browser launch with `libglib-2.0.so.0: cannot open shared object file` | Environment blocker. |
| The same run with the sysroot libraries | **96 passed** (2.4m) | |
| `make e2e`, Playwright against the real stack | **not run** | It needs `docker compose`, which this container lacks. Recorded as an environment blocker. |
| Alembic `upgrade head` on an empty database | **pass**: every test session runs `0001` → `0012` (`tests/conftest.py`) | The chain is linear. |

### 2.1 Final runs (filled in after the full runs)

The final numbers, also in the lane report (`v2-audit-report.md`):

- `ORACLE_REQUIRE_PDF=1 make test` (whole suite plus `tests/legacy/`): **1206 passed, 0 skipped, exit 0** (15m38s). That is 1164 existing tests, including the 7 PDF tests that were skipped before, plus 42 new legacy tests. One warning: WeasyPrint asks for `libharfbuzz-subset`, which the sysroot lacks.
- Playwright against the mock with the sysroot libraries: **96 passed (2.4m), exit 0**.

## 3. Capabilities, classified from code and tests

Counts:
- 44 tables and 167 REST operations on 135 paths (`web/lib/api/openapi.json`). There is
  one MCP tool per operation, plus curated tools (`mcp/curated.py`).
- 27 web pages, 31 components, and about 32.7k lines of Python in `api/oracle`.
- Tests: 1164 API tests (1157 without the PDF libraries), plus 42 new in `tests/legacy/`; 96 Playwright tests against the
  mock.

| Capability | Code | Proven by | Class | Gaps found in code |
|---|---|---|---|---|
| Company scoping (`TenantScoped`, ORM filter and flush guard) | `tenancy.py:72-103` | `test_tenancy.py`, cross-company tests in `test_import.py`, `test_review.py`, `legacy/test_legacy_roles.py` | working | Raw SQL (`text()`, Core inserts) is not rewritten (`tenancy.py:13-14`). The two Core inserts set `tenant_id` themselves. |
| Auth: IAP, session cookie, API token, OAuth, run token | `auth/deps.py:109-131`, `mcp/auth.py` | `test_auth.py`, `test_iap.py`, `test_oauth.py`, `test_runtokens.py` | working | Sessions cannot be revoked server-side. There is no API to issue or revoke API tokens (only `oracle.seed`). See doc 06. |
| Roles viewer < commenter < approver < owner | `authz.py:20-36` | `test_authz.py`, `legacy/test_legacy_roles.py` | working | Some routes check only that the caller is signed in (sources, runs reads, templates reads). That is equivalent to viewer. |
| Members and invites | `members/` | `test_members.py`, `members.spec.ts` | working | |
| Audit log | `audit.py` | asserted across suites | working | There is no read API for audit events. |
| Encryption of credentials | `crypto.py:25-41` | `test_crypto.py` | working | One secret derives every key. No key rotation (`KEY_VERSION` is stored but has no keyring). |
| MCP server, one tool per operation | `mcp/server.py`, `mcp/tools.py` | `test_mcp.py` (verified end to end with Claude Code, per the build brief) | working | |
| OAuth 2.1 for MCP | `mcp/oauth/` | `test_oauth.py`, `test_oauth_migration.py`, `oauth-consent.spec.ts` | working | Dynamic client registration is open to anyone, by design (I2). |
| Run tokens | `runtokens.py` | `test_runtokens.py`, `test_mcp.py::test_run_token_scopes_limit_tools_and_calls` | tested (never used live) | SwarmCloud never receives them: `swarmcloud.py:225` leaves `spec.mcp` out on purpose. There is no egress-address restriction (decided in `swarmcloud-interface.md` §3.2, not built). Scope is per area, not per run. |
| Sources, sync, snapshots, search | `sources/` | `test_sources.py`, `tests/connectors/`, `sources.spec.ts` | partial | Connectors are tested against fixtures; live use depends on each user's connections. Sync is on demand only (no webhooks). There is no "new evidence since version X". Visibility differs from S3: each user sets their own source's allowlist and reads only their own items (`sources/items.py:32-35`). There is no admin allowlist and no company-wide visibility (change request AUD-9). |
| Per-user connections, S5b revocation | `connections/` | `test_connections_*.py`, `connections.spec.ts` | tested | |
| Public-link evidence (C2b, C2c) | `baseline/public_links.py` | `test_public_links.py` (33 test functions, parametrised), `evidence-links.spec.ts` | working | SSRF hardening is described in doc 06. |
| Confidence scoring | `confidence.py` | `test_confidence.py` | working | |
| Baseline graph: typed entities and edges, evidence, locks, conflicts, traceability | `baseline/` | `test_baseline_*.py`, `baseline.spec.ts` | tested | Node types are goal, product, feature, requirement, constraint, decision and person. There is no assumption, blocker, alternative, experiment or risk type, and no document-section or artifact links (CR-04, CR-05). |
| Priorities (goal-weighted, RICE, MoSCoW, WSJF) | `priorities/` | `test_priorities.py`, `priorities.spec.ts` | tested | |
| Draft format: `{#id}`, front matter, `[c:id]`, `resolutions` | `docs/parser.py` | `test_parser.py`, `test_import.py`, `legacy/test_legacy_documents.py` | working | The section hashes of a legacy draft are now pinned. |
| Brief and full layers, notes blocks, O1g refusal | `docs/layers.py`, `templates/validation.py` | `test_brief.py`, `test_o1g.py`, `brief.spec.ts`, `legacy/` | working | Versions imported before the brief layer are not backfilled (O1g), as decided. |
| Section diff | `docs/diff.py` | `test_diff.py`, legacy | working | |
| Review: comments, verdicts, locked sections, feedback package, approve | `review/` | `test_review.py`, `review.spec.ts`, `legacy/test_legacy_locked_sections.py` | working | See the notes after this table. |
| Pushback once with an override log (C1b, C1d) | `jobs/`, `llm/` | `test_llm_jobs.py`, `test_pushback_threshold.py`, `llm-jobs.spec.ts` | tested | Runs on the Claude account pool (P3b), and one account is live. |
| Templates: 7 PRD and 5 roadmap built-ins, company edit and archive, upgrade that skips edited copies | `templates/builtins.py:317-424` | `test_templates.py`, `test_brief.py`, `legacy/test_legacy_templates_themes.py` | working | The upgrade path covers templates only. Built-in themes are inserted when missing and never updated, so a fix to a packaged theme reaches companies only through shared CSS. |
| Themes: 6 built-ins, validated CSS and slide CSS | `templates/validation.py:377-408` | `test_o1g.py`, `themes.spec.ts` | working | |
| Picker recommendation (four questions) | `templates/service.py` | `test_templates.py`, `new-draft.spec.ts` | working | `audience` is a picker input only. There are no audience-variant renders (O5). |
| Exports: HTML, PDF, markdown, deck PDF, PPTX | `export/` | `test_export.py`, `test_drafts_export.py`, `test_brief.py`, legacy | working | PDF tests need Pango (see §2). Markdown export is full layer only; `layer=brief&format=md` is 422. |
| Present mode | `web/components/PresentMode.tsx` | `brief.spec.ts` | working | |
| Runs: three code-defined flows, knobs, estimate, >$50 approval, 1.5x pause, checkpoints in the Inbox | `runs/` | `test_runs.py`, `test_roadmap.py`, `runs.spec.ts`, `inbox.spec.ts`, `legacy/test_legacy_cost_gates.py` | partial | See the notes after this table. |
| Roadmap from an approved PRD (O4b), with provenance | `runs/roadmap.py`, `docs/models.py:90` | `test_roadmap.py`, `roadmap.spec.ts`, `legacy/test_legacy_roadmap_provenance.py` | tested | Dated milestones are only as good as the estimates in the items file; E1 (tracker estimates) is not built. |
| Runtime adapter: the `Runtime` protocol, fake, SwarmCloud, `/v1/runtime/status` | `swarm/` | `test_swarm.py` | partial | See §6. |
| Claude account pool | `claude_accounts/` | `test_claude_accounts_*.py`, `claude-accounts.spec.ts` | working (one account) | |
| CLI: push, pull, sync, baseline, accounts, tick | `cli/oracle_cli.py` | `test_cli*.py` (mocked transport), plus `legacy/test_legacy_import_paths.py` against the real app | tested | |
| Web app screens and typed client with mock API | `web/` | 96 Playwright tests against the mock | working | The real-stack Playwright run (`make e2e`) was not run here. |
| Head of Product chat (I4) | none | none | spec | It is decided in I4 and listed as not built in the build brief (§8). See CR row 1. |
| Slack pings and thread feedback (C1) | none | none | spec | |
| Share links and audience variants (O5) | none | none | spec | |
| Engineering tracker two-way (E1) | none | none | spec | Linear and Jira appear only as precedence kinds in `baseline/conflicts.py:48-49`. |
| Code indexer and capability map (S2) | none | none | spec, blocked on SwarmCloud's `indexer` access to Oracle | |
| Flows and wireframes (O2), Figma (O6) | none | none | spec; Figma authoring is blocked (O6 is unverified headless) | |
| Webhooks (I1, default) | none | none | spec | |
| Modules, compositions, gaps, blockers, readiness, trace links, artifacts (CR-01 to CR-05, CR-08 to CR-11) | none at this SHA | none | spec | The wave 1 foundation adds the shared schema. |

Notes on the review row:
- An approved section is locked per version only; a new version starts unlocked.
- A changed locked section is flagged with a warning, not refused.
- There are no per-section assignees or due dates, no optimistic concurrency, and approval
  is per version with no publish transaction (CR-06).

Notes on the runs row:
- Live agents get prompt-only context (no MCP).
- There is one workflow per segment, and no submit de-duplication by label.
- A failed submit is retried on the next tick, which can create a duplicate workflow if
  the first submit timed out after SwarmCloud accepted it (§16.15; CR-07).

## 4. What to reuse and extend (and what not to duplicate)

| Area | Reuse as is | Extend | Do not |
|---|---|---|---|
| Tables | `TenantScoped`, `audit_events`, `users`, `api_tokens`, `run_tokens`, `documents`, `document_versions` (with `source_version_id`), `sections`, `citations`, `comments`, `section_reviews`, `feedback_items`, `templates`, `template_versions`, `themes`, `entities`, `edges`, `evidence`, `snapshots`, `runs`, `run_segments`, `checkpoints` | New tables reference `document_versions.id`, `sections.section_key` plus the content hash, `entities.id` and `snapshots.id`, so they stay revision-safe. Add edge types to `edges` before adding a graph table (§7). | Store a second canonical markdown beside `document_versions.markdown` (§14). Add a second graph next to `entities`/`edges`. Edit migrations `0001`–`0012`. |
| Routes | `/v1/documents/*`, review routes, exports, `/v1/templates`, `/v1/themes`, `/v1/drafts/recommend`, `/v1/runs/*`, `/v1/inbox`, `/v1/baseline/*`, `/v1/search`, `/v1/snapshots` | Add new routes under `/v1` with `require_role`, `TenantDB` and `audit.record`. MCP picks them up automatically. Add the run-token scope area to `mcp/scopes.py` for anything agents may call. | Change the request or response shape of existing operations. The CLI and generated client depend on them. |
| Pages | Documents, version view (brief/full, Expand, Present, diff, exports), templates and themes settings, new draft, runs, Inbox, baseline, priorities | Per I3 (on `origin/main`), new screens wait for the design track; wave 1 is API-only. | Replace navigation or document URLs (`/documents/{slug}/v/{n}`). |
| Suites | `tests/fixtures/`, `seed_auth`, `FakeRuntime` with scripted `Outcome`, `tests/legacy/helpers.py` (CLI over ASGI, MCP session, role credentials) | Each new route needs a negative cross-company test. | Change `tests/legacy/` expectations without a change request (see the header of `tests/legacy/__init__.py`). |

## 5. Decisions made, decisions open

Already decided (do not re-ask):
- F1, F2, F3b
- P3, P3b, P3c (cost)
- P4 (stack)
- S3, S4, S5, S5b (sources)
- B1, B2, B3 (baseline)
- W1, W2, W2b (flows and checkpoints)
- O1, O1b, O1c, O1d, O1e, O1f, O1g (documents)
- O2, O3, O4, O4b, O5, O6, E1
- C1, C1b, C1c, C1d, C2, C2b, C2c
- I2, I2b, I4
- X1, X2, X2b, X4b
- V2

On `origin/main` since this checkout: T2, I3 and V2a are answered.

Still open:
- **X3:** whether SwarmCloud is bundled when Oracle is sold.
- **T1:** compliance.
- **T3:** dogfood organisations; partial, recorded in `private/`.
- **R1:** release plan.
- **R3:** pricing.
- **O6 follow-up:** the Figma authoring path.

Two items are defaults the owner may veto: **C3** (version history) and **T4** (test
layers).

Conflicts between the build prompt and these decisions are rows in
[change-requests.md](change-requests.md).

## 6. SwarmCloud capability state (from `docs/swarmcloud-interface.md` and the code)

Nothing below was probed live from this lane: the shared rules forbid calling real
external services.

| Capability | Interface doc says | Code at b1bc1cf | Verified status |
|---|---|---|---|
| Service tenant `u-or-9a0792`, Google ID-token auth | Live; proved by `GET /v1/runtime/status` on 2026-10-19 | `swarm/swarmcloud.py:137-148` (`auth_from_settings`) supports `bearer`, `google_id_token` and `google_access_token`. The code default is `bearer` (`swarm/settings.py`). | Code: tested with fakes in `test_swarm.py`. Live: claimed by the doc, not re-verified here. |
| Submit, poll, cost, artifacts, cancel (one workflow per segment) | Supported | `swarmcloud.py:208-310` | tested (fakes) |
| Submit de-duplication by label | "Oracle labels each submission and checks before resubmitting" (§3.1, to build) | Labels are sent in `metadata` (`runs/service.py:1027-1032`), but nothing checks for an existing label before resubmitting | **not built** (CR-07) |
| Caller MCP, #1433 (`/v1/mcp-servers`, `mcp_credentials`) | **[OFF]**: 503 `mcp_unavailable` | Not sent: `can_reach_oracle` is `False` (`swarmcloud.py:178-179`) and `spec.mcp` is dropped (`:225`) | **blocked** on the switch, plus the adapter v2 lane |
| Run-token egress allowlist | Decided (§3.2) | None (`runtokens.py`, `mcp/auth.py`) | **not built** |
| `await-input`, #1436, and service answering with `on_behalf_of` | **[OFF]** | None (`grep await_input` finds only a comment in `runs/flows.py:4`) | **blocked** on the switch, plus adapter v2 |
| Fallback: one workflow per segment, Oracle Inbox checkpoints | The required fallback | Built: `runs/service.py`, `runs/flows.py` | working |
| Per-step model choice (#1435) | Model-tier profiles (X2b) | One profile setting, `ORACLE_SWARMCLOUD_PROFILE` (default `claude-code`) | spec |
| Extra read-only repos (#1434) | Filed | None | spec |

## 7. Migration risk and backward compatibility

- **Alembic.** The chain is linear `0001`–`0012`, and every test session upgrades an empty
  database to head.
  - The foundation owns `0013`. Lanes add `0014_<lane>`, which the integrator re-chains.
  - The API image migrates at startup (build brief §9). Running a migration first takes the
    old image down.
  - Risk: several `0014_*` heads at merge time; the integrator must re-chain before deploy.
- **Draft format.** These are pinned by `tests/legacy/test_legacy_documents.py`:
  - section keys, levels, layers, citation keys and section hashes of a legacy draft;
  - the byte-for-byte markdown round trip;
  - markdown and HTML exports (citations stay out of the body, plus the appendix);
  - the brief-layer and deck slides, and notes taken only from `notes` blocks;
  - `resolutions` and the diff.

  A module manifest stored in front matter must not change these hashes for drafts
  without one. Verdicts and locks are keyed by section key, and the import warning
  compares content hashes per section.
- **Import paths.** REST, `oracle push`/`pull` and the MCP `import_version` and
  `push_draft` tools give identical parse, diff and export
  (`legacy/test_legacy_import_paths.py`). The OpenAPI operation ids and request shapes of
  existing routes must not change, since the MCP tool names derive from them.
- **Templates and themes.** A built-in upgrade leaves edited, archived and company-written
  templates and every existing theme row byte-for-byte unchanged
  (`legacy/test_legacy_templates_themes.py`). Attach module manifests beside template
  versions; do not write new versions into company-edited templates.
- **Review.**
  - Locks are per version, and a changed locked section only produces a warning
    (`legacy/test_legacy_locked_sections.py`).
  - CR-06's section-revision approvals are a behaviour change: either refuse, or keep the
    warning and invalidate. Record which in a change request, and update the legacy test
    in the same PR.
- **Roadmap provenance.**
  - `document_versions.source_version_id` points at the exact approved PRD version, and
    an unapproved PRD is refused (`legacy/test_legacy_roadmap_provenance.py`).
  - CR-11 adds requirement ids; it must keep this column.
- **Cost policy.** `APPROVAL_THRESHOLD_USD = 50` (strictly greater waits) and
  `OVERRUN_FACTOR = 1.5`. A resume moves the ceiling to the spend so far plus half the
  estimate. The budget gates the estimate only (`legacy/test_legacy_cost_gates.py`).
- **Quirk found (not a defect):** an export made before the built-in templates are seeded
  names `oracle-default` by its key, not "Goal-traced PRD". `ensure_builtins` runs during
  that export and fixes it from the next export on (`export/render.py:334`).

## 8. Regression tests added by this lane (`api/tests/legacy/`)

| File | Protects |
|---|---|
| `test_legacy_documents.py` | Legacy PRD parse (pinned hashes), markdown round trip, md, HTML, brief, deck, PPTX and PDF exports, O1c body, appendix by section, `resolutions`, diff, drafts without a brief |
| `test_legacy_import_paths.py` | REST = CLI `push` = MCP `import_version` = MCP `push_draft` (parse, diff, exports); CLI `pull` writes the locked sections |
| `test_legacy_templates_themes.py` | A built-in template or theme upgrade leaves edited, archived and company templates and themes untouched; documents keep resolving an edited and archived template version |
| `test_legacy_locked_sections.py` | Approve locks; latest verdict wins; changed or removed locked sections warn and are stored; locks do not carry over; verdict and comment roles; re-import after approval reopens review |
| `test_legacy_roadmap_provenance.py` | Roadmap only from an approved PRD; exact version recorded and unchanged by later PRD drafts; export banner; kind enforcement |
| `test_legacy_roles.py` | The role order; one call per level for sessions and role tokens; 401 without credentials; no cross-company read or write (REST and MCP) |
| `test_legacy_cost_gates.py` | Constants; > $50 waits and only an owner approves; exactly $50 runs; budget gate; 1.5x pause after the segment keeps its output; only an owner resumes; owner cancel; the same gate on `prd_to_roadmap` |

No `web/e2e/legacy/` tests were added. The behaviours above are API contracts, and the
96 mock Playwright tests already cover the screens. Per I3 (on `origin/main`), the design
track restyles every screen "without changing behaviour or the Playwright contracts", so
those existing specs are the UI regression gate.
