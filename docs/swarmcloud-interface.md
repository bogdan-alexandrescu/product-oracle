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
  short. The search is conclusive by time (adapter v2 review fixes, round 4): it stops,
  "not found", at the first task whose `created_at` is older than when Oracle sent the
  submission less a skew margin, since the listing is newest first. The margin is 10
  minutes plus how far Oracle's clock is ahead of SwarmCloud's `Date` header (round 5),
  so a task stamped by a clock behind Oracle's is never taken for an older one. Oracle
  checks the order as it reads: a row newer than one before it means the listing is not
  newest first, and then no time concludes anything (the search runs to the listing's
  end or 20 pages, and the attempt cap below applies). Rows without `created_at` (not
  confirmed by SwarmCloud yet) prove nothing, and past 20 pages with no older row the
  search is inconclusive. An inconclusive lookup holds the submission; after 30 minutes
  or 30 lookups the run shows in the Inbox with **Retry** (looked up once more, else,
  after the web asks "This can start a paid duplicate run", the segment is submitted
  again under a new key, the lost one's token revoked) and **Cancel**; meanwhile it is
  looked up every 10 minutes. Cancelling looks for it the same way, also past the cap.
- **A submission given up on is still looked for** (round 5: spend never escapes the
  ceiling). Retry, or a cancelled run whose lost submission is past the cap, puts its
  key and send time on the run's background search: looked up every 10 minutes, whatever
  the run's state, until found (then cancelled, its cost read and counted on its own
  attempt of the segment, and noted; a cancel SwarmCloud does not confirm is tried again
  on every tick, its cost read meanwhile) or ruled out by the time-based search, and at
  most until the lost submission's credential would have expired (at most 24 h; then
  noted). The run's spend, and its ceiling, include it. Meanwhile the Inbox ("Looking
  for earlier submissions") and the run show "Oracle is looking for an earlier
  submission".
