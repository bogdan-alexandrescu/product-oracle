"""Runs: drafts, estimates and approval, segments on the agent runtime, checkpoints.

    draft --start--> running                     (estimate <= $50)
    draft --start--> awaiting_approval --approve (owner)--> running
    running --segment ends--> awaiting_checkpoint --approved--> running (next segment)
                                                  --changes_requested--> running (re-run)
    running --spend > ceiling--> paused_overrun --resume (owner)--> running
    last checkpoint approved (or off) --> succeeded; a failed segment --> failed
    any non-final state --cancel--> cancelled

Every state change locks the run row. ``tick`` advances runs: it polls running
segments, records cost, pauses on overrun, and on success merges ``baseline.yaml``
into the baseline (through its YAML import: locked items get proposals), checks
``roadmap_items.yaml``, imports the draft (``prd.md`` or ``roadmap.md``, the target
document's kind) as the document's next version, and opens the segment's checkpoint (or
skips a disabled one).

Adapter v2 (oracle.runs.workflow, docs/swarmcloud-interface.md): whenever SwarmCloud's
caller MCP is on, the run token reaches the agents through the workflow's credential map,
in either mode, so agents read Oracle's data; while await-input is on too, a run is one
workflow whose checkpoints wait for a person in SwarmCloud, and the Inbox decision is
posted as the answer. Await-input off (or refused at submit): today's one workflow per
segment, the token still attached while MCP is on; MCP off: nothing attached. The run's
notes say which.

    running --wait opens--> awaiting_checkpoint (the workflow parked on its step)
    running --review1 of the last segment opens, its draft refused at import--> running
            (Oracle answers NOT_YET with the import's problems, :func:`_send_back`; the
            revision's draft is imported when review2 opens, for a person. Meanwhile the
            run reads "Revising: sent back by Oracle", :func:`_sent_back`)
            --approved / changes posted--> running (the same workflow goes on)
            --already answered, the workflow ran what the decision needs (same verdict,
              or an approval)--> running (the workflow goes on)
            --answered in SwarmCloud's console (the tick reads the wait once a
              minute) by an Oracle member with the approver role--> the checkpoint
              decided by that answer; the run follows it (W5)
            --answered there by anyone else--> stays open in the Inbox, showing the
              answer, for an approver to confirm or request changes
            --a counted console NOT_YET with no revision step (an earlier checkpoint)-->
              stays open with the findings: Redo from the segment (a new workflow, one
              more segment) or Continue; nothing re-runs without that choice
            --already answered with MERGE, changes requested (a correction), expired,
              closed, tail rule, refused--> the workflow cancelled; today's flow: a new
              workflow
    running / awaiting_checkpoint --spend > ceiling--> paused_overrun, the live workflow
            cancelled

A cancel SwarmCloud does not confirm keeps the workflow attached (``cancel_pending``):
its cost is still counted, its run token is revoked, every tick cancels it again (giving
up, recorded, on SwarmCloud's not_found; other 404s are counted, and past
``NOT_FOUND_TRIES`` the run shows in the Inbox with Cancel), and nothing is submitted
after it until the cancel holds; an Inbox decision that would need it says "decide
again". Past the cap only the cancel call rests: the workflow's status and cost are read
every tick. Stop cancelling (P3d) ends the cancel calls and clears the Inbox item, but
the workflow is never detached from the spend: it goes on ``searches`` with its id, its
status and cost read on every tick until it ends. On a run that has not ended, Stop
cancelling ends the run (owner, 2026-10-19): no second workflow starts for that segment,
and a spend over the ceiling after the end (seen on any read, the final one included)
is audited and shows in the Inbox with the spend and the ceiling, with Cancel again for
a stopped workflow that still runs (its cancel calls back on; nothing restarts), until
dismissed once nothing is left to read. A submission given up
on (Retry, or a cancel past the lookup cap) is looked for in the background
(``searches``, the first look on the next tick) until found, then cancelled and its cost
counted, or ruled out, within its credential's lifetime plus a step's timeout of slack;
a found workflow whose status reads is followed (on every tick) until SwarmCloud says it
ended, a confirmed cancel still winding down included. One whose status does not read
past that (or past ``NOT_FOUND_TRIES`` bare 404s) shows in the Inbox as "Cost unknown"
(Retry lookup reads it now), read again now and then until ``COST_UNKNOWN_SECONDS``
later, then dropped (noted). A confirmed cancel that keeps reading CANCELLING has its
cost read and counted (never "Cost unknown") until the same cap, then dropped (noted);
one SwarmCloud no longer knows right after a confirmed cancel is read once more before
it is taken as ended. An overrun after the end is recorded only for spend that arrived
after it (``spent_at_end``); a dismissed one does not block a new one once the spend
grows past it. A workflow's cost counts once, on the first attempt that
carries it. Search results are committed on their own, before the rest of the tick. A
confirmed cancel reads the workflow's final cost (a recorded cost is never lowered), and
the spend is checked against the ceiling before every submission and before anything
follows an answer.

W5 (owner, 2026-10-19, 'Open waits'): while any checkpoint wait of the run is open in
SwarmCloud, from the moment the workflow reaches it, the run token is read-only; writes
return once Oracle has read an answer that counts. The hold is decided just before a
run token's write runs (never for a read, initialize or tools/list): Oracle's records are
read and released first, then a review step no checkpoint stands for yet is read from
SwarmCloud (:func:`run_token_hold`; one read shared by concurrent writes, bounded by
``HOLD_READ_SECONDS``; reached once the step it depends on succeeded, whatever its own
row says, and in any state but parked on that unfinished step, not listed or not read,
it holds; a
read-only answer is reused for up to 5 seconds, 'may write' never; a request joining a
read in flight shares only a read-only answer, and on 'may write' reads for itself).
A lost submission holds its token until it is resolved, and a decision recorded in Oracle
until it is delivered to the workflow (owner, 2026-10-20). Agents are told a fixed reason. An
answered wait Oracle cannot read yet (SwarmCloud errors, a 404, a record that lags the
step, or a 409 already_answered whose record does not read) is shown as ``needs: unread``
until the answer is read; the approver rule applies then.

Segment ``artifacts`` (jsonb) hold ``files`` (name -> text), ``attempts`` (one entry
per submission or in-workflow round: workflow id, label, cost, the reviewer's note),
``notes``, ``import``, ``baseline_import``, ``items_check`` and ``lost`` (a submission
whose answer was lost, looked up by its label before resubmitting).
Run ``knobs`` hold the resolved knobs plus values Oracle sets: ``document_slug`` (a
document the run will create), ``spend_ceiling_usd``, and for prd_to_roadmap
``source_version_id`` (the approved PRD version), ``template``, ``template_version`` and
``theme`` (the roadmap's), ``workflow``: the live v2 workflow's id, label, credential
expiry and plan (oracle.runs.workflow), ``stuck_lookup`` (a lost submission past the
lookup cap, for Retry), ``searches`` (submissions given up on, still looked for),
``post_404`` (404s that prove nothing on an answer post, counted), ``planning_horizons``
(prd_to_roadmap: the company's horizons when the run started, A1), ``spent_at_end``
(the spend when the run ended) and ``import_failed`` (a resumed advance stopped after
``RESUME_TRIES`` failures, for an owner's Retry).

An advance interrupted after its first commit (an import raised) is advanced again on
each tick; the run's workflow is read whatever that does. Each failure is counted on the
attempt (``resume_failures``: the error's class and when); at ``RESUME_TRIES`` the step
fails and owners see "Couldn't import" in the Inbox with Retry.
"""

