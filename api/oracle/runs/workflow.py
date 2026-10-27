"""Adapter v2: a run as one SwarmCloud workflow, checkpoints as waits for a person.

While SwarmCloud's await-input and caller MCP are on (docs/swarmcloud-interface.md), a run
submits one workflow for the rest of its flow: every segment's agent steps, and after each
segment whose checkpoint is on, an ``await-input`` step (``form: verdict``) that the Inbox
decision answers. Later steps read earlier outputs through Oracle's MCP server with the
run token, so prompts name tools instead of pasting files.

Rounds are unrolled, not looped. Only a workflow's last step may be gated (a ``when`` on a
verdict), so:

- the checkpoint of the workflow's **last** segment has two rounds, the contract's shape:
  ``work -> review1 -> revise1 (always runs) -> review2 -> revise2 (when review2 is
  NOT_YET)``; a NOT_YET after revise2 opens a checkpoint in the Inbox only, and deciding
  it continues the run as a new workflow. A draft refused at import when review1 opens
  goes back to the writer first: Oracle answers review1 itself with NOT_YET and the
  import's problems (:func:`import_findings`; oracle.runs.service._send_back);
- an **earlier** segment's checkpoint has one round: the next segment depends on it and
  runs once Oracle answers MERGE. A change request there is not posted: Oracle cancels the
  workflow and re-runs the segment as a new workflow (today's flow).

The wait follows W2b: ``on_expire: fail``, never an expiry default. When it expires, or a
decision comes with too little of the run's credential left for the agent steps that
follow the wait (the tail rule, :func:`tail_seconds`), Oracle cancels the waiting workflow
and continues as a new workflow with a fresh run token.

An answer SwarmCloud refuses with 409 ``already_answered`` was not recorded, but the wait
was answered and the workflow goes on with that first answer. Oracle follows it whenever
the workflow ran what the Inbox decision needs: the same verdict, or an approval over a
recorded NOT_YET (an earlier segment's checkpoint has no revise step and no gate, so the
next segment runs whatever the verdict; at the last, the approval ends the run). Only a
change request over a recorded MERGE is a correction: the workflow is cancelled and the
run continues as a new workflow carrying it. A wait answered outside Oracle while the run
waits (SwarmCloud's console) is noticed by the tick and followed the same way.

No segment runs in two workflows: a successor is submitted only once SwarmCloud confirms
the earlier workflow is cancelled (or it has ended). Until then it stays attached, its
cost counted, and the tick cancels it again.

The plan of the live workflow is kept on the run (``knobs["workflow"]``): its id, label,
credential expiry, and per segment the steps that produce its files and its waits.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from oracle import wording
from oracle.docs.schemas import ImportProblem
from oracle.runs import flows, rejection
from oracle.runtokens import SCOPES
from oracle.swarm.runtime import AWAIT_PROFILE, NOT_YET, StepSpec
from oracle.swarm.settings import MAX_CREDENTIAL_SECONDS, MIN_CREDENTIAL_SECONDS, RuntimeSettings

REVIEWER_ROLE = "reviewer"


def label(run_id: Any, segment: str, attempt: int) -> str:
    """A submission's de-duplication key, ``oracle_key`` in every step's metadata
    (SwarmCloud has no idempotency keys, and a workflow keeps no metadata)."""
    return f"oracle-{run_id}-{segment}-{attempt}"


def review_artifact(round_: int) -> str:
    """The form artifact a wait records its verdict in (what the revise step reads)."""
    return f"review{round_}.json"


def agent_steps_after(segments: list[dict[str, Any]], seq: int, approved: bool, round_: int) -> int:
    """The agent steps of the live workflow that run after the wait of segment ``seq``
    (round ``round_``) is answered with this decision, up to the next wait or the end:
    the revision for a change request; for an approval, the next segments' work up to
    the next checkpoint (none for the last segment, whose rest Oracle stops)."""
    index = next((i for i, e in enumerate(segments) if e.get("seq") == seq), None)
    if index is None:
        return 0
    entry = segments[index]
    if not approved:
        return 1 if round_ <= len(entry.get("revises") or []) else 0
    if index == len(segments) - 1:
        return 0
    count = 0
    for later in segments[index + 1 :]:
        count += len(later.get("work") or [])
        if later.get("checkpoint"):
            break
    return count


def tail_seconds(agent_steps: int, settings: RuntimeSettings) -> int:
    """How much of the run's credential a decision must leave: the budget of the agent
    steps that follow the wait (``ORACLE_STEP_SECONDS`` each), at least
    ``ORACLE_CHECKPOINT_TAIL_SECONDS``; nothing when no agent step follows."""
    if agent_steps <= 0:
        return 0
    return max(settings.checkpoint_tail_seconds, agent_steps * settings.step_seconds)


def credential_seconds(agent_steps: int, waits: int, settings: RuntimeSettings) -> int:
    """The workflow's whole budget, waits included, held to SwarmCloud's 60-86400 s."""
    budget = agent_steps * settings.step_seconds + waits * settings.checkpoint_wait_seconds
    return max(MIN_CREDENTIAL_SECONDS, min(MAX_CREDENTIAL_SECONDS, budget))


def scopes_for(segments: list[flows.SegmentDef]) -> tuple[str, ...]:
    """One run token serves every segment of the workflow: the union of their scopes."""
    wanted = {s for seg in segments for s in seg.scopes}
    return tuple(s for s in SCOPES if s in wanted)


def await_input(round_: int, settings: RuntimeSettings) -> dict[str, Any]:
    """W2b: wait up to the setting, fail on expiry (nothing is approved by default)."""
    return {
        "form": "verdict",
        "artifact": review_artifact(round_),
        "max_files": 0,
        "expires_after_seconds": settings.checkpoint_wait_seconds,
        "on_expire": "fail",
        "remind": [],
    }


@dataclass
class Plan:
    steps: list[StepSpec] = field(default_factory=list)
    # Per segment: seq, name, work (step keys), checkpoint, reviews, revises, round.
    segments: list[dict[str, Any]] = field(default_factory=list)

    @property
    def agent_steps(self) -> int:
        return sum(1 for s in self.steps if not s.waits)

    @property
    def waits(self) -> int:
        return sum(1 for s in self.steps if s.waits)


def review_prompt(
    flow: flows.FlowDef, sdef: flows.SegmentDef, kind: str, round_: int, run_id: str
) -> str:
    files = ", ".join(sdef.outputs_for(kind))
    return (
        f"Approve {files} or list changes. Product Oracle run {run_id}, {flow.title} flow, "
        f"segment '{sdef.title}', checkpoint {sdef.checkpoint_for(kind)}, round {round_}. "
        "Oracle answers this step from its Inbox for the person who decides."
    )


def revise_note(round_: int) -> str:
    return (
        f"The reviewer's verdict is in review{round_}.json, staged in your workspace "
        '({"verdict": "MERGE" | "NOT_YET", "findings": [...]}). If it is NOT_YET, address '
        "every finding in a new version of the files; if it is MERGE, write the files "
        "unchanged. When the findings are a structured review (their first line names "
        "get_checkpoint_review): at the top of the file it reviews, write `resolutions:` with "
        "one entry per review entry: `{id, action, status: done | declined, note}`. Declining "
        "is allowed with a reason in `note`."
    )


# A refused draft goes back to the writer before a person is asked (owner, 2026-10-20):
# the findings are the agents' rendering of the refusal's summary (oracle.runs.rejection).
def import_findings(
    name: str, problems: list[dict[str, Any]], total: int | None = None
) -> list[str]:
    """The review findings for a draft the import refused (:func:`rejection.findings`)."""
    return rejection.findings(name, problems, total)


def check_problems(
    name: str, items_check: dict[str, Any] | None, import_problems: list[dict[str, Any]]
) -> list[str]:
    """One line per problem Oracle's check found in ``name`` that the agents must fix:
    the items check's blocking reasons (D2 Product reasons: label and sentence; to-confirm
    reasons are a person's), else its problems; and a refused draft's import problems in
    their plain summary (oracle.runs.rejection)."""
    out: list[str] = []
    check = items_check or {}
    reasons = check.get("reasons")
    if isinstance(reasons, list) and reasons:
        for r in reasons:
            if not isinstance(r, dict) or not _blocking(r):
                continue
            label = str(r.get("label") or r.get("code") or "Problem")
            item = f" ({r['item']})" if r.get("item") else ""
            sentence = str(r.get("text") or "")
            out.append(f"{label}{item}: {sentence}" if sentence else f"{label}{item}")
    else:
        for p in check.get("problems") or []:
            if isinstance(p, dict):
                out.append(f"[{p.get('code')}] {p.get('message')}")
    if import_problems:
        problems = [ImportProblem.model_validate(p) for p in import_problems]
        out.append(rejection.summary(name, problems))
    return out


def _blocking(reason: dict[str, Any]) -> bool:
    return reason.get("blocking") is True or reason.get("severity") == "blocking"


def check_findings(
    name: str, items_check: dict[str, Any] | None, import_problems: list[dict[str, Any]]
) -> list[str]:
    """A person's NOT_YET at the last segment's review: a lead line and the problems
    Oracle's check found in ``name`` (:func:`check_problems`), or nothing when none."""
    lines = check_problems(name, items_check, import_problems)
    if not lines:
        return []
    return [f"Oracle's check found these problems in {name}; fix each one:", *lines]


