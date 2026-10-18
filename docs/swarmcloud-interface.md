# What Oracle needs from SwarmCloud: caller MCP access (#1433) and waiting for input (#1436)

Product Oracle runs its agents in SwarmCloud, behind `api/oracle/swarm/`. The two
products share only this interface: Oracle's calls to SwarmCloud's workflow API, and
Oracle's MCP server that agents call back. This page is the contract for the two
SwarmCloud features Oracle is waiting on, written for a SwarmCloud session to build
from. Decided by Bogdan on 2026-10-18 (spec both). Admitting Oracle as a caller is
configured separately.

## What Oracle does today

- `POST /v1/workflows` with one step per agent role, `runner_profile` `claude-code`,
  `input.prompt`, `depends_on`, `input_from` (an upstream step's artifact staged into the
  next step), `on_step_failure: fail_workflow`, `strategy: collect`, and metadata
  `{client: "product-oracle", workflow, run_id, segment, attempt}`.
- `GET /v1/workflows/{id}` for state and per-task cost; `GET /v1/tasks/{id}/artifacts`
  and `.../artifacts/raw` for the files a segment writes (`prd.md`, `roadmap.md`,
  `baseline.yaml`, `roadmap_items.yaml`, ...); `POST /v1/workflows/{id}/cancel`.
- One workflow per segment of a run, because a workflow cannot pause for a person
  (#1436): at each checkpoint Oracle waits for an approver, then submits the next
  segment with every earlier output pasted into its prompts.
- Agents cannot reach Oracle (#1433): Oracle mints a run token for each segment but
  never sends it, since a prompt is no place for a credential. Agents work from their
  prompts only; every run says so.

## SwarmCloud #1433: a workflow can attach its caller's MCP server

### What Oracle will send

One `mcp` block on the workflow submission, applied to every step:

```json
"mcp": {
  "servers": [
    {
      "name": "oracle",
      "transport": "http",
      "url": "https://oracle.swarm.saga.xyz/mcp",
      "headers": {"Authorization": "Bearer ort_..."},
      "expires_at": "2026-10-18T18:00:00Z"
    }
  ]
}
```

- The token is a **run token**: minted by Oracle for one segment of one run, scoped to
  what that segment needs (`read:sources`, `read:baseline`, `read:documents`, and only
  where a segment writes: `write:proposals`, `write:drafts`), expiring after 6 hours by
  default, revoked by Oracle when the run ends. It is useless outside Oracle and grants
  nothing in SwarmCloud.
- The field names above are Oracle's proposal; SwarmCloud chooses the final shape and
  Oracle adapts in one place (`SwarmCloudRuntime.submit`).

### What SwarmCloud must do

1. Accept the block on `POST /v1/workflows` (and on single-task dispatch, for parity),
   and refuse it with a clear 422 when malformed or already expired.
2. Put the server into each `claude-code` step's MCP configuration, so the agent sees
   Oracle's tools (`search`, `get_source_item`, `get_baseline`, `trace_feature`,
   `get_priorities`, `get_document`, `get_document_markdown`, `get_feedback_package`,
   `propose_change`, `push_draft`) beside its own.
3. Treat the header values as secrets: never write them to logs, events, artifacts, the
   console, task metadata or error messages; redact them wherever task input is shown;
   keep them only for the workflow's life, and drop them when it ends or `expires_at`
   passes.
4. Allow the step's network egress to the server's host (HTTPS only).
5. Report a failing MCP server on the step (its tool errors surface in the step's error
   or log), so Oracle can tell "Oracle unreachable" from "agent failed".

### How to check it

From Oracle: start a run against the real SwarmCloud; its first segment's agent calls
`search` and `get_document`, Oracle's server logs the calls under that run token, the
segment finishes, and nothing in SwarmCloud's task view, events or logs shows the token.

### What Oracle changes once it lands

`SwarmCloudRuntime.submit` sends `spec.mcp` as the block above and `can_reach_oracle`
becomes true; segment prompts stop pasting earlier outputs and tell the agent which
Oracle tools to use. Already built on Oracle's side: run tokens, their scopes and
expiry, the MCP server at `/mcp`, and the per-segment `McpAccess` in each workflow spec.

## SwarmCloud #1436: a workflow step can wait for a person

### How Oracle would use it

A run becomes one workflow. Between segments sits a wait step; Oracle shows the
checkpoint in its Inbox (approve, approve with a note, or request changes), and posts
the decision back. The workflow resumes with the decision as input to the next step,
and keeps every earlier artifact staged without Oracle re-sending it.

### What SwarmCloud must provide (Oracle's proposal)

1. A step kind that waits, e.g. `{"step_id": "checkpoint-1", "kind": "await_input",
   "depends_on": ["prd_draft-2-critic"], "timeout_hours": 168}`. It holds no agent
   capacity while waiting and shows as waiting, not running, in workflow state.
2. A call to resume it with input, e.g. `POST /v1/workflows/{id}/steps/{step_id}/input`
   with `{"decision": "approved" | "changes_requested", "note": "..."}`, accepted only
   from the workflow's submitter; idempotent for the same body.
3. The input reaches the dependent steps like an artifact (`input_from`), so the next
   agent reads the decision and note.
4. A decision of `changes_requested` can re-run a named earlier step (a loop) rather
   than continue, or Oracle cancels and resubmits: either works, but say which.
5. Timeouts end the step with a clear state Oracle can read; cancel works while waiting.

### What Oracle changes once it lands

A run submits one workflow with wait steps instead of one per segment; the checkpoint
decision goes to the resume call; prompts stop re-sending earlier outputs. Until then,
Oracle's one-workflow-per-segment path keeps working unchanged.

## Not needed now

#1434 (extra read-only repositories per step) and #1435 (model-tier profiles) help
later: reading code for engineering alignment, and cheaper models for summarising roles.