import copy
import logging
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import wording
from oracle.decisions import capture as decisions_capture  # noqa: F401
from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.review import inbox as inbox_states  # noqa: F401
from oracle.runs import (
    flows,
)
from oracle.runs.models import Run, RunSegment
from oracle.swarm import (
    get_runtime,  # noqa: F401
    redact,  # noqa: F401
)

if TYPE_CHECKING:
    pass

log = logging.getLogger(__name__)

FINAL = ("succeeded", "failed", "cancelled")
# A checkpoint decided by a person (the others: pending, skipped).
DECIDED = ("approved", "changes_requested")
# D4: a send-back with nothing staged and no note.
NOTHING_TO_SEND = "Stage a change, ask a question, or write a note to send back."
ACTIVE = ("running", "awaiting_checkpoint", "paused_overrun")
# Run knobs Oracle sets (not the user's knobs): kept when a draft's knobs change.
ORACLE_KNOBS = (
    "document_slug",
    "source_version_id",
    "template",
    "template_version",
    "theme",
    # prd_to_spec: the spec request the run writes (oracle.specs).
    "artifact_request_id",
    # A run started from a product intake (oracle.intake): the intake, the snapshot it
    # pinned (the run reads that one, S4) and, for research, the gaps to look into.
    "intake_id",
    "intake_snapshot_id",
    "intake_gap_ids",
    # C5: the intake's answers that existed when the run started (the ones it reads).
    "intake_answer_ids",
    # D12: a feedback loop started from Build next draft: exactly the items staged for
    # it, the agent-staged feedback and the accepted section-text suggestions; G4: the
    # section changes staged from discussions (next_draft_changes).
    "feedback_ids",
    "suggestion_ids",
    "next_draft_change_ids",
    # A launch_kit run (oracle.launches): the launch it drafts for.
    "launch_id",
    # strategy_draft (oracle.strategy.brief): the owner's brief from Company › Strategy.
    "strategy_brief",
    # C4 (B1 "Reuse base"): a Baseline to PRD run that uses the current baseline: the
    # review it reuses, {"checkpoint_id", "approved_at"} (oracle.runs.reuse).
    "reuse_baseline",
    # #260: the confirmed goals a Baseline to PRD run serves, [{"id", "key", "title"}].
    "target_goals",
    # "Add it to a PRD": the Ground Truth features a Baseline to PRD run adds to its PRD,
    # [{"id", "key", "title"}].
    "target_features",
    # E1: the PRD draft's derivation a prd_draft_items run stores its items in.
    "draft_roadmap_id",
    # E1 part B ("Reuse items"): false on a Build roadmap run that derives its items
    # again ("Derive the items again"); absent: it reuses the source version's draft items.
    "reuse_draft_items",
    # E1 part B: the draft items its estimate reuses, {"draft_roadmap_id", "version",
    # "ready_at"}; the start re-checks them (oracle.roadmap.draft_items.reusable).
    "draft_items_reused",
    # #482: a Regenerate's note to the agents (oracle.trash.regenerate).
    "regenerate_note",
    # prd-reads-working-draft: which company roadmap the run read ("Company roadmap,
    # working draft (edited Nov 5, 2026, 11:40 PM PST)"; oracle.simple.roadmap_of_record).
    "roadmap_read",
    # The roadmap each step read, by step name ({"prd_draft": "Company roadmap v7 ..."}).
    "roadmap_read_by",
)
ITEMS_FILE = "roadmap_items.yaml"