def build_plan(
    flow: flows.FlowDef,
    segments: list[tuple[int, flows.SegmentDef, flows.PromptContext]],
    knobs: flows.Knobs,
    settings: RuntimeSettings,
    profile: str,
    *,
    run_id: str,
) -> Plan:
    """The steps of one workflow for ``segments`` (seq, definition, prompt context), in
    order, with its checkpoints as waits for a person."""
    plan = Plan()
    after: tuple[str, ...] = ()
    staged: dict[str, str] = {}
    for index, (seq, sdef, ctx) in enumerate(segments):
        kind = ctx.kind
        primary = sdef.outputs_for(kind)[0]
        work = flows.build_steps(flow, sdef, knobs, ctx)
        keys: list[str] = []
        for i, (key, role, prompt, deps, inputs) in enumerate(work):
            if i == 0:
                deps, inputs = after, dict(staged)
            plan.steps.append(StepSpec(key, role, profile, prompt, deps, inputs))
            keys.append(key)
        entry: dict[str, Any] = {
            "seq": seq,
            "name": sdef.name,
            "work": keys,
            "checkpoint": sdef.checkpoint is not None
            and knobs.checkpoints.get(sdef.checkpoint, True),
            "reviews": [],
            "revises": [],
            "round": 1,
        }
        last = index == len(segments) - 1
        producer = keys[-1]
        if not entry["checkpoint"]:
            # The next segment starts on this one's files: its main file is staged.
            after, staged = (producer,), {producer: primary}
            plan.segments.append(entry)
            continue
        rounds = 2 if last else 1
        writer = work[-1][1]
        for r in range(1, rounds + 1):
            review = f"{sdef.name}-review{r}"
            plan.steps.append(
                StepSpec(
                    review,
                    REVIEWER_ROLE,
                    AWAIT_PROFILE,
                    review_prompt(flow, sdef, kind, r, run_id),
                    (producer,),
                    {producer: primary},
                    await_input=await_input(r, settings),
                )
            )
            entry["reviews"].append(review)
            if not last:
                continue
            revise = f"{sdef.name}-revise{r}"
            revise_ctx = _with_note(ctx, revise_note(r), ctx.attempt + r)
            plan.steps.append(
                StepSpec(
                    revise,
                    writer,
                    profile,
                    flows.step_prompt(flow, sdef, writer, last=True, ctx=revise_ctx),
                    # SwarmCloud stages files only from a step's direct dependencies.
                    (review, producer),
                    {review: review_artifact(r), producer: primary},
                    # The last step only: gated on the last verdict.
                    when={"step": review, "verdict_in": [NOT_YET]} if r == rounds else None,
                )
            )
            entry["revises"].append(revise)
            producer = revise
        # Oracle has the files by then (read when the wait opened): nothing to stage.
        after, staged = (entry["reviews"][0],), {}
        plan.segments.append(entry)
    return plan