- **A 404 is "gone" only in SwarmCloud's envelope** (`detail.reason` or `code`
  `not_found`): a bare 404 (a proxy's page, a changed URL or principal), or one with
  another reason, proves nothing and is retried like a 503, so Oracle never stops
  cancelling on one by itself. It is counted, though (round 5): after 5 such 404s on a
  cancel (the tick then tries every 10 minutes) or on posting a checkpoint's answer, the
  run shows in the Inbox ("Stuck runs") with Cancel, which ends the run, or, for a run
  already cancelled, stops cancelling (noted: cancel it in SwarmCloud's console).
- **What SwarmCloud returns for a route it does not have is not confirmed.** Its
  envelope is confirmed for its handlers' errors (an unknown workflow is an enveloped
  `not_found`). A missing route is most likely the web framework's default, a bare
  `{"detail": "Not Found"}`, which Oracle reads as a bare 404. The fake answers a missing
  route that way, never with an enveloped `not_found` (which would make a mistyped path
  look like "the workflow does not exist"); to confirm with SwarmCloud.
- **Caller MCP reads** (`GET /v1/mcp-servers`) are served while the switch is off, so
  Oracle counts MCP as on only once SwarmCloud accepted its registration or a run's token.
  A registration that is already current is PATCHed with the same URL to confirm it, and
  no run token is sent before that (adapter v2 review fixes, round 2).

What Oracle does with an answer (adapter v2 review fixes, 2026-10-19):

| SwarmCloud answers | Oracle |
| --- | --- |
| 200 (or 200 `replayed: true`) | posted; the run follows the workflow |
| 409 `already_answered`, recorded verdict = the Inbox decision | treated as posted (who and when recorded on the checkpoint); the run follows the workflow; the revision's note is SwarmCloud's recorded findings, by their author, and the Inbox note is kept as not applied |
| 409 `already_answered`, recorded NOT_YET, the Inbox approves | the workflow ran what the approval needs (an earlier checkpoint has no revise step or gate, so the next segment ran; at the last, the run ends and Oracle stops the revision): followed, with a note of what the console recorded (who, via, findings) |
| 409 `already_answered`, recorded MERGE, the Inbox requests changes | a correction (the revision never ran): the workflow is cancelled and the run continues as a new workflow carrying it; noted |
| 409 `already_answered`, the recorded verdict cannot be read | read again; still unreadable: "decide again", never a correction |
| either, `answer_id` not Oracle's, or not recorded as Oracle's principal via `mcp` | also noted: who answered, via what, and that it was decided outside Oracle |
| answered in SwarmCloud's console while the run waits, by an Oracle member whose role meets the checkpoint's approver role (matched by `answered_by`, never `on_behalf_of`; W5) | the tick reads the wait at most once a minute, records the answer (who, via, when, verdict, findings) as the checkpoint's decision and follows it |
| answered there by anyone else (not a member, or a member below the approver role; an `answered_by` that redaction altered; an address matching two members by case, neither exactly) | recorded ("answered in SwarmCloud by ..."); the checkpoint stays open in the Inbox showing it, for an approver to Confirm it, approve or request changes. Meanwhile the run's token is **read-only** (owner, 2026-10-19): its agents may read Oracle, and their writes (drafts, proposals) are refused "HTTP 403 ... waiting for approval"; confirming or deciding restores it (`RunOut.token_read_only`) |
| a counted console NOT_YET where the workflow has no revise step (an earlier checkpoint) | never re-run on its own: the checkpoint stays open with the findings, and an approver chooses Redo from the segment (cancel, re-run as a new workflow with the findings: one more segment, its estimate shown) or Continue (follow the workflow, the note recorded). Redo needs findings or a note (`ConsoleAnswer.can_redo`; the button is disabled without either) |
| answered, and the verdict cannot be read (form missing, over 256 KB, not valid gzip or JSON, a verdict other than MERGE or NOT_YET, the record refused after the step SUCCEEDED) | shown in the Inbox and read again each minute; the run's token is **read-only** meanwhile, as for an answer that does not count (round 5); an approval is followed (it needs nothing the workflow did not do), a change request says "decide again", and Redo runs the segment again as a new workflow |
| 409 `not_open`, `expired`, `cancelled` | the wait is closed: cancel, continue as a new workflow with the decision |
| 403 `person_required` | service answers recorded as off until SwarmCloud reports them on (or Oracle's API restarts); cancel, continue as a new workflow (today's flow); later runs keep checkpoints in the Inbox |
| other refusals (403, 404 `not_found` in SwarmCloud's envelope, 422) | not posted: cancel, continue as a new workflow, with a note |
| 503, 429, timeout, a bare (non-envelope) 404 or a 404 with another reason | nothing recorded: "decide again" (the same answer replays); after 5 such 404s for the checkpoint, the run also shows in the Inbox with Cancel |

**A refused draft goes back to the writer first (owner, 2026-10-20).** When the import at
segment end refuses the draft and the wait is review1 of the workflow's last segment (a
revise step and a later review follow it), Oracle answers review1 itself: NOT_YET, with
the import's problems grouped in plain words as findings (citations, front matter,
headings and section ids, feedback resolutions, the file), each group with what a valid
draft does. The revision runs in the same workflow and its draft is imported when review2
opens; only one still refused there reaches the Inbox, where a person decides review2
(Retry import, or Request changes for revise2). The answer is Oracle's, never a person's:
no checkpoint stands for review1, nothing is decided or approved, it is noted on the
segment and audited as `run.draft_sent_back` with actor `oracle`, and the run's token
stays read-only (W5) until review2's checkpoint stands. An earlier segment's checkpoint
(one round, no revise step) is never answered this way; neither is a wait already
answered or closed, one with too little credential left for the revision (the tail rule),
or one SwarmCloud did not take the answer for (tried twice): the review waits for a person.

No case runs a segment in two workflows unless an approver chose Redo: a workflow is
cancelled before its successor is submitted, and a cancel SwarmCloud does not confirm
holds the successor back. The workflow stays attached (`cancel_pending`), its run token
revoked, its cost counted in the run's spend, and every tick cancels it again (SwarmCloud's
enveloped 404 ends that, recorded); an Inbox decision that needs the cancel says "decide
again". A confirmed cancel reads the workflow's final cost; when that read fails, the
workflow stays attached for one more read by the tick (still unread, it is detached and
noted). A workflow's cost is counted once, on its first attempt at the segment it was
submitted for: a revision inside it adds an attempt that counts nothing again. The spend ceiling is checked on every tick before
anything that follows an answer or submits (a wait SwarmCloud does not serve is read
again next tick, the cost reading kept), and before every submission. A submission whose
answer was lost is looked up before anything is resubmitted; a lookup that cannot finish
holds it, and cancelling the run cancels it if it landed. **Tail rule:** a decision is posted only when the credential left covers the
agent steps that follow the wait (`ORACLE_STEP_SECONDS` x their count, at least
`ORACLE_CHECKPOINT_TAIL_SECONDS`); otherwise the run continues as a new workflow.