class RunError(Exception):
    status = 409

    def __init__(self, *args: object, refs: wording.Refs | None = None) -> None:
        super().__init__(*args)
        # #396: the ids agents need beside a message a person reads (oracle.wording).
        self.refs = refs


class NotFound(RunError):
    status = 404


class Invalid(RunError):
    status = 422


class Forbidden(RunError):
    status = 403


class Unavailable(RunError):
    """The agent runtime did not confirm a call; repeating it is safe."""

    status = 503
    # An Inbox decision's delivery that stopped on a cancel SwarmCloud did not confirm:
    # the run's workflow id and its cancel_pending marker, kept when the rest rolls back.
    held: dict[str, Any] | None = None
    # The runtime's own failure behind it, when there is one: what the run page and the
    # Inbox show of an undelivered decision (:func:`_cause`).
    cause: BaseException | None = None

    def __init__(self, message: str = "", *, cause: BaseException | None = None) -> None:
        super().__init__(message)
        if cause is not None:
            self.cause = cause


def _now() -> datetime:
    return datetime.now(UTC)


def _usd(value: Decimal | None) -> float | None:
    return None if value is None else float(value)


def _known_sum(values: Iterable[Any]) -> Decimal | None:
    """#1572: the sum of the known values; None (unknown, never $0) when none is known."""
    known = [Decimal(str(v)) for v in values if v is not None]
    return sum(known, Decimal(0)) if known else None