def _with_note(ctx: flows.PromptContext, note: str, attempt: int) -> flows.PromptContext:
    from dataclasses import replace

    change = f"{ctx.change_request}\n\n{note}" if ctx.change_request else note
    # A revision works on the staged file and the review's findings, not on an earlier
    # attempt's files.
    return replace(
        ctx,
        change_request=change,
        attempt=attempt,
        previous_attempt=None,
        previous_files={},
        previous_problems=[],
    )


def expires_at(submitted: datetime, seconds: int) -> datetime:
    return submitted + timedelta(seconds=seconds)


# --------------------------------------------------------------------------- codes

# The note on a run that is one workflow per segment while caller MCP is on.
SEGMENT_MODE_WITH_MCP = (
    "Caller MCP is on, so each segment's workflow carries the run token in its credential "
    "map and its agents read Oracle's sources, baseline, documents and earlier outputs "
    "through Oracle's MCP server (intended: agents read Oracle's data whenever MCP is on, "
    "whether or not checkpoints wait in SwarmCloud)."
)

# What each of SwarmCloud's refusals and failures means for a run, and what to do.
ADVICE: dict[str, str] = {
    "mcp_unavailable": "SwarmCloud's caller MCP (#1433) is switched off (503 "
    "mcp_unavailable): the run continues without Oracle's MCP server, one workflow per "
    "segment. Nothing to do; Oracle uses it once SwarmCloud switches it on.",
    "await_input_disabled": "SwarmCloud's await-input (#1436) is switched off (422 "
    '"await-input is disabled"): checkpoints wait in Oracle\'s Inbox and each segment is '
    "its own workflow. Nothing to do; Oracle uses it once SwarmCloud switches it on.",
    "mcp_server_unregistered": "SwarmCloud has no MCP server named 'oracle' for Oracle's "
    "tenant (422 mcp_server_unregistered). Oracle registers it again on the next submit; "
    "nothing to do meanwhile.",
    "mcp_server_profile_refused": "SwarmCloud refuses Oracle's MCP server for this step's "
    "runner profile (403 mcp_server_profile_refused): the registration allows only "
    "claude-code. Set ORACLE_SWARMCLOUD_PROFILE=claude-code or widen allowed_profiles.",
    "mcp_credential_missing": "SwarmCloud found no credential for Oracle's MCP server in "
    "the workflow (mcp_credential_missing). This is an Oracle bug: report it with the run "
    "id; the run continued without the MCP server.",
    "mcp_credential_unexpected": "SwarmCloud got a credential for a server no step names "
    "(422 mcp_credential_unexpected). This is an Oracle bug: report it with the run id; "
    "the run continued without the MCP server.",
    "mcp_credential_shape": "SwarmCloud refused the run token's shape or lifetime (422 "
    "mcp_credential_shape: printable ASCII, 8 B to 8 KiB, expires_in 60 to 86400 s). Check "
    "ORACLE_STEP_SECONDS and ORACLE_CHECKPOINT_WAIT_SECONDS; the run continued without "
    "the MCP server.",
    "mcp_credential_expired": "The run token expired before a step finished "
    "(mcp_credential_expired). Start the run again; if steps or waits run long, lower "
    "ORACLE_CHECKPOINT_WAIT_SECONDS so the credential covers the work after a wait.",
    "mcp_server_withheld": "SwarmCloud withheld Oracle's MCP server when the step started "
    "(mcp_server_withheld; its result_summary.mcp_check gives the cause). Check that "
    "ORACLE_PUBLIC_URL/mcp answers over public https and that Oracle's MCP server is "
    "enabled in SwarmCloud, then start the run again.",
    "key_refresh_forbidden": "A step waits in SwarmCloud because the run's key expired "
    "while it was queued, and SwarmCloud did not let Oracle renew it: Oracle's service "
    "account is no longer the workflow's submitter or an admin of its workspace. Whoever "
    "runs Oracle's SwarmCloud setup checks that account; meanwhile cancel the run and start "
    "it again.",
    "key_refresh_refused": "A step waits in SwarmCloud because the run's key expired while "
    "it was queued, and SwarmCloud refused the renewed key Oracle sent (its server is "
    "disabled or not registered there, no step names it, or the key's shape or lifetime "
    "was refused). Cancel the run and start it again; if it happens again, report it with "
    "the run's id.",
    "key_missing": "A step waits in SwarmCloud: it found no key for Oracle's MCP server "
    "in the workflow (mcp_credential_missing), so Oracle has nothing to renew. Cancel the "
    "run and start it again; report it with the run id.",
    "key_expired_unnamed": "A step waits in SwarmCloud because the run's key expired while "
    "it was queued, and SwarmCloud did not say which server's key to renew. Cancel the run "
    "and start it again; report it with the run id.",
    # #481: these two are read by a person; the operator detail is in ADVICE_REFS.
    "CREDENTIAL_MISSING": "A step is waiting: Oracle's connection to SwarmCloud is switched "
    "off there, so its agents cannot read Oracle's data. Whoever runs Oracle's SwarmCloud "
    "setup switches it back on; the step then resumes on its own.",
    "already_answered": "SwarmCloud already held an answer for this checkpoint's wait (409 "
    "already_answered): Oracle's post was not recorded and the workflow went on with the "
    "first answer. Oracle followed it when the workflow ran what the Inbox decision needs "
    "(the same verdict, or an approval), and otherwise (changes requested over a recorded "
    "MERGE) cancelled the workflow and continued the run as a new workflow carrying the "
    "Inbox decision.",
    "not_open": "The checkpoint's wait in SwarmCloud is not open (409 not_open), so Oracle "
    "did not post the decision: it cancelled that workflow and continued the run as a new "
    "workflow from the Inbox decision.",
    "cancelled": "The checkpoint's wait in SwarmCloud was cancelled (409 cancelled), so "
    "Oracle did not post the decision: it continued the run as a new workflow from the "
    "Inbox decision.",
    "expired": "The checkpoint's wait in SwarmCloud expired (W2b: nothing is approved by "
    "default). The checkpoint stays open in the Inbox; deciding it continues the run as a "
    "new workflow.",
    "person_required": "SwarmCloud lets only a person answer this checkpoint for now, so "
    "Oracle continued the run as a new workflow from the Inbox decision. Later runs keep "
    "their checkpoints in the Inbox, one workflow per segment, until SwarmCloud lets "
    "Oracle answer them; nobody needs to act.",
}

