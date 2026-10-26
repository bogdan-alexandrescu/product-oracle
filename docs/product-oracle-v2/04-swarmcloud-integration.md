# 04. SwarmCloud integration, as built

How Product Oracle runs its agent work in SwarmCloud today. The live contract between the
two products is [docs/swarmcloud-interface.md](../swarmcloud-interface.md); the run ticker
is [docs/ops-run-ticker.md](../ops-run-ticker.md). This document describes what Oracle's
code does with that contract, where it lives, what is switched off, and how it is tested.
Every name below is a placeholder: no company, tenant or account appears here.

## 1. Where it lives

| Part | Code |
|---|---|
| Choosing the runtime | `api/oracle/swarm/__init__.py` (`get_runtime`, `set_runtime`) |
| Settings (`ORACLE_` environment) | `api/oracle/swarm/settings.py` |
| The runtime interface | `api/oracle/swarm/runtime.py` (`AgentRuntime`, `WorkflowSpec`, `StepSpec`, `Features`) |
| SwarmCloud's public API | `api/oracle/swarm/swarmcloud.py` (`SwarmCloudRuntime`, `UnconfiguredSwarmCloud`) |
| The deterministic runtime | `api/oracle/swarm/fake.py` (`FakeRuntime`, `Outcome`) |
| Runs, segments and checkpoints | `api/oracle/runs/` (`flows.py`, `service.py`, `router.py`) |
| The tick | `api/oracle/ticker/` (`POST /internal/scheduler/tick`), `POST /v1/internal/tick`, `oracle tick` |
| Run tokens for agents' MCP calls | `api/oracle/runtokens.py`, `api/oracle/mcp/` |

## 2. The runtime choice

`ORACLE_RUNTIME` picks one process-wide runtime:

- `swarmcloud` (the default): `SwarmCloudRuntime`. When it is chosen but not configured
  (no `ORACLE_SWARMCLOUD_URL`, or no credential for the chosen auth), the runtime is
  `UnconfiguredSwarmCloud`. Runs then say what is missing instead of the API failing.
- `fake`: `FakeRuntime`. Every workflow succeeds on its first poll, costs 90% of its
  estimate, and leaves fixed files for the segment it ran (`SEGMENT_FILES`). Tests can
  script other outcomes. The workflow id encodes the segment, attempt and estimate, so a
  process that did not submit it (`oracle tick` against a running API) still answers.

Auth to SwarmCloud is one of `bearer`, `google_id_token` (an ID token minted for
`ORACLE_SWARMCLOUD_AUDIENCE` by the metadata server) or `google_access_token`. Tokens never
reach a log line or an exception message (`redact`).

## 3. A run, segment by segment

A flow (`api/oracle/runs/flows.py`) is an ordered list of segments, each with an optional
stop (a checkpoint a person decides). The flows on SwarmCloud today:

| Flow | Segments | Stops |
|---|---|---|
| `baseline_to_prd` | `baseline`, `feature_set`, `eng_review`, `priority`, `prd_draft` | Confirm the baseline, Feature set and dependencies, Engineering check, Priority order, PRD review |
| `feedback_loop` | `next_draft` | PRD review |
| `prd_to_roadmap` | `roadmap_items`, `roadmap_draft` | Roadmap items, Roadmap review |
| `prd_to_spec` | `spec_draft` | Engineering approval |
| `prd_draft_items`, `code_map`, `baseline` and the reporting flows | one segment each | none, or one review |

1. **Estimate and start.** Every run shows an estimate first. A run estimated over $50
   waits for an owner (P3); a run over its budget cannot start.
2. **Submit.** Starting submits the first segment as a workflow (`POST /v1/workflows`).
   Each submission is keyed `oracle-<run id>-<segment>-<attempt>`, and the key is in every
   step's `metadata`. SwarmCloud has no idempotency keys, so after a lost response Oracle
   looks for the key (`GET /v1/tasks?submitted_by=me`) before it submits again.
3. **Tick.** SwarmCloud never calls Oracle back. A tick polls each running workflow, reads
   its cost, and when it has ended, reads its artifacts and imports them. In production, a
   Cloud Scheduler job ticks every company every minute. Locally, `oracle tick` does it, or
   an owner presses **Check agents now** on a run page.
4. **Stop or continue.** After a segment is imported, its stop opens a checkpoint in the
   Inbox and on the run page. If the stop is off, Oracle auto-approves when nothing
   blocks and submits the next segment. Switching off the Engineering check skips its
   segment.
5. **Draft import.** A drafting segment (`prd_draft`, `next_draft`, `roadmap_draft`,
   `spec_draft`) imports its file as the next version of the run's document. The run
   then waits for that version's review. Approving or publishing the version settles the
   run's review.
6. **Cost.** Spend is read per workflow. An overrun past 1.5x the estimate pauses the
   run after the running segment (P3c in [docs/questions.md](../questions.md)).
   Cancelling a run cancels its workflow and keeps reading it until it ends.

## 4. Adapter v2: behind SwarmCloud's switches

Each part waits for SwarmCloud to report its feature on (`GET /v1/capacity`,
`GET /v1/mcp-servers`). While a switch is off, Oracle keeps the flow above: one workflow
per segment, resubmitted after each checkpoint.

- **Caller MCP** (agents call Oracle's `/mcp` with a run token). Oracle registers its
  server once and refreshes SwarmCloud's egress addresses (`ORACLE_EGRESS_REFRESH_SECONDS`).
  A run token is accepted only from those addresses. Until a registration write or a
  submission carrying the token has been accepted, the token is never sent, and every run
  says so in its notes. Once it is on, the token travels only in the workflow's
  `mcp_credentials`, never in a step's input.
- **Waiting for a person** (await-input steps). A checkpoint becomes a step that waits up
  to `ORACLE_CHECKPOINT_WAIT_SECONDS`. The Inbox decision is posted as the answer with a
  stable `answer_id`. If too little of the run's credential would be left for the steps
  after the wait (`ORACLE_CHECKPOINT_TAIL_SECONDS`, `ORACLE_STEP_SECONDS`), Oracle does not
  post the decision. It cancels the waiting workflow and continues as a new one, as after
  an expiry. A 409 `already_answered` means the step goes on with the first, recorded
  answer.

## 5. What runs on Oracle's own model, not SwarmCloud

Real-time, on-demand work runs on Oracle's own Claude account pool and fallback credential
(`api/oracle/llm/`, [docs/claude-accounts.md](../claude-accounts.md)). That covers
discussion replies, interview follow-ups and the built-in model jobs (V2c). Everything an
agent writes over minutes runs in SwarmCloud.

## 6. How it is tested

- **API tests** drive `SwarmCloudRuntime` against a fake SwarmCloud API
  (`api/tests/swarmcloud_fake.py`), with the shapes SwarmCloud confirmed (section 4 of the
  interface document). They also drive whole flows on `FakeRuntime` (for example
  `api/tests/test_runs.py`).
- **The vertical slice** (`web/e2e/real/slice.spec.ts`, `make e2e`) runs on the real API
  with `ORACLE_RUNTIME=fake`. A person's brief becomes a published PRD and a roadmap, and
  every run advances only through the run page's **Check agents now**.
- **Not covered:** the live SwarmCloud end-to-end check in section 3 of the interface
  document. It runs once SwarmCloud reports both switches on in its development
  environment and the owner authorizes it (see 07, section 4).