def _attempts_cost(art: dict[str, Any]) -> Decimal | None:
    return _known_sum(a.get("cost_usd") for a in art["attempts"])


def _spent(run: Run) -> Decimal:
    """What the run is known to have spent, against its ceiling: an unknown spend is not
    over it."""
    return run.spent_usd or Decimal(0)


def _about(estimate: Decimal | float | None) -> str:  # noqa: F811
    """ ", about $N" for a known estimate; nothing when it is unknown (never "about $0")."""
    return "" if estimate is None else f", about ${float(estimate):g}"


def _flow(run: Run) -> flows.FlowDef:
    return flows.FLOWS[run.flow]


def _knobs(run: Run) -> flows.Knobs:
    raw = run.knobs or {}
    stored = raw.get("checkpoints")
    if isinstance(stored, dict) and stored:
        # Stored knobs name every stop of the flow as it was when the run was made: a stop
        # added since (F4's eng_review) is off for it, so its segments stay as they were.
        added = {
            s.checkpoint: False
            for s in _flow(run).segments
            if s.skip_when_off and s.checkpoint not in stored
        }
        if added:
            raw = {**raw, "checkpoints": {**stored, **added}}
    return flows.resolve_knobs(_flow(run), raw)


def _skipped_off(sdef: flows.SegmentDef, knobs: flows.Knobs) -> bool:
    """F4: a segment skipped whole because its stop is off (no step, no spend)."""
    return (
        sdef.skip_when_off
        and sdef.checkpoint is not None
        and not knobs.checkpoints.get(sdef.checkpoint, True)
    )


OFF_NOTE = "Turned off when the run started."


def _art(segment: RunSegment) -> dict[str, Any]:
    """A copy of the segment's artifacts to edit; assign it back with ``_set_art``."""
    data = copy.deepcopy(segment.artifacts or {})
    data.setdefault("files", {})
    data.setdefault("attempts", [])
    data.setdefault("notes", [])
    return data


def _set_art(segment: RunSegment, data: dict[str, Any]) -> None:
    # A fresh object every time: the column is not mutation-tracked.
    segment.artifacts = copy.deepcopy(data)


# #541 part 5: whether a ``company_draft`` run reads as a member (its target was
# company-wide when it started). Set by start, never by a caller (not an ORACLE_KNOB).
MEMBER_VIEW = "member_view"
# one-roadmap-many-prds: the shared queue a prd_to_roadmap run froze (_frozen_queue).
COMPANY_QUEUE = "company_queue"


async def target_visibility(db: AsyncSession, run: Run) -> str:
    """The visibility of the document ``run`` writes: its document's, else (a run that
    creates it) the one a new document of its target kind gets."""
    if run.document_id is not None:
        found = await db.scalar(
            select(Document.visibility)
            .where(Document.id == run.document_id)
            .execution_options(oracle_all_documents=True)
        )
        if found is not None:
            return found
    return visibility.default_for(_flow(run).target_kind or "")


async def reads_as_member(db: AsyncSession, run: Run) -> bool:
    """Whether ``run``'s calls read as a commenter would (oracle.docs.visibility): a
    ``member_output`` flow's always; a ``company_draft`` flow's when its target was
    company-wide when it started (MEMBER_VIEW) or is now. A target made approvers-only
    later leaves the run reading as a member; one opened to the company later makes it
    read as one from then on (its draft import checks what it read before)."""
    flow = flows.FLOWS.get(run.flow)
    if flow is None or flow.member_output:
        return flow is not None
    if not flow.company_draft:
        return False
    if (run.knobs or {}).get(MEMBER_VIEW) is True:
        return True
    return await target_visibility(db, run) == visibility.COMPANY


async def member_hidden(db: AsyncSession, run: Run) -> visibility.Hidden | None:
    """What a commenter may not see, when ``run`` reads as a member (None otherwise): the
    text Oracle adds to such a run's prompt is checked against it (#562 review)."""
    if not await reads_as_member(db, run):
        return None
    return await visibility.hidden_for_reader(db, as_member=True)