# #481: what an operator needs beside the two notes a person reads (served as the run's
# ``note_refs``): the code, and the call that fixes or checks it.
ADVICE_REFS: dict[str, wording.Refs] = {
    "CREDENTIAL_MISSING": {
        "code": "CREDENTIAL_MISSING",
        "mcp_server": "oracle",
        "operator_action": "PATCH /v1/mcp-servers/oracle with enabled: true (SwarmCloud)",
    },
    "person_required": {
        "code": "person_required",
        "status": "403",
        "service_answers": "off",
        "operator_check": "GET /v1/capacity (SwarmCloud) until service answers are on, or "
        "restart Oracle's API",
    },
}
# The two notes as stored on runs before #481, served in the words above.
_LEGACY_ADVICE = {
    "SwarmCloud parked a step with CREDENTIAL_MISSING: Oracle's MCP server is disabled "
    "there. Enable it (PATCH /v1/mcp-servers/oracle, enabled: true); the step resumes on its "
    "own.": "CREDENTIAL_MISSING",
    "SwarmCloud lets only a person answer this wait (403 person_required): Oracle's "
    "principal may not answer yet, so Oracle records service answers as off, cancelled the "
    "workflow and continued the run as a new workflow from the Inbox decision. Later runs "
    "keep checkpoints in the Inbox, one workflow per segment, until SwarmCloud reports "
    "service answers on (GET /v1/capacity) or Oracle's API restarts; nothing to do "
    "meanwhile.": "person_required",
}
_NOTE_CODES = {**_LEGACY_ADVICE, **{ADVICE[code]: code for code in ADVICE_REFS}}


def advice(code: str | None, fallback: str) -> str:
    return ADVICE.get(code or "", fallback)


def noted(note: str) -> tuple[str, wording.Refs]:
    """A run's stored note as served, and its refs: one of ADVICE_REFS's (in its current
    words, when stored before #481) with them; any other note as it is, with none."""
    code = _NOTE_CODES.get(note)
    return (ADVICE[code], dict(ADVICE_REFS[code])) if code else (note, {})
