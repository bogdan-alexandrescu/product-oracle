# How Oracle talks to SwarmCloud: caller MCP (#1433), waiting for a person (#1436)

Product Oracle runs its agents in SwarmCloud, behind `api/oracle/swarm/`. The two
products share only this interface: Oracle's calls to SwarmCloud's API, and Oracle's MCP
server that agents call back. SwarmCloud built both features to designs Bogdan approved,
and Oracle adapts to them (Bogdan, 2026-10-18). Shapes below are SwarmCloud's, as its
session reported them from SwarmCloud's main on 2026-10-18; **[OFF]** marks what is not
switched on yet.

## 0. Admission and auth

- Oracle's API (`oracle-api@saga-agents-staging.iam.gserviceaccount.com`) is its own
  service tenant `u-or-9a0792` (SwarmCloud #1568, merged). Done: the bootstrap apply
  (front door), a Claude account lent to the tenant. Applying on 2026-10-19: the release
  with the tenant's worker permissions (no task runs for Oracle before it). A git token
  only if Oracle's steps ever clone private repositories.
- **Auth is a Google ID token**, not an access token: SwarmCloud verifies an ID token for
  its API audience (email claim, verified). Oracle settings
  `ORACLE_SWARMCLOUD_AUTH=google_id_token` and `ORACLE_SWARMCLOUD_AUDIENCE` are live, and
  `GET /v1/runtime/status` proves them (reachable, tenant `u-or-9a0792`, 2026-10-19).
- **No tenant header:** the service tenant is the default; naming it is a 403.
- **No idempotency keys:** a retried `POST /v1/workflows` creates a duplicate. Oracle
  keys each submission `oracle-<run id>-<segment>-<attempt>` and looks for that key
  before resubmitting (how: section 4).

## 1. Oracle's MCP server for agents (#1433) [OFF]

**Register once:** `POST /v1/mcp-servers` (Oracle's principal may, in its own tenant):

```json
{"name": "oracle", "url": "https://oracle.swarm.saga.xyz/mcp", "transport": "streamable-http",
 "description": "Oracle knowledge",
 "auth": {"mode": "dispatch", "header": "Authorization", "scheme": "Bearer"},
 "allowed_profiles": ["claude-code"], "allowed_tools": [], "enabled": true,
 "limits": {"max_request_bytes": 1048576, "max_response_bytes": 4194304,
            "calls_per_minute": 60, "call_timeout_seconds": 60}}
```

- The URL must be public https; SwarmCloud follows no redirects. `PATCH` changes it, and
  there is no delete (disable instead). `GET /v1/mcp-servers` lists SwarmCloud's
  `egress_addresses`.

**Per workflow:** each `claude-code` step names the server in its input, and the workflow
carries one credential map:

```json
{"steps": [{"step_id": "research", "runner_profile": "claude-code",
            "input": {"prompt": "...", "mcp_servers": ["oracle"]}}],
 "mcp_credentials": {"oracle": {"value": "<run token>", "expires_in": 86400}}}
```

- The value is Oracle's run token for that run: printable ASCII, 8 B to 8 KiB.
  `expires_in` is 60 to 86400 s from submission and must cover the whole workflow,
  person-waits included.
- SwarmCloud sends it as `Authorization: Bearer <run token>`. The agent never sees it,
  and it never appears in task input, events, artifacts, logs or the console. It is
  destroyed within 10 minutes of the workflow ending.
- Refusals at submit: 422 `mcp_server_unregistered`, 403 `mcp_server_profile_refused`,
  422 `mcp_credential_missing|unexpected|shape`, **503 `mcp_unavailable` while the
  feature is off**.
- Failures on a step: the task FAILED with `mcp_credential_expired|missing`; PARKED
  `CREDENTIAL_MISSING` while the server is disabled; or the attempt failing at attach
  with `mcp_server_withheld` and a `result_summary.mcp_check` cause.

## 2. A step that waits for a person (#1436) [OFF]

**The step** (workflows only; it holds no capacity while waiting):

```json
{"step_id": "review1", "runner_profile": "await-input", "depends_on": ["draft"],
 "input_from": {"draft": "draft.md"}, "input": {"prompt": "Approve draft.md or list changes"},
 "await_input": {"form": "verdict", "artifact": "review1.json", "max_files": 0,
                 "expires_after_seconds": 86400, "on_expire": "default",
                 "default": {"verdict": "MERGE", "findings": []}, "remind": []}}
```

- Verdict payload: `{"verdict": "MERGE" | "NOT_YET", "findings": [...]}`. Oracle maps
  approved to MERGE, and changes requested to NOT_YET with the notes as findings.
- `expires_after_seconds` 300 to 86400; `on_expire` is `fail` (dead-lettered) or
  `default`. Service tenants pass `"remind": []`.

**The answer:** `POST /v1/workflows/{id}/steps/{step_id}/input` with
`{"answer_id": "<stable id>", "payload": {...}, "via": "mcp"}`. The same `answer_id` with
the same body replays (200, `replayed: true`); any other second answer is 409
`already_answered` (the exact rules, confirmed on 2026-10-19, are in section 4). **Who answers:** Oracle's own principal, in its own tenant only
(SwarmCloud PR 1577, security-reviewed; merging 2026-10-19). An optional
`"on_behalf_of": "<email>"` (at most 254 characters, checked for shape only) records the
person Oracle answers for. It is a recorded label, not a verified identity. The step then
shows `answered_by` = the service principal, `answered_as: "service"` and `source:
"person"` (an answer, not the expiry default). Oracle passes the Inbox user who decided.

**Rounds are unrolled, not looped:** a later step stages the answer
(`input_from: {"review1": "review1.json"}`), and a gated step runs only on a verdict
(`"when": {"step": "review2", "verdict_in": ["NOT_YET"]}`). An await-input step cannot be
gated, `when` needs strategy `collect`, and a two-round run is
draft → review1 → revise1 (always runs) → review2 → revise2 (when review2 is NOT_YET).
Two 24 h waits do not fit in one 86400 s credential, so Oracle keeps waits shorter or uses
one review round per workflow.

**Status:** the waiting step's task is PARKED with `park_reason: AWAITING_INPUT` and
`metadata.await_input {opened_at, expires_at}`. `GET .../steps/{step}/input` returns
waiting, not_open, answered, expired or cancelled. Cancel works while waiting.
Artifacts are read by task: `GET /v1/tasks/{task_id}/artifacts`, `.../content?name=` and
`.../raw?name=`.

**Switch detection:** a 422 "runner_profile 'await-input' is disabled" at submit.

## 3. What Oracle builds

**When (Bogdan, 2026-10-19):** built now, against a fake SwarmCloud, with the fallback below
so it is safe to merge while a switch is off. The real end-to-end check waits until
SwarmCloud reports "person-wait on" and "answering on" in dev. (On 2026-10-18 the plan was
to build only after the switches; it moved once all three were merged.)

1. **Auth:** switch to the ID token, with the audience as a setting. De-duplicate submits
   by label.
2. **MCP server:** register Oracle's MCP server once (`auth.mode: dispatch`). **Decided
   (Bogdan, 2026-10-18):** Oracle accepts a run token only from SwarmCloud's
   `egress_addresses`, refreshed from `GET /v1/mcp-servers`. People's OAuth sign-ins
   and API tokens keep working from any address, so there is no network allowlist on
   `/mcp`.
3. **Per run:** a run token whose TTL covers the whole workflow; `mcp_servers` on every
   claude-code step; one `mcp_credentials` map.
4. **Checkpoints:** checkpoints become await-input verdict steps in the unrolled shape.
   The Inbox decision is posted as the answer with a stable `answer_id`, once a service
   principal may answer. **Wait (W2b in docs/questions.md):** 20 h (`expires_after_seconds:
   72000`) so draft, wait and revise fit in one 24 h credential; `on_expire: fail`, never an
   expiry default; on expiry the checkpoint stays open in the Inbox and the run continues
   as a new workflow once someone decides. The run token is one credential from submission
   (at most 86400 s), so a decision that arrives when too little of it is left for the
   steps after the wait is not posted to SwarmCloud: Oracle cancels the waiting workflow
   and continues as a new workflow, exactly as after an expiry.
5. **Status and artifacts:** poll for AWAITING_INPUT and the terminal state; read
   artifacts by task; handle the codes above.
6. **Fallback:** while either switch is off (503 or 422 above), keep today's flow of one
   workflow per segment, resubmitted after each checkpoint.

**End-to-end check (after the owner steps and both switches):**
1. Register the server.
2. Submit draft → review1 with `mcp_servers`.
3. See AWAITING_INPUT.
4. Answer NOT_YET.
5. Confirm revise runs with `review1.json` staged.
6. Confirm Oracle's `/mcp` saw only the run token, and that it is gone after the run.

## 4. Confirmed by SwarmCloud (main, 2026-10-19)

A security review found that Oracle's fake SwarmCloud returned shapes the real one does
not. SwarmCloud's team confirmed the real contract, and it overrides anything above:

- **Errors:** `{"code": ..., "message": ..., "detail": {"reason": ..., ...}}`. What a
  refusal means is `detail.reason`, not the top-level `code`.
- **Answering a wait** (`POST .../steps/{step}/input`):
  - 403 `forbidden`, reason `person_required`, `not_a_member` or `role_member_required`;
  - 409 `conflict`, reason `already_answered` (detail also has `answered_by`,
    `answered_at`, `via`), or `not_open`, `expired`, `cancelled` (with `detail.state`);
  - 503 `membership_unavailable`, `role_unavailable` or store unavailable: nothing was
    written, retry.
  - A replay is a 200 with `replayed: true` only when `answer_id`, the form body,
    `on_behalf_of` and `files` all match. The same `answer_id` with any difference is 409
    `already_answered`.
  - 409 `already_answered` means this post was not recorded but the step was answered
    (by someone else, or by an earlier, different post whose response was lost). The
    workflow is not stuck: it goes on with the recorded answer, and its `when` gates
    follow that answer's verdict. The first answer is final.
- **What was answered:** `GET .../steps/{step}/input` serves an `answer` record:
  `answer_id`, `answered_by`, `on_behalf_of`, `answered_at`, `via`, `sha256`, `bytes`,
  `files`. Never the payload, and its `sha256` is over SwarmCloud's validated, redacted,
  re-serialised form, so it never matches Oracle's bytes: hashes are not compared. The
  recorded verdict is in the waiting step's form artifact (the step task's artifact named
  by `await_input.artifact`, e.g. `review1.json`).
- **Finding a submission whose answer was lost:** there is no label filter, and a
  workflow has no metadata. Oracle puts its key in every step's own `metadata` as
  `{"oracle_key": "oracle-<run id>-<segment>-<attempt>"}` (plain), then reads
  `GET /v1/tasks?submitted_by=me&limit=50` (newest first; `submitted_by` alone is applied
  in the query, so pages are exact), matches `metadata.oracle_key` and takes the row's
  `workflow_id`, paging with `page_token`. No `state`, `runner_profile` or `workflow_id`
  filter is added: combined filters are applied after the cursor and pages come back
  short.
- **Caller MCP reads** (`GET /v1/mcp-servers`) are served while the switch is off, so
  Oracle counts MCP as on only once SwarmCloud accepted its registration or a run's token.

What Oracle does with an answer (adapter v2 review fixes, 2026-10-19):

| SwarmCloud answers | Oracle |
| --- | --- |
| 200 (or 200 `replayed: true`) | posted; the run follows the workflow |
| 409 `already_answered`, recorded verdict = the Inbox decision | treated as posted (who and when recorded on the checkpoint); the run follows the workflow; a note says SwarmCloud kept the earlier wording |
| 409 `already_answered`, recorded verdict differs | the Inbox decision is a correction: the workflow is cancelled and the run continues as a new workflow carrying it; noted |
| either, `answer_id` not Oracle's | also noted: who answered, via what, and that it was decided outside Oracle |
| 409 `not_open`, `expired`, `cancelled` | the wait is closed: cancel, continue as a new workflow with the decision |
| 403 `person_required` | service answers recorded as off (cached like the other features); cancel, continue as a new workflow (today's flow); later runs keep checkpoints in the Inbox |
| other refusals (403, 404, 422) | not posted: cancel, continue as a new workflow, with a note |
| 503, 429, timeout | nothing recorded: "decide again" (the same answer replays) |

No case runs a segment in two workflows: a workflow is cancelled before its successor is
submitted. **Tail rule:** a decision is posted only when the credential left covers the
agent steps that follow the wait (`ORACLE_STEP_SECONDS` x their count, at least
`ORACLE_CHECKPOINT_TAIL_SECONDS`); otherwise the run continues as a new workflow.