async def _decide_member_view(db: AsyncSession, run: Run) -> None:
    if _flow(run).company_draft:
        _set_knob(run, MEMBER_VIEW, await target_visibility(db, run) == visibility.COMPANY)


def _set_knob(run: Run, key: str, value: Any) -> None:
    knobs = dict(run.knobs or {})
    if value is None:
        knobs.pop(key, None)
    else:
        knobs[key] = value
    run.knobs = knobs


def _ceiling(run: Run) -> Decimal | None:
    raw = (run.knobs or {}).get("spend_ceiling_usd")
    if raw is not None:
        return Decimal(str(raw))
    if run.estimate_usd is None:
        return None
    return run.estimate_usd * flows.OVERRUN_FACTOR


# --------------------------------------------------------------------------- tick


@dataclass
class _TickStats:
    checked: int = 0
    # run-progress: runs checked that were running when their pass began.
    active: set[uuid.UUID] = field(default_factory=set)
    finished: int = 0
    advanced: int = 0
    paused: int = 0
    # Kept, not raised: what a raise would roll back (a count of 404s) is written.
    errors: list[str] = field(default_factory=list)
    # This tick's pass over one run (set per run): what the pass committed and must not
    # redo when it runs again after a runtime call (_replay) is marked with it.
    pass_id: str = field(default_factory=lambda: uuid.uuid4().hex)


# Moved out of this module (#1576), imported back so ``service.NAME`` and every
# patch of it keep working. Keep these imports last: the modules import from here.

