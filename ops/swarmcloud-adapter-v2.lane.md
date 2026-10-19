# Lane: SwarmCloud adapter v2 (caller MCP, waits for a person)

Dispatch after SwarmCloud reports "MCP on" and "person-wait on" in dev (Bogdan,
2026-10-18: build after the switches). One SwarmCloud `claude-code` task, strategy
`direct-pr`. Real end-to-end runs wait for "answering on" as well.

## Prompt

SWARMCLOUD ADAPTER V2 for Product Oracle. Read docs/swarmcloud-interface.md first (the
contract, as SwarmCloud built it), then docs/build-brief.md §5 ("Runs and flows", "Agent
runtime adapter"), api/oracle/swarm/, api/oracle/runs/, api/oracle/runtokens.py,
api/oracle/mcp/ and the decisions W1, W2, P3 and P3b in docs/questions.md. Oracle's ID-token
auth is live, and GET /v1/runtime/status proves it (tenant u-or-9a0792).

Build, behind feature detection so today's flow keeps working while a feature is off:

1. **Feature detection.** `GET /v1/runtime/status` gains `features: {mcp, await_input,
   service_answer}` (on, off, unknown). Read MCP from `GET /v1/mcp-servers`, where 503
   `mcp_unavailable` means off. Read await-input from the runtime or capacity
   availability, or from a 422 at submit. Cache briefly, and never block a request
   longer than the runtime timeout.
2. **Register Oracle's MCP server once,** idempotently: GET `/v1/mcp-servers/oracle`, POST
   it if missing, PATCH it if the URL changed. Use the exact body in the contract,
   `auth.mode: dispatch`, with the URL from ORACLE_PUBLIC_URL + `/mcp`.
3. **Run tokens through SwarmCloud.** Each workflow sends:
   - `mcp_servers: ["oracle"]` in every claude-code step's input;
   - one top-level `mcp_credentials: {"oracle": {"value": <run token>, "expires_in": N}}`,
     where N covers the whole workflow, waits included, and is at most 86400. Mint the run
     token with the same lifetime.
   - `can_reach_oracle` turns true, and segment prompts stop pasting earlier outputs: they
     name the Oracle tools to use instead.
   - **Egress check (Bogdan, 2026-10-18):** a run token is accepted only from SwarmCloud's
     `egress_addresses` (from `GET /v1/mcp-servers`, cached and refreshed). Find the client
     address correctly behind Oracle's load balancer: take the right X-Forwarded-For hop,
     never the first.
   - People's OAuth sign-ins and API tokens are unaffected.
4. **Checkpoints as waits for a person.** When await-input is on, a run is one workflow:
   - Each checkpoint is an `await-input` step with `form: verdict`.
   - Rounds are unrolled with `when` gates, using strategy `collect`.
   - The step's `expires_after_seconds` and `on_expire` follow the owner's decision
     recorded in docs/questions.md (ask if it is not there).
   - The Inbox decision is posted as the answer: `answer_id` = the checkpoint's id;
     approved → MERGE, changes requested → NOT_YET, with the note as findings;
     `on_behalf_of` = the deciding user's email; `via: "mcp"`.
   - A 409 replay with the same body counts as success.
   - Map status: PARKED `AWAITING_INPUT` → waiting on that checkpoint; read artifacts by
     task id.
5. **Submits.** Label every submission `oracle-<run id>-<segment>-<attempt>`. When a submit's
   answer is lost (timeout, 5xx), look up that label before resubmitting, because
   SwarmCloud has no idempotency keys. Send no X-Swarm-Tenant.
6. **Fallback.** While a feature is off, or SwarmCloud answers 503 `mcp_unavailable` or 422
   "await-input is disabled", keep today's one-workflow-per-segment flow, with nothing
   attached. Show the reason in the run's notes.
7. **Refusals and failures.** Map every code in the contract to a run error or note that
   says what to do: `mcp_server_unregistered`, `mcp_credential_*`, `mcp_server_withheld`,
   PARKED `CREDENTIAL_MISSING`, `already_answered`, `not_open`, `expired`, `person_required`.

Tests against an extended fake SwarmCloud:
- each feature on and off;
- registration, idempotently;
- the credential map and step inputs exactly as in the contract;
- the TTL covers the waits;
- the egress check, with an X-Forwarded-For spoof refused;
- a two-round unrolled workflow;
- answer posting, replay and 409;
- expiry;
- label de-duplication after a lost response;
- the fallback path unchanged (the existing run tests keep passing);
- no credential in any response, note or log.

Product Oracle words only (users, roles; never "workspace"). Never touch .github/. Run the
full API suite, ruff, `make openapi`, web lint, tsc and build, and Playwright. Commit.
Write `$SWARM_ARTIFACTS_DIR/adapter-v2-report.md`, including the manual end-to-end check:
1. register the server;
2. run a two-step workflow with a review;
3. see AWAITING_INPUT;
4. answer NOT_YET as Oracle on behalf of the user;
5. confirm the revise step ran with `review1.json`;
6. confirm `/mcp` saw only the run token, and that the token is gone afterwards.
