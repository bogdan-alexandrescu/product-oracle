# How Oracle talks to SwarmCloud: caller MCP (#1433), waiting for a person (#1436)

Product Oracle runs its agents in SwarmCloud, behind `api/oracle/swarm/`. The two
products share only this interface: Oracle's calls to SwarmCloud's API, and Oracle's MCP
server that agents call back. SwarmCloud built both features to designs Bogdan approved,
and Oracle adapts to them (Bogdan, 2026-10-18). Shapes below are SwarmCloud's, as its
session reported them from SwarmCloud's main on 2026-10-18; **[OFF]** marks what is not
switched on yet.

## 0. Admission and auth

- Oracle's API (`oracle-api@saga-agents-staging.iam.gserviceaccount.com`) is its own
  service tenant `u-or-9a0792` (SwarmCloud #1568, merged). Remaining owner steps: the
  bootstrap apply that lets it through SwarmCloud's front door, lending a Claude account
  to the tenant, and a git token only if Oracle's steps ever clone private repositories.
- **Auth is a Google ID token**, not an access token: SwarmCloud verifies an ID token for
  its API audience (email claim, verified). Oracle setting:
  `ORACLE_SWARMCLOUD_AUTH=google_id_token`, `ORACLE_SWARMCLOUD_AUDIENCE=<confirmed by a
  live probe after the bootstrap apply>`. (Oracle's deploy currently says
  `google_access_token`; it changes when the audience is confirmed.)
- **No tenant header:** the service tenant is the default; naming it is a 403.
- **No idempotency keys:** a retried `POST /v1/workflows` creates a duplicate. Oracle
  labels each submission `oracle-<run id>-<segment>-<attempt>` and checks for that label
  before resubmitting.

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
`already_answered`. **[CHANGING]** As built, only a person may answer; SwarmCloud is
adding "a service tenant's own principal may answer its own workflow's steps, optionally
naming the person it answers for". The field for that name comes when it lands.

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

1. **Auth:** switch to the ID token, with the audience as a setting. De-duplicate submits
   by label.
2. **MCP server:** register Oracle's MCP server once (`auth.mode: dispatch`). Restrict
   run tokens to SwarmCloud's `egress_addresses`. That means app-level enforcement, not
   a network allowlist on `/mcp`, which people's Claude Code clients also use over OAuth.
   Bogdan decides this.
3. **Per run:** a run token whose TTL covers the whole workflow; `mcp_servers` on every
   claude-code step; one `mcp_credentials` map.
4. **Checkpoints:** checkpoints become await-input verdict steps in the unrolled shape.
   The Inbox decision is posted as the answer with a stable `answer_id`, once a service
   principal may answer.
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