from oracle.runs.advance import (  # noqa: E402, F401
    ORDER_SAVED_BY_ORACLE,
    RESUME_TRIES,
    SENT_BACK_BY,
    CheckedItems,
    PriorReview,
    _advance,
    _apply_section_changes,
    _baseline_autonomy,
    _check_feature_set,
    _check_goal_trace,
    _check_items,
    _check_priority_order,
    _checked,
    _creator,
    _current_attempt,
    _draft_source,
    _import_baseline,
    _import_draft,
    _link_order,
    _link_requests,
    _link_scope,
    _loop_plan_inputs,
    _oracle_saves_order,
    _plan_table_problems,
    _prd_links,
    _prd_source,
    _relocked,
    _resume_advance,
    _resume_error,
    _resume_failed,
    _resuming,
    _run_importer,
    _section_keys,
    _send_back,
    _send_back_entry,
    _settle_sent_items,
    _source_of,
    _tell_order_saved,
    _version_source,
    _with_work_problems,
    _work_problems,
    checked_items,
    items_check,
    prior_review,
)
from oracle.runs.console import (  # noqa: E402, F401
    _console_member,
    _console_record,
    _outside_note,
    _recorded,
    _said,
    _take_answer,
    _unread,
    _unread_console,
    _unreadable,
    _wait_ended,
    _waiting_on,
    _watch_wait,
)
from oracle.runs.decisions import (  # noqa: E402, F401
    _apply_staged_edits,
    _complete_decision,
    _continue_decided,
    _decider_refusal,
    _deliver_decision,
    _Edited,
    _edits_refused,
    _failed_try,
    _finish_decision,
    _finish_decision_now,
    _finished_posting,
    _member_name,
    _owed_decision,
    _owed_q,
    _owed_voids,
    _owes,
    _posting_id,
    _restore_agents_file,
    _unapplied_note,
    _void_owed,
    _voided_while_delivered,
    _write_edits,
    decide_checkpoint,
    read_review_file,
    select_owed_decisions,
    void_decision,
    void_owed_decisions,
)
from oracle.runs.drafts import (  # noqa: E402, F401
    BUILD_UNDER_WAY,
    REUSES_DRAFT_ITEMS,
    TEMPLATED_KINDS,
    NotReusable,
    _current_inputs,
    _draft_items_to_reuse,
    _free_slug,
    _Inputs,
    _intake_snapshot,
    _items_reused_note,
    _launch,
    _one_build_at_a_time,
    _recheck_draft_items,
    _recheck_reuse,
    _reset_segments,
    _resolve_document,
    _resolve_inputs,
    _resolve_knobs,
    _resolve_source,
    _resolve_template,
    _reuse_draft_items,
    _reuse_knob,
    _skip_off,
    _skip_reused_baseline,
    _target_features,
    _target_goals,
    approve,
    create_run,
    estimate,
    start,
    update_run,
)
from oracle.runs.hold import (  # noqa: E402, F401
    _COUNTED,
    _HOLDING,
    HOLD_CACHE_SECONDS,
    HOLD_DECISION,
    HOLD_READ_SECONDS,
    HOLD_UNKNOWN,
    _cached_hold,
    _held,
    _hold_cache,
    _hold_clock,
    _hold_deadline,
    _hold_plan,
    _hold_reads,
    _hold_reason,
    _HoldKey,
    _HoldPlan,
    _holds_token,
    _live_hold,
    _prune_hold_cache,
    _read_hold,
    _review_predecessors,
    _Reviews,
    console_blocked,
    run_token_hold,
    token_hold,
)
from oracle.runs.inbox import (  # noqa: E402, F401
    _NOT_ROADMAP_OPS,
    NO_DOCUMENT_SINCE,
    WEBHOOK_NOTICE_KINDS,
    WaitingStop,
    _access_failures,
    _access_requests,
    _date_rows,
    _hidden_runs,
    _inbox,
    _no_document_text,
    _no_documents,
    _revising,
    _revoke_failures,
    _unread_webhook_notices,
    _waits_for,
    inbox,
    inbox_counts,
    mark_inbox_seen,
    waiting_stops,
)
from oracle.runs.manage import (  # noqa: E402, F401
    BUDGET_STOPPED,
    CONSOLE_BLOCKED,
    DRAFT_RETRY_SLOTS,
    NOT_IMPORTED,
    RETRY_LOOKUP_SECONDS,
    TooSoon,
    _accept_new,
    _cancel_stuck,
    _cannot_approve,
    _draft_retries,
    _draft_retry_refusal,
    _draft_retry_role,
    _draft_retry_slots,
    _end_stopped,
    _hold_console_approval,
    _manages,
    _may_manage,
    _order_decided,
    _recheck_order_goals,
    _recheck_scope,
    _retry_checked,
    _retry_draft_import,
    _retry_refused,
    _retry_slots,
    _retryable_seq,
    _review_of,
    _run_version,
    _scope_decided,
    _scope_of,
    _scope_reopened,
    _slug_taken,
    _still_manages,
    _stop_cancelling,
    cancel,
    cancel_again,
    dismiss_overrun,
    end_as_oracle,
    not_imported,
    one_version,
    resume,
    retry,
    retry_draft_import,
    retry_import,
    retry_lookup,
    retry_segment,
    stop_cancelling,
    stop_run,
)
from oracle.runs.posting import (  # noqa: E402, F401
    _already_answered,
    _attach_for_cancel,
    _console_choice,
    _count_post_404,
    _decide_in_workflow,
    _duration,
    _email,
    _follow,
    _hold_unread,
    _left,
    _PostNotFound,
    _problem_findings,
    _read_recorded,
    _send_back_findings,
    _undecide,
    _Unread,
)
from oracle.runs.prompts import (  # noqa: E402, F401
    SENT_KNOBS,
    WITHHELD_NOTE,
    _carried_lines,
    _draft_context,
    _explain,
    _frozen_queue,
    _imported_numbers,
    _intake_title,
    _known_roadmap_items,
    _loop_feedback,
    _loop_section_changes,
    _low_threshold,
    _prompt_context,
    _regenerate_note,
    _roadmap_lines,
    _run_horizons,
    _source_context,
    _target_kind,
    sent_items,
)
from oracle.runs.reads import (  # noqa: E402, F401
    _DECIDER_KEYS,
    _LISTED,
    CHECKPOINT_TITLES,
    _agent_out,
    _artifact,
    _can_dismiss_overrun,
    _can_redo,
    _can_retry,
    _cancel_again_ids,
    _checkpoint_out,
    _checkpoints,
    _console_findings,
    _cost_unknown,
    _decider_names,
    _decider_of,
    _delivery,
    _get_run,
    _import_failed,
    _import_failed_text,
    _live_reasons,
    _may_read_files,
    _offers_interviews,
    _open_questions,
    _overrun_shown,
    _pending_titles,
    _people_named,
    _progress,
    _proposals_since,
    _record_decider,
    _Refs,
    _refs,
    _refused,
    _segment_out,
    _segments,
    _sent_back,
    _source_id,
    _staged_actions,
    _stuck,
    _summary,
    _vague_goals,
    _winding,
    approve_gate_of,
    blocking_open,
    creator_only_hidden,
    creator_only_visible,
    decision_summary,
    decisions_of_runs,
    flow_catalog,
    list_decisions,
    list_runs,
    read_artifact,
    read_run,
    read_scope,
    recheck_briefs,
)
from oracle.runs.renewal import (  # noqa: E402, F401
    _FINISHED_STEPS,
    _KEY_REFRESH_PARKS,
    KEY_REFRESH_SECONDS,
    WATCH_SECONDS,
    _key_park_advice,
    _mark_key_refresh,
    _park_key,
    _pause_workflow,
    _renewed_note,
    refresh_key,
)
from oracle.runs.replay import (  # noqa: E402, F401
    _GUARD,
    _OUTSIDE,
    CANCEL_FOLLOW_UP_GRACE_SECONDS,
    CLAIM_SECONDS,
    REPLAY_LIMIT,
    _cancel_follow_up,
    _claimed,
    _disarm,
    _finish,
    _Guard,
    _Guarded,
    _NeedCall,
    _next,
    _recompute_spend,
    _replay,
    _rt,
    _settle_cancel_follow_ups,
    _submit_queued,
    cancel_at_runtime,
    submit_queued,
)
from oracle.runs.searches import (  # noqa: E402, F401
    _OPEN_OR_DONE,
    _after_search,
    _cost_cap,
    _cost_on,
    _credential_end,
    _failed_why,
    _found_apply,
    _found_call,
    _found_cancels,
    _harvest,
    _higher,
    _import_names,
    _last_cost,
    _may_restart,
    _new_overrun_after_end,
    _note_refused,
    _overrun_after_end,
    _queued_expiry,
    _read_call,
    _read_found,
    _restart_queued,
    _rests,
    _search_earlier,
    _search_end,
    _search_for,
    _searching,
    _tick_workflow,
    _title,
    _under_cap,
    _usd_text,
)
from oracle.runs.submission import (  # noqa: E402, F401
    _DROP_MCP,
    _DROP_WAITS,
    _STUCK,
    COST_UNKNOWN_SECONDS,
    LOST_LOOKUP_SECONDS,
    LOST_LOOKUP_TRIES,
    NOT_FOUND_TRIES,
    QUEUED,
    RESUME_VOIDED,
    SEARCH_SECONDS,
    STUCK_LOOKUP_SECONDS,
    TICK_RUN_SECONDS,
    _accepted,
    _apply_cancel,
    _awaiting_items,
    _cancel_call,
    _cancel_pending,
    _Cancelled,
    _cause,
    _clip,
    _count_not_found,
    _degrade,
    _detach,
    _draft_items_ready,
    _drivable,
    _end_workflow,
    _give_up,
    _keep_previous,
    _live,
    _locked,
    _lookup_exhausted,
    _Mode,
    _mode,
    _not_found,
    _not_started,
    _note,
    _note_art,
    _parse_at,
    _pending,
    _plan_entry,
    _queue_wait,
    _queue_wait_out,
    _read_on,
    _read_once_more,
    _record_agents,
    _record_running,
    _record_wait,
    _record_workflow_wait,
    _resting,
    _set_wait,
    _shown,
    _submit,
    _submit_now,
    _unconfirmed,
    _waiting,
    _within,
    _workflow_segments,
    unqueue,
)
from oracle.runs.tick import (  # noqa: E402, F401
    _SPENDING,
    _add_attempt,
    _adopt,
    _attempt_of,
    _dates_pending,
    _has_waiting,
    _overrun,
    _pause_overrun,
    _resetter,
    _rested,
    _retry_pending_cancel,
    _stamp_checked,
    _stop_looking,
    _take_cost,
    _tick_one,
    _tick_run,
    _tick_searches,
    _unchecked,
    _unchecked_reason,
    tick,
)
