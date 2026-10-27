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

import asyncio
import contextvars
import copy
import hashlib
import logging
import time
import uuid
import weakref
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

from sqlalchemy import ColumnElement, and_, func, literal_column, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy, company_time, confidence, safe_yaml, webhooks, wording
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.baseline import yaml_io
from oracle.baseline.goals import target_words
from oracle.baseline.models import Edge, Entity, Proposal
from oracle.claude_accounts.pool import readable_refusal
from oracle.decisions import capture as decisions_capture
from oracle.docs import service as docs_service
from oracle.docs import visibility, written
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.parser import DraftError, is_uuid
from oracle.docs.schemas import ImportProblem, VersionSource
from oracle.engineering import check as eng_check
from oracle.engineering import dates as eng_dates
from oracle.jobs.models import LlmSuggestion
from oracle.members.leads import (
    ENGINEERING_KINDS,
    LEAD_ONLY,
    SPEC_FLOW,
    decides,
    engineering_leads,
    lead_now,
    lead_refusal,
    lead_stop,
    may_decide,
)
from oracle.priorities import run_order
from oracle.priorities import service as priorities_service
from oracle.priorities.models import PrioritySnapshot
from oracle.priorities.schemas import PriorityCheck
from oracle.review import inbox as inbox_states
from oracle.review.models import FeedbackItem
from oracle.review.schemas import Resolution
from oracle.review.service import locked_section_keys
from oracle.roadmap import doc_dates, schedule
from oracle.roadmap.views import items_version, version_items
from oracle.runs import (
    apply_edits,
    extensions,
    feature_set,
    flows,
    gate,
    reasons,
    rejection,
    reuse,
    review_link,
    roadmap,
    waits,
    workflow,
)
from oracle.runs import resolutions as answers
from oracle.runs.batch import batched, once
from oracle.runs.models import Checkpoint, CheckpointAction, Run, RunSegment
from oracle.runs.schemas import (
    AgentRoleOut,
    CheckpointDelivery,
    CheckpointOut,
    ConsoleAnswer,
    DraftImport,
    EstimateOut,
    FeatureSetCheck,
    FlowCatalog,
    FlowOut,
    FlowSegmentOut,
    FlowStart,
    Gate,
    InboxAccessFailure,
    InboxAccessRequest,
    InboxCheckpoint,
    InboxCounts,
    InboxDocument,
    InboxFeedbackCounts,
    InboxFeedbackItem,
    InboxOut,
    InboxRevokeFailure,
    InboxShareRevocation,
    InboxStaged,
    InboxStrategy,
    ItemsCheck,
    KnobsIn,
    KnobsOut,
    NeedsAgents,
    PrdScopeOut,
    PreviousAttempt,
    QueueWait,
    RunCreate,
    RunDecision,
    RunNoteRefs,
    RunOut,
    RunPatch,
    RunProgress,
    RunSummary,
    SegmentAgent,
    SegmentAttempt,
    SegmentEstimate,
    SegmentOut,
    TargetGoal,
    TickOut,
)
from oracle.runs.scope_models import PrdScope
from oracle.runtokens import RunToken, mint_run_token, revoke_run_tokens
from oracle.sources.models import Snapshot
from oracle.swarm import (
    AgentRuntime,
    McpAccess,
    Parked,
    RecordedAnswer,
    RuntimeUnavailable,
    StepSpec,
    WorkflowSpec,
    WorkflowStatus,
    get_runtime,
    load_learned,
    redact,
)
from oracle.swarm.runtime import MCP_SERVER, MERGE, NOT_YET, WORKING, not_reached
from oracle.swarm.settings import (
    MAX_CREDENTIAL_SECONDS,
    MIN_CREDENTIAL_SECONDS,
    get_runtime_settings,
)
from oracle.templates import service as templates_service
from oracle.templates.builtins import (
    DEFAULT_TEMPLATE_FOR_KIND,
    DEFAULT_THEME_FOR_KIND,
    ensure_builtins,
)
from oracle.templates.models import Template, TemplateVersion, Theme
from oracle.tenancy import current_tenant, tenant_session
from oracle.tenant_settings import TenantSetting
from oracle.tenant_settings_api import company_horizons
from oracle.v2.models import StakeholderQuestion

if TYPE_CHECKING:
    from oracle.members.models import MemberFollowUp

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


# --------------------------------------------------------------------------- reads


def flow_catalog() -> FlowCatalog:
    runtime = get_runtime()
    return FlowCatalog(
        flows=[
            FlowOut(
                key=f.key,  # type: ignore[arg-type]
                title=f.title,
                description=f.description,
                requires_document=f.requires_document,
                target_kind=f.target_kind,  # type: ignore[arg-type]
                source_kind=f.source_kind,  # type: ignore[arg-type]
                entry=f.entry,
                in_new_run_dialog=f.in_new_run_dialog,
                writes_document=f.writes_document,
                starts_from=FlowStart(label=f.starts_from[0], href=f.starts_from[1])
                if f.starts_from
                else None,
                segments=[
                    FlowSegmentOut(
                        name=s.name,
                        title=s.title,
                        roles=list(s.roles),
                        scopes=list(s.scopes),
                        outputs=list(s.outputs_for(f.target_kind or "prd")),
                        checkpoint=s.checkpoint,  # type: ignore[arg-type]
                        approver_role=s.approver_role,  # type: ignore[arg-type]
                        decider="engineering_lead"
                        if s.checkpoint in ENGINEERING_KINDS and f.key != SPEC_FLOW
                        else "role",
                    )
                    for s in f.segments
                ],
            )
            for f in flows.FLOWS.values()
        ],
        roles=[
            AgentRoleOut(key=r.key, title=r.title, description=r.description, base_usd=r.base_usd)
            for r in flows.ROLES.values()
        ],
        depths={k: float(v) for k, v in flows.DEPTHS.items()},
        approval_threshold_usd=float(flows.APPROVAL_THRESHOLD_USD),
        overrun_factor=float(flows.OVERRUN_FACTOR),
        runtime=runtime.name,
        runtime_notes=runtime.notes(),
    )


def creator_only_visible(db: AsyncSession) -> ColumnElement[bool] | None:
    """#624 review: the runs of a flow private to its creator (``FlowDef.creator_only``,
    Oracle's read of an intake) that the session's principal may list, as a WHERE clause
    on :class:`Run`; None for Oracle's own sessions, which see every run. Only the run's
    creator sees one: a person, their personal token or MCP client, or a run they
    started, unless that run reads as a member (its output is every member's)."""
    principal = visibility.principal_of(db)
    if principal is None:
        return None
    others = Run.flow.not_in(flows.CREATOR_ONLY_FLOWS)
    user_id = getattr(principal, "user_id", None)
    if user_id is None or getattr(principal, "as_member", False):
        return others
    return or_(others, Run.created_by == user_id)


def creator_only_hidden(db: AsyncSession, run: Run) -> bool:
    """:func:`creator_only_visible` on a loaded run."""
    principal = visibility.principal_of(db)
    if principal is None or run.flow not in flows.CREATOR_ONLY_FLOWS:
        return False
    user_id = getattr(principal, "user_id", None)
    return user_id is None or getattr(principal, "as_member", False) or run.created_by != user_id


async def _get_run(db: AsyncSession, run_id: uuid.UUID, *, lock: bool = False) -> Run:
    if lock:
        # Read again as it is now: the caller may have read it unlocked before.
        stmt = select(Run).where(Run.id == run_id)
        run = await db.scalar(stmt.with_for_update().execution_options(populate_existing=True))
    else:
        # The run this request already read (the research gate, runs.router) is reused;
        # one deleted since in this session is as absent as the read would find it.
        run = await db.get(Run, run_id)
        if run is not None and run.deleted_at is not None:
            run = None
    # H8: a run on a document the principal may not see (an update, for a commenter or a
    # viewer) is as absent as its document, with its segments and files; so is another
    # member's run of a flow private to its creator (#624 review).
    if (
        run is None
        or creator_only_hidden(db, run)
        or (
            run.document_id is not None
            and await visibility.hidden_document_ids(db, [run.document_id])
        )
    ):
        raise NotFound(f"run {run_id} not found")
    return run


async def _segments(
    db: AsyncSession, run_id: uuid.UUID, *, fresh: bool = False
) -> list[RunSegment]:
    stmt = select(RunSegment).where(RunSegment.run_id == run_id).order_by(RunSegment.seq)
    if fresh:
        # Read again as they are now: another transaction may have changed them.
        stmt = stmt.execution_options(populate_existing=True)
    return list(await db.scalars(stmt))


async def _checkpoints(db: AsyncSession, run_ids: list[uuid.UUID]) -> list[Checkpoint]:
    if not run_ids:
        return []
    rows = await db.scalars(
        select(Checkpoint)
        .where(Checkpoint.run_id.in_(run_ids))
        .order_by(Checkpoint.created_at, Checkpoint.id)
    )
    return list(rows)


@dataclass
class _Refs:
    """What run summaries show of the documents they name, loaded once per list."""

    slugs: dict[uuid.UUID, str]
    kinds: dict[uuid.UUID, str]
    sources: dict[uuid.UUID, VersionSource]
    # The Company time zone a stored error's moments are read in (#556).
    zone: str = company_time.DEFAULT_ZONE

    def get(self, document_id: uuid.UUID | None) -> str | None:
        return self.slugs.get(document_id) if document_id else None


def _source_id(run: Run) -> uuid.UUID | None:
    raw = (run.knobs or {}).get("source_version_id")
    return uuid.UUID(raw) if raw else None


async def _refs(
    db: AsyncSession, runs: list[Run], segments: list[RunSegment] | None = None
) -> _Refs:
    ids = {r.document_id for r in runs if r.document_id}
    slugs: dict[uuid.UUID, str] = {}
    kinds: dict[uuid.UUID, str] = {}
    if ids:
        rows = await db.execute(
            select(Document.id, Document.slug, Document.kind).where(Document.id.in_(ids))
        )
        for doc_id, slug, kind in rows.all():
            slugs[doc_id], kinds[doc_id] = slug, kind
    sources = await docs_service.version_sources(db, [_source_id(r) for r in runs])
    zone = (
        await company_time.company_time_zone(db)
        if any(r.error for r in runs) or any(s.error for s in segments or [])
        else company_time.DEFAULT_ZONE
    )
    return _Refs(slugs, kinds, sources, zone)


def _progress(run: Run, segments: list[RunSegment]) -> RunProgress:
    flow = _flow(run)
    now = next((s for s in segments if s.status == "running"), None) or next(
        (s for s in segments if s.status == "pending"), None
    )
    return RunProgress(
        done=sum(1 for s in segments if s.status in ("succeeded", "skipped")),
        total=len(segments),
        now=flow.segment(now.name).title if now else None,
    )


def _summary(
    run: Run,
    refs: _Refs,
    waiting: Checkpoint | None,
    segments: list[RunSegment] | None = None,
    owed: Checkpoint | None = None,
) -> RunSummary:
    """``owed``: the run's checkpoint whose recorded decision is not delivered yet
    (:func:`_owes`), where the checkpoints were read."""
    flow = _flow(run)
    source_id = _source_id(run)
    return RunSummary(
        id=run.id,
        flow=run.flow,  # type: ignore[arg-type]
        flow_title=flow.title,
        status=run.status,  # type: ignore[arg-type]
        document_id=run.document_id,
        document_slug=refs.get(run.document_id)
        if run.document_id
        else run.knobs.get("document_slug"),
        document_kind=(refs.kinds.get(run.document_id) if run.document_id else None)
        or flow.target_kind,  # type: ignore[arg-type]
        source=refs.sources.get(source_id) if source_id else None,
        template=run.knobs.get("template"),
        theme=run.knobs.get("theme"),
        estimate_usd=_usd(run.estimate_usd),
        spent_usd=float(run.spent_usd or 0),
        created_by=run.created_by,
        created_at=run.created_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        waiting_on=waiting.kind if waiting else None,  # type: ignore[arg-type]
        review_link=review_link.link(waiting) if waiting else None,
        error=readable_refusal(run.error, refs.zone, past=run.status == "failed"),
        stuck=_stuck(run, refs.zone),
        queue_wait=_queue_wait_out(run),
        can_retry=_can_retry(run),
        can_stop_cancelling=_cancel_stuck(run) is not None,
        can_retry_lookup=_cost_unknown(run) is not None,
        cancel_again=_cancel_again_ids(run),
        can_dismiss_overrun=_can_dismiss_overrun(run),
        searching=_searching(run),
        import_failed=_import_failed_text(run, refs),
        can_retry_import=_import_failed(run) is not None,
        progress=_progress(run, segments) if segments is not None else None,
        draft_rejected=_refused(run, segments, False) if segments is not None else None,
        sent_back=_refused(run, segments, True) if segments is not None else None,
        # Paused on overrun, it delivers nothing until resumed: it reads paused. Oracle's
        # send-back means no human decision is owed, so a sent-back run never delivers.
        delivering=owed.kind  # type: ignore[arg-type]
        if owed is not None
        and run.status == "awaiting_checkpoint"
        and not (segments is not None and _refused(run, segments, True))
        else None,
    )


def _sent_back(run: Run, segment: RunSegment) -> bool:
    """Oracle sent the segment's refused draft back to the writer (:func:`_send_back`), and
    the revision is not imported yet: its attempt is Oracle's send-back and was not
    advanced, on a run that has not ended. The run page and the Inbox read "Revising: sent
    back by Oracle", not "Draft rejected": nothing waits for a person until the revision is
    imported (cleared) or still refused (review2's checkpoint, "Draft rejected")."""
    art = segment.artifacts or {}
    imp = art.get("import")
    if run.status in FINAL or not isinstance(imp, dict) or not imp.get("error"):
        return False
    if not art.get("attempts"):
        return False
    attempt = _current_attempt(art, segment)
    return attempt.get("sent_back") is True and attempt.get("advanced") is not True


def _refused(run: Run, segments: list[RunSegment], sent_back: bool) -> str | None:
    """The summary of a draft the run's segments left that Oracle refused to import, else
    None: one Oracle sent back to the writer and is being revised (``sent_back``, the
    runs list's "Revising"), or one that is not (the runs list's "Draft rejected"). A run
    that succeeded past the refusal reads neither (owner, 2026-10-25): if it finished with
    no document, its owners' Inbox says so (:func:`_no_document_text`)."""
    if run.status == "succeeded":
        return None
    for s in segments:
        imp = (s.artifacts or {}).get("import")
        if isinstance(imp, dict) and imp.get("error") and _sent_back(run, s) is sent_back:
            return imp.get("summary") or imp["error"]
    return None


def _import_failed(run: Run) -> dict[str, Any] | None:
    """A resumed advance stopped at :data:`RESUME_TRIES` on a run that has not ended
    (owners: Retry)."""
    failed = (run.knobs or {}).get("import_failed")
    return failed if isinstance(failed, dict) and run.status not in FINAL else None


def _import_failed_text(run: Run, refs: "_Refs") -> str | None:
    """The owners' Inbox item for :func:`_import_failed`: the error's class only, never
    what the agents wrote."""
    failed = _import_failed(run)
    if failed is None:
        return None
    name = (refs.get(run.document_id) if run.document_id else None) or (run.knobs or {}).get(
        "document_slug"
    )
    what = f"{name}" if name else f"the {_flow(run).title} run"
    return (
        f"Couldn't import {what}'s output: {failed.get('error')} on {failed.get('count')} "
        "tries in a row, and Oracle stopped trying. Retry tries again; meanwhile Oracle "
        "keeps reading the run's workflow and counting its cost."
    )


def _can_retry(run: Run) -> bool:
    return run.status == "running" and isinstance((run.knobs or {}).get("stuck_lookup"), dict)


def _stuck(run: Run, zone: str = company_time.DEFAULT_ZONE) -> str | None:
    """What the Inbox says of a run that waits for an owner or its creator: its lost
    submission is past the lookup cap (Retry or Cancel), SwarmCloud answered a cancel
    or an answer post with :data:`NOT_FOUND_TRIES` 404s that prove nothing (Cancel), or
    its current workflow started no agent in :data:`waits.NOT_STARTED_SECONDS` (Cancel;
    ``zone``: the Company time zone its moment is shown in)."""
    knobs = run.knobs or {}
    if _can_retry(run):
        label = knobs["stuck_lookup"].get("label")
        return f"Submission {label} was lost and is still not found. {_STUCK}."
    wf = _cancel_stuck(run)
    if wf is not None:
        pending = wf.get("cancel_pending") or {}
        return (
            f"SwarmCloud answered HTTP 404 {pending.get('not_found')} times while Oracle "
            f"cancelled workflow {wf.get('id')}, without saying it does not exist "
            f"({pending.get('error')}): it may still run. Oracle keeps reading its cost and "
            f"cancels it again every {_duration(STUCK_LOOKUP_SECONDS)}; in the Inbox, Stop "
            "cancelling stops the cancel calls and ends the run (its cost is still read and "
            "counted until it ends; cancel it in SwarmCloud's console)."
        )
    over = _overrun_shown(run)
    if over is not None:
        running = [str(e["id"]) for e in knobs.get("searches") or [] if e.get("id")]
        said = (
            f"After the run ended its spend reached {_usd_text(run.spent_usd)}, over its "
            f"{_usd_text(over.get('ceiling_usd'))} ceiling"
        )
        if not running:
            return (
                f"{said}. No workflow of the run is left running; Dismiss clears this "
                "(the overrun stays on the run)."
            )
        stopped = _cancel_again_ids(run)
        said += (
            f": workflow {', '.join(running)} still runs in SwarmCloud, and Oracle counts its "
            "spend on the run until it ends."
        )
        if stopped:
            return (
                f"{said} An approver stopped cancelling {', '.join(stopped)}: Cancel again "
                "turns Oracle's cancel calls back on (nothing restarts), or cancel it in "
                "SwarmCloud's console."
            )
        return f"{said} Cancel it in SwarmCloud's console."
    unknown = _cost_unknown(run)
    if unknown is not None:
        n = unknown.get("not_found")
        if n:
            why = f"SwarmCloud answered HTTP 404 {n} times without saying it does not exist"
        else:
            why = "SwarmCloud has not served its status"
        return (
            f"Cost unknown for workflow {unknown.get('id')} (submission {unknown.get('label')}): "
            f"{why} ({unknown.get('error')}) since {str(unknown.get('cost_unknown'))[:16]}. "
            f"Oracle reads it again every {_duration(STUCK_LOOKUP_SECONDS)} until "
            f"{_cost_cap(unknown).isoformat(timespec='minutes')}, and Retry lookup reads it "
            "now; the run's spend has what Oracle last read. If it still runs, cancel it in "
            "SwarmCloud's console."
        )
    winding = _winding(run)
    if winding is not None:
        return (
            f"Workflow {winding.get('id')} (submission {winding.get('label')}) still reads "
            "CANCELLING although SwarmCloud confirmed its cancel, since "
            f"{str(winding.get('winding_since'))[:16]}. Oracle reads its cost on every tick "
            "and counts it on the run until "
            f"{_cost_cap(winding).isoformat(timespec='minutes')}, then stops with a note on "
            "the run. If it still runs, cancel it in SwarmCloud's console."
        )
    post = knobs.get("post_404")
    if (
        run.status == "awaiting_checkpoint"
        and isinstance(post, dict)
        and int(post.get("tries") or 0) >= NOT_FOUND_TRIES
    ):
        return (
            f"SwarmCloud answered the checkpoint's decision with HTTP 404 {post.get('tries')} "
            f"times, without saying the wait does not exist ({post.get('error')}): nothing "
            "was recorded. Decide again later, or in the Inbox, Cancel ends the run."
        )
    return _not_started(run, zone)


def _overrun_shown(run: Run) -> dict[str, Any] | None:
    """An ended run's spend over its ceiling (P3d), while it shows in the Inbox: until
    dismissed."""
    over = (run.knobs or {}).get("overrun_after_end")
    if isinstance(over, dict) and run.status in FINAL and not over.get("dismissed_at"):
        return over
    return None


def _cancel_again_ids(run: Run) -> list[str]:
    """Workflows an approver stopped cancelling that still run while the ended run's
    spend is over its ceiling: Cancel again turns Oracle's cancel calls back on."""
    if _overrun_shown(run) is None:
        return []
    return [
        str(e["id"])
        for e in (run.knobs or {}).get("searches") or []
        if e.get("id") and e.get("cancel") is False
    ]


def _can_dismiss_overrun(run: Run) -> bool:
    """The overrun of an ended run is dismissed once nothing is left to read."""
    return _overrun_shown(run) is not None and not (run.knobs or {}).get("searches")


def _cost_unknown(run: Run) -> dict[str, Any] | None:
    """The first searched workflow whose cost is unknown (in the Inbox: Retry lookup)."""
    return next(
        (
            e
            for e in (run.knobs or {}).get("searches") or []
            if e.get("id") and e.get("cost_unknown")
        ),
        None,
    )


def _winding(run: Run) -> dict[str, Any] | None:
    """The first searched workflow whose confirmed cancel still reads CANCELLING past its
    search's end, its cost read (P3d: not 'cost unknown'; dropped at its cap)."""
    return next(
        (
            e
            for e in (run.knobs or {}).get("searches") or []
            if e.get("id") and e.get("winding") and not e.get("cost_unknown")
        ),
        None,
    )


# Who decided an owed decision, as they authenticated (wait.posting): Oracle's own, re-read
# before each try, never returned.
_DECIDER_KEYS = ("user_id", "token_id", "grant_id")


async def _decider_names(db: AsyncSession, checkpoints: list[Checkpoint]) -> dict[uuid.UUID, str]:
    """Who decided each checkpoint whose decision is owed (:func:`_owes`): the member's
    email, or the API token's name."""
    ids = {c.decided_by for c in checkpoints if c.decided_by is not None and _owes(c)}
    if not ids:
        return {}
    out: dict[uuid.UUID, str] = dict(
        (await db.execute(select(User.id, User.email).where(User.id.in_(ids)))).all()
    )
    if rest := ids - set(out):
        out.update(
            (
                await db.execute(select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(rest)))
            ).all()
        )
    return out


def _delivery(
    cp: Checkpoint, names: dict[uuid.UUID, str]
) -> tuple[dict[str, Any], CheckpointDelivery | None]:
    """The checkpoint's payload as returned (the decider's ids dropped from an owed
    decision's marker), and the owed decision's delivery (owner, 2026-10-20: shown on the
    run page and in the Inbox until SwarmCloud takes it)."""
    payload = cp.payload or {}
    wait = payload.get("wait") or {}
    posting = wait.get("posting")
    if not isinstance(posting, dict):
        return payload, None
    shown = {k: v for k, v in posting.items() if k not in _DECIDER_KEYS}
    payload = {**payload, "wait": {**wait, "posting": shown}}
    if not _owes(cp):
        return payload, None
    return payload, CheckpointDelivery(
        decided_by_name=names.get(cp.decided_by) if cp.decided_by else None,
        since=_parse_at(posting.get("at")),
        tries=int(posting.get("tries") or 0),
        last_error=posting.get("error"),
        last_tried_at=_parse_at(posting.get("tried_at")),
    )


def _checkpoint_out(
    cp: Checkpoint,
    principal: Principal | None,
    names: dict[uuid.UUID, str] | None = None,
    *,
    flow: str,
    leads: frozenset[uuid.UUID],
    staged: dict[uuid.UUID, list[CheckpointAction]] | None = None,
    vague_goals: int | None = None,
    live: dict[uuid.UUID, list[dict[str, Any]]] | None = None,
    open_questions: set[uuid.UUID] | None = None,
) -> CheckpointOut:
    """``names``: :func:`_decider_names` of the checkpoints read; ``flow``: the run's;
    ``leads``: :func:`oracle.members.leads.engineering_leads`, read once per request;
    ``staged``: :func:`_staged_actions` of the checkpoints read (the approve gate);
    ``vague_goals``: :func:`_vague_goals` of the checkpoints read;
    ``live``: :func:`_live_reasons` of the checkpoints read;
    ``open_questions``: :func:`_open_questions` of those (D7: what needs the agents)."""
    console = ((cp.payload or {}).get("wait") or {}).get("console")
    payload, delivery = _delivery(cp, names or {})
    mine = (staged or {}).get(cp.id, []) if cp.status == "pending" else []
    shut = gate.approve_gate(cp, (live or {}).get(cp.id), mine) if cp.status == "pending" else None
    edits = cp.kind in apply_edits.FILES
    blocked = apply_edits.needs_agents(mine, open_questions or set()) if edits else []
    return CheckpointOut(
        id=cp.id,
        run_id=cp.run_id,
        kind=cp.kind,  # type: ignore[arg-type]
        status=cp.status,  # type: ignore[arg-type]
        approver_role=cp.approver_role,  # type: ignore[arg-type]
        segment_seq=(cp.payload or {}).get("segment_seq"),
        decided_by=cp.decided_by,
        decided_at=cp.decided_at,
        note=cp.note,
        review=cp.review,
        payload=payload,
        created_at=cp.created_at,
        console=ConsoleAnswer.model_validate({**console, "can_redo": _can_redo(console)})
        if isinstance(console, dict) and cp.status == "pending"
        else None,
        can_decide=cp.status == "pending"
        and principal is not None
        and may_decide(principal, cp, flow, leads),
        lead_stop=lead_stop(cp.kind, flow, leads),
        cannot_approve=_cannot_approve(cp)
        or (gate.message(shut) if shut is not None and not shut.open else None),
        gate=shut,
        delivery=delivery,
        vague_goals=vague_goals if _offers_interviews(cp) else None,
        approve_label=apply_edits.label(apply_edits.edit_count(mine) if edits else 0),
        needs_agents=[NeedsAgents(action_id=a.id, item=a.item_key, kind=a.kind) for a in blocked],
        review_link=review_link.link(cp),
    )


async def _open_questions(
    db: AsyncSession, staged: dict[uuid.UUID, list[CheckpointAction]]
) -> set[uuid.UUID]:
    """The questions of staged question actions still asked (D7: they need the agents)."""
    ids = {a.question_id for xs in staged.values() for a in xs if a.question_id is not None}
    if not ids:
        return set()
    return set(
        await db.scalars(
            select(StakeholderQuestion.id).where(
                StakeholderQuestion.id.in_(ids),
                StakeholderQuestion.status.in_(apply_edits.OPEN_QUESTIONS),
            )
        )
    )


def _offers_interviews(cp: Checkpoint) -> bool:
    return cp.kind == "baseline_confirm" and cp.status == "approved"


async def _vague_goals(db: AsyncSession, checkpoints: list[Checkpoint]) -> int | None:
    """B6: how many goals are not measurable, when an approved Confirm the baseline is
    read (the after-review line offers an interview; nothing starts one here)."""
    if not any(_offers_interviews(c) for c in checkpoints):
        return None
    from oracle.baseline.goal_interview import vague_count

    return await vague_count(db)


async def _staged_actions(
    db: AsyncSession, checkpoints: list[Checkpoint]
) -> dict[uuid.UUID, list[CheckpointAction]]:
    """The staged draft actions (D8) of the pending checkpoints that have an approve gate."""
    ids = [c.id for c in checkpoints if c.status == "pending" and c.kind in gate.BLOCKING_SOURCES]
    out: dict[uuid.UUID, list[CheckpointAction]] = {}
    if not ids:
        return out
    for action in await db.scalars(
        select(CheckpointAction).where(
            CheckpointAction.checkpoint_id.in_(ids), CheckpointAction.state == "staged"
        )
    ):
        out.setdefault(action.checkpoint_id, []).append(action)
    return out


async def _live_reasons(
    db: AsyncSession, checkpoints: list[Checkpoint]
) -> dict[uuid.UUID, list[dict[str, Any]]]:
    """The blocking reasons of the pending checkpoints whose kind reads them live (B2:
    the goals a run proposed and nobody decided, at Confirm the baseline)."""
    from oracle.baseline import from_run

    out: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for c in checkpoints:
        if c.status == "pending" and c.kind in gate.LIVE_KINDS:
            out[c.id] = await from_run.gate_reasons(db, c.run_id)
    return out


async def approve_gate_of(db: AsyncSession, cp: Checkpoint) -> Gate | None:
    """The approve gate of ``cp`` now (D3): its blocking reasons and staged actions."""
    staged = await _staged_actions(db, [cp])
    live = await _live_reasons(db, [cp])
    return gate.approve_gate(cp, live.get(cp.id), staged.get(cp.id, []))


def blocking_open(shut: Gate) -> RunError:
    """The 409 an approval gets while the gate is closed (decide, console confirm)."""
    message = gate.message(shut)
    error = RunError(message)
    error.detail = {  # type: ignore[attr-defined]
        "code": "blocking_open",
        "message": message,
        "left": [x.model_dump() for x in shut.left],
    }
    return error


def _segment_out(
    run: Run,
    segment: RunSegment,
    knobs: flows.Knobs,
    kind: str = "prd",
    can_retry_draft_import: bool = False,
    zone: str = company_time.DEFAULT_ZONE,
    draft_retry_refused: str | None = None,
) -> SegmentOut:
    sdef = _flow(run).segment(segment.name)
    art = segment.artifacts or {}
    imp = art.get("import")
    check = art.get("items_check")
    merged = art.get("baseline_import") or {}
    progress = art.get("progress") or {}
    if segment.status != "running" or progress.get("workflow_id") != segment.swarm_workflow_id:
        progress = {}
    return SegmentOut(
        id=segment.id,
        seq=segment.seq,
        name=segment.name,
        title=sdef.title,
        status=segment.status,  # type: ignore[arg-type]
        roles=knobs.roles.get(segment.name, list(sdef.roles)),
        scopes=list(sdef.scopes),
        checkpoint=sdef.checkpoint_for(kind),  # type: ignore[arg-type]
        checkpoint_on=sdef.checkpoint is not None and knobs.checkpoints.get(sdef.checkpoint, True),
        estimate_usd=_usd(segment.estimate_usd),
        cost_usd=float(segment.cost_usd or 0),
        workflow_id=segment.swarm_workflow_id,
        artifacts=sorted((art.get("files") or {}).keys()),
        attempts=[SegmentAttempt(**a) for a in art.get("attempts") or []],
        draft_import=DraftImport(**imp) if imp else None,
        sent_back=_sent_back(run, segment),
        reused=art.get("reused") if segment.status == "skipped" else None,
        note=art.get("note") if segment.status == "skipped" or art.get("reused_items") else None,
        can_retry_draft_import=can_retry_draft_import,
        draft_retry_refused=draft_retry_refused,
        items_check=ItemsCheck(**check) if check else None,
        previous_attempt=PreviousAttempt(
            attempt=previous["attempt"], artifacts=sorted(previous.get("files") or {})
        )
        if isinstance(previous := art.get("previous"), dict)
        else None,
        feature_set_check=FeatureSetCheck(**fs) if (fs := art.get("feature_set_check")) else None,
        priority_check=PriorityCheck(**pc) if (pc := art.get("priority_check")) else None,
        autonomy_note=(merged.get("autonomy") or {}).get("note"),
        started_at=segment.started_at,
        finished_at=segment.finished_at,
        error=readable_refusal(segment.error, zone, past=segment.status == "failed"),
        # #258: only while it runs, and only what was read of its current workflow.
        agents=[SegmentAgent(**a) for a in progress.get("agents") or []],
        checked_at=progress.get("checked_at"),
        queue_wait=_queue_wait_out(run, segment.seq) if segment.status == "running" else None,
    )


# D11: how a decision reads for the run's agents and on the run page.
CHECKPOINT_TITLES = {
    "baseline_confirm": "Baseline",
    "feature_set": "Feature set",
    "priority_order": "Priority order",
    "prd_review": "PRD review",
    "eng_review": "Engineering review",
    "roadmap_items": "Roadmap items",
    "roadmap_review": "Roadmap review",
    "strategy_review": "Vision or strategy review",
    "request_triage": "Request triage",
    "launch_review": "Launch kit review",
}
_LISTED = ("approved", "changes_requested", "skipped")


def _record_decider(cp: Checkpoint, role: str | None, via: str) -> None:
    """Who decided ``cp``, by role, and where (:func:`list_decisions`); kept on the
    checkpoint as it is decided, so a later change of the member's role does not alter
    what the run's agents read."""
    cp.payload = {**copy.deepcopy(cp.payload or {}), "decided": {"role": role, "via": via}}


def decision_summary(
    kind: str, status: str, role: str | None, via: str, note: str | None, delivered: bool
) -> str:
    """One line: "Feature set · approved by an approver · note: Keep bulk import out"."""
    what = status.replace("_", " ")
    if role:
        what += f" by {'an' if role[0] in 'aeiou' else 'a'} {role}"
    if via == "swarmcloud_console":
        what += " in SwarmCloud's console"
    parts = [CHECKPOINT_TITLES.get(kind, kind), what]
    if note:
        parts.append(f"note: {note}")
    if not delivered:
        parts.append("not delivered to the run yet")
    return " · ".join(parts)


async def list_decisions(
    db: AsyncSession, run_id: uuid.UUID, principal: Principal
) -> list[RunDecision]:
    """Every decided checkpoint of the run, by segment then decided time (pending ones,
    a console answer held for an approver included, are not decisions yet). A run's own
    call reads its own run only."""
    if principal.run_id is not None and principal.run_id != run_id:
        raise NotFound(f"run {run_id} not found")
    run = await _get_run(db, run_id)
    flow = _flow(run)
    decided = [c for c in await _checkpoints(db, [run.id]) if c.status in _LISTED]
    # Decisions recorded before the decider was kept on the checkpoint: their role now.
    ids = {
        c.decided_by
        for c in decided
        if c.decided_by is not None and "decided" not in (c.payload or {})
    }
    roles: dict[uuid.UUID, str] = {}
    if ids:
        roles = dict((await db.execute(select(User.id, User.role).where(User.id.in_(ids)))).all())
        if rest := ids - set(roles):
            roles.update(
                (
                    await db.execute(
                        select(ApiToken.id, ApiToken.role).where(ApiToken.id.in_(rest))
                    )
                ).all()
            )
    out: list[RunDecision] = []
    for cp in decided:
        payload = cp.payload or {}
        mark = payload.get("decided")
        if isinstance(mark, dict):
            role, via = mark.get("role"), mark.get("via") or "oracle"
        else:
            role = roles.get(cp.decided_by) if cp.decided_by else None
            via = "oracle"
        seq = payload.get("segment_seq")
        name = payload.get("segment")
        title = None
        if name and any(s.name == name for s in flow.segments):
            title = flow.segment(name).title
        extra = payload.get("review") if isinstance(payload.get("review"), dict) else {}
        delivered = not _owes(cp)
        out.append(
            RunDecision(
                checkpoint_id=cp.id,
                kind=cp.kind,  # type: ignore[arg-type]
                segment_seq=seq,
                segment_title=title,
                attempt=payload.get("attempt"),
                status=cp.status,  # type: ignore[arg-type]
                decided_at=cp.decided_at,
                decided_by_role=role,
                via=via,
                note=cp.note,
                edits=extra.get("edits"),
                review=cp.review or extra.get("review"),
                delivered=delivered,
                summary=decision_summary(cp.kind, cp.status, role, via, cp.note, delivered),
            )
        )
    far = datetime.max.replace(tzinfo=UTC)
    out.sort(key=lambda d: (d.segment_seq or 0, d.decided_at or far))
    return out


async def read_run(db: AsyncSession, run_id: uuid.UUID, principal: Principal | None) -> RunOut:
    run = await _get_run(db, run_id)
    segments = await _segments(db, run.id)
    checkpoints = await _checkpoints(db, [run.id])
    names = await _decider_names(db, checkpoints)
    leads = await engineering_leads(db)
    staged = await _staged_actions(db, checkpoints)
    vague = await _vague_goals(db, checkpoints)
    live = await _live_reasons(db, checkpoints)
    asked = await _open_questions(db, staged)
    refs = await _refs(db, [run], segments)
    knobs = _knobs(run)
    kind = await _target_kind(db, run)
    snapshot = await db.get(Snapshot, run.snapshot_id) if run.snapshot_id else None
    waiting = next((c for c in checkpoints if c.status == "pending"), None)
    retries = _draft_retries(run, segments, checkpoints, kind, principal)
    version = _run_version(segments, checkpoints)
    runtime = get_runtime()
    notes: list[str] = []
    note_refs: list[RunNoteRefs] = []
    for s in segments:
        for stored in (s.artifacts or {}).get("notes") or []:
            n, n_refs = workflow.noted(stored)
            if n not in notes:
                notes.append(n)
                if n_refs:
                    note_refs.append(RunNoteRefs(note=n, refs=n_refs))
    if run.status == "draft" or not segments or not any(s.swarm_workflow_id for s in segments):
        await load_learned(runtime)
        notes += [n for n in runtime.notes() if n not in notes]
    return RunOut(
        **_summary(
            run, refs, waiting, segments, next((c for c in checkpoints if _owes(c)), None)
        ).model_dump(),
        knobs=KnobsOut(
            depth=knobs.depth,  # type: ignore[arg-type]
            roles=knobs.roles,
            checkpoints=knobs.checkpoints,
            budget_usd=_usd(knobs.budget_usd),
            reuse_baseline=(run.knobs or {}).get("reuse_baseline") or None,
            goals=[TargetGoal(**g) for g in (run.knobs or {}).get("target_goals") or []],
            reuse_draft_items=(run.knobs or {}).get("reuse_draft_items") is not False
            if run.flow == REUSES_DRAFT_ITEMS
            else None,
        ),
        snapshot_id=run.snapshot_id,
        snapshot_as_of=snapshot.as_of if snapshot else None,
        approved_by=run.approved_by,
        approved_at=run.approved_at,
        needs_approval=run.estimate_usd is not None
        and run.estimate_usd > flows.APPROVAL_THRESHOLD_USD,
        overrun_ceiling_usd=_usd(_ceiling(run)),
        runtime=runtime.name,
        notes=notes,
        note_refs=note_refs,
        segments=[
            _segment_out(
                run,
                s,
                knobs,
                kind,
                s.seq in retries,
                zone=refs.zone,
                draft_retry_refused=_retry_refused(run, s, version),
            )  # fmt: skip
            for s in segments
        ],
        checkpoints=[
            _checkpoint_out(
                c,
                principal,
                names,
                flow=run.flow,
                leads=leads,
                staged=staged,
                vague_goals=vague,
                live=live,
                open_questions=asked,
            )  # fmt: skip
            for c in checkpoints
        ],
        token_read_only=await token_hold(db, run.id, live=False) is not None,
        waiting_for=(awaiting.artifacts or {}).get("waiting_for")
        if (awaiting := _awaiting_items(segments)) is not None
        else None,
        open_proposals=await db.scalar(
            select(func.count())
            .select_from(Proposal)
            .where(Proposal.run_id == run.id, Proposal.status == "open")
        )
        or 0,
    )


# Console answers that did not count (W5): one Oracle could not count (its answerer),
# one it could not read (the form over its limit or odd, a verdict that is neither
# MERGE nor NOT_YET, a refused read of a step that SUCCEEDED), and one it cannot read
# yet (``unread``: SwarmCloud errors, a 404, a record that lags the step; read again on
# every tick). Each waits for an approver or for the read, and the run's token is
# read-only meanwhile.
_HOLDING = ("confirm", "unreadable", "unread")
# A counted console answer whose follow-up (Redo or Continue) is still to choose: the
# answer counts and Oracle has read it, so the wait no longer holds the token.
_COUNTED = ("redo_or_continue",)


def _holds_token(cp: Checkpoint) -> bool:
    """W5 (owner, 2026-10-19): the run's token is read-only while a checkpoint wait is
    open in SwarmCloud (unanswered, answered and not read yet, unreadable, or answered by
    someone whose answer does not count); writes return once Oracle has read an answer
    that counts. A wait that ended (expired, closed, paused) is no longer open.
    Owner decision 2026-10-20: a decision recorded in the Inbox and not delivered to the
    workflow yet (:func:`_owes`, "Delivering decision") holds it too, until delivered; a
    voided one leaves the checkpoint pending, which holds as any other."""
    if _owes(cp):
        return True
    if cp.status != "pending":
        return False
    wait = (cp.payload or {}).get("wait") or {}
    needs = (wait.get("console") or {}).get("needs")
    if needs in _HOLDING:
        return True
    return bool(wait.get("workflow_id")) and not wait.get("ended") and needs not in _COUNTED


def console_blocked(cp: Checkpoint) -> bool:
    """A console approval held because the feature set (C6) or the priority order (C8)
    has blocking problems."""
    return bool((((cp.payload or {}).get("wait") or {}).get("console") or {}).get("blocking"))


def _hold_reason(cp: Checkpoint) -> str:
    needs = (((cp.payload or {}).get("wait") or {}).get("console") or {}).get("needs")
    if _owes(cp):
        why = "has a decision recorded in Oracle that is not delivered to the run yet"
    elif needs == "confirm" and console_blocked(cp):
        what = CHECKPOINT_TITLES.get(cp.kind, cp.kind).lower()
        why = (
            f"was approved in SwarmCloud's console while the {what} has blocking "
            "problems; an Oracle approver confirms it once they are fixed or waived"
        )
    elif needs == "confirm":
        why = (
            "was answered in SwarmCloud's console by someone whose answer does not count "
            "until an Oracle approver confirms it"
        )
    elif needs == "unread":
        why = (
            "was answered in SwarmCloud's console and Oracle has not read the recorded "
            "answer yet (it reads it again each tick)"
        )
    elif needs == "unreadable":
        why = (
            "was answered in SwarmCloud's console and Oracle could not read the recorded "
            "answer, so an Oracle approver decides"
        )
    else:
        why = "waits for a decision in SwarmCloud"
    return f"{cp.kind} {why}"


def _held(why: str) -> str:
    return (
        f"waiting for approval: {why}; until Oracle reads an answer that counts, this run's "
        "token may read Oracle but not write to it"
    )


# What the run's agents are told when their write is held back (W5): a fixed reason,
# never what Oracle recorded of the checkpoint or what SwarmCloud said (that is logged).
HOLD_DECISION = "waiting for a checkpoint decision"
HOLD_UNKNOWN = "status unknown"
# The live read a write waits on: one deadline for all of it (past it, or on an error,
# the token is read-only), and how long a read-only answer is reused (W5, owner
# 2026-10-19: a 'read-only' answer may be cached for up to 5 seconds; 'may write' is
# never cached).
HOLD_READ_SECONDS = 3.0
HOLD_CACHE_SECONDS = 5.0
_hold_clock = time.monotonic
# The read's deadline (tests fire it themselves rather than wait on the runner's clock).
_hold_deadline = asyncio.timeout

# Run, workflow, and each review step no checkpoint stands for yet with the step it
# depends on (None: not known, so it holds).
_Reviews = tuple[tuple[str, str | None], ...]
_HoldKey = tuple[uuid.UUID, str, _Reviews]
_hold_cache: dict[_HoldKey, tuple[float, str]] = {}
_hold_reads: dict[_HoldKey, "asyncio.Task[str | None]"] = {}


@dataclass(frozen=True)
class _HoldPlan:
    """What Oracle's records say of a run token's hold: held (``reason``, and the
    ``detail`` logged for it), or decided by a live read of workflow ``workflow_id``:
    its review steps no checkpoint stands for yet, each with the step it depends on
    (``reviews``)."""

    reason: str | None = None
    detail: str | None = None
    workflow_id: str | None = None
    reviews: _Reviews = ()


def _review_predecessors(entry: dict[str, Any]) -> list[tuple[str, str | None]]:
    """A segment's review steps, each with the step it depends on in Oracle's own plan
    (:func:`workflow.build_plan`): the segment's last work step for the first round, the
    previous round's revise step after it. None when Oracle's record does not say."""
    work = entry.get("work") or []
    before = [work[-1] if work else None, *(entry.get("revises") or [])]
    return [
        (str(r), before[i] if i < len(before) else None)
        for i, r in enumerate(entry.get("reviews") or [])
    ]


async def _hold_plan(db: AsyncSession, run_id: uuid.UUID) -> _HoldPlan:
    checkpoints = await _checkpoints(db, [run_id])
    held = next((c for c in checkpoints if _holds_token(c)), None)
    if held is not None:
        return _HoldPlan(HOLD_DECISION, _hold_reason(held))
    run = await db.get(Run, run_id)
    if run is None:
        return _HoldPlan()
    for s in await _segments(db, run_id):
        lost = _art(s).get("lost")
        if s.status == "pending" and isinstance(lost, dict):
            # Its answer was lost and its token kept alive: it may run, and a wait in it
            # may be open, until the lookup resolves it.
            return _HoldPlan(HOLD_UNKNOWN, f"submission {lost.get('label')} was lost")
    wf = _drivable(run)
    if wf is None:
        return _HoldPlan()
    opening = (run.knobs or {}).get("opening_wait")
    if isinstance(opening, dict) and opening.get("workflow_id") == wf.get("id"):
        # _advance is opening a checkpoint on this wait (its import commits first).
        return _HoldPlan(HOLD_DECISION, f"{opening.get('kind') or 'a checkpoint'} is opening")
    known = {
        ((c.payload or {}).get("wait") or {}).get("step_id")
        for c in checkpoints
        if ((c.payload or {}).get("wait") or {}).get("workflow_id") == wf.get("id")
    }
    for e in wf.get("segments") or []:
        reviews = e.get("reviews") or []
        for answered in e.get("oracle_answered") or []:
            # Oracle's answer is no person's (_send_back): held until the checkpoint of a
            # later round stands, and then as that checkpoint holds.
            later = reviews[reviews.index(answered) + 1 :] if answered in reviews else []
            if not any(r in known for r in later):
                return _HoldPlan(
                    HOLD_DECISION, f"{e.get('name')}'s refused draft is back with the writer"
                )
    reviews = [
        p
        for e in wf.get("segments") or []
        for p in _review_predecessors(e)
        if p[0] not in (e.get("oracle_answered") or [])
    ]
    unknown = tuple(p for p in reviews if p[0] not in known)
    if not unknown or not wf.get("id"):
        return _HoldPlan()
    return _HoldPlan(workflow_id=wf["id"], reviews=unknown)


async def _read_hold(key: _HoldKey) -> str | None:
    """One live read of a workflow's status: whether it reached a review step no
    checkpoint stands for yet (not :func:`not_reached` given the step it depends on in
    the same read, or not listed).
    Bounded by :data:`HOLD_READ_SECONDS`; a read-only answer
    is kept for :data:`HOLD_CACHE_SECONDS`."""
    run_id, workflow_id, reviews = key
    held: str | None = None
    try:
        async with _hold_deadline(HOLD_READ_SECONDS):
            status = await get_runtime().status(workflow_id)
    except (RuntimeUnavailable, TimeoutError) as exc:
        log.warning(
            "run %s: token read-only, status of %s not read: %s",
            run_id,
            workflow_id,
            exc or f"no answer in {HOLD_READ_SECONDS:g} s",
        )
        held = HOLD_UNKNOWN
    else:
        for review, after in reviews:
            step = status.step(review)
            before = status.step(after) if after else None
            if step is None or not not_reached(step, before):
                log.info(
                    "run %s: token read-only, step %s of %s is %s (park reason %s, after %s: %s)",
                    run_id,
                    review,
                    workflow_id,
                    step.state if step else "not listed",
                    step.park_reason if step else None,
                    after,
                    before.state if before else "not listed",
                )
                held = HOLD_DECISION
                break
    if held is not None:
        now = _hold_clock()
        _prune_hold_cache(now)
        _hold_cache[key] = (now, held)
    return held


def _prune_hold_cache(now: float) -> None:
    for k in [k for k, (at, _) in _hold_cache.items() if now - at >= HOLD_CACHE_SECONDS]:
        del _hold_cache[k]


def _cached_hold(key: _HoldKey) -> str | None:
    """A read-only answer from the last :data:`HOLD_CACHE_SECONDS` (expired ones pruned)."""
    now = _hold_clock()
    _prune_hold_cache(now)
    cached = _hold_cache.get(key)
    return cached[1] if cached is not None else None


async def _live_hold(run_id: uuid.UUID, workflow_id: str, reviews: _Reviews) -> str | None:
    """The live read's answer: a read-only one from the last 5 seconds, else a read.

    W5, shared status checks (owner, 2026-10-20): a request that starts a read uses its
    own answer, and requests arriving while it is in flight join it, but share only a
    read-only answer. On 'may write' each joiner makes a read of its own, never joining
    one started before it arrived (a wait may have opened since that read was sent)."""
    key = (run_id, workflow_id, reviews)
    cached = _cached_hold(key)
    if cached is not None:
        return cached
    loop = asyncio.get_running_loop()
    task = _hold_reads.get(key)
    if task is not None and task.get_loop() is loop:
        # Shielded: one request going away does not cancel the read the others wait on.
        shared = await asyncio.shield(task)
        if shared is not None:
            return shared
        cached = _cached_hold(key)
        if cached is not None:
            return cached
        # 'May write' was read before this request arrived: read for itself.
        return await _read_hold(key)
    task = loop.create_task(_read_hold(key))
    _hold_reads[key] = task

    def done(t: "asyncio.Task[str | None]") -> None:
        if _hold_reads.get(key) is t:
            del _hold_reads[key]

    task.add_done_callback(done)
    return await asyncio.shield(task)


async def token_hold(db: AsyncSession, run_id: uuid.UUID, *, live: bool = True) -> str | None:
    """Why the run's token is read-only now (W5), or None: its agents may read Oracle,
    and their writes (drafts, proposals) are refused while any checkpoint wait of the
    run is open in SwarmCloud, until Oracle has read an answer that counts, while a
    decision recorded in Oracle is not delivered to the workflow yet, and while a lost
    submission (whose token is alive) is unresolved.

    From the moment the workflow reaches the wait, not from Oracle's next look at it: a
    review step of the live workflow that no checkpoint stands for yet is read from
    SwarmCloud, and reached (once the step it depends on succeeded, whatever its own row
    says; in any state but parked on that unfinished step; not listed, or not read) it
    holds.
    ``live`` False: from what Oracle recorded only (the run's page). A write checks it
    with :func:`run_token_hold`, which releases the database before SwarmCloud is read."""
    plan = await _hold_plan(db, run_id)
    if plan.reason is not None:
        return _held(plan.reason)
    if not live or plan.workflow_id is None:
        return None
    why = await _live_hold(run_id, plan.workflow_id, plan.reviews)
    return _held(why) if why else None


async def run_token_hold(tenant_id: uuid.UUID, run_id: uuid.UUID) -> str | None:
    """:func:`token_hold` for a write a run token is about to make: Oracle's records are
    read in a session of their own, closed before SwarmCloud is called."""
    async with tenant_session(tenant_id) as s:
        plan = await _hold_plan(s, run_id)
    if plan.reason is not None:
        log.info("run %s: token read-only: %s", run_id, plan.detail)
        return _held(plan.reason)
    if plan.workflow_id is None:
        return None
    why = await _live_hold(run_id, plan.workflow_id, plan.reviews)
    return _held(why) if why else None


def _console_findings(console: dict[str, Any]) -> list[str]:
    return [str(f).strip() for f in console.get("findings") or [] if str(f).strip()]


def _can_redo(console: dict[str, Any]) -> bool:
    """Redo carries the console's findings as the change request; without any, a note
    is needed (the web disables the button until one is written)."""
    return bool(_console_findings(console))


async def list_runs(db: AsyncSession, status: str | None = None) -> list[RunSummary]:
    stmt = select(Run).order_by(Run.created_at.desc(), Run.id)
    if status:
        stmt = stmt.where(Run.status == status)
    if hidden := await visibility.hidden_document_ids(db):
        # H8: no row for a run on a document the principal may not see.
        stmt = stmt.where(or_(Run.document_id.is_(None), Run.document_id.not_in(hidden)))
    if (private := creator_only_visible(db)) is not None:
        stmt = stmt.where(private)
    runs = list(await db.scalars(stmt))
    refs = await _refs(db, runs)
    ids = [r.id for r in runs]
    checkpoints = await _checkpoints(db, ids)
    pending = {c.run_id: c for c in checkpoints if c.status == "pending"}
    owed = {c.run_id: c for c in checkpoints if _owes(c)}
    # Every run's segments in one query, so a list never costs a call per run.
    segments: dict[uuid.UUID, list[RunSegment]] = {i: [] for i in ids}
    if ids:
        rows = await db.scalars(
            select(RunSegment).where(RunSegment.run_id.in_(ids)).order_by(RunSegment.seq)
        )
        for seg in rows:
            segments[seg.run_id].append(seg)
    return [_summary(r, refs, pending.get(r.id), segments[r.id], owed.get(r.id)) for r in runs]


async def read_scope(db: AsyncSession, run_id: uuid.UUID) -> PrdScopeOut:
    """The run's latest PRD scope, any status (C6)."""
    run = await _get_run(db, run_id)
    scope = await feature_set.latest_scope(db, run.id)
    if scope is None:
        raise NotFound(f"run {run_id} has no PRD scope yet")
    return feature_set.scope_out(scope, await feature_set.scope_items(db, scope.id))


async def read_artifact(
    db: AsyncSession,
    run_id: uuid.UUID,
    seq: int,
    name: str,
    attempt: int | None = None,
    agents: bool = False,
) -> str:
    """A segment's file; with ``attempt``, that attempt's: the current one, or the previous
    one a send-back kept (D5). Older attempts are not kept. ``agents``: the file as the
    agents wrote it, before an approver's edits were applied (D7; 404 when none were).
    Served only to a reader who may see what the run read (:func:`_may_read_files`)."""
    run = await _get_run(db, run_id)
    return await _may_read_files(db, run, await _artifact(db, run_id, seq, name, attempt, agents))


async def _may_read_files(db: AsyncSession, run: Run, text: str) -> str:
    """#562 review: ``text``, a raw file of ``run``, as its reader may see it. Owners,
    approvers and Oracle's own sessions read every file. Anyone who may not see
    approvers-only things (a commenter, a viewer, their API tokens, a run that reads as a
    member: oracle.docs.visibility ``restricted``) reads a file of a run that read as a
    member (:func:`reads_as_member`) only when it names nothing hidden from them, as its
    importer and the read-time checks of #541 parts 3-5 check (``Hidden.names``: output
    written before part 4/5 may); a file of any other run, which read with its
    starter's view, never. A creator-only run's (#624 review: Oracle's read of an intake) is
    read by its creator alone (:func:`creator_only_hidden`), with the same check. Refused: a
    404, as a file that is not there."""
    hidden = await visibility.hidden_for_reader(db)
    if hidden is None:
        return text
    readable = _flow(run).creator_only or await reads_as_member(db, run)
    if not readable or hidden.names(text):
        raise NotFound(f"run {run.id} has no such file")
    return text


async def _artifact(
    db: AsyncSession, run_id: uuid.UUID, seq: int, name: str, attempt: int | None, agents: bool
) -> str:
    segment = await db.scalar(
        select(RunSegment).where(RunSegment.run_id == run_id, RunSegment.seq == seq)
    )
    art = (segment.artifacts or {}) if segment else {}
    files = art.get("files") or {}
    if agents:
        revisions = art.get("revisions") or []
        last = str(revisions[-1].get("attempt")) if revisions else None
        kept = (art.get("agent_files") or {}).get(last) or {} if last else {}
        if name not in kept:
            raise NotFound(f"no edits were applied to {name!r}: the agents' file is current")
        return kept[name]
    if attempt is not None:
        previous = art.get("previous") or {}
        attempts = art.get("attempts") or []
        current = int(attempts[-1].get("attempt") or len(attempts)) if attempts else None
        if previous and attempt == previous.get("attempt") and attempt != current:
            files = previous.get("files") or {}
        elif attempt != current:
            raise NotFound(
                f"attempt {attempt} of segment {seq} is not kept: only the current and the "
                "previous attempt are kept"
            )
    if name not in files:
        raise NotFound(f"artifact {name!r} not found")
    return files[name]


# --------------------------------------------------------------------------- drafts


async def _resolve_document(
    db: AsyncSession, flow: flows.FlowDef, ref: str | None, default_slug: str | None = None
) -> tuple[Document | None, str | None]:
    """(document, new slug) for a run's target document."""
    if ref is None:
        if flow.requires_document:
            raise Invalid(f"the {flow.title} flow needs the document to work on")
        if default_slug is None:
            raise Invalid("name the PRD: an existing document, or a new slug to create")
        ref = default_slug
    document = await docs_service.find_document(db, ref)
    if document is None:
        if flow.requires_document or is_uuid(ref):
            raise Invalid(f"document '{ref}' not found")
        return None, ref
    if flow.target_kind and document.kind != flow.target_kind:
        raise Invalid(
            f"document '{ref}' is a {flows.KIND_NAMES.get(document.kind, document.kind)}, "
            f"not a {flows.KIND_NAMES[flow.target_kind]}"
        )
    if flow.document_kinds and document.kind not in flow.document_kinds:
        raise Invalid(
            f"document '{ref}' is a {flows.KIND_NAMES.get(document.kind, document.kind)}; "
            f"the {flow.title} flow drafts a "
            + " or a ".join(flows.KIND_NAMES[k] for k in flow.document_kinds)
        )
    if flow.requires_document:
        latest = await db.scalar(
            select(func.max(DocumentVersion.number)).where(
                DocumentVersion.document_id == document.id
            )
        )
        if latest is None:
            raise Invalid(f"document '{ref}' has no version to give feedback on")
    return document, None


async def _resolve_source(
    db: AsyncSession, flow: flows.FlowDef, ref: str | None, number: int | None
) -> tuple[Document, DocumentVersion] | None:
    """The approved source version a flow reads (prd_to_roadmap: a PRD version)."""
    if flow.source_kind is None:
        if ref is not None or number is not None:
            raise Invalid(f"the {flow.title} flow reads no source document")
        return None
    name = flows.KIND_NAMES[flow.source_kind]
    if ref is None:
        raise Invalid(f"name the approved {name} to build from")
    document = await docs_service.find_document(db, ref)
    if document is None:
        raise Invalid(f"document '{ref}' not found")
    if document.kind != flow.source_kind:
        raise Invalid(
            f"document '{ref}' is a {flows.KIND_NAMES.get(document.kind, document.kind)}, "
            f"not a {name}"
        )
    stmt = select(DocumentVersion).where(DocumentVersion.document_id == document.id)
    if number is None and not flow.source_approved:
        raise Invalid(f"name the version of the {name} to read")
    if number is not None:
        version = await db.scalar(stmt.where(DocumentVersion.number == number))
        if version is None:
            raise Invalid(f"version {number} of '{document.slug}' not found")
        if version.approved_at is None and flow.source_approved:
            target = flows.KIND_NAMES.get(flow.target_kind or "", "roadmap")
            raise Invalid(
                f"version {number} of '{document.slug}' is not approved: a {target} is built "
                f"from an approved {name} version"
            )
    else:
        version = await db.scalar(
            stmt.where(DocumentVersion.approved_at.is_not(None))
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        if version is None:
            target = flows.KIND_NAMES.get(flow.target_kind or "", "roadmap")
            raise Invalid(
                f"'{document.slug}' has no approved version: approve a version of the {name} "
                f"before building its {target}"
            )
    # #254: nothing is built from a version that is still only its template's text.
    if await written.nothing_written(db, document, version):
        raise Invalid(f"version {version.number} of '{document.slug}': {written.NOTHING_WRITTEN}")
    return document, version


async def _resolve_template(
    db: AsyncSession,
    kind: str,
    template: str | None,
    theme: str | None,
    document: Document | None,
) -> dict[str, Any]:
    """The target's template (key + version) and theme: the ones named, else the
    existing document's, else the company's new-draft default for the kind (Settings,
    as the new-draft picker), else the built-in defaults (O4: now-next-later and
    roadmap-board for roadmaps)."""
    await ensure_builtins(db)
    company = (await templates_service.company_draft_defaults(db)).get(kind) or {}
    key = template or (document.template if document and document.template else None)
    if not key and company.get("template"):
        key = await db.scalar(
            select(Template.key).where(
                Template.key == company["template"],
                Template.kind == kind,
                Template.archived_at.is_(None),
            )
        )
    key = key or DEFAULT_TEMPLATE_FOR_KIND[kind]
    row = await db.scalar(select(Template).where(Template.key == key))
    if row is None:
        raise Invalid(f"template '{key}' not found")
    if row.kind != kind:
        raise Invalid(f"template '{key}' is a {row.kind} template, not a {kind} template")
    if row.archived_at is not None and template:
        raise Invalid(f"template '{key}' is archived; restore it to start new drafts")
    number = None
    if (
        not template
        and document is not None
        and document.template == key
        and (document.template_version or "").isdigit()
    ):
        number = int(document.template_version)  # type: ignore[arg-type]
    stmt = select(TemplateVersion.version).where(TemplateVersion.template_id == row.id)
    if number is not None:
        stmt = stmt.where(TemplateVersion.version == number)
    number = await db.scalar(stmt.order_by(TemplateVersion.version.desc()).limit(1))
    if number is None:
        raise Invalid(f"template '{key}' has no version")
    company_theme = None
    if company.get("theme"):
        company_theme = await db.scalar(
            select(Theme.key).where(
                Theme.key == company["theme"],
                Theme.kind.in_((kind, "any")),
                Theme.archived_at.is_(None),
            )
        )
    theme_key = (
        theme
        or (document.theme if document else None)
        or company_theme
        or DEFAULT_THEME_FOR_KIND[kind]
    )
    trow = await db.scalar(select(Theme).where(Theme.key == theme_key))
    if trow is None:
        raise Invalid(f"theme '{theme_key}' not found")
    if trow.kind not in (kind, "any"):
        raise Invalid(f"theme '{theme_key}' is for {trow.kind} documents, not {kind}")
    if trow.archived_at is not None and theme:
        raise Invalid(f"theme '{theme_key}' is archived")
    return {"template": key, "template_version": number, "theme": theme_key}


async def _free_slug(db: AsyncSession, base: str) -> str:
    return await templates_service._free_slug(db, base)


# Flows whose target kind takes a template and theme at the run: roadmaps (prd_to_roadmap)
# and, since C4 One New PRD door, PRDs (baseline_to_prd). The feedback loop refuses them.
TEMPLATED_KINDS = ("roadmap", "prd")


@dataclass
class _Inputs:
    document: str | None = None
    source: str | None = None
    source_version: int | None = None
    template: str | None = None
    theme: str | None = None


async def _resolve_inputs(
    db: AsyncSession, flow: flows.FlowDef, inputs: _Inputs
) -> tuple[uuid.UUID | None, dict[str, Any]]:
    """(target document id, the knobs Oracle sets) for a run's document, source and
    template choices."""
    if not flow.writes_document:
        named = (
            inputs.document,
            inputs.source,
            inputs.source_version,
            inputs.template,
            inputs.theme,
        )
        if any(v is not None for v in named):
            raise Invalid(f"the {flow.title} flow writes no document")
        return None, {}
    if flow.target_kind not in TEMPLATED_KINDS and (inputs.template or inputs.theme):
        raise Invalid(f"the {flow.title} flow takes no template or theme")
    source = await _resolve_source(db, flow, inputs.source, inputs.source_version)
    if flow.stores_draft_items:
        # E1: the run's document is its source PRD; it writes no document of its own.
        if inputs.document is not None:
            raise Invalid(f"the {flow.title} flow writes no document")
        assert source is not None
        return source[0].id, {"source_version_id": str(source[1].id)}
    default_slug = None
    if source is not None and inputs.document is None:
        # "<prd>-roadmap": that roadmap's next version, or a new roadmap.
        base = f"{source[0].slug}-{flow.target_kind or 'roadmap'}"
        existing = await docs_service.find_document(db, base)
        default_slug = (
            base
            if existing is None or existing.kind == flow.target_kind
            else (await _free_slug(db, base))
        )
    document, new_slug = await _resolve_document(db, flow, inputs.document, default_slug)
    oracle: dict[str, Any] = {}
    if new_slug:
        oracle["document_slug"] = new_slug
    if source is not None:
        oracle["source_version_id"] = str(source[1].id)
    if flow.target_kind in TEMPLATED_KINDS:
        oracle.update(
            await _resolve_template(db, flow.target_kind, inputs.template, inputs.theme, document)
        )
    return (document.id if document else None), oracle


def _resolve_knobs(flow: flows.FlowDef, knobs: KnobsIn) -> flows.Knobs:
    try:
        return flows.resolve_knobs(flow, knobs.model_dump())
    except flows.KnobError as exc:
        raise Invalid(str(exc)) from exc


async def _reset_segments(db: AsyncSession, run: Run, flow: flows.FlowDef) -> None:
    for s in await _segments(db, run.id):
        await db.delete(s)
    await db.flush()
    for i, sdef in enumerate(flow.segments, start=1):
        db.add(RunSegment(run_id=run.id, seq=i, name=sdef.name, status="pending"))
    run.estimate_usd = None


# A baseline build in these states is under way: another is refused (B1), as two would
# race on the same (type, key) items and double the proposals.
BUILD_UNDER_WAY = ("awaiting_approval", "running", "awaiting_checkpoint", "paused_overrun")


async def _one_build_at_a_time(db: AsyncSession, flow: flows.FlowDef) -> None:
    """Refuse a second Build the baseline run while one is under way (409)."""
    if flow.key != "baseline":
        return
    under_way = await db.scalar(
        select(Run.id)
        .where(Run.flow == flow.key, Run.status.in_(BUILD_UNDER_WAY))
        .order_by(Run.created_at)
        .limit(1)
    )
    if under_way is not None:
        raise RunError(f"A baseline build is already under way (run {under_way})")


class NotReusable(RunError):
    """409 ``baseline_not_reusable``: the current baseline may not be reused (C4)."""

    def __init__(self, reason: str | None) -> None:
        super().__init__(f"the current baseline is not reusable ({reason})")
        self.detail = {"code": "baseline_not_reusable", "reason": reason}


async def _reuse_knob(db: AsyncSession, flow: flows.FlowDef) -> dict[str, Any]:
    """The ``reuse_baseline`` knob for a run asking to reuse the current baseline: the
    review it reuses. 422 off Baseline to PRD; 409 when not reusable."""
    if flow.key != "baseline_to_prd":
        raise Invalid(f"the {flow.title} flow does not reuse the baseline")
    st = await reuse.review_status(db)
    if not st.reusable:
        raise NotReusable(st.reason)
    return st.knob()


async def _recheck_reuse(db: AsyncSession, run: Run) -> None:
    """A run reusing the baseline: still reusable (else 409, nothing changed); the knob
    follows the current review."""
    if not (run.knobs or {}).get("reuse_baseline"):
        return
    _set_knob(run, "reuse_baseline", await _reuse_knob(db, _flow(run)))


async def create_run(
    db: AsyncSession,
    principal: Principal | str,
    body: RunCreate,
    *,
    entry_knobs: dict[str, Any] | None = None,
    oracle_knobs: dict[str, Any] | None = None,
    commit: bool = True,
    created_by: uuid.UUID | None = None,
) -> uuid.UUID:
    """A draft run. A flow with an ``entry`` route is created only through it, which
    passes ``entry_knobs`` (what the run builds, e.g. its spec request) and commits.
    ``oracle_knobs``: knobs Oracle sets (``ORACLE_KNOBS``), e.g. the intake a run starts
    from; ``commit=False`` leaves the commit to the caller. ``principal`` an actor string
    (``audit.ORACLE``): a run Oracle starts on its own (the daily request triage), created
    for the member ``created_by`` it acts as (its run token acts for them)."""
    flow = flows.FLOWS[body.flow]
    if flow.entry and entry_knobs is None:
        raise Invalid(f"start a {flow.title} run from {flow.entry}")
    if flow.key == "launch_kit" and not (oracle_knobs or {}).get("launch_id"):
        raise Invalid(
            "the Launch kit flow starts from a launch: open it on Roadmap › Launches and "
            "choose Draft with Oracle"
        )
    if flow.key == "update_draft" and not has_role(principal.role, "owner"):
        # H8: the CEO decides what is said to the board and investors.
        raise Forbidden("Only an owner can draft an update")
    if flow.key == "pricing_memo" and await autonomy.level(db, "pricing_input") == "observe":
        # H9 / H11: at Observe Oracle keeps the evidence and writes no memo.
        raise RunError("Oracle writes no pricing memo at Observe")
    knobs = _resolve_knobs(flow, body.knobs)
    await _one_build_at_a_time(db, flow)
    document_id, oracle = await _resolve_inputs(
        db,
        flow,
        _Inputs(body.document, body.source, body.source_version, body.template, body.theme),
    )
    if document_id is not None:
        # H11: at Observe Oracle drafts no strategy, vision, nor update for people outside.
        from oracle import autonomy_drafts

        kind = await db.scalar(select(Document.kind).where(Document.id == document_id))
        if refusal := await autonomy_drafts.run_refusal(db, flow.key, kind):
            raise RunError(refusal)
    if flow.key == "update_draft" and "depth" not in body.knobs.model_fields_set:
        # H8: an investor update is quick by default ($4.50); a board update standard.
        template = (
            await db.scalar(select(Document.template).where(Document.id == document_id))
            if document_id is not None
            else None
        )
        depth = "standard" if template == "board-product" else "quick"
        knobs = _resolve_knobs(flow, body.knobs.model_copy(update={"depth": depth}))
    extra = {k: v for k, v in (oracle_knobs or {}).items() if k in ORACLE_KNOBS}
    extra.pop("reuse_baseline", None)
    if body.knobs.reuse_baseline:
        extra["reuse_baseline"] = await _reuse_knob(db, flow)
    extra.pop("target_goals", None)
    if goals := await _target_goals(db, flow, body.knobs.goals):
        extra["target_goals"] = goals
    extra.pop("reuse_draft_items", None)
    extra.pop("draft_items_reused", None)
    if body.knobs.reuse_draft_items is False and flow.key == REUSES_DRAFT_ITEMS:
        extra["reuse_draft_items"] = False
    if body.strategy_brief is not None:
        if flow.key != "strategy_draft":
            raise Invalid("only a Vision or strategy draft run takes a brief")
        from oracle.strategy import brief as strategy_brief

        try:
            extra["strategy_brief"] = await strategy_brief.resolve(
                db, document_id, body.strategy_brief
            )
        except ValueError as exc:
            raise Invalid(str(exc)) from exc
    run = Run(
        flow=flow.key,
        status="draft",
        knobs={**knobs.as_json(), **oracle, **extra, **(entry_knobs or {})},
        document_id=document_id,
        created_by=principal.id if isinstance(principal, Principal) else created_by,
    )
    db.add(run)
    await db.flush()
    await _reset_segments(db, run, flow)
    details: dict[str, Any] = {"flow": flow.key}
    if oracle.get("source_version_id"):
        details["source_version_id"] = oracle["source_version_id"]
    if extra.get("intake_id"):
        details["intake_id"] = extra["intake_id"]
    await audit.record(db, principal, "run.created", "run", run.id, details)
    if commit:
        await db.commit()
    return run.id


async def _target_goals(
    db: AsyncSession, flow: flows.FlowDef, refs: list[str] | None
) -> list[dict[str, str]]:
    """The ``target_goals`` knob (#260): each named goal (key or id), confirmed, once, in
    the order named. Only a Baseline to PRD run names goals."""
    if not refs:
        return []
    if flow.key != "baseline_to_prd":
        raise Invalid("only a Baseline to PRD run names the goals it serves")
    refs = list(dict.fromkeys(r.strip() for r in refs))
    ids = [uuid.UUID(r) for r in refs if is_uuid(r)]
    rows = (
        await db.scalars(
            select(Entity).where(
                Entity.type == "goal",
                Entity.status == "confirmed",
                or_(Entity.key.in_(refs), Entity.id.in_(ids)),
            )
        )
    ).all()
    found = {e.key: e for e in rows} | {str(e.id): e for e in rows}
    missing = [r for r in refs if r not in found]
    if missing:
        raise Invalid(f"not a confirmed goal: {', '.join(missing)}")
    goals = list({found[r].id: found[r] for r in refs}.values())
    return [{"id": str(g.id), "key": g.key, "title": g.title} for g in goals]


async def _current_inputs(db: AsyncSession, run: Run) -> _Inputs:
    knobs = run.knobs or {}
    source = number = None
    source_id = _source_id(run)
    if source_id:
        version = await db.get(DocumentVersion, source_id)
        if version is not None:
            source, number = str(version.document_id), version.number
    return _Inputs(
        document=str(run.document_id) if run.document_id else knobs.get("document_slug"),
        source=source,
        source_version=number,
        template=knobs.get("template"),
        theme=knobs.get("theme"),
    )


async def update_run(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, body: RunPatch
) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError("only a draft run can be changed")
    flow = _flow(run)
    oracle = {k: run.knobs[k] for k in ORACLE_KNOBS if k in (run.knobs or {})}
    stored = {k: v for k, v in run.knobs.items() if k not in ORACLE_KNOBS}
    if body.knobs is not None:
        stored = _resolve_knobs(flow, body.knobs).as_json()
    changed = body.model_fields_set & {"document", "source", "source_version", "template", "theme"}
    if flow.entry and any(getattr(body, k) is not None for k in changed):
        raise Invalid(f"a {flow.title} run's document and source come from {flow.entry}")
    if any(getattr(body, k) is not None for k in changed):
        current = await _current_inputs(db, run)
        if body.source is not None:
            # Another PRD: its latest approved version unless one is named.
            current.source, current.source_version = body.source, None
        for k in ("document", "source_version", "template", "theme"):
            if getattr(body, k) is not None:
                setattr(current, k, getattr(body, k))
        intake = {
            k: v
            for k, v in oracle.items()
            if k.startswith("intake_")
            or k in ("reuse_baseline", "target_goals", "reuse_draft_items")
        }
        run.document_id, oracle = await _resolve_inputs(db, flow, current)
        oracle.update(intake)
    if body.knobs is not None and body.knobs.reuse_baseline is not None:
        oracle.pop("reuse_baseline", None)
        if body.knobs.reuse_baseline:
            oracle["reuse_baseline"] = await _reuse_knob(db, flow)
    if body.knobs is not None and body.knobs.goals is not None:
        oracle.pop("target_goals", None)
        if goals := await _target_goals(db, flow, body.knobs.goals):
            oracle["target_goals"] = goals
    # E1 part B: what the run reuses is decided again by its next estimate.
    oracle.pop("draft_items_reused", None)
    if body.knobs is not None and body.knobs.reuse_draft_items is not None:
        oracle.pop("reuse_draft_items", None)
        if body.knobs.reuse_draft_items is False and flow.key == REUSES_DRAFT_ITEMS:
            oracle["reuse_draft_items"] = False
    run.knobs = {**stored, **oracle}
    await _reset_segments(db, run, flow)
    await audit.record(db, principal, "run.updated", "run", run.id, {})
    await db.commit()


async def estimate(db: AsyncSession, principal: Principal | str, run_id: uuid.UUID) -> EstimateOut:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError("only a draft run can be estimated")
    await _recheck_reuse(db, run)
    flow, knobs = _flow(run), _knobs(run)
    reused = (run.knobs or {}).get("reuse_baseline")
    items_reused = await _draft_items_to_reuse(db, run)
    _set_knob(run, "draft_items_reused", items_reused)
    zone = (
        await company_time.company_time_zone(db)
        if reused or items_reused
        else company_time.DEFAULT_ZONE
    )
    segments = {s.name: s for s in await _segments(db, run.id)}
    rows = []
    for i, sdef in enumerate(flow.segments, start=1):
        amount = flows.segment_estimate(sdef, knobs)
        skip = bool(reused) and sdef.name == "baseline"
        off = _skipped_off(sdef, knobs)
        skip_items = items_reused is not None and sdef.name == "roadmap_items"
        if skip or off or skip_items:
            amount = Decimal("0.00")
        segments[sdef.name].estimate_usd = amount
        note = None
        if skip:
            note = f"Current baseline, approved {reuse.short_date(reused['approved_at'], zone)}"
        elif items_reused is not None and skip_items:
            note = _items_reused_note(items_reused, zone)
        elif off:
            note = OFF_NOTE
        rows.append(
            SegmentEstimate(
                seq=i,
                name=sdef.name,
                title=sdef.title,
                roles=knobs.roles[sdef.name],
                estimate_usd=float(amount),
                reused=skip or skip_items,
                reused_from_version=items_reused["version"]
                if items_reused is not None and skip_items
                else None,
                note=note,
            )
        )
    total = sum((Decimal(str(r.estimate_usd)) for r in rows), Decimal(0))
    run.estimate_usd = total
    await audit.record(db, principal, "run.estimated", "run", run.id, {"usd": str(total)})
    await db.commit()
    return EstimateOut(
        run_id=run.id,
        depth=knobs.depth,  # type: ignore[arg-type]
        total_usd=float(total),
        segments=rows,
        approval_threshold_usd=float(flows.APPROVAL_THRESHOLD_USD),
        needs_approval=total > flows.APPROVAL_THRESHOLD_USD,
        budget_usd=_usd(knobs.budget_usd),
        within_budget=knobs.budget_usd is None or total <= knobs.budget_usd,
    )


# --------------------------------------------------------------------------- start


async def start(db: AsyncSession, principal: Principal | str, run_id: uuid.UUID) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "draft":
        raise RunError(f"run is {run.status}, not a draft")
    if run.estimate_usd is None:
        raise RunError("estimate the run first: press Estimate, then Start run")
    await _recheck_reuse(db, run)
    await _recheck_draft_items(db, run)
    await _one_build_at_a_time(db, _flow(run))
    knobs = _knobs(run)
    source_id = _source_id(run)
    if source_id is not None and await db.get(DocumentVersion, source_id) is None:
        raise Invalid("the PRD version this roadmap is built from no longer exists")
    # A run started from an intake (C5): a draft waits at the draft gate, and it reads
    # the intake's answers given before now, whichever segment asks.
    from oracle.intake import drafting

    pinned = await drafting.on_start(db, run, principal)
    if knobs.budget_usd is not None and run.estimate_usd > knobs.budget_usd:
        raise Invalid(
            f"the estimate (${run.estimate_usd:.2f}) is over the budget "
            f"(${knobs.budget_usd:.2f}): lower the depth or roles, or raise the budget"
        )
    # The sources the run reads are pinned now, for the user who created it; a run
    # started from an intake reads the snapshot the intake pinned (S4).
    snapshot = await _intake_snapshot(db, run)
    if snapshot is None:
        snapshot = Snapshot(
            label=f"Run {str(run.id)[:8]} ({_flow(run).title})",
            as_of=_now(),
            created_by=run.created_by,
        )
        db.add(snapshot)
        await db.flush()
    run.snapshot_id = snapshot.id
    for key, value in (pinned or {}).items():
        _set_knob(run, key, value)
    # #541 part 5: a draft run of a company-wide document reads as a member.
    await _decide_member_view(db, run)
    if any(flows.BRIEFS_FILE in s.outputs for s in _flow(run).segments):
        # F5-2: the shared code maps the run's briefs cite, recorded now (S6: a map made
        # private later stops new uses; this run keeps what it read).
        from oracle.engineering import codemaps

        used = await codemaps.for_run(db)
        if used:
            _set_knob(run, "code_maps", used)
    if source_id is not None:
        # Every segment, attempt and change request of the run reads these (A1).
        _set_knob(run, "planning_horizons", await company_horizons(db))
    if run.estimate_usd > flows.APPROVAL_THRESHOLD_USD:
        run.status = "awaiting_approval"
        await audit.record(
            db, principal, "run.awaiting_approval", "run", run.id, {"usd": str(run.estimate_usd)}
        )
        await webhooks.capture(db, "run.awaiting_approval", principal, run_id=run.id)
        await db.commit()
        return
    await audit.record(db, principal, "run.started", "run", run.id, {})
    await webhooks.capture(db, "run.started", principal, run_id=run.id)
    await _launch(db, run, principal)
    await db.commit()  # the router submits it (submit_queued), outside the gate


async def _intake_snapshot(db: AsyncSession, run: Run) -> Snapshot | None:
    raw = (run.knobs or {}).get("intake_snapshot_id")
    if not raw:
        return None
    try:
        return await db.get(Snapshot, uuid.UUID(str(raw)))
    except ValueError:
        return None


async def approve(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "awaiting_approval":
        raise RunError(f"run is {run.status}, not awaiting approval")
    # A run reusing the baseline: still reusable now (else 409, nothing changed, C4).
    await _recheck_reuse(db, run)
    await _recheck_draft_items(db, run)
    run.approved_by = principal.id
    run.approved_at = _now()
    await audit.record(db, principal, "run.approved", "run", run.id, {"usd": str(run.estimate_usd)})
    await webhooks.capture(db, "run.started", principal, run_id=run.id)
    await _launch(db, run, principal)
    await db.commit()  # the router submits it (submit_queued), outside the gate


async def _launch(db: AsyncSession, run: Run, principal: Principal | str | None = None) -> None:
    run.status = "running"
    run.started_at = _now()
    items_reused = (run.knobs or {}).get("draft_items_reused")
    base = run.estimate_usd
    if items_reused:
        # E1 part B: the ceiling counts the reused items step at its nominal cost, so a
        # send-back that derives the items again (a paid step) does not pause the run.
        base += flows.segment_estimate(_flow(run).segment("roadmap_items"), _knobs(run))
    ceiling = (base * flows.OVERRUN_FACTOR).quantize(Decimal("0.0001"))
    _set_knob(run, "spend_ceiling_usd", str(ceiling))
    segments = await _segments(db, run.id)
    knobs = _knobs(run)
    for s in segments:
        if _skipped_off(_flow(run).segment(s.name), knobs):
            _skip_off(s)
    first = segments[0]
    reused = (run.knobs or {}).get("reuse_baseline")
    if reused and first.name == "baseline" and len(segments) > 1:
        await _skip_reused_baseline(db, run, first, reused, principal)
        first = segments[1]
    if items_reused and first.name == "roadmap_items":
        try:
            if await _reuse_draft_items(db, run, first, segments, items_reused, principal):
                return
        except safe_yaml.ParseBusy:
            # No free worker for the items check: the segment stays succeeded with its
            # advance "opening", and the next tick advances it again (_resume_advance).
            log.warning("run %s: the reused items wait for a parse worker", run.id)
            return
    # Workflow mode covers the segments from ``first`` on: no baseline step is submitted.
    await _submit(db, run, first, segments)


def _skip_off(segment: RunSegment) -> None:
    """F4: the segment's stop is off, so nothing of it runs (recorded skipped at no cost)."""
    art = _art(segment)
    art["note"] = OFF_NOTE
    _set_art(segment, art)
    segment.status = "skipped"
    segment.estimate_usd = Decimal("0.00")
    segment.cost_usd = Decimal("0")
    segment.finished_at = _now()
    segment.error = None


# E1 part B (decided 2026-10-21, "Reuse items"): the flow whose items step reuses the
# approved source version's draft items.
REUSES_DRAFT_ITEMS = "prd_to_roadmap"


async def _draft_items_to_reuse(db: AsyncSession, run: Run) -> dict[str, Any] | None:
    """The ``draft_items_reused`` knob of a Build roadmap run: the source version's draft
    items when they may be reused and the run does not derive them again; else None."""
    if run.flow != REUSES_DRAFT_ITEMS or (run.knobs or {}).get("reuse_draft_items") is False:
        return None
    source_id = _source_id(run)
    if source_id is None:
        return None
    from oracle.roadmap import draft_items

    found = await draft_items.reusable(db, source_id)
    version = await db.get(DocumentVersion, source_id)
    if found is None or version is None:
        return None
    row = found[0]
    return {
        "draft_roadmap_id": str(row.id),
        "version": version.number,
        "ready_at": row.ready_at.isoformat() if row.ready_at else None,
    }


def _items_reused_note(knob: dict[str, Any], zone: str) -> str:
    """'Reused: the roadmap items of v3, derived 20 Oct', the Company time zone's day."""
    note = f"Reused: the roadmap items of v{knob['version']}"
    if knob.get("ready_at"):
        note += f", derived {company_time.day_first_in_words(knob['ready_at'], zone)}"
    return note


async def _recheck_draft_items(db: AsyncSession, run: Run) -> None:
    """A run estimated with reused draft items: still the same items (else 409, nothing
    changed): a Derive again or a new derivation since makes the estimate stale."""
    knob = (run.knobs or {}).get("draft_items_reused")
    if knob and await _draft_items_to_reuse(db, run) != knob:
        raise RunError(
            "the PRD version's draft roadmap items changed since the estimate: "
            "estimate the run again"
        )


async def _reuse_draft_items(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    knob: dict[str, Any],
    principal: Principal | str | None,
) -> bool:
    """E1 part B: the run's roadmap_items segment reuses the source version's draft items.
    Their roadmap_items.yaml is written from the stored rows, the segment succeeds at no
    cost with nothing submitted, and it is advanced: its stop opens on those items (or,
    with the stop off, the roadmap draft is queued). False when they are gone."""
    from oracle.roadmap import draft_items

    source_id = _source_id(run)
    found = await draft_items.reusable(db, source_id) if source_id else None
    version = await db.get(DocumentVersion, source_id) if source_id else None
    prd = await db.get(Document, version.document_id) if version is not None else None
    if found is None or version is None or prd is None:
        return False
    row, rows = found
    now = _now()
    note = _items_reused_note(knob, await company_time.company_time_zone(db))
    art = _art(segment)
    art["files"] = {ITEMS_FILE: draft_items.items_yaml(prd.slug, version.number, rows)}
    art["attempts"].append(
        {
            "attempt": len(art["attempts"]) + 1,
            "workflow_id": None,
            "submitted_at": now.isoformat(),
            "cost_usd": 0,
            "note": None,
            "state": "succeeded",
        }
    )
    art["reused_items"] = knob
    art["note"] = note
    # Until it is advanced: a busy parse pool stops the advance, and the tick resumes it.
    art["attempts"][-1]["advanced"] = "opening"
    _set_art(segment, art)
    segment.status = "succeeded"
    segment.estimate_usd = Decimal("0.00")
    segment.cost_usd = Decimal("0")
    segment.started_at = segment.started_at or now
    segment.finished_at = now
    segment.error = None
    await audit.record(
        db,
        principal if principal is not None else audit.ORACLE,
        "run.items_reused",
        "run",
        run.id,
        {"draft_roadmap_id": str(row.id), "version": version.number, "items": len(rows)},
    )
    await _advance(db, run, segment, segments)
    return True


async def _skip_reused_baseline(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    reused: dict[str, Any],
    principal: Principal | str | None,
) -> None:
    """C4: the run uses the current baseline. Its baseline segment is recorded skipped at
    no cost and its Confirm the baseline stop skipped; nothing runs for them."""
    zone = await company_time.company_time_zone(db)
    note = f"Reused the baseline approved {reuse.short_date(reused['approved_at'], zone)}"
    now = _now()
    art = _art(segment)
    art["reused"] = reused
    art["note"] = note
    _set_art(segment, art)
    segment.status = "skipped"
    segment.estimate_usd = Decimal("0.00")
    segment.cost_usd = Decimal("0")
    segment.finished_at = now
    segment.error = None
    db.add(
        Checkpoint(
            run_id=run.id,
            kind="baseline_confirm",
            status="skipped",
            approver_role=_flow(run).segment(segment.name).approver_role,
            note=note,
            payload={
                "segment_seq": segment.seq,
                "segment": segment.name,
                "reused_checkpoint_id": reused.get("checkpoint_id"),
            },
            decided_at=now,
        )
    )
    await audit.record(
        db,
        principal if principal is not None else audit.ORACLE,
        "run.baseline_reused",
        "run",
        run.id,
        {"checkpoint_id": reused.get("checkpoint_id"), "approved_at": reused.get("approved_at")},
    )


# --------------------------------------------------------------------------- segments


async def _low_threshold(db: AsyncSession) -> float:
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == "confidence_weights"))
    overrides = row.value if row is not None and isinstance(row.value, dict) else None
    return float(confidence.merged(overrides)["low"])


# D12: the knobs that name what Build next draft sent a feedback loop.
SENT_KNOBS = ("feedback_ids", "suggestion_ids", "next_draft_change_ids")


def sent_items(run: Run) -> bool:
    """D12: the run was started from Build next draft, so it was given exactly the items
    in its knobs (one missing names none), not every open item."""
    return any(k in (run.knobs or {}) for k in SENT_KNOBS)


async def _loop_feedback(db: AsyncSession, run: Run) -> list[dict[str, Any]]:
    """D12: the items a feedback loop started from Build next draft was given: the
    feedback staged for the agents and each accepted section-text change, with its text."""
    knobs = run.knobs or {}
    fids = [uuid.UUID(str(i)) for i in knobs.get("feedback_ids") or []]
    sids = [uuid.UUID(str(i)) for i in knobs.get("suggestion_ids") or []]
    texts: dict[uuid.UUID, str] = {}
    for sug in await db.scalars(
        select(LlmSuggestion).where(
            LlmSuggestion.id.in_(sids), LlmSuggestion.document_id == run.document_id
        )
    ):
        texts[sug.feedback_item_id] = sug.edited_text or sug.text or ""
    items = await db.scalars(
        select(FeedbackItem)
        .where(
            FeedbackItem.document_id == run.document_id,
            FeedbackItem.id.in_([*fids, *texts]),
        )
        .order_by(FeedbackItem.created_at, FeedbackItem.id)
    )
    return [
        {
            "id": str(f.id),
            "section_key": f.section_key,
            "summary": f.summary,
            **({"accepted_text": texts[f.id]} if f.id in texts else {}),
        }
        for f in items
    ]


async def _imported_numbers(db: AsyncSession, run: Run) -> set[int]:
    """The version numbers this run's drafts were imported as, any attempt (each attempt's
    import is on its checkpoint's payload, the current one on its segment)."""
    segments = await db.scalars(select(RunSegment).where(RunSegment.run_id == run.id))
    checkpoints = await db.scalars(select(Checkpoint).where(Checkpoint.run_id == run.id))
    imports = [(s.artifacts or {}).get("import") for s in segments]
    imports += [(c.payload or {}).get("import") for c in checkpoints]
    return {
        int(imp["version"])
        for imp in imports
        if isinstance(imp, dict) and imp.get("version") is not None and not imp.get("error")
    }


async def _loop_section_changes(db: AsyncSession, run: Run) -> list[dict[str, Any]]:
    """G4: the section changes staged from discussions that a feedback loop started from
    Build next draft was given, oldest first: still staged, or applied in a draft this run
    imported (a later attempt keeps them); never one another build applied."""
    from oracle.staging.models import NextDraftChange

    ids = [uuid.UUID(str(i)) for i in (run.knobs or {}).get("next_draft_change_ids") or []]
    if not ids:
        return []
    mine = await _imported_numbers(db, run)
    rows = await db.scalars(
        select(NextDraftChange)
        .where(
            NextDraftChange.id.in_(ids),
            NextDraftChange.document_id == run.document_id,
            or_(
                NextDraftChange.status == "staged",
                and_(
                    NextDraftChange.status == "applied",
                    NextDraftChange.applied_in_version.in_(mine),
                ),
            ),
        )
        .order_by(NextDraftChange.created_at, NextDraftChange.id)
    )
    return [
        {
            "id": str(r.id),
            "section_key": r.section_key,
            "instruction": r.instruction,
            "reason": r.reason,
            **({"text": r.text} if r.text else {}),
        }
        for r in rows
    ]


async def _prompt_context(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    attempt: int,
    change_request: str | None,
    runtime: AgentRuntime,
    *,
    attached: bool = False,
    planned: list[tuple[int, str, list[str]]] | None = None,
) -> flows.PromptContext:
    """``attached``: the run token reaches the agents, so earlier outputs are named, not
    pasted; ``planned``: earlier segments of the same workflow and the files they write."""
    knobs = _knobs(run)
    snapshot = await db.get(Snapshot, run.snapshot_id) if run.snapshot_id else None
    document = None
    doc = await db.get(Document, run.document_id) if run.document_id else None
    if doc is not None:
        document = doc.slug
    document = document or run.knobs.get("document_slug")
    kind = await _target_kind(db, run)
    source = await _source_context(db, run) if _flow(run).source_prompt else None
    draft_ctx = None
    # A roadmap draft is built from its source PRD (as before C4); a PRD draft from the
    # baseline, with the template picked at New PRD.
    if (
        _flow(run).segment(segment.name).imports_draft
        and run.knobs.get("template")
        and (source is not None or kind != "roadmap")
    ):
        if doc is not None:
            title = doc.title
        elif source is not None:
            title = f"{source.title} {flows.KIND_NAMES[kind]}"
        else:
            title = await _intake_title(db, run) or (document or "")
        draft_ctx = await _draft_context(db, run, kind, document or "", title)
    prior: dict[str, str] = {}
    prior_files: list[tuple[int, str, list[str]]] = []
    in_workflow = {seq for seq, _, _ in planned or []}
    for s in segments:
        if s.seq < segment.seq and s.seq not in in_workflow:
            files = (s.artifacts or {}).get("files") or {}
            for name, content in files.items():
                prior[name] = content
            if files:
                prior_files.append((s.seq, _flow(run).segment(s.name).title, sorted(files)))
    prior_files += list(planned or [])
    # A person sent the segment back (D5): it starts from its previous files and the
    # problems Oracle's check found in them. A runtime retry has no change request.
    previous = (segment.artifacts or {}).get("previous") if change_request else None
    previous_attempt: int | None = None
    previous_files: dict[str, str] = {}
    previous_problems: list[str] = []
    if attempt > 1 and isinstance(previous, dict) and int(previous.get("attempt") or 0) < attempt:
        previous_attempt = int(previous["attempt"])
        previous_files = dict(previous.get("files") or {})
        previous_problems = workflow.check_problems(
            ITEMS_FILE, previous.get("items_check"), []
        ) + workflow.check_problems(
            flows.draft_file(kind), None, list(previous.get("import_problems") or [])
        )
    # #562 review: a person's words that name something a commenter may not see stay out
    # of a member-view run's prompt (reviewer notes, the change request, the Regenerate
    # note; discussions: oracle.discussions.agent_view.for_member_run).
    hidden = await member_hidden(db, run)
    notes = [
        f"{c.kind}: {c.note}"
        for c in await _checkpoints(db, [run.id])
        if c.status == "approved" and c.note and not (hidden and hidden.names(c.note))
    ]
    if change_request and hidden and hidden.names(change_request):
        change_request = WITHHELD_NOTE
    feedback: list[dict[str, Any]] = []
    locked: list[str] = []
    section_changes: list[dict[str, Any]] = []
    chosen = sent_items(run)
    if run.flow == "feedback_loop" and run.document_id:
        feedback = await _loop_feedback(db, run) if chosen else []
        section_changes = await _loop_section_changes(db, run) if chosen else []
        if not chosen:
            items = await db.scalars(
                select(FeedbackItem)
                .where(FeedbackItem.document_id == run.document_id, FeedbackItem.status == "open")
                .order_by(FeedbackItem.created_at, FeedbackItem.id)
            )
            feedback = [
                {"id": str(f.id), "section_key": f.section_key, "summary": f.summary} for f in items
            ]
        latest = await db.scalar(
            select(DocumentVersion)
            .where(DocumentVersion.document_id == run.document_id)
            .order_by(DocumentVersion.number.desc())
            .limit(1)
        )
        if latest is not None:
            locked = sorted(await locked_section_keys(db, latest.id))
    from oracle.discussions import agent_view

    # G5: what people discussed about the run, as its agents see it.
    discussions = await agent_view.for_prompt(db, run)
    scope_yaml = None
    if not attached and "get_prd_scope" in _flow(run).segment(segment.name).tools:
        scope = await feature_set.approved_scope(db, run_id=run.id, document_id=run.document_id)
        if scope is not None:
            scope_rows = await feature_set.scope_items(db, scope.id)
            scope_yaml = await feature_set.scope_yaml_async(scope, scope_rows)
    return flows.PromptContext(
        run_id=str(run.id),
        document=document,
        snapshot_as_of=snapshot.as_of.isoformat() if snapshot else None,
        low_confidence=await _low_threshold(db),
        depth=knobs.depth,
        prior_outputs=prior,
        reviewer_notes=notes,
        feedback=feedback,
        staged=chosen,
        section_changes=section_changes,
        locked_sections=locked,
        attempt=attempt,
        change_request=change_request,
        previous_attempt=previous_attempt,
        previous_seq=segment.seq if previous_attempt is not None else None,
        previous_files=previous_files,
        previous_problems=previous_problems,
        # SwarmCloud reaches Oracle only through the credential it attaches; the local
        # runtime's agents are Oracle's own.
        mcp_reachable=attached or (runtime.can_reach_oracle and runtime.name != "swarmcloud"),
        mcp_attached=attached,
        prior_files=prior_files,
        kind=kind,
        source=source,
        draft=draft_ctx,
        extra_lines=[
            *await extensions.prompt_lines(db, run),
            *await eng_check.prompt_lines(db, run.id, segment.name),
            *await eng_dates.prompt_lines(db, run, segment.name),
            *_regenerate_note(run, hidden),
        ],
        intake_id=run.knobs.get("intake_id"),
        intake_gap_ids=list(run.knobs.get("intake_gap_ids") or []),
        scope_yaml=scope_yaml,
        launch_id=run.knobs.get("launch_id"),
        target_goals=[(g["key"], g["title"]) for g in run.knobs.get("target_goals") or []],
        discussions=discussions,
        baseline_reused=reuse.short_date(
            reused["approved_at"], await company_time.company_time_zone(db)
        )
        if (reused := run.knobs.get("reuse_baseline")) and segment.name != "baseline"
        else None,
    )


# #562 review: what a member-view run's prompt says instead of a person's note that names
# something a commenter may not see.
WITHHELD_NOTE = (
    "A person's note names something only owners and approvers may see, so it is not shown here."
)


def _regenerate_note(run: Run, hidden: visibility.Hidden | None = None) -> list[str]:
    """#482: the note given with Regenerate, for every step of the run it started (none
    when it names something ``hidden``)."""
    note = (run.knobs or {}).get("regenerate_note")
    if not note or (hidden is not None and hidden.names(note)):
        return []
    return [
        "This run regenerates the document as its next version. The note given with "
        "Regenerate (a person's words: follow them where they fit the task above):",
        f"- {note}",
    ]


async def _target_kind(db: AsyncSession, run: Run) -> str:
    """The kind of the document the run writes: the flow's, else the document's."""
    flow = _flow(run)
    if flow.target_kind:
        return flow.target_kind
    if run.document_id:
        kind = await db.scalar(select(Document.kind).where(Document.id == run.document_id))
        if kind:
            return kind
    return "prd"


def _explain(feature: dict[str, Any]) -> str:
    explanation = feature.get("explanation") or {}
    parts = [explanation.get("formula") or ""]
    parts += list(explanation.get("steps") or [])[:3]
    parts += list(explanation.get("order") or [])[:2]
    return " ".join(p for p in parts if p)[:400]


async def _run_horizons(db: AsyncSession, run: Run) -> dict[str, int]:
    """The planning horizons pinned when the run started (A1: runs under way keep what
    they started with); a run started before they were pinned reads the company's."""
    pinned = (run.knobs or {}).get("planning_horizons")
    if isinstance(pinned, dict):
        return dict(pinned)
    return await company_horizons(db)


async def _source_context(db: AsyncSession, run: Run) -> flows.SourceContext | None:
    """prd_to_roadmap: the approved PRD version, priorities, edges and goals."""
    source_id = _source_id(run)
    if source_id is None:
        return None
    version = await db.get(DocumentVersion, source_id)
    if version is None:
        return None
    document = await db.get(Document, version.document_id)
    sections = list(
        (
            await db.execute(
                select(Section.section_key, Section.heading)
                .where(Section.version_id == version.id)
                .order_by(Section.ordinal)
            )
        ).all()
    )
    # C8 rule 7: this PRD's approved order, else a person's company-wide snapshot (no
    # run), else the live goal-weighted ranking. A proposed or discarded order never counts.
    newest = PrioritySnapshot.created_at.desc()
    saved = select(PrioritySnapshot).where(PrioritySnapshot.status == "saved")
    stored = await db.scalar(
        saved.where(PrioritySnapshot.document_id == version.document_id).order_by(newest).limit(1)
    )
    if stored is not None:
        at = stored.decided_at or stored.created_at
        on = company_time.day_first_in_words(at, await company_time.company_time_zone(db))
        method = f"{stored.method}, this PRD's approved order of {on}"
        ranking = list(stored.ranking or [])
    elif (
        stored := await db.scalar(
            saved.where(PrioritySnapshot.run_id.is_(None)).order_by(newest).limit(1)
        )
    ) is not None:
        on = company_time.day(stored.created_at, await company_time.company_time_zone(db))
        method = f"{stored.method}, priority snapshot of {on.isoformat()}"
        ranking = list(stored.ranking or [])
    else:
        live = await priorities_service.compute(db, "goal_weighted")
        method = f"{live.method}, live ranking"
        ranking = [f.model_dump(mode="json") for f in live.features]
    priorities = [
        {
            "rank": f.get("rank"),
            "key": f.get("key"),
            "title": f.get("title"),
            "score": f.get("score"),
            "flags": f.get("flags") or [],
            "depends_on": f.get("depends_on") or [],
            "explanation": _explain(f),
        }
        for f in ranking
    ]
    shown = select(Entity).where(Entity.status != "rejected")
    if await reads_as_member(db, run):
        # #562 review: a member-view run's prompt has no hidden decision's entity, nor
        # (both ends must be shown) any edge to or from one.
        shown = shown.where(visibility.member_entity_visible(Entity))
    entities = {e.id: e for e in await db.scalars(shown)}
    edges = [
        {
            "src": f"{entities[e.src_id].type}:{entities[e.src_id].key}",
            "type": e.type,
            "dst": f"{entities[e.dst_id].type}:{entities[e.dst_id].key}",
        }
        for e in await db.scalars(
            select(Edge)
            .where(Edge.type.in_(("depends_on", "blocks")), Edge.status != "rejected")
            .order_by(Edge.created_at, Edge.id)
        )
        if e.src_id in entities and e.dst_id in entities
    ]
    goals = [
        {
            "key": e.key,
            "title": e.title,
            **{k: (e.attrs or {}).get(k) for k in ("metric", "target", "horizon")},
            # B5: the typed target in words ("at least 45% (...), short horizon").
            "target_words": target_words(e.attrs or {}),
        }
        for e in sorted(entities.values(), key=lambda e: e.key)
        if e.type == "goal" and e.status == "confirmed"
    ]
    bases = await schedule.verified_bases(db, version.document_id)
    if _flow(run).stores_draft_items:
        from oracle.roadmap import draft_items

        known_from, known = await draft_items.known_items(db, version)
    else:
        known_from, known = await _known_roadmap_items(db, run)
    return flows.SourceContext(
        approved=version.approved_at is not None or not _flow(run).stores_draft_items,
        known_items=known,
        known_from=known_from,
        horizons=await _run_horizons(db, run),
        schedule_bases=[b.as_json() for b in bases],
        slug=document.slug if document else str(version.document_id),
        title=document.title if document else "",
        version=version.number,
        markdown=version.markdown,
        sections=[(k, h) for k, h in sections],
        priorities=priorities,
        priority_method=method,
        edges=edges,
        goals=goals,
    )


async def _known_roadmap_items(db: AsyncSession, run: Run) -> tuple[str, list[dict[str, str]]]:
    """E3: the latest items of the roadmap a prd_to_roadmap run writes the next version
    of, so the agents keep their ids; none for a new roadmap."""
    doc = await db.get(Document, run.document_id) if run.document_id else None
    if doc is None and run.knobs.get("document_slug"):
        doc = await db.scalar(select(Document).where(Document.slug == run.knobs["document_slug"]))
    if doc is None or doc.kind != "roadmap":
        return "", []
    version = await items_version(db, doc)
    rows = await version_items(db, version)
    if not rows or version is None:
        return "", []
    known = [{"id": r.item_key, "title": r.title, "horizon": r.horizon} for r in rows]
    return f"roadmap v{version.number}", known


async def _intake_title(db: AsyncSession, run: Run) -> str | None:
    """The title of the intake a run started from (a new PRD takes it, C4)."""
    raw = run.knobs.get("intake_id")
    if not raw:
        return None
    from oracle.v2.models import ProductIntake

    try:
        intake = await db.get(ProductIntake, uuid.UUID(str(raw)))
    except ValueError:
        return None
    return intake.title if intake is not None else None


async def _draft_context(
    db: AsyncSession, run: Run, kind: str, slug: str, title: str
) -> flows.DraftContext | None:
    """The draft's template, theme and skeleton (the template's body as a first draft of
    this ``kind`` document, front matter included): a roadmap's (prd_to_roadmap) and a
    PRD's (baseline_to_prd, C4)."""
    key, number = run.knobs.get("template"), run.knobs.get("template_version")
    if not key or not number:
        return None
    body = await docs_service.template_body(db, key, str(number))
    if body is None:
        return None
    theme = run.knobs.get("theme")
    skeleton = templates_service.draft_skeleton(
        body,
        slug=slug,
        title=title,
        kind=kind,
        template=key,
        version=int(number),
        theme=theme,
    )
    return flows.DraftContext(
        kind=kind,
        slug=slug,
        template=key,
        template_version=int(number),
        theme=theme,
        skeleton=skeleton,
    )


# A segment a request queued for the runtime (a start, an approval, a resume, a checkpoint
# decision): the request commits under the review gate, then submits it outside the gate
# (:func:`submit_queued`). If that never happens, the tick submits it.
QUEUED = "waiting to be submitted to the agent runtime"
# How long one tick pass on one run may spend on its status and artifact reads: past it
# the pass gives up and the next tick tries again.
TICK_RUN_SECONDS = 60.0


@dataclass
class _Mode:
    """How a submission uses the runtime: the run token attached for the agents, and the
    rest of the run as one workflow with its checkpoints as waits for a person."""

    attach: bool
    waits: bool
    notes: list[str]


# Refusals at submit that a submission survives by dropping the feature they concern.
_DROP_WAITS = ("await_input_disabled",)
_DROP_MCP = (
    "mcp_unavailable",
    "mcp_server_profile_refused",
    "mcp_credential_missing",
    "mcp_credential_unexpected",
    "mcp_credential_shape",
)


async def _mode(runtime: AgentRuntime, url: str) -> _Mode:
    """Which v2 features this submission uses: the runtime's (cached) reading, and
    Oracle's MCP server registered once before the first credential is sent."""
    feats = await runtime.features()
    notes: list[str] = []
    registered = True
    # The run token is sent only once caller MCP is confirmed on. Reads are served while
    # the switch is off, so "unknown" is the usual first reading: registering confirms it
    # (SwarmCloud accepts the write only while caller MCP is on).
    if feats.mcp != "off":
        try:
            await runtime.ensure_mcp_server(url)
        except RuntimeUnavailable as exc:
            # Not registered at this URL (a failed PATCH may leave an old one): an earlier
            # "on" does not make it safe to send the token.
            registered = False
            if exc.code == "mcp_unavailable":
                notes.append(workflow.advice(exc.code, str(exc)))
            else:
                notes.append(
                    f"Oracle's MCP server could not be registered in SwarmCloud ({exc}): "
                    "agents run without it. An owner can retry with POST "
                    "/v1/runtime/mcp-server."
                )
        else:
            feats = await runtime.features()
    attach = feats.mcp == "on" and registered
    if not attach and not notes and feats.reasons.get("mcp"):
        notes.append(f"Agents run without Oracle's MCP server: {feats.reasons['mcp']}.")
    waits = attach and feats.await_input != "off" and feats.service_answer != "off"
    if not waits:
        why = None
        if feats.await_input == "off":
            why = feats.reasons.get("await_input")
        elif feats.service_answer == "off":
            why = feats.reasons.get("service_answer")
        elif feats.reasons and not attach:
            why = "a run is one workflow only while agents can read Oracle's MCP server"
        if why:
            notes.append(f"Checkpoints wait in Oracle's Inbox, one workflow per segment: {why}.")
        if attach:
            notes.append(workflow.SEGMENT_MODE_WITH_MCP)
    return _Mode(attach, waits, notes)


def _degrade(mode: _Mode, exc: RuntimeUnavailable) -> _Mode | None:
    """The mode to submit again with after a refusal, or None when none helps."""
    if exc.code in _DROP_WAITS and mode.waits:
        return _Mode(mode.attach, False, [*mode.notes, workflow.advice(exc.code, str(exc))])
    if exc.code in _DROP_MCP and mode.attach:
        return _Mode(False, False, [*mode.notes, workflow.advice(exc.code, str(exc))])
    return None


def _note(segment: RunSegment, note: str) -> None:
    art = _art(segment)
    _note_art(art, note)
    _set_art(segment, art)


def _note_art(art: dict[str, Any], note: str) -> None:
    if note not in art["notes"]:
        art["notes"].append(note)


def _live(run: Run) -> dict[str, Any] | None:
    """The run's workflow (adapter v2) that is still attached: Oracle drives it, or is
    cancelling it (``cancel_pending``) and still reads its cost."""
    wf = (run.knobs or {}).get("workflow")
    # A copy: the column is not mutation-tracked, so changes go back with _set_knob.
    return copy.deepcopy(wf) if isinstance(wf, dict) and wf.get("state") == "live" else None


def _drivable(run: Run) -> dict[str, Any] | None:
    """The live workflow, unless Oracle is cancelling it: nothing more runs in it."""
    wf = _live(run)
    return wf if wf is not None and not wf.get("cancel_pending") else None


def _cancel_pending(run: Run) -> bool:
    wf = _live(run)
    return wf is not None and bool(wf.get("cancel_pending"))


def _unconfirmed(what: str) -> "Unavailable":
    """The Inbox decision path when a cancel is not confirmed: nothing proceeds."""
    return Unavailable(
        f"SwarmCloud did not confirm cancelling the run's workflow (or Oracle could not read "
        f"its last cost), so Oracle did not {what} yet: the decision is recorded and Oracle "
        "goes on with it on its next tick, there is no need to decide again"
    )


def _shown(value: Any) -> str | None:
    """An upstream value as Oracle stores it: text, redacted, at most 200 characters."""
    return None if value in (None, "") else redact(str(value))[:200]


def _cause(exc: BaseException) -> str | None:
    """Why a call to SwarmCloud did not finish, in a few words for the run page and the
    Inbox: "SwarmCloud HTTP 503 unavailable" when SwarmCloud answered, else what failed
    ("cannot reach SwarmCloud ...", a timeout, the replay limit). Stored like
    :func:`_shown`."""
    cause = exc.cause if isinstance(exc, Unavailable) and exc.cause is not None else exc
    if isinstance(cause, RuntimeUnavailable) and cause.status is not None:
        code = f" {cause.code}" if cause.code else ""
        return _shown(f"SwarmCloud HTTP {cause.status}{code}")
    held = exc.held if isinstance(exc, Unavailable) else None
    if held is not None and cause is exc:
        # A cancel the decision needs, not confirmed (_unconfirmed): its own marker's why.
        why = (held.get("cancel_pending") or {}).get("error")
        return _shown(f"cancelling the run's workflow is not confirmed: {why or 'no answer'}")
    return _shown(cause)


def _clip(text: str, limit: int = 200) -> str:
    """For a note or a log line only: what goes to the agents is never clipped."""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _set_wait(cp: Checkpoint, wait: dict[str, Any]) -> None:
    """The checkpoint's wait, as a copy: the column is not mutation-tracked, so a dict
    changed after an autoflush must not be the one already flushed."""
    cp.payload = {**copy.deepcopy(cp.payload or {}), "wait": copy.deepcopy(wait)}


def _parse_at(value: Any) -> datetime | None:
    try:
        at = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    return at if at.tzinfo is not None else at.replace(tzinfo=UTC)


# A lost submission is looked up on every tick; past either cap without an answer either
# way (SwarmCloud's listing neither shows it nor reaches a task older than it), the run
# shows in the Inbox with Retry and Cancel.
LOST_LOOKUP_SECONDS = 30 * 60
LOST_LOOKUP_TRIES = 30
_STUCK = (
    "Oracle cannot tell whether SwarmCloud created it: in the Inbox, Retry submits the "
    "segment again (if the lost one landed, it may run too, without Oracle's data, until "
    "Oracle finds it, cancels it and counts its cost) or Cancel ends the run"
)
# A 404 that is not SwarmCloud's not_found envelope (a bare one, or another reason)
# proves nothing and is tried again; past this many on a cancel or an answer post, the
# run shows in the Inbox with Cancel.
NOT_FOUND_TRIES = 5
# A submission given up on (Retry, or Cancel past the lookup cap) is looked for in the
# background until found or ruled out, at most this long after it was sent when its
# credential's end is not recorded (a credential never outlives 86400 s).
SEARCH_SECONDS = 86400
# A searched workflow known by its id whose status does not read past its search's end
# (or past NOT_FOUND_TRIES bare 404s) has an unknown cost: it shows in the Inbox (Retry
# lookup) and is read again now and then for this much longer, then dropped (noted).
COST_UNKNOWN_SECONDS = 3 * 86400


# How often a lost submission past the lookup cap is looked up again (it waits in the
# Inbox meanwhile).
STUCK_LOOKUP_SECONDS = 10 * 60


def _resting(run: Run, lost: dict[str, Any]) -> bool:
    if not (run.knobs or {}).get("stuck_lookup"):
        return False
    looked = _parse_at(lost.get("looked_at"))
    return looked is not None and (_now() - looked).total_seconds() < STUCK_LOOKUP_SECONDS


def _lookup_exhausted(lost: dict[str, Any]) -> bool:
    """Whether the search for a lost submission passed its attempt or age cap."""
    if int(lost.get("lookups") or 0) >= LOST_LOOKUP_TRIES:
        return True
    since = _parse_at(lost.get("submitted_at"))
    return since is not None and (_now() - since).total_seconds() >= LOST_LOOKUP_SECONDS


def _plan_entry(wf: dict[str, Any], seq: int) -> dict[str, Any] | None:
    return next((e for e in wf.get("segments") or [] if e.get("seq") == seq), None)


def _record_agents(
    segment: RunSegment, workflow_id: str, status: WorkflowStatus, steps: set[str] | None = None
) -> None:
    """#258: the running segment's working agents as this tick read them (``steps``: the
    segment's own steps in a workflow that runs several; None: every step), and when."""
    agents = [
        {
            "role": st.role,
            "state": st.state.lower(),
            "started_at": st.started_at.isoformat() if st.started_at else None,
            "heartbeat_at": st.heartbeat_at.isoformat() if st.heartbeat_at else None,
            "cost_usd": float(st.cost_usd) if st.cost_usd is not None else None,
        }
        for st in status.steps
        if st.state in WORKING and (steps is None or st.step_id in steps)
    ]
    art = _art(segment)
    checked = _now().isoformat()
    art["progress"] = {"workflow_id": workflow_id, "checked_at": checked, "agents": agents}
    _set_art(segment, art)


def _record_running(wf: dict[str, Any], status: WorkflowStatus, segments: list[RunSegment]) -> None:
    """#258: the agents of the run's running segment in the workflow just read, its own
    steps only."""
    current = next((s for s in segments if s.status == "running"), None)
    if current is None or current.swarm_workflow_id != wf["id"]:
        return
    entry = _plan_entry(wf, current.seq)
    own = {*(entry.get("work") or []), *(entry.get("revises") or [])} if entry else None
    _record_agents(current, wf["id"], status, own)


def _record_workflow_wait(
    run: Run, wf: dict[str, Any], status: WorkflowStatus, segments: list[RunSegment]
) -> None:
    """:func:`_record_wait` for the running segment of the live workflow just read."""
    current = next((s for s in segments if s.status == "running"), None)
    if current is None or current.swarm_workflow_id != wf["id"]:
        return
    entry = _plan_entry(wf, current.seq)
    own = {*(entry.get("work") or []), *(entry.get("revises") or [])} if entry else None
    _record_wait(run, current, wf["id"], wf.get("submitted_at"), status, own)


def _record_wait(
    run: Run,
    segment: RunSegment,
    workflow_id: str,
    submitted_at: Any,
    status: WorkflowStatus,
    own: set[str] | None = None,
) -> None:
    """Why SwarmCloud holds the running segment's step, as this read saw it, in the run's
    ``queue_wait`` knob (oracle.runs.waits): whether any agent of the workflow started,
    the steps seen started, since when each step waits to start, and the first of the
    segment's own steps (``own``; None: every step) parked for a reason shown in words.
    A moment is kept while the step waits the same way; on the workflow's first read it
    is its submission (it waited from there). Nothing is kept for a run that ended."""
    if run.status != "running":
        return
    prev = (run.knobs or {}).get("queue_wait") or {}
    first = prev.get("workflow_id") != workflow_id
    if first:
        prev = {}
    now = _now().isoformat()
    since = (_parse_at(submitted_at) or _now()).isoformat() if first else now
    started_steps = set(prev.get("started_steps") or [])
    waiting = dict(prev.get("waiting") or {})
    held = None
    for st in status.steps:
        if waits.began(st):
            started_steps.add(st.step_id)
            waiting.pop(st.step_id, None)
            continue
        if not waits.waits(st):
            continue
        waiting.setdefault(st.step_id, since)
        if (
            held is None
            and (own is None or st.step_id in own)
            and st.state == "PARKED"
            and waits.words(st.park_reason)
        ):
            was = prev.get("held") or {}
            kept = was.get("step_id") == st.step_id and was.get("code") == st.park_reason
            held = {
                "step_id": st.step_id,
                "code": st.park_reason,
                "since": was["since"] if kept else since,
            }
    _set_knob(
        run,
        "queue_wait",
        {
            "workflow_id": workflow_id,
            "seq": segment.seq,
            "submitted_at": submitted_at,
            "checked_at": now,
            "started": bool(prev.get("started")) or bool(started_steps),
            "started_steps": sorted(started_steps),
            "waiting": waiting,
            "held": held,
        },
    )


def _queue_wait(run: Run) -> dict[str, Any] | None:
    """The ``queue_wait`` knob while it is the running run's current workflow's."""
    qw = (run.knobs or {}).get("queue_wait")
    if run.status != "running" or not isinstance(qw, dict):
        return None
    wf = _live(run)
    if wf is not None and wf.get("id") != qw.get("workflow_id"):
        return None
    return qw


def _queue_wait_out(run: Run, seq: int | None = None) -> QueueWait | None:
    """What the Runs row (and with ``seq``, that segment) shows of a held step."""
    qw = _queue_wait(run)
    held = (qw or {}).get("held")
    if not held or (seq is not None and qw.get("seq") != seq):  # type: ignore[union-attr]
        return None
    text = waits.words(held.get("code"))
    since = _parse_at(held.get("since"))
    if text is None or since is None:
        return None
    return QueueWait(code=held["code"], text=text, since=since)


def _not_started(run: Run, zone: str) -> str | None:
    """The Inbox's words for a run whose current workflow started no agent
    :data:`waits.NOT_STARTED_SECONDS` after its submission (Cancel, Open)."""
    qw = _queue_wait(run)
    if qw is None or qw.get("started"):
        return None
    submitted = _parse_at(qw.get("submitted_at"))
    if submitted is None:
        return None
    age = (_now() - submitted).total_seconds()
    if age < waits.NOT_STARTED_SECONDS:
        return None
    said = (
        f"SwarmCloud has started no agent of this run {waits.minutes(age)} after it was submitted."
    )
    shown = _queue_wait_out(run)
    if shown is not None:
        why = f"{shown.text}, since {company_time.in_words(shown.since, zone)}."
    else:
        moments = [m for m in map(_parse_at, (qw.get("waiting") or {}).values()) if m]
        since = min(moments, default=submitted)
        why = f"Its first step is queued there since {company_time.in_words(since, zone)}."
    return f"{said} {why} It starts on its own once SwarmCloud lets it; Cancel ends the run."


@dataclass
class _Cancelled:
    """What SwarmCloud said to cancelling a workflow, then to reading it: the network half
    of a cancel, made without the run's row lock (:func:`_cancel_call`), and applied to
    the run under it (:func:`_apply_cancel`)."""

    # The cancel was not confirmed (None: confirmed).
    error: RuntimeUnavailable | None = None
    # SwarmCloud does not know the workflow (its enveloped 404): nothing is left to cancel.
    gone: bool = False
    # Not confirmed, but the workflow has ended anyway.
    ended: bool = False
    # The workflow as read after the cancel (its last cost), and why it was not read.
    final: WorkflowStatus | None = None
    unread: RuntimeUnavailable | None = None
    # The cancel was confirmed, then SwarmCloud no longer knew the workflow (its
    # enveloped 404): its cost is read once more, then it is taken as ended.
    forgotten: bool = False


def _not_found(exc: RuntimeUnavailable | None) -> bool:
    """A 404 that is not SwarmCloud's not_found envelope: it proves nothing."""
    return exc is not None and exc.status == 404 and not exc.gone


async def _cancel_call(wf: dict[str, Any]) -> _Cancelled:
    """Cancel workflow ``wf`` and read it after (its last cost, or that it ended): calls
    only, nothing written, so the caller may hold no lock."""
    runtime = _rt()
    out = _Cancelled()
    if not wf.get("id"):
        # A lost submission not found yet: the tick looks it up, then cancels it.
        out.error = RuntimeUnavailable(f"submission {wf.get('lookup')} not looked up yet")
        return out
    try:
        await runtime.cancel(wf["id"])
    except RuntimeUnavailable as exc:
        if exc.gone:
            out.gone = True
            return out
        out.error = exc
    try:
        out.final = await runtime.status(wf["id"])
    except RuntimeUnavailable as exc:
        if exc.gone:
            # Not cancelled and unknown: given up. Cancelled: nothing more to read, its
            # cost is what Oracle last read.
            out.gone = out.error is not None
            out.forgotten = out.error is None
        else:
            out.unread = exc
        return out
    out.ended = out.error is not None and out.final.terminal
    return out


async def _apply_cancel(
    db: AsyncSession, run: Run, wf: dict[str, Any], out: _Cancelled, state: str
) -> bool:
    """Record a cancel (:func:`_cancel_call`) on the run: True when the workflow is done
    with (cancelled, ended, or unknown to SwarmCloud), else it stays attached with a
    ``cancel_pending`` marker for the tick. A 404 that proves nothing is counted on the
    marker: past :data:`NOT_FOUND_TRIES` the run shows in the Inbox with Cancel."""
    pending = wf.get("cancel_pending") or {}
    if out.gone:
        await _give_up(db, run, wf, state)
        return True
    if out.final is not None and wf.get("id"):
        _take_cost(run, wf, out.final, await _segments(db, run.id))
    now = _now().isoformat()
    if out.error is not None and not out.ended:
        log.warning("run %s: cancel of %s not confirmed: %s", run.id, wf.get("id"), out.error)
        marker: dict[str, Any] = {
            "state": state,
            "since": pending.get("since") or now,
            "tries": int(pending.get("tries") or 0) + 1,
            "tried_at": now,
            "error": _shown(out.error),
        }
        _count_not_found(marker, pending, _not_found(out.error) or _not_found(out.unread))
        _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
        # Nothing Oracle drives runs in it any more: its agents lose Oracle's data now,
        # not when SwarmCloud confirms.
        await revoke_run_tokens(db, run.id)
        return False
    if out.unread is not None:
        # Cancelled, its last cost unread: attached for one more read (the tick's), so
        # that nothing is submitted after it before its spend is counted.
        log.warning("run %s: final cost of %s not read: %s", run.id, wf.get("id"), out.unread)
        marker = {
            "state": state,
            "since": pending.get("since") or now,
            "tries": int(pending.get("tries") or 0),
            "tried_at": now,
            "confirmed": True,
            "error": "its last cost was not read",
        }
        _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
        await revoke_run_tokens(db, run.id)
        return False
    if out.error is None and out.final is not None and not out.final.terminal:
        _read_on(run, wf, costed=True)
    elif out.forgotten and wf.get("id"):
        _read_once_more(run, wf)
    await _end_workflow(db, run, wf, state)
    return True


def _read_on(run: Run, wf: dict[str, Any], *, costed: bool = False) -> None:
    """A workflow whose cancel SwarmCloud confirmed and that has not ended yet (winding
    down), or whose last cost was not read: detached, and read on ``searches`` until its
    status reads terminal, so that what it spends meanwhile is counted on the run.
    ``costed``: its cost was read after the cancel."""
    _search_for(
        run,
        label=wf.get("label") or wf["id"],
        seq=wf.get("start_seq"),
        submitted_at=wf.get("submitted_at"),
        until=_credential_end(wf),
        why="cancel",
        workflow_id=wf["id"],
        cancelled=True,
        costed=costed,
    )


def _read_once_more(run: Run, wf: dict[str, Any]) -> None:
    """A workflow SwarmCloud no longer knows (its enveloped 404) right after confirming
    its cancel: its cost is read once more (``searches``, the next tick) before it is
    taken as ended, so what it spent since Oracle's last read is counted. A second 404
    ends it; a read that fails follows the cost-unknown rules (:func:`_found_apply`)."""
    _read_on(run, wf)
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    for e in entries:
        if e.get("id") == wf["id"]:
            e["gone_reads"] = 1
            e["error"] = "SwarmCloud did not know it right after confirming its cancel"
    _set_knob(run, "searches", entries)


def _count_not_found(marker: dict[str, Any], pending: dict[str, Any], hit: bool) -> None:
    count = int(pending.get("not_found") or 0) + (1 if hit else 0)
    if count:
        marker["not_found"] = count
    if count >= NOT_FOUND_TRIES:
        marker["stuck"] = True


async def _detach(
    db: AsyncSession,
    run: Run,
    *,
    cancel: bool,
    state: str,
    done: dict[str, _Cancelled] | None = None,
) -> bool:
    """Stop driving the run's live workflow (cancelling it when asked) and revoke its
    run token: what comes next is a new workflow with a fresh token, or the end.

    Returns False when SwarmCloud did not confirm the cancel (and the workflow has not
    ended): it may still run, so it stays attached with a ``cancel_pending`` marker. Its
    cost is still read into the run's spend, the tick cancels it again, and nothing is
    submitted after it until the cancel is confirmed: no segment runs in two workflows.
    A workflow already being cancelled stays so; only ``cancel`` tries again. ``done``:
    cancels already made (outside the run's row lock), by workflow id."""
    wf = _live(run)
    if wf is None:
        return True
    if wf.get("cancel_pending") and not cancel:
        return False
    if cancel:
        out = (done or {}).get(wf.get("id") or "")
        if out is None:
            out = await _cancel_call(wf)
        return await _apply_cancel(db, run, wf, out, state)
    await _end_workflow(db, run, wf, state)
    return True


async def _give_up(db: AsyncSession, run: Run, wf: dict[str, Any], state: str) -> None:
    """SwarmCloud does not know the workflow (404): nothing is left to cancel."""
    gone = (
        f"SwarmCloud does not know workflow {wf.get('id')} (HTTP 404): Oracle stopped "
        "cancelling it; its cost is what Oracle last read."
    )
    log.warning("run %s: %s", run.id, gone)
    segments = await _segments(db, run.id)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        _note(target or segments[0], gone)
    await _end_workflow(db, run, wf, state, gone=gone)


async def _end_workflow(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    state: str,
    *,
    gone: str | None = None,
    stopped: bool = False,
) -> None:
    """Detach the run's workflow: Oracle no longer drives or cancels it. ``stopped``: an
    approver stopped cancelling it, and its cost is still read (``searches``)."""
    rest = {k: v for k, v in wf.items() if k != "cancel_pending"}
    if gone:
        rest["gone"] = gone
    if stopped:
        rest["stopped"] = True
    _set_knob(run, "workflow", {**rest, "state": state, "ended_at": _now().isoformat()})
    await revoke_run_tokens(db, run.id)


def _pending(
    segment: RunSegment, art: dict[str, Any], change_request: str | None, error: str
) -> None:
    """Left pending: the next tick submits it again."""
    art.pop("claim", None)
    segment.status = "pending"
    segment.error = error
    if change_request:
        art["pending_note"] = change_request
    _set_art(segment, art)


async def _submit_now(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    change_request: str | None = None,
    *,
    claim: str | None = None,
) -> str | None:
    """Mint the run token and submit the segment's workflow (the caller commits).

    With ``claim`` (:func:`submit_queued`: the segment carries that claim) the
    transaction commits right before the submit call, so neither the run's row lock nor
    the new token's key lock is held across it, and the run is locked and read again
    after it. If the run changed meanwhile (cancelled, a disable voided the decision or
    the approval), nothing is recorded and the id of the workflow SwarmCloud started is
    returned, for the caller to cancel; otherwise None.

    With caller MCP on, the token goes to the agents through the workflow's credential
    map; with await-input on too, the workflow covers the rest of the run and its
    checkpoints wait for a person in SwarmCloud (oracle.runs.workflow). A refusal that
    names a switched-off feature submits again without it; a lost answer is looked up by
    the submission's label before anything is submitted again."""
    runtime = _rt()
    settings = get_runtime_settings()
    flow, knobs = _flow(run), _knobs(run)
    sdef = flow.segment(segment.name)
    art = _art(segment)
    # Submissions given up on (Retry from the Inbox) keep their numbers: a new key each.
    attempt = len(art["attempts"]) + len(art.get("abandoned") or []) + 1
    # A retry after the runtime refused a re-run keeps the reviewer's note; it stays
    # recorded until a submission succeeds (:func:`_accepted`).
    change_request = change_request or art.get("pending_note")
    # What the agents get: the structured review of a send-back (D4), else the note.
    agents_request = art.get("pending_review") or change_request
    if segment.estimate_usd is None:
        segment.estimate_usd = flows.segment_estimate(sdef, knobs)
    tag = workflow.label(run.id, segment.name, attempt)

    async def still_ours() -> bool:
        fresh, _ = await _locked(db, run.id)
        return (
            fresh is not None
            and fresh.status == "running"
            and segment.status == "pending"
            and ((segment.artifacts or {}).get("claim") or {}).get("id") == claim
        )

    # SwarmCloud has no idempotency keys: a submission whose answer was lost may exist.
    lost = art.get("lost")
    if isinstance(lost, dict) and lost.get("label") == tag and _resting(run, lost):
        return  # past the lookup cap, in the Inbox: looked up again now and then
    lost = art.pop("lost", None)
    if isinstance(lost, dict) and lost.get("label") == tag:
        lost["looked_at"] = _now().isoformat()
        try:
            found = await runtime.find_by_label(tag, since=_parse_at(lost.get("submitted_at")))
        except RuntimeUnavailable as exc:
            lost["lookups"] = int(lost.get("lookups") or 0) + 1
            art["lost"] = lost
            error = f"looking up submission {tag}: {exc}"
            if _lookup_exhausted(lost):
                # Never resolved either way: an owner or the run's creator decides.
                error += f". {_STUCK}"
                _set_knob(
                    run,
                    "stuck_lookup",
                    {"seq": segment.seq, "label": tag, "since": lost.get("submitted_at")},
                )
            _pending(segment, art, change_request, error)
            return
        _set_knob(run, "stuck_lookup", None)
        if found:
            _accepted(run, segment, art, found, lost, change_request, runtime)
            return

    # One submission at a time: an earlier workflow and its token end before a new one,
    # and nothing is submitted while SwarmCloud has not confirmed its cancel.
    earlier = _live(run)
    if not await _detach(db, run, cancel=True, state="replaced"):
        _pending(
            segment,
            art,
            change_request,
            f"Waiting for SwarmCloud to confirm that workflow {earlier['id'] if earlier else ''} "
            "is cancelled: no segment runs in two workflows, so this one is submitted once it "
            "is (Oracle tries again on every tick).",
        )
        return
    # The spend, the cancelled workflow's last cost included, is checked before every
    # submission: nothing new starts over the ceiling.
    if (ceiling := _overrun(run)) is not None:
        _pending(
            segment,
            art,
            change_request,
            f"Not submitted: the run spent ${run.spent_usd}, over its ${ceiling} ceiling, so "
            "it paused; resuming submits this segment.",
        )
        await _pause_overrun(db, run, ceiling)
        return
    await revoke_run_tokens(db, run.id)
    url = settings.public_url.rstrip("/") + "/mcp"
    mode = await _mode(runtime, url)
    kind = await _target_kind(db, run)
    registered_again = False
    while True:
        covered = _workflow_segments(flow, segment, segments) if mode.waits else [segment]
        planned: list[tuple[int, str, list[str]]] = []
        contexts: list[tuple[int, flows.SegmentDef, flows.PromptContext]] = []
        for s in covered:
            d = flow.segment(s.name)
            own = s.seq == segment.seq
            ctx = await _prompt_context(
                db,
                run,
                s,
                segments,
                attempt if own else 1,
                agents_request if own else None,
                runtime,
                attached=mode.attach,
                planned=list(planned),
            )
            contexts.append((s.seq, d, ctx))
            planned.append((s.seq, d.title, list(d.outputs_for(kind))))
        plan = None
        if mode.waits:
            plan = workflow.build_plan(
                flow, contexts, knobs, settings, settings.swarmcloud_profile, run_id=str(run.id)
            )
            steps = tuple(plan.steps)
            scopes = workflow.scopes_for([d for _, d, _ in contexts])
            outputs = contexts[-1][1].outputs_for(kind)
        else:
            steps = tuple(
                StepSpec(
                    key=key,
                    role=role,
                    profile=settings.swarmcloud_profile,
                    prompt=prompt,
                    depends_on=deps,
                    input_from=inputs,
                )
                for key, role, prompt, deps, inputs in flows.build_steps(
                    flow, sdef, knobs, contexts[0][2]
                )
            )
            scopes = sdef.scopes
            outputs = sdef.outputs_for(kind)
        if (run.knobs or {}).get("triage_automatic"):
            # Oracle's daily request triage acts as a member and reads no one's sources.
            scopes = tuple(sc for sc in scopes if sc != "read:sources")
        if mode.attach:
            agents = sum(1 for s in steps if not s.waits)
            ttl = workflow.credential_seconds(agents, len(steps) - agents, settings)
        else:
            ttl = settings.run_token_ttl_seconds
        await revoke_run_tokens(db, run.id)
        token = await mint_run_token(db, run.id, scopes, ttl)
        submitted_at = _now()
        info: dict[str, Any] = {
            "label": tag,
            "attempt": attempt,
            "mode": "workflow" if mode.waits else "segment",
            "attach": mode.attach,
            "notes": mode.notes,
            "submitted_at": submitted_at.isoformat(),
            "credential_seconds": ttl if mode.attach else None,
            "expires_at": workflow.expires_at(submitted_at, ttl).isoformat(),
            "segments": plan.segments if plan else None,
            # The wait steps, as the lifetime was sized: a renewal sizes the rest the same.
            "waits": [s.key for s in steps if s.waits],
            "start_seq": segment.seq,
        }
        spec = WorkflowSpec(
            name=f"oracle-{run.flow}-{segment.name}",
            steps=steps,
            outputs=outputs,
            mcp=McpAccess(
                url=url,
                token=token,
                scopes=scopes,
                expires_in=ttl if mode.attach else 0,
                attach=mode.attach,
            ),
            budget_usd=knobs.budget_usd,
            labels={
                "run_id": str(run.id),
                "segment": segment.name,
                "attempt": str(attempt),
                "estimate_usd": str(segment.estimate_usd),
            },
            label=tag,
        )
        if claim is not None:
            # Nothing held across the call: a cancel or a disable never waits on it. From
            # here the submission is not run again (:func:`_replay`).
            await db.commit()
            _disarm()
        try:
            try:
                workflow_id = await runtime.submit(spec)
            except RuntimeUnavailable:
                raise
            except Exception as unexpected:
                if claim is None:
                    raise
                # After a commit: recorded as a refusal, never a 500.
                log.exception("run %s: submission failed", run.id)
                raise RuntimeUnavailable(
                    f"the submission failed ({type(unexpected).__name__})"
                ) from None
        except RuntimeUnavailable as exc:
            if claim is not None and not await still_ours():
                return None
            if exc.code == "mcp_server_unregistered" and mode.attach and not registered_again:
                registered_again = True
                await db.commit()  # the run's row lock is not held across the call
                try:
                    await runtime.ensure_mcp_server(url)
                    registered = True
                except RuntimeUnavailable:
                    registered = False
                if claim is not None and not await still_ours():
                    return None
                if registered:
                    continue
            fallback = _degrade(mode, exc)
            if fallback is None and exc.code == "mcp_server_unregistered" and mode.attach:
                fallback = _Mode(False, False, [*mode.notes, workflow.advice(exc.code, "")])
            if fallback is not None:
                log.info("run %s: submitting %s again: %s", run.id, segment.name, exc.code)
                mode = fallback
                continue
            if exc.lost:
                # The workflow may exist: keep its token alive and look before resubmitting.
                found = None
                await db.commit()  # the run's row lock is not held across the lookup
                try:
                    found = await runtime.find_by_label(tag, since=submitted_at)
                except RuntimeUnavailable:
                    pass
                if claim is not None and not await still_ours():
                    return found or None  # found: nothing runs for it, the caller cancels it
                if found:
                    _accepted(run, segment, art, found, info, change_request, runtime)
                    return None
                art["lost"] = info
                _pending(
                    segment,
                    art,
                    change_request,
                    f"{exc}; Oracle looks for submission {tag} before submitting again",
                )
                log.warning("run %s segment %s: submit lost: %s", run.id, segment.name, exc)
                return None
            await revoke_run_tokens(db, run.id)
            _pending(segment, art, change_request, workflow.advice(exc.code, str(exc)))
            log.warning("run %s segment %s: submit failed: %s", run.id, segment.name, exc)
            return None
        if claim is not None and not await still_ours():
            return workflow_id
        _accepted(run, segment, art, workflow_id, info, change_request, runtime)
        return None


def _accepted(
    run: Run,
    segment: RunSegment,
    art: dict[str, Any],
    workflow_id: str,
    info: dict[str, Any],
    change_request: str | None,
    runtime: AgentRuntime,
) -> None:
    """Record a submission the runtime holds (just made, or found by its label)."""
    art.pop("lost", None)
    art.pop("decision", None)
    art.pop("claim", None)
    art.pop("pending_note", None)
    art.pop("pending_review", None)
    # A new workflow: what was read of the last one's waits no longer applies.
    _set_knob(run, "queue_wait", None)
    art["attempts"].append(
        {
            # The number in its key: submissions given up on (Retry) keep theirs.
            "attempt": int(info.get("attempt") or _attempt_of(info.get("label"), 0))
            or len(art["attempts"]) + 1,
            "workflow_id": workflow_id,
            "submitted_at": info.get("submitted_at") or _now().isoformat(),
            "cost_usd": 0,
            "note": change_request,
            "state": "running",
            "label": info.get("label"),
            "mode": info.get("mode"),
        }
    )
    notes = list(info.get("notes") or [])
    if not info.get("attach") and not runtime.can_reach_oracle:
        notes += runtime.notes()
    if info.get("mode") == "workflow":
        hours = get_runtime_settings().checkpoint_wait_seconds / 3600
        notes.append(
            f"From '{_flow(run).segment(segment.name).title}' on, this run is one SwarmCloud "
            f"workflow: each checkpoint waits there for up to {hours:g} h and is answered "
            "from the Inbox, and the run token lasts "
            f"{info.get('credential_seconds')} s from submission."
        )
    for note in notes:
        if note not in art["notes"]:
            art["notes"].append(note)
    _set_art(segment, art)
    segment.status = "running"
    segment.swarm_workflow_id = workflow_id
    segment.error = None
    segment.finished_at = None
    segment.started_at = segment.started_at or _now()
    run.status = "running"
    if info.get("mode") == "workflow":
        _set_knob(
            run,
            "workflow",
            {
                "id": workflow_id,
                "label": info.get("label"),
                "state": "live",
                "start_seq": info.get("start_seq", segment.seq),
                "submitted_at": info.get("submitted_at"),
                "expires_at": info.get("expires_at"),
                "credential_seconds": info.get("credential_seconds"),
                "segments": info.get("segments") or [],
                "waits": info.get("waits") or [],
            },
        )
    else:
        _set_knob(run, "workflow", None)


async def _submit(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    change_request: str | None = None,
    review: str | None = None,
) -> None:
    """Queue the segment for submission (the caller commits): the runtime is not called,
    the segment waits (:data:`QUEUED`) for :func:`submit_queued` to submit it after the
    caller commits, with neither the review gate nor the run's row lock held across the
    call. Every path that starts a segment queues; none submits under a lock.

    ``change_request`` is the person's note (the attempt's note, kept until a submission
    succeeds); ``review``, the structured review a send-back delivers (D4), is what the
    agents get instead when given."""
    if _flow(run).segment(segment.name).waits_for_draft_items and not await _draft_items_ready(
        db, run, segment, segments
    ):
        return
    art = _art(segment)
    if change_request or review:
        _keep_previous(art)
    if change_request:
        art["pending_note"] = change_request
    if review:
        art["pending_review"] = review
    elif change_request:
        art.pop("pending_review", None)
    art.pop("claim", None)
    _set_art(segment, art)
    segment.status = "pending"
    segment.error = QUEUED
    run.status = "running"


def _workflow_segments(
    flow: flows.FlowDef, segment: RunSegment, segments: list[RunSegment]
) -> list[RunSegment]:
    """The segments one workflow covers from ``segment`` on: up to, not including, a later
    segment that waits for the draft's roadmap items (F4 lane B: Oracle starts it once they
    are ready, as a workflow of its own)."""
    out: list[RunSegment] = []
    for s in segments:
        if s.seq < segment.seq or s.status == "skipped":
            continue
        if s.seq > segment.seq and flow.segment(s.name).waits_for_draft_items:
            break
        out.append(s)
    return out


async def _draft_items_ready(
    db: AsyncSession, run: Run, segment: RunSegment, segments: list[RunSegment]
) -> bool:
    """F4 lane B: whether a segment that reads the approved PRD version's draft roadmap
    items may be queued now. Otherwise the run waits for them (``waiting_for`` on the
    segment, re-checked each tick, a Derive asked for when there are none) or the segment
    is skipped with its note, and the run goes on (it ends)."""
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        creator: Principal | None = _creator(current_tenant(db), user, token)
    except LookupError:
        creator = None
    state, n, note = await eng_dates.start_state(db, run, creator)
    art = _art(segment)
    waited = art.pop("waiting_for", None)
    if state == "go":
        if waited is not None:
            _set_art(segment, art)
        return True
    if state == "wait":
        art["waiting_for"] = {"kind": "draft_items", "version": n}
        _set_art(segment, art)
        segment.status = "pending"
        segment.error = None
        run.status = "running"
        return False
    art["note"] = note
    _note_art(art, note or "")
    _set_art(segment, art)
    segment.status = "skipped"
    segment.estimate_usd = Decimal("0.00")
    segment.cost_usd = Decimal("0")
    segment.finished_at = _now()
    segment.error = None
    await _next(db, run, segment, segments)
    return False


def _awaiting_items(segments: list[RunSegment]) -> RunSegment | None:
    """The segment waiting for the draft's roadmap items (F4 lane B), if any."""
    return next(
        (s for s in segments if s.status == "pending" and (s.artifacts or {}).get("waiting_for")),
        None,
    )


def _keep_previous(art: dict[str, Any]) -> None:
    """A person sent the segment back (D5): its current files and what Oracle's check found
    in them become ``previous``, the files the re-run starts from (and that ``?attempt=``
    serves). One level only: an earlier ``previous`` is replaced."""
    files = art.get("files") or {}
    if not files or not art["attempts"]:
        return
    last = art["attempts"][-1]
    imported = art.get("import") or {}
    art["previous"] = {
        "attempt": int(last.get("attempt") or len(art["attempts"])),
        "files": dict(files),
        "items_check": art.get("items_check"),
        "import_problems": list(imported.get("problems") or []),
        "kept_at": _now().isoformat(),
    }


# Set on a segment a voided overrun Resume had queued: the next Resume queues it again.
RESUME_VOIDED = "resume_voided"


def unqueue(segment: RunSegment) -> None:
    """Take a pending segment off the queue (its run no longer waits on the runtime): a
    submission under way finds its claim gone and cancels what it started."""
    art = _art(segment)
    art.pop("claim", None)
    art.pop("decision", None)
    _set_art(segment, art)
    segment.error = None


async def _locked(db: AsyncSession, run_id: uuid.UUID) -> tuple[Run | None, list[RunSegment]]:
    """The run, locked and read afresh, with its segments read afresh."""
    run = await db.scalar(
        select(Run)
        .where(Run.id == run_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if run is None:
        return None, []
    segments = list(
        await db.scalars(
            select(RunSegment)
            .where(RunSegment.run_id == run_id)
            .order_by(RunSegment.seq)
            .execution_options(populate_existing=True)
        )
    )
    return run, segments


def _waiting(segment: RunSegment) -> bool:
    """Pending with a reason: queued by a request (:data:`QUEUED`), or refused by the
    runtime earlier (the error it gave). Either waits to be submitted."""
    return segment.status == "pending" and bool(segment.error)


async def _within[T](call: Awaitable[T], deadline: float | None) -> T:
    """A runtime call, cut at ``deadline`` (loop time; None: the client's own timeouts).
    Only the call is timed: a database query is never cancelled halfway."""
    if deadline is None:
        return await call
    try:
        async with asyncio.timeout_at(deadline):
            return await call
    except TimeoutError:
        raise RuntimeUnavailable(
            f"the agent runtime did not answer within the tick's {TICK_RUN_SECONDS:g} s for "
            "this run"
        ) from None


# --------------------------------------------------------------- calls outside locks
#
# Code that decides under a run's row lock (the tick's pass over a run, the claim of a
# queued segment, an Inbox decision's follow-through) also needs to read or change things
# at SwarmCloud. It never does so with the lock (or the review gate) held: it runs inside
# :func:`_replay`, where a runtime call goes through :func:`_rt`. A call whose result is not
# known yet raises :class:`_NeedCall`; the transaction is rolled back (every lock is
# released), the call is made, and the code runs again from the top, locking and reading
# the run as it is now, with the result of that call (and every earlier one) at hand. So
# whatever the code writes is decided on the run as it is when it writes, never as it was
# when SwarmCloud was asked; a run that changed meanwhile is simply handled as it is. This
# is a crash and a restart at that point, which every pass has to survive anyway, with the
# answers of calls already made kept.
#
# The replayed code is therefore written like the tick's: it starts by reading the run
# afresh, commits only what stays true if it runs again, and keeps in-memory counters
# through ``reset``.


class _NeedCall(BaseException):
    """A runtime call made inside :func:`_replay` with no result yet. A BaseException: the
    ``except Exception`` of the code between must not take it for a failed call."""

    def __init__(self, slot: tuple, call: Any, args: tuple, kwargs: dict[str, Any]) -> None:
        super().__init__(slot[0])
        self.slot, self.call, self.args, self.kwargs = slot, call, args, kwargs


# The calls that go to SwarmCloud and are decided outside the lock (the rest of the
# runtime's surface is local: its notes, whether it reaches Oracle).
_OUTSIDE = frozenset(
    {
        "status",
        "cost",
        "artifacts",
        "cancel",
        "features",
        "ensure_mcp_server",
        "find_by_label",
        "answer",
        "answer_record",
    }
)
# How many different calls one replayed pass may need before it gives up.
REPLAY_LIMIT = 64


@dataclass
class _Guard:
    cache: dict[tuple, tuple[bool, Any]]
    seen: dict[tuple, int] = field(default_factory=dict)
    armed: bool = True


_GUARD: contextvars.ContextVar[_Guard | None] = contextvars.ContextVar(
    "oracle_runs_guard", default=None
)


class _Guarded:
    """The runtime as :func:`_rt` hands it out inside :func:`_replay`."""

    def __init__(self, inner: Any, guard: _Guard) -> None:
        self._inner, self._guard = inner, guard

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._inner, name)
        if name not in _OUTSIDE:
            return attr
        guard = self._guard

        async def call(*args: Any, **kwargs: Any) -> Any:
            if not guard.armed:
                return await attr(*args, **kwargs)
            key = (name, repr((args, kwargs)))
            n = guard.seen.get(key, 0)
            guard.seen[key] = n + 1
            slot = (*key, n)
            if slot in guard.cache:
                ok, value = guard.cache[slot]
                if ok:
                    return value
                raise value
            raise _NeedCall(slot, attr, args, kwargs)

        return call


def _rt() -> Any:
    """The runtime for code that may run inside :func:`_replay` (else the runtime itself)."""
    runtime = get_runtime()
    guard = _GUARD.get()
    return runtime if guard is None else _Guarded(runtime, guard)


def _disarm() -> None:
    """From here the code is not run again (it committed what must not be done twice):
    its runtime calls go straight to the runtime, made with nothing held."""
    guard = _GUARD.get()
    if guard is not None:
        guard.armed = False


async def _replay[T](
    db: AsyncSession,
    deadline: float | None,
    body: Callable[[], Awaitable[T]],
    *,
    reset: Callable[[], None] | None = None,
) -> T:
    """Run ``body`` (which locks and reads what it needs itself) with its runtime calls
    made outside any lock: see the note above. Each call is bounded by ``deadline`` (loop
    time; a call past it fails like a call that timed out), and its failure is what the
    code sees, at the same place. ``reset``: puts back what an unfinished run of ``body``
    counted in memory."""
    cache: dict[tuple, tuple[bool, Any]] = {}
    for _ in range(REPLAY_LIMIT):
        token = _GUARD.set(_Guard(cache))
        try:
            return await body()
        except _NeedCall as need:
            wanted = need
        finally:
            _GUARD.reset(token)
        await db.rollback()
        if reset is not None:
            reset()
        try:
            cache[wanted.slot] = (
                True,
                await _within(wanted.call(*wanted.args, **wanted.kwargs), deadline),
            )
        except Exception as exc:  # noqa: BLE001 - the code sees the call's own failure
            cache[wanted.slot] = (False, exc)
    raise RuntimeUnavailable("this pass needed more calls to SwarmCloud than it may make")


def _cancel_follow_up(
    db: AsyncSession, member_id: uuid.UUID, segment_id: uuid.UUID, workflow_id: str
) -> "MemberFollowUp":
    """Record the cancel of a workflow at the runtime as a follow-up, in the transaction
    that decides it: made right after the commit, retried by the tick if it fails or the
    process dies first (``oracle.members.service.run_follow_ups``)."""
    from oracle.members.models import MemberFollowUp

    row = MemberFollowUp(
        id=uuid.uuid4(),
        member_id=member_id,
        kind="run_cancel",
        target_id=segment_id,
        workflow_id=workflow_id,
    )
    db.add(row)
    return row


async def submit_queued(
    db: AsyncSession, run_id: uuid.UUID, *, deadline: float | None = None
) -> None:
    """Submit the run's waiting segment (:func:`_waiting`), after the request that queued
    it committed: outside the review gate. The tick calls it too, for a segment the
    runtime refused before.

    The segment is claimed under the run's row lock; :func:`_submit_now` commits before
    the submit call (nothing held across it) and reads the run again after it. If the
    run changed meanwhile (cancelled, its approval or the checkpoint decision voided by
    a disable), the workflow SwarmCloud started is cancelled at once (a follow-up
    recorded first, retried from the tick). A submission whose process died mid-call
    keeps its claim until it expires. Before the commit that precedes the submit call, the
    runtime calls it needs (looking up a lost submission, cancelling an earlier workflow,
    the features, the MCP server) are made outside the run's row lock too, by
    :func:`_replay`. ``deadline`` (loop time): bounds each of those calls; the tick's cap
    for a run bounds its submission with it. Commits."""
    await _replay(db, deadline, lambda: _submit_queued(db, run_id))


async def _submit_queued(db: AsyncSession, run_id: uuid.UUID) -> None:
    run, segments = await _locked(db, run_id)
    segment = next((s for s in segments if _waiting(s)), None)
    if run is None or run.status != "running" or segment is None or _claimed(segment):
        await db.rollback()
        return
    if _live(run) is not None:
        # A workflow is still attached (driven, or its cancel not confirmed): the tick
        # follows it and submits what waits only once it is done with.
        await db.rollback()
        return
    claim = uuid.uuid4().hex
    art = _art(segment)
    art["claim"] = {"id": claim, "at": _now().isoformat()}
    _set_art(segment, art)
    segment_id = segment.id
    orphan = await _submit_now(db, run, segment, segments, claim=claim)
    if orphan is None:
        await db.commit()
        return
    # The run changed while SwarmCloud started the workflow: nothing runs for it.
    await audit.record(
        db, None, "run.workflow_cancelled", "run", run_id,
        {"workflow_id": orphan, "segment_id": str(segment_id),
         "reason": "the run changed while its segment was submitted"},
    )  # fmt: skip
    fresh = await db.get(Run, run_id)
    member_id = (fresh.created_by if fresh is not None else None) or run_id
    row = _cancel_follow_up(db, member_id, segment_id, orphan)
    await db.commit()
    await cancel_at_runtime(db, [row.id])


# How long a submission under way keeps the tick off its segment: past it, the process
# that claimed it is taken to be gone and the tick submits the segment again.
CLAIM_SECONDS = 300


def _claimed(segment: RunSegment) -> bool:
    """A submission of this segment is under way (claimed less than CLAIM_SECONDS ago)."""
    at = _parse_at(((segment.artifacts or {}).get("claim") or {}).get("at"))
    return at is not None and (_now() - at).total_seconds() < CLAIM_SECONDS


# How long a cancel's follow-up, recorded before its call, waits before the tick may make
# it: the request that recorded it is making the call meanwhile.
CANCEL_FOLLOW_UP_GRACE_SECONDS = 120


async def _settle_cancel_follow_ups(
    db: AsyncSession, follow_ups: dict[str, uuid.UUID], done: dict[str, "_Cancelled"]
) -> None:
    """Record the outcome of the cancel calls :func:`cancel` made on their follow-ups, in
    the transaction that records them on the run: from here a cancel not confirmed is the
    run's to retry (``cancel_pending`` or a background search), not the follow-up's."""
    from oracle.members.models import MemberFollowUp

    for workflow_id, follow_up_id in follow_ups.items():
        row = await db.get(MemberFollowUp, follow_up_id, with_for_update=True)
        if row is None or row.status != "pending":
            continue
        out = done.get(workflow_id)
        confirmed = out is not None and (out.error is None or out.gone)
        row.attempts += 1
        row.outcome = "cancelled" if confirmed else "followed_by_run"
        row.last_error = (
            None if confirmed or out is None or out.error is None else _shown(out.error)
        )
        row.status = "done"
        row.done_at = _now()
        row.next_attempt_at = None


async def cancel_at_runtime(db: AsyncSession, follow_ups: list[uuid.UUID]) -> None:
    """Make the run_cancel follow-ups a cancel recorded (:func:`_cancel_follow_up`),
    after it committed (outside the review gate). A cancel the runtime does not confirm
    is noted on its segment and retried from the tick. Commits."""
    from oracle.members import service as members_service

    for follow_up_id in follow_ups:
        try:
            await members_service.attempt_follow_up(db, follow_up_id)
        except Exception:  # noqa: BLE001 - the tick retries it
            log.exception("run cancel follow-up %s could not be made", follow_up_id)
            await db.rollback()


def _recompute_spend(run: Run, segments: list[RunSegment]) -> None:
    run.spent_usd = sum((s.cost_usd or Decimal(0) for s in segments), Decimal(0))


async def _finish(
    db: AsyncSession,
    run: Run,
    status: str,
    error: str | None = None,
    *,
    state: str = "ended",
    done: dict[str, "_Cancelled"] | None = None,
) -> None:
    run.status = status
    run.finished_at = _now()
    if error:
        run.error = error
    _set_knob(run, "post_404", None)
    # Nothing waits in SwarmCloud's queue once the run ended (the Inbox reads running
    # runs' waits only).
    _set_knob(run, "queue_wait", None)
    # A run that ends early stops its workflow; a finished one's ends on its own. A cancel
    # SwarmCloud does not confirm leaves the workflow attached: the tick cancels it again
    # and keeps reading its cost.
    await _detach(db, run, cancel=status != "succeeded", state=state, done=done)
    _set_knob(run, "spent_at_end", str(run.spent_usd or 0))
    await revoke_run_tokens(db, run.id)
    # I1: every ending, from here only; a code on failure, never the error's text.
    if status in ("succeeded", "failed", "cancelled"):
        await webhooks.capture(
            db,
            f"run.{status}",
            audit.ORACLE,
            run_id=run.id,
            error_kind="run_failed" if status == "failed" else None,
        )
    if status in ("failed", "cancelled") and _flow(run).stores_draft_items:
        from oracle.roadmap import draft_items

        await draft_items.run_ended(db, run, run.error or "Cancelled")


async def _next(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
) -> None:
    later = [s for s in segments if s.seq > segment.seq and s.status != "skipped"]
    wf = _drivable(run)
    if later and wf is not None and _plan_entry(wf, later[0].seq) is not None:
        # Already part of the live workflow: it runs once the wait is answered.
        nxt = later[0]
        art = _art(nxt)
        art["attempts"].append(
            {
                "attempt": len(art["attempts"]) + 1,
                "workflow_id": wf["id"],
                "submitted_at": _now().isoformat(),
                "cost_usd": 0,
                "note": None,
                "state": "running",
                "label": wf.get("label"),
                "mode": "workflow",
            }
        )
        _set_art(nxt, art)
        nxt.status = "running"
        nxt.swarm_workflow_id = wf["id"]
        nxt.error = None
        nxt.started_at = nxt.started_at or _now()
        run.status = "running"
        return
    if later:
        await _submit(db, run, later[0], segments)
    else:
        await _finish(db, run, "succeeded")


def _creator(principal_tenant: uuid.UUID, user: User | None, token: ApiToken | None) -> Principal:
    if user is not None and user.disabled_at is not None:
        # A disabled member's runs act for no one (C2); disabling cancels them too.
        raise LookupError("run creator is disabled")
    if user is not None:
        return Principal(
            tenant_id=principal_tenant,
            kind="user",
            role=user.role,  # type: ignore[arg-type]
            user_id=user.id,
        )
    if token is not None:
        return Principal(
            tenant_id=principal_tenant,
            kind="token",
            role=token.role,  # type: ignore[arg-type]
            token_id=token.id,
        )
    raise LookupError("run creator not found")


async def _draft_source(db: AsyncSession, run: Run) -> uuid.UUID | None:
    """The provenance of the draft a run imports: the run's source version
    (prd_to_roadmap), else the document's latest version's (the feedback loop keeps the
    PRD version a roadmap came from)."""
    source_id = _source_id(run)
    if source_id is not None or not run.document_id:
        return source_id
    return await db.scalar(
        select(DocumentVersion.source_version_id)
        .where(DocumentVersion.document_id == run.document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _prd_links(db: AsyncSession, markdown: str, source: VersionSource) -> dict[str, Any]:
    """Which of the draft's links to its source document resolve to a section of the
    source version."""
    keys = set(
        await db.scalars(select(Section.section_key).where(Section.version_id == source.version_id))
    )
    resolved, unresolved = 0, []
    for link in roadmap.doc_links(markdown):
        if link["slug"] not in (source.slug, str(source.document_id)):
            continue
        if link["version"] == source.version and (
            link["section"] is None or link["section"] in keys
        ):
            resolved += 1
        else:
            unresolved.append(link["href"])
    return {"resolved": resolved, "unresolved": unresolved}


async def _import_draft(db: AsyncSession, run: Run, kind: str, markdown: str) -> dict[str, Any]:
    """Import the draft as the next version of the run's document (of ``kind``, with
    the run's provenance), in its own transaction."""
    tenant_id = current_tenant(db)
    name = flows.draft_file(kind)
    ref = str(run.document_id) if run.document_id else run.knobs.get("document_slug")
    if not ref:
        return {"error": "the run names no document"}
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": str(exc)}
    source_id = await _draft_source(db, run)
    knobs = run.knobs or {}
    template = (
        (knobs["template"], str(knobs["template_version"]))
        if knobs.get("template") and knobs.get("template_version")
        else None
    )
    async with tenant_session(tenant_id) as s:
        try:
            result = await docs_service.import_draft(
                s,
                ref,
                markdown,
                principal,
                kind=kind,
                theme=knobs.get("theme"),
                template=template,
                source_version_id=source_id,
                # An agent's draft never replaces approved text: it becomes a patch.
                cause="run_draft",
                origin="run",
                run_id=run.id,
                # A run's draft is kept: its unverified dates are marked and recorded.
                unverified_dates="mark",
                # The slug of a document the run was to create: never another document's
                # next version (checked under the document's row lock).
                run_creates=run.document_id is None,
            )
        except DraftError as exc:
            # The string stays (older readers); the run page, the Inbox and MCP read the
            # problems and their summary, and the problems are the findings when the draft
            # goes back to the writer (_send_back). All capped (rejection.refused).
            return rejection.refused(name, exc.problems)
        except (docs_service.NotFoundError, docs_service.ImportConflictError) as exc:
            return {"error": f"{name} was not imported: {exc}"}
        if not result.created and source_id and result.version.source is None:
            # The same draft was already imported (an agent pushed it) without its
            # provenance: record it now.
            row = await s.get(DocumentVersion, result.version.id)
            if row is not None and row.source_version_id is None:
                row.source_version_id = source_id
                await s.commit()
                # Without its date markers (the import checked its dates; none of the
                # markers is read here): never a wait for dates in the middle of a tick.
                result.version = await docs_service.read_version(s, row, require_dates=False)
        if run.flow == "feedback_loop" and any(knobs.get(k) for k in SENT_KNOBS):
            await _settle_sent_items(s, run, result.version.number, result.resolutions)
        if (run.knobs or {}).get("intake_id"):
            # C5: the intake's answers given while this draft was written become feedback.
            from oracle.intake import late_answers

            # Committed also when it raised nothing: it links the intake to its PRD, which
            # an answer given later needs to become feedback (#587 review).
            await late_answers.sync(s, run, result.version.document_id)
            await s.commit()
        document = await s.get(Document, result.version.document_id)
        out: dict[str, Any] = {
            "document_id": str(result.version.document_id),
            "slug": document.slug if document else None,
            "kind": document.kind if document else kind,
            "version": result.version.number,
            "created": result.created,
            "warnings": [w.code for w in result.version.warnings],
        }
        source = result.version.source
        if source is not None:
            out["source"] = source.model_dump(mode="json")
            out["prd_links"] = await _prd_links(s, markdown, source)
    return out


async def _run_importer(
    db: AsyncSession, run: Run, name: str, files: dict[str, str]
) -> dict[str, Any]:
    """A lane's importer (oracle.runs.extensions) on the segment's files, as the run's
    creator."""
    tenant_id = current_tenant(db)
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": str(exc)}
    # The importer works in its own transactions (a spec's design check takes up to
    # DESIGN_CHECK_SECONDS): this session holds none open meanwhile.
    await db.commit()
    return await extensions.run_importer(name, db, run, files, principal)


async def _settle_sent_items(
    s: AsyncSession, run: Run, number: int, resolutions: list[Resolution]
) -> None:
    """D12: what a feedback loop started from Build next draft was sent, once its draft
    is version ``number``: the accepted section-text changes and the discussions' section
    changes are applied in it (as the built-in path's apply records them), and the items
    staged for the agents that the draft's resolutions answer leave Staged. Their status
    is the import's: an agent never closes a whole-draft item itself, so a person confirms
    it in the version's review.
    ``resolutions`` are the import's own parse of the draft: it is not parsed again."""
    knobs = run.knobs or {}
    answered = {str(r.feedback_id) for r in resolutions}
    sent = [uuid.UUID(str(i)) for i in knobs.get("feedback_ids") or [] if str(i) in answered]
    items = list(
        await s.scalars(
            select(FeedbackItem).where(
                FeedbackItem.id.in_(sent), FeedbackItem.document_id == run.document_id
            )
        )
    )
    for item in items:
        item.staged_for_agents_at = item.staged_for_agents_by = None
    ids = [uuid.UUID(str(i)) for i in knobs.get("suggestion_ids") or []]
    rows = list(
        await s.scalars(
            select(LlmSuggestion).where(
                LlmSuggestion.id.in_(ids),
                LlmSuggestion.document_id == run.document_id,
                LlmSuggestion.status == "accepted",
                LlmSuggestion.applied_in_version.is_(None),
            )
        )
    )
    for row in rows:
        row.status = "applied"
        row.applied_in_version = number
    changes = await _apply_section_changes(s, run, number)
    if rows or items or changes:
        await s.commit()


async def _apply_section_changes(s: AsyncSession, run: Run, number: int) -> int:
    """G4: the section changes staged from discussions that the run was sent are applied
    in its draft, version ``number``, and their discussion changes done, as Oracle's own
    apply (``next_draft.apply``) records them. A run that writes no draft (failed,
    cancelled) never gets here: its rows stay staged for the next draft."""
    from oracle.discussions.models import DiscussionChange
    from oracle.staging.models import NextDraftChange

    ids = [uuid.UUID(str(i)) for i in (run.knobs or {}).get("next_draft_change_ids") or []]
    if not ids:
        return 0
    rows = list(
        await s.scalars(
            select(NextDraftChange).where(
                NextDraftChange.id.in_(ids),
                NextDraftChange.document_id == run.document_id,
                NextDraftChange.status == "staged",
            )
        )
    )
    for r in rows:
        r.status = "applied"
        r.applied_in_version = number
        change = (
            await s.get(DiscussionChange, r.discussion_change_id)
            if r.discussion_change_id
            else None
        )
        if change is not None and change.status == "staged":
            change.status = "done"
            change.decision_note = f"Applied in draft {number}"
    return len(rows)


async def _import_baseline(db: AsyncSession, run: Run, text: str) -> dict[str, Any]:
    """Merge baseline.yaml through the baseline's YAML import, in its own transaction:
    the run's agent writes, as the run's creator; locked items get proposals."""
    tenant_id = current_tenant(db)
    user = await db.get(User, run.created_by) if run.created_by else None
    token = None if user or not run.created_by else await db.get(ApiToken, run.created_by)
    try:
        principal = _creator(tenant_id, user, token)
    except LookupError as exc:
        return {"error": str(exc)}
    async with tenant_session(tenant_id) as s:
        # H11: how far Oracle may go with the baseline, read now (a change applies to the
        # next merge). Below Act every write is a proposal; at Observe nothing is merged.
        level = await autonomy.level(s, "baseline")
        if level == "observe":
            return {"skipped": True, "autonomy": _baseline_autonomy(level)}
        try:
            result = await yaml_io.import_yaml(
                s,
                principal,
                text,
                run_id=run.id,
                origin="agent",
                reason="Run baseline.yaml",
                proposals_only=level != "act",
            )
        except yaml_io.YamlInvalid as exc:
            problems = "; ".join(
                f"[{p.code}] {p.message}" + (f" ({p.where})" if p.where else "")
                for p in exc.problems
            )
            return {"error": f"baseline.yaml was rejected: {problems}"}
        await s.commit()
    out = result.model_dump(mode="json")
    if level != "act":
        out["autonomy"] = _baseline_autonomy(level)
    return out


def _baseline_autonomy(level: str) -> dict[str, str]:
    """What the run page says when the baseline's level changed the merge (H11)."""
    if level == "observe":
        note = "Baseline merge skipped: Oracle is set to observe the baseline"
    else:
        note = f"Baseline changes became proposals: Oracle is set to {level} for the baseline"
    return {"level": level, "note": note}


def _current_attempt(art: dict[str, Any], segment: RunSegment) -> dict[str, Any]:
    """The segment's current attempt: the latest on its workflow. A found earlier
    submission (a search, a cancel's lookup) is listed by its number and may sit after
    it; the last listed is taken only when none is on the segment's workflow."""
    ours = [a for a in art["attempts"] if a.get("workflow_id") == segment.swarm_workflow_id]
    if ours:
        return ours[-1]
    return art["attempts"][-1] if art["attempts"] else {}


async def _relocked(
    db: AsyncSession, run: Run, segment: RunSegment, attempt: int, *, gate: bool
) -> list[RunSegment] | None:
    """After :func:`_advance` committed mid-way (an import runs in its own transaction):
    take the run's row lock again (the review gate first, with ``gate``) and read the
    run and its segments afresh into the same objects. None when the run is no longer
    running (cancelled, by its owner or a disable of its creator, failed, paused) or the
    segment is no longer this attempt, succeeded and being advanced: nothing more is
    written for it, nothing opened or submitted."""
    if gate:
        from oracle.review import publish

        await publish.gate_lock(db, shared=True)
    fresh, segments = await _locked(db, run.id)
    now = next((s for s in segments if s.id == segment.id), None)
    if fresh is None or fresh.status != "running" or now is None or now.status != "succeeded":
        return None
    last = _current_attempt(_art(now), now)
    if last.get("attempt", 1) != attempt or not last.get("advanced"):
        return None
    return segments


async def _advance(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    wait: dict[str, Any] | None = None,
    *,
    gate: bool = False,
) -> bool:
    """After a segment succeeded: import its draft, then open or skip its checkpoint
    (and queue the next segment for :func:`submit_queued`: :func:`_submit`).

    An import commits first (it runs in its own transaction), which releases the run's
    row lock and, with ``gate`` (the caller held the review gate), the gate: both are
    taken again and the run re-read before anything more is written (:func:`_relocked`).

    ``wait``: the step of the live workflow that waits for this checkpoint's decision
    (adapter v2); the Inbox decision is posted to it.

    Returns False when this attempt of the segment was already advanced. One that was
    interrupted after its first commit (an import raised) is marked ``opening`` and is
    advanced again by the next tick (:func:`_resume_advance`): the imports are
    idempotent, and the checkpoint opens then (its wait kept in ``opening_wait``).
    It also returns False when the run or the segment changed during an import.
    """
    flow, knobs = _flow(run), _knobs(run)
    sdef = flow.segment(segment.name)
    art = _art(segment)
    attempt = _current_attempt(art, segment)
    if attempt.get("advanced") is True:
        return False
    # Set to True in the transaction that opens (or skips) the checkpoint.
    attempt["advanced"] = "opening"
    if wait is not None:
        # W5: the token is held from before the import's commit until the checkpoint
        # that stands for this wait is added (cleared in the same transaction).
        _set_knob(
            run,
            "opening_wait",
            {
                "workflow_id": wait.get("workflow_id"),
                "step_id": wait.get("step_id"),
                "kind": sdef.checkpoint_for(await _target_kind(db, run)),
                "seq": segment.seq,
                "wait": wait,
            },
        )
    number = attempt.get("attempt", 1)
    imported: dict[str, Any] | None = None
    baseline_import: dict[str, Any] | None = None
    if sdef.imports_baseline:
        text = art["files"].get("baseline.yaml")
        if text is None:
            baseline_import = {"error": "the segment left no baseline.yaml"}
        else:
            # Committed first: the import runs in its own transaction.
            _set_art(segment, art)
            await db.commit()
            baseline_import = await _import_baseline(db, run, text)
            # The commit released the run's row lock: take it again, read the run again.
            fresh = await _relocked(db, run, segment, number, gate=gate)
            if fresh is None:
                return False
            segments = fresh
        art["baseline_import"] = baseline_import
    items_check: dict[str, Any] | None = None
    if ITEMS_FILE in sdef.outputs:
        try:
            # In a savepoint: a database error while checking rolls back the check's own
            # reads only, and the tick's transaction (the segment, the run's row lock)
            # stays usable.
            async with db.begin_nested():
                items_check = await _check_items(
                    db, run, art["files"].get(ITEMS_FILE), segment, number
                )
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # noqa: BLE001 - a bad file fails the check, never the tick
            log.exception("checking %s of run %s failed", ITEMS_FILE, run.id)
            items_check = reasons.summarize(
                {
                    "items": 0,
                    "by_horizon": {},
                    "problems": [
                        {
                            "code": "unreadable_yaml",
                            "message": f"{ITEMS_FILE} could not be checked ({type(exc).__name__})",
                        }
                    ],
                },
                [],
                None,
            )
        art["items_check"] = items_check
    draft_error: str | None = None
    if flow.stores_draft_items:
        from oracle.roadmap import draft_items

        try:
            # In a savepoint, as the check: a failed store fails the run, never the tick.
            async with db.begin_nested():
                stored, draft_error = await draft_items.store(
                    db, run, art["files"].get(ITEMS_FILE), items_check or {}
                )
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # noqa: BLE001
            log.exception("storing the draft items of run %s failed", run.id)
            draft_error = f"the roadmap items could not be stored ({type(exc).__name__})"
        art["draft_items"] = {"error": draft_error} if draft_error else {"stored": stored}
    fs_check: dict[str, Any] | None = None
    scope_id: uuid.UUID | None = None
    if feature_set.FILE in sdef.outputs:
        try:
            # In a savepoint, as the items check: a database error rolls back the check's
            # own reads and writes only.
            async with db.begin_nested():
                fs_check, scope_id = await _check_feature_set(
                    db, run, segment, number, art["files"].get(feature_set.FILE)
                )
        except Exception as exc:  # noqa: BLE001 - a bad file fails the check, never the tick
            log.exception("checking %s of run %s failed", feature_set.FILE, run.id)
            failed = feature_set.FeatureSetCheck()
            failed.add(
                "unreadable_yaml",
                f"{feature_set.FILE} could not be checked ({type(exc).__name__})",
            )
            fs_check = failed.as_json()
        art["feature_set_check"] = fs_check
    order_check: dict[str, Any] | None = None
    snapshot_id: uuid.UUID | None = None
    if run_order.FILE in sdef.outputs:
        try:
            # In a savepoint, as the items check: a database error rolls back the check's
            # own reads and writes only.
            async with db.begin_nested():
                order_check, snapshot_id = await _check_priority_order(
                    db, run, segment, number, art["files"].get(run_order.FILE)
                )
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # noqa: BLE001 - a bad file fails the check, never the tick
            log.exception("checking %s of run %s failed", run_order.FILE, run.id)
            failed = run_order.OrderCheck()
            failed.add(
                "unreadable_yaml", f"{run_order.FILE} could not be checked ({type(exc).__name__})"
            )
            order_check = failed.as_json()
        art["priority_check"] = order_check
    launch_import: dict[str, Any] | None = None
    if flows.LAUNCH_FILE in sdef.outputs:
        from oracle.launches import service as launches_service

        try:
            # In a savepoint, as the items check: a bad file never fails the tick.
            async with db.begin_nested():
                launch_import = await launches_service.import_kit_run(
                    db, run, art["files"].get(flows.LAUNCH_FILE)
                )
        except Exception as exc:  # noqa: BLE001
            log.exception("importing %s of run %s failed", flows.LAUNCH_FILE, run.id)
            launch_import = {"error": f"{flows.LAUNCH_FILE} could not be imported "
                             f"({type(exc).__name__})"}  # fmt: skip
        art["launch_import"] = launch_import
    triage_import: dict[str, Any] | None = None
    if flows.TRIAGE_FILE in sdef.outputs:
        from oracle.requests import triage

        try:
            # In a savepoint, as the items check: a bad file never fails the tick.
            async with db.begin_nested():
                triage_import = await triage.apply(db, run, art["files"].get(flows.TRIAGE_FILE))
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # noqa: BLE001
            log.exception("applying %s of run %s failed", flows.TRIAGE_FILE, run.id)
            triage_import = {"error": f"{flows.TRIAGE_FILE} could not be applied "
                             f"({type(exc).__name__})"}  # fmt: skip
        for note in triage_import.get("notes") or []:
            _note_art(art, note)
        art["triage_import"] = triage_import
    if sdef.imports_draft:
        kind = await _target_kind(db, run)
        name = flows.draft_file(kind)
        markdown = art["files"].get(name)
        if markdown is None:
            # The same shape as a refusal (_import_draft): the run page, the Inbox, MCP
            # and the send-back findings read it alike.
            missing = [
                ImportProblem(code=rejection.MISSING_DRAFT, message=f"the segment left no {name}")
            ]
            imported = {
                "error": missing[0].message,
                "problems": [p.model_dump(mode="json") for p in missing],
                "summary": rejection.summary(name, missing),
            }
        else:
            # Committed first: the import runs in its own transaction.
            _set_art(segment, art)
            await db.commit()
            imported = await _import_draft(db, run, kind, markdown)
            # The commit released the run's row lock: take it again, read the run again.
            fresh = await _relocked(db, run, segment, number, gate=gate)
            if fresh is None:
                return False
            segments = fresh
            if imported.get("document_id"):
                run.document_id = uuid.UUID(imported["document_id"])
                _set_knob(run, "document_slug", None)
                # Rule 6 (C6, C8): the run's PRD scope and priority order name the
                # document from now on.
                await feature_set.fill_document(db, run.id, run.document_id)
                await run_order.fill_document(db, run.id, run.document_id)
                await _link_requests(db, run)
                _check_goal_trace(run, art, imported, markdown)
        art["import"] = imported
    if sdef.importer:
        # Committed first: the importer runs in its own transaction.
        _set_art(segment, art)
        await db.commit()
        try:
            imported = await _run_importer(db, run, sdef.importer, art["files"])
        except safe_yaml.ParseBusy:
            raise  # no worker for it: this tick gives up, the next retries
        except Exception as exc:  # the checkpoint must open whatever the importer does
            log.exception("run %s: importer %s failed", run.id, sdef.importer)
            imported = {"error": f"the {sdef.importer} import failed ({type(exc).__name__})"}
        # The commit released the run's row lock: take it again.
        await db.execute(select(Run.id).where(Run.id == run.id).with_for_update())
        if imported.get("document_id"):
            run.document_id = uuid.UUID(imported["document_id"])
            _set_knob(run, "document_slug", None)
            await _link_requests(db, run)
        art["import"] = imported
    attempt["advanced"] = True
    _set_art(segment, art)

    payload = {
        "segment_seq": segment.seq,
        "segment": segment.name,
        "attempt": attempt.get("attempt", 1),
        "artifacts": sorted(art["files"].keys()),
    }
    if sdef.checkpoint == eng_check.KIND and flows.BRIEFS_FILE in sdef.outputs:
        # F4: what the Engineering check's screen and its gate read.
        payload[eng_check.PAYLOAD_KEY] = await eng_check.check_segment(
            db, run, art["files"].get(flows.BRIEFS_FILE)
        )
    if sdef.checkpoint == eng_dates.KIND:
        # F4 lane B: what the Engineering dates' screen and its gate read.
        payload[eng_dates.PAYLOAD_KEY] = await eng_dates.summarize(
            db, run, art["files"].get(eng_dates.FILE)
        )
    if imported is not None:
        payload["import"] = imported
    if baseline_import is not None:
        payload["baseline_import"] = baseline_import
    if items_check is not None:
        payload["items_check"] = items_check
    if fs_check is not None:
        payload["feature_set_check"] = fs_check
        if scope_id is not None:
            payload["scope_id"] = str(scope_id)
    if order_check is not None:
        payload["priority_check"] = order_check
        if snapshot_id is not None:
            payload["priority_snapshot_id"] = str(snapshot_id)
    if launch_import is not None:
        payload["launch_import"] = launch_import
    if triage_import is not None:
        payload["triage_import"] = triage_import
    if wait is not None:
        payload["wait"] = wait
        _set_knob(run, "opening_wait", None)
    if sdef.checkpoint is None:
        # No stop (F5-2's code_map index): a failed import fails the run, else it goes on.
        for result in (baseline_import, imported, launch_import):
            if result is not None and result.get("error"):
                await _finish(db, run, "failed", result["error"])
                return True
        await _next(db, run, segment, segments)
        return True
    checkpoint_kind = sdef.checkpoint_for(await _target_kind(db, run))
    if (
        wait is not None
        and imported is not None
        and imported.get("problems")
        and knobs.checkpoints.get(sdef.checkpoint, True)
        and await _send_back(
            db, run, segment, segments, wait, imported, await _target_kind(db, run), checkpoint_kind
        )
    ):
        return True
    checkpoint_id = uuid.uuid4()
    # H11 ``priorities`` at Act: Oracle saves an order inside the limits itself.
    oracle_orders = (
        order_check is not None
        and snapshot_id is not None
        and knobs.checkpoints.get(sdef.checkpoint, True)
        and await _oracle_saves_order(db, order_check, snapshot_id)
    )
    if knobs.checkpoints.get(sdef.checkpoint, True) and not oracle_orders:
        db.add(
            Checkpoint(
                id=checkpoint_id,
                run_id=run.id,
                kind=checkpoint_kind,
                status="pending",
                approver_role=sdef.approver_role,
                payload=payload,
            )
        )
        await _link_scope(db, scope_id, checkpoint_id)
        await _link_order(db, snapshot_id, checkpoint_id)
        run.status = "awaiting_checkpoint"
        await webhooks.capture(
            db, "run.checkpoint_waiting", audit.ORACLE, run_id=run.id, checkpoint_id=checkpoint_id
        )
        return True
    db.add(
        Checkpoint(
            id=checkpoint_id,
            run_id=run.id,
            kind=checkpoint_kind,
            status="skipped",
            approver_role=sdef.approver_role,
            note=ORDER_SAVED_BY_ORACLE if oracle_orders else "Turned off when the run started.",
            payload=payload,
            decided_at=_now(),
        )
    )
    await _link_scope(db, scope_id, checkpoint_id)
    await _link_order(db, snapshot_id, checkpoint_id)
    for result in (baseline_import, imported, launch_import, triage_import):
        if result is not None and result.get("error"):
            await _finish(db, run, "failed", result["error"])
            return True
    if flow.stores_draft_items:
        # E1: the items are stored with their problems; the review is on the Roadmap
        # tab. The run fails only when nothing could be stored.
        if draft_error:
            await _finish(db, run, "failed", draft_error)
            return True
    elif items_check is not None and items_check["problems"]:
        problems = "; ".join(f"[{p['code']}] {p['message']}" for p in items_check["problems"][:5])
        await _finish(db, run, "failed", f"{ITEMS_FILE} was rejected: {problems}")
        return True
    if fs_check is not None:
        blocking = [p for p in fs_check["problems"] if p.get("blocking", True)]
        if blocking or scope_id is None:
            problems = "; ".join(f"[{p['code']}] {p['message']}" for p in blocking[:5])
            await _finish(db, run, "failed", f"{feature_set.FILE} was rejected: {problems}")
            return True
        # Rule 5 (C6): the stop is off and nothing blocks, so Oracle approves the scope.
        scope = await db.get(PrdScope, scope_id)
        if scope is not None:
            await feature_set.approve(db, scope, None, run.document_id)
            await audit.record(
                db,
                audit.ORACLE,
                "prd_scope.approved",
                "prd_scope",
                scope.id,
                {"by": "oracle", "reason": "stop off", "run_id": str(run.id)},
            )
    if order_check is not None:
        blocking = [p for p in order_check["problems"] if p.get("blocking", True)]
        if blocking or snapshot_id is None:
            problems = "; ".join(f"[{p['code']}] {p['message']}" for p in blocking[:5])
            await _finish(db, run, "failed", f"{run_order.FILE} was rejected: {problems}")
            return True
        # Rule 5 (C8): the stop is off and nothing blocks, so Oracle saves the order.
        snapshot = await db.get(PrioritySnapshot, snapshot_id)
        if snapshot is not None:
            run_order.approve(snapshot, None, run.document_id)
            await audit.record(
                db,
                audit.ORACLE,
                "priority_snapshot.approved",
                "priority_snapshot",
                snapshot.id,
                {
                    "by": "oracle",
                    "reason": "autonomy" if oracle_orders else "stop off",
                    "run_id": str(run.id),
                },
            )
            if oracle_orders:
                await _tell_order_saved(db, run)
    await _next(db, run, segment, segments)
    return True


async def _link_requests(db: AsyncSession, run: Run) -> None:
    """C1: the PRD a brief's run makes links the requests behind the brief."""
    # Here, not at the top: oracle.requests reads this module.
    from oracle.requests import service as requests_service

    await requests_service.link_run_document(db, run)


def _check_goal_trace(
    run: Run, art: dict[str, Any], imported: dict[str, Any], markdown: str
) -> None:
    """#260: the imported PRD's Goal trace covers every target goal of the run; one it
    leaves out is a warning on the import and a note on the run."""
    targets = {g["key"]: g["title"] for g in (run.knobs or {}).get("target_goals") or []}
    missing = flows.goal_trace_missing(markdown, list(targets.items()))
    if not missing:
        return
    imported["warnings"] = [*imported.get("warnings", []), "goal_trace_incomplete"]
    named = ", ".join(f"{k} ({targets[k]})" for k in missing)
    _note_art(
        art, f"The PRD's Goal trace leaves out target goal{'s' * (len(missing) > 1)}: {named}"
    )


async def _check_feature_set(
    db: AsyncSession, run: Run, segment: RunSegment, attempt: int, text: str | None
) -> tuple[dict[str, Any], uuid.UUID]:
    """C6: feature_set.yaml checked against the run's PRD slug and the baseline, and the
    proposed scope written from it (even with blocking problems, so they can be fixed)."""
    known = await feature_set.known_for_run(db, run.id)
    if text is None:
        check = feature_set.FeatureSetCheck()
        check.add("missing_file", f"the segment left no {feature_set.FILE}")
    else:
        doc = await db.get(Document, run.document_id) if run.document_id else None
        slug = doc.slug if doc is not None else (run.knobs or {}).get("document_slug")
        # In a worker thread with a time cap: agent output never holds the event loop.
        check = await feature_set.check_feature_set_async(text, document=slug, known=known)
    scope = await feature_set.write_scope(
        db, run, segment_seq=segment.seq, attempt=attempt, check=check, known=known
    )
    return check.as_json(), scope.id


# The priority stop's note when Oracle saved the order itself (H11 ``priorities`` at Act).
ORDER_SAVED_BY_ORACLE = "Oracle saved this order: Order priorities is set to Act within limits."


async def _oracle_saves_order(
    db: AsyncSession, check: dict[str, Any], snapshot_id: uuid.UUID
) -> bool:
    """Whether Oracle saves the run's order with no stop: ``priorities`` at Act, nothing
    blocking, and every move within one goal and the most places an owner allows."""
    if not await autonomy.allows(db, "priorities", "act"):
        return False
    if any(p.get("blocking", True) for p in check.get("problems") or []):
        return False
    snapshot = await db.get(PrioritySnapshot, snapshot_id)
    limits = await autonomy.limits(db, "priorities")
    if snapshot is None or limits is None:
        return False
    most = int(getattr(limits, "max_rank_move", 0))
    return run_order.outside_limits(list(snapshot.ranking or []), max_rank_move=most) is None


async def _tell_order_saved(db: AsyncSession, run: Run) -> None:
    """The run's starter hears that Oracle saved the order (an "Oracle did" row)."""
    document = await db.get(Document, run.document_id) if run.document_id else None
    name = document.title if document else (run.knobs or {}).get("document_slug") or "this run"
    await autonomy.acted(
        db,
        "priorities",
        summary=f"Saved the priority order of {name}, within one goal and your limit",
        subject={"kind": "run", "key": str(run.id), "href": f"/runs/{run.id}"},
        undo=None,
        notify=[run.created_by] if run.created_by else [],
    )


async def _check_priority_order(
    db: AsyncSession, run: Run, segment: RunSegment, attempt: int, text: str | None
) -> tuple[dict[str, Any], uuid.UUID]:
    """C8: priority.yaml checked against the baseline, the run's approved PRD scope and the
    live ranking, and stored as the run's proposed snapshot (even with blocking problems,
    so they can be seen and sent back)."""
    known, scope_id = await run_order.known_for_run(db, run)
    if text is None:
        check = run_order.OrderCheck()
        check.add("unreadable_yaml", f"the segment left no {run_order.FILE}")
    else:
        # In a worker thread with a time cap: agent output never holds the event loop.
        check = await run_order.check_order_async(text, known=known)
    snapshot = await run_order.propose(
        db, run, segment_seq=segment.seq, attempt=attempt, check=check, known=known,
        scope_id=scope_id,
    )  # fmt: skip
    return check.as_json(), snapshot.id


async def _link_order(
    db: AsyncSession, snapshot_id: uuid.UUID | None, checkpoint_id: uuid.UUID
) -> None:
    """The proposed order names the checkpoint that decides it (added in the same flush)."""
    if snapshot_id is None:
        return
    await db.flush()
    snapshot = await db.get(PrioritySnapshot, snapshot_id)
    if snapshot is not None:
        snapshot.checkpoint_id = checkpoint_id


async def _link_scope(
    db: AsyncSession, scope_id: uuid.UUID | None, checkpoint_id: uuid.UUID
) -> None:
    """The proposed scope names the checkpoint that decides it (added in the same flush)."""
    if scope_id is None:
        return
    await db.flush()
    scope = await db.get(PrdScope, scope_id)
    if scope is not None:
        scope.checkpoint_id = checkpoint_id


# Who Oracle's own answer is from, on the revision's attempt.
SENT_BACK_BY = "Oracle"


def _send_back_entry(
    run: Run, segment: RunSegment, wait: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """The live workflow and the segment's plan entry when Oracle answers this wait itself
    (:func:`_send_back`): a review of the workflow's last segment, open (not answered or
    ended), followed by a revise step and by a later review for the person."""
    wf = _drivable(run)
    if wf is None or wf.get("id") != wait.get("workflow_id"):
        return None
    if not wait.get("task_id") or wait.get("console") or wait.get("ended"):
        return None
    planned = wf.get("segments") or []
    entry = _plan_entry(wf, segment.seq)
    if entry is None or planned[-1].get("seq") != segment.seq:
        return None
    round_ = int(wait.get("round") or 1)
    reviews, revises = entry.get("reviews") or [], entry.get("revises") or []
    if round_ > len(revises) or round_ >= len(reviews) or reviews[round_ - 1] != wait["step_id"]:
        return None
    return wf, entry


async def _send_back(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    wait: dict[str, Any],
    imported: dict[str, Any],
    kind: str,
    checkpoint: str,
) -> bool:
    """A refused draft goes back to the writer before a person is asked (owner,
    2026-10-20). When the segment-end import refused the draft and the wait is a review
    of the workflow's last segment that a revise step and a later review follow, Oracle
    answers it itself: NOT_YET, with the import's problems grouped in plain words as
    findings (:func:`workflow.import_findings`). The revision runs in the same workflow
    and its draft is imported when the next review opens; only one still refused there
    reaches the Inbox (a person decides that review).

    The answer is Oracle's, never a person's: no checkpoint stands for the wait, nothing
    is decided or approved, it is noted on the segment and audited with actor ``oracle``,
    and the run's token stays read-only (W5) until the next round's checkpoint stands
    (:func:`_hold_plan`). Returns False, leaving the review to the person, when the wait
    does not qualify (an earlier segment's checkpoint has one round and no revise step),
    too little of the credential is left for the revision (the tail rule), or SwarmCloud
    did not take the answer."""
    found = _send_back_entry(run, segment, wait)
    if found is None:
        return False
    wf, entry = found
    round_ = int(wait.get("round") or 1)
    step = wait["step_id"]
    name = flows.draft_file(kind)
    left = _left(wf)
    steps = workflow.agent_steps_after(wf.get("segments") or [], segment.seq, False, round_)
    tail = workflow.tail_seconds(steps, get_runtime_settings())
    if left < tail:
        _note(
            segment,
            f"{name} was refused at import. With {_duration(left)} of the run's credential "
            f"left, under the {_duration(tail)} the revision needs, Oracle did not send it "
            f"back to the writer: {checkpoint} waits for a person.",
        )
        return False
    findings = workflow.import_findings(
        name, imported.get("problems") or [], imported.get("problems_total")
    )
    payload = {"verdict": NOT_YET, "findings": findings}
    # The same id for the same wait: a post repeated after a lost response is a replay.
    answer_id = str(uuid.uuid5(run.id, f"send-back/{wf['id']}/{step}"))
    runtime = get_runtime()
    for tries in (1, 2):
        try:
            await runtime.answer(wf["id"], step, answer_id=answer_id, payload=payload)
            break
        except RuntimeUnavailable as exc:
            if exc.retryable and tries == 1:
                continue
            log.warning("run %s: refused draft not sent back on %s: %s", run.id, step, exc)
            _note(
                segment,
                f"{name} was refused at import, and Oracle could not send it back to the "
                f"writer (SwarmCloud: {_shown(exc)}): {checkpoint} waits for a person.",
            )
            return False
    _note(
        segment,
        f"{name} was refused at import, so Oracle sent the draft back to the writer before "
        f"asking a person: it answered {step} (round {round_}) with NOT_YET and the import's "
        "problems as findings. This is Oracle's answer, not a person's decision: nothing is "
        "approved, and the run's agents may not write to Oracle until a person's answer "
        "counts. The revision is imported when the next review opens; if it is still "
        f"refused, {checkpoint} waits in the Inbox.",
    )
    await audit.record(
        db,
        audit.ORACLE,
        "run.draft_sent_back",
        "run",
        run.id,
        {
            "segment": segment.name,
            "seq": segment.seq,
            "kind": checkpoint,
            "workflow_id": wf["id"],
            "step_id": step,
            "round": round_,
            "verdict": NOT_YET,
            "findings": findings,
            "error": imported.get("error"),
        },
    )
    entry["oracle_answered"] = [*(entry.get("oracle_answered") or []), step]
    await _follow(
        db,
        run,
        None,
        segment,
        segments,
        wf,
        entry,
        round_,
        False,
        note="\n".join(findings),
        note_by=SENT_BACK_BY,
    )
    # The revision's attempt is Oracle's send-back: the run reads "Revising: sent back by
    # Oracle" until it is imported (_sent_back).
    art = _art(segment)
    art["attempts"][-1]["sent_back"] = True
    _set_art(segment, art)
    return True


# A resumed advance that raises this many times stops: its step fails, and an owner
# retries it from the Inbox (:func:`retry_import`).
RESUME_TRIES = 5


def _resuming(run: Run, segments: list[RunSegment]) -> RunSegment | None:
    """The segment whose advance was interrupted after its first commit (:func:`_advance`
    raised in an import), to advance again: none once its step failed
    (:data:`RESUME_TRIES`)."""
    if run.status != "running":
        return None
    return next(
        (
            s
            for s in segments
            if s.status == "succeeded" and _current_attempt(_art(s), s).get("advanced") == "opening"
        ),
        None,
    )


async def _resume_advance(
    db: AsyncSession,
    run: Run,
    segment: RunSegment,
    segments: list[RunSegment],
    stats: "_TickStats",
) -> None:
    """An advance interrupted after its first commit: advanced again now, with the wait
    it was opening a checkpoint on (the imports are idempotent: a locked item's proposal
    is the open one already there)."""
    opening = (run.knobs or {}).get("opening_wait")
    wait = None
    if isinstance(opening, dict) and opening.get("seq") == segment.seq:
        wait = opening.get("wait")
    log.warning("run %s: advancing %s again (interrupted)", run.id, segment.name)
    if await _advance(db, run, segment, segments, wait=wait):
        stats.advanced += 1


async def _resume_failed(
    db: AsyncSession, run_id: uuid.UUID, seq: int, exc: Exception, stats: "_TickStats"
) -> tuple[Run, list[RunSegment]]:
    """A resumed advance raised: what it did is rolled back, and the failure is counted
    on the segment's attempt (the error's class and when; never its message, which may
    carry what the agents wrote). At :data:`RESUME_TRIES` it is tried no more: the step
    fails, and owners see "Couldn't import" in the Inbox with Retry
    (:func:`retry_import`). Returns the run and its segments as they are now, locked, for
    the rest of the tick (the workflow is still read: its status, cost and the ceiling)."""
    error = type(exc).__name__
    log.warning("run %s: advancing segment %s again failed (%s)", run_id, seq, error, exc_info=exc)
    await db.rollback()
    run = await _get_run(db, run_id, lock=True)
    segments = await _segments(db, run_id, fresh=True)
    segment = next((s for s in segments if s.seq == seq), None)
    if segment is None or _resuming(run, segments) is not segment:
        return run, segments
    art = _art(segment)
    attempt = _current_attempt(art, segment)
    count = int((attempt.get("resume_failures") or {}).get("count") or 0) + 1
    now = _now().isoformat()
    # ``pass``: this tick's pass over the run, so that the pass run again after a runtime
    # call (_replay) neither tries the advance again nor counts it twice (_tick_run).
    failed = {"count": count, "error": error, "at": now, "pass": stats.pass_id}
    attempt["resume_failures"] = failed
    stats.errors.append(_resume_error(run_id, segment, failed))
    if count >= RESUME_TRIES:
        segment.status = "failed"
        segment.error = (
            f"Couldn't import its output: {error} on {count} tries in a row. Oracle stopped "
            "trying; an owner can retry it from the Inbox."
        )
        _set_knob(run, "import_failed", {"seq": seq, "error": error, "count": count, "at": now})
        await audit.record(
            db,
            None,
            "run.import_failed",
            "run",
            run.id,
            {"segment": segment.name, "error": error, "tries": count},
        )
    _set_art(segment, art)
    await db.commit()
    # The commit released the run's row lock: taken again, read as they are now.
    run = await _get_run(db, run_id, lock=True)
    return run, await _segments(db, run_id, fresh=True)


def _resume_error(run_id: uuid.UUID, segment: RunSegment, failed: dict[str, Any]) -> str:
    return (
        f"run {run_id}: importing {segment.name}'s output failed ({failed.get('error')}), "
        f"try {failed.get('count')} of {RESUME_TRIES}"
    )


async def _check_items(
    db: AsyncSession,
    run: Run,
    text: str | None,
    segment: RunSegment | None = None,
    attempt: int | None = None,
) -> dict[str, Any]:
    """roadmap_items.yaml checked against the run's PRD version (oracle.runs.roadmap),
    with every item's reasons (oracle.runs.reasons); after a send-back with a review (D6),
    how this attempt answered it (``resolution``) and its diff (``diff``)."""
    if text is None:
        missing = {
            "items": 0,
            "by_horizon": {},
            "problems": [{"code": "missing_file", "message": f"the segment left no {ITEMS_FILE}"}],
        }
        return reasons.summarize(missing, [], None)
    prior = await prior_review(db, run, segment, attempt) if segment is not None else None
    checked = await checked_items(db, run, text, prior)
    return reasons.summarize(
        checked.check.as_json(),
        checked.reasons,
        checked.base,
        checked.partial,
        checked.resolution,
        checked.diff,
    )


@dataclass(frozen=True)
class PriorReview:
    """D6: the review a send-back delivered (D4) and the attempt it reviewed (D5)."""

    review: dict[str, Any]
    attempt: int
    text: str
    # The attempt that answers it.
    answered_by: int


async def prior_review(
    db: AsyncSession, run: Run, segment: RunSegment, attempt: int | None
) -> PriorReview | None:
    """The review the segment's ``attempt`` answers: the send-back of the previous attempt
    (``artifacts["previous"]``, D5) whose checkpoint stored a review (D4); None for a first
    attempt, a note-only send-back's kept file, or a kind with no item file."""
    previous = (segment.artifacts or {}).get("previous")
    if not isinstance(previous, dict):
        return None
    text = (previous.get("files") or {}).get(ITEMS_FILE)
    number = previous.get("attempt")
    if not isinstance(text, str) or not isinstance(number, int):
        return None
    if attempt is not None and attempt <= number:
        return None
    for cp in reversed(await _checkpoints(db, [run.id])):
        if (
            (cp.payload or {}).get("segment_seq") == segment.seq
            and cp.status == "changes_requested"
            and isinstance(cp.review, dict)
            and cp.review.get("attempt") == number
        ):
            return PriorReview(cp.review, number, text, attempt or number + 1)
    return None


@dataclass
class CheckedItems:
    """roadmap_items.yaml checked, with its reasons: what :func:`_check_items` stores and
    the shared draft (oracle.runs.actions) reads again on every read."""

    check: roadmap.ItemsCheck
    reasons: list[dict[str, Any]]
    base: dict[str, Any] | None
    partial: bool
    # The section keys of the run's PRD version; None without one.
    prd_sections: set[str] | None
    # D6: how the attempt answered the review it was sent back with, and its diff.
    resolution: dict[str, Any] | None = None
    diff: dict[str, Any] | None = None


async def _version_source(db: AsyncSession, source_id: uuid.UUID) -> Any:
    """A PRD version's slug, number and title (once per Inbox call, oracle.runs.batch)."""
    return await once(
        ("version_source", source_id),
        lambda: _source_of(db, source_id),
    )


async def _source_of(db: AsyncSession, source_id: uuid.UUID) -> Any:
    return (await docs_service.version_sources(db, [source_id])).get(source_id)


async def _section_keys(db: AsyncSession, version_id: uuid.UUID) -> list[str]:
    return list(
        await db.scalars(select(Section.section_key).where(Section.version_id == version_id))
    )


async def items_check(db: AsyncSession, run: Run, text: str) -> roadmap.ItemsCheck:
    """The check of a Roadmap items file, read once per Inbox call (oracle.runs.batch)."""
    check, *_ = await once(("items_check", _source_id(run), text), lambda: _checked(db, run, text))
    return check


async def _checked(
    db: AsyncSession, run: Run, text: str
) -> tuple[roadmap.ItemsCheck, str | None, int | None, set[str] | None]:
    slug = version = prd_id = None
    keys: set[str] | None = None
    source_id = _source_id(run)
    if source_id is not None:
        source = await _version_source(db, source_id)
        if source is not None:
            slug, version, prd_id = source.slug, source.version, source.document_id
            keys = set(
                await once(("section_keys", source_id), lambda: _section_keys(db, source_id))
            )
    # CR-11: a date only with a verified estimate, capacity or commitment behind it.
    bases = await once(("date_bases", prd_id), lambda: schedule.verified_bases(db, prd_id))
    # In a worker thread with a time cap: agent output never holds the event loop.
    check = await roadmap.check_items_async(
        text, prd_slug=slug, prd_version=version, prd_sections=keys, date_bases=bases
    )
    return check, slug, version, keys


async def checked_items(
    db: AsyncSession, run: Run, text: str, prior: PriorReview | None = None
) -> CheckedItems:
    check, slug, version, keys = await once(
        ("items_check", _source_id(run), text), lambda: _checked(db, run, text)
    )
    if not check.items:
        return CheckedItems(check, [], None, False, keys)
    try:
        # In a savepoint: a database or trace error loses the advisory reasons only; the
        # blocking ones (the check's) are still stored, flagged partial.
        async with db.begin_nested():
            context = await reasons.reason_context(db, run, check.items)
        partial = False
    except Exception:  # noqa: BLE001 - advisory reasons never fail the check or the tick
        log.exception("the reasons of %s of run %s could not be loaded", ITEMS_FILE, run.id)
        context = reasons.ReasonContext(prd_title=slug, prd_version=version, advisory=False)
        partial = True
    found = reasons.reasons_for(check.items, check.problems, context)
    if prior is None:
        return CheckedItems(check, found, context.base, partial, keys)
    before = await roadmap.check_items_async(prior.text)
    resolution = answers.resolve(prior.review, before.items, check.items, check.resolutions)
    resolution["attempt"] = prior.answered_by
    found = reasons.with_resolutions(
        found, reasons.resolution_reasons(resolution, check.items), check.items
    )
    diff = answers.item_diff(before.items, check.items, prior.attempt)
    return CheckedItems(check, found, context.base, partial, keys, resolution, diff)


# --------------------------------------------------------------------------- tick


@dataclass
class _TickStats:
    checked: int = 0
    finished: int = 0
    advanced: int = 0
    paused: int = 0
    # Kept, not raised: what a raise would roll back (a count of 404s) is written.
    errors: list[str] = field(default_factory=list)
    # This tick's pass over one run (set per run): what the pass committed and must not
    # redo when it runs again after a runtime call (_replay) is marked with it.
    pass_id: str = field(default_factory=lambda: uuid.uuid4().hex)


def _dates_pending(exc: BaseException) -> bool:
    """A roadmap's dates still being found, or its company's date jobs busy
    (oracle.roadmap.doc_dates: 503, try again): a tick retries, never a failed try or run.
    Dates given up on (422) are a failure like any other."""
    return isinstance(exc, doc_dates.DatesUnavailable) and exc.pending


def _resetter(stats: _TickStats) -> Callable[[], None]:
    """``reset`` for one :func:`_replay`: puts ``stats`` back as they are now, before it."""
    saved = replace(stats, errors=list(stats.errors))

    def reset() -> None:
        for f in ("checked", "finished", "advanced", "paused"):
            setattr(stats, f, getattr(saved, f))
        stats.errors[:] = saved.errors

    return reset


async def _tick_run(db: AsyncSession, run: Run, stats: _TickStats, deadline: float) -> None:
    """One run's tick pass (the run locked by the caller, inside :func:`_replay`: in a
    live workflow's pass the runtime calls (status, artifacts, a wait's record, the
    cancels) are made outside the lock and the pass runs again with their results, on the
    run as it is by then). In segment mode the run's row lock is not held across the
    status and artifact reads either: the transaction ends, the runtime is called (within
    :data:`TICK_RUN_SECONDS`, ``deadline`` in loop time), then the run is locked and read
    again and the outcome written only if it still applies (the run still active, the
    segment still running the same workflow). So a cancel, or a disable of the run's
    creator (which holds the review gate while it waits on the run's row), never waits on
    those reads. What a pass queued is submitted by the caller (:func:`submit_queued`)."""
    run_id = run.id
    runtime = get_runtime()
    segments = await _segments(db, run.id)
    wf = _live(run)
    if wf is not None and (wf.get("cancel_pending") or run.status in FINAL):
        if not await _retry_pending_cancel(db, run, wf, segments, stats) or run.status != "running":
            return
        wf = None  # confirmed: what was held back (a new workflow) goes on below
        # Its last cost may have crossed the ceiling: nothing is submitted over it.
        if (ceiling := _overrun(run)) is not None:
            await _pause_overrun(db, run, ceiling, stats)
            return
    # The workflow's status is read before anything that commits (a resumed advance): a pass
    # run again after a runtime call (:func:`_replay`) must not redo what it committed.
    status: WorkflowStatus | None = None
    if wf is not None and not wf.get("cancel_pending") and run.status not in FINAL:
        try:
            status = await _rt().status(wf["id"])
        except RuntimeUnavailable:
            status = None  # read again where it is needed, and failing there as before
    resuming = _resuming(run, segments)
    if resuming is not None:
        failed = _current_attempt(_art(resuming), resuming).get("resume_failures") or {}
        if failed.get("pass") == stats.pass_id:
            # Tried and counted by this tick's pass already, which runs again after a
            # runtime call: not tried again; its error, which ``reset`` dropped, reported.
            stats.errors.append(_resume_error(run.id, resuming, failed))
        else:
            try:
                await _resume_advance(db, run, resuming, segments, stats)
                return
            except safe_yaml.ParseBusy:
                # No free worker: not a failed try (RESUME_TRIES). The tick rolls back,
                # records parse_busy and the next tick resumes the advance again.
                raise
            except Exception as exc:  # counted; the workflow is still read below
                if _dates_pending(exc):
                    # Not a failed try (RESUME_TRIES): the tick gives up on this run and
                    # the next tick resumes the advance again.
                    raise
                run, segments = await _resume_failed(db, run.id, resuming.seq, exc, stats)
        wf = _live(run)
        if wf is not None and not wf.get("cancel_pending") and run.status not in FINAL:
            # Its status, cost and the ceiling, a wait's expiry and the workflow's end:
            # read whatever the resume did.
            await _tick_workflow(db, run, wf, segments, stats, status)
        return
    if wf is not None:
        await _tick_workflow(db, run, wf, segments, stats, status)
        return
    if run.status in FINAL:
        return
    running = next((s for s in segments if s.status == "running"), None)
    if running is None:
        if run.status != "running":
            return
        # A submission the runtime refused earlier, or one a request queued: the caller
        # submits it (what this pass wrote, a cancel confirmed above, commits first).
        if any(_waiting(s) for s in segments):
            await db.commit()
            return
        if (awaiting := _awaiting_items(segments)) is not None:
            # F4 lane B: the draft's roadmap items, re-checked on every tick.
            await _submit(db, run, awaiting, segments)
            await db.commit()
            return
        # Resumed after an overrun with a finished segment not yet advanced.
        done = [s for s in segments if s.status == "succeeded"]
        if done and await _advance(db, run, done[-1], segments):
            stats.advanced += 1
        await db.commit()
        return

    segment_id, workflow_id = running.id, running.swarm_workflow_id or ""
    await db.commit()  # nothing held across the runtime calls
    status = await _within(runtime.status(workflow_id), deadline)
    files: dict[str, str] = {}
    if status.terminal and status.state == "succeeded":
        files = await _within(runtime.artifacts(workflow_id), deadline)

    run, segments = await _locked(db, run_id)
    running = next((s for s in segments if s.id == segment_id), None)
    if (
        run is None
        or run.status not in ("running", "paused_overrun")
        or running is None
        or running.status != "running"
        or running.swarm_workflow_id != workflow_id
    ):
        await db.rollback()  # cancelled, decided or ticked meanwhile: not ours to write
        return
    art = _art(running)
    # A workflow's cost counts once, on the first attempt that carries it: a later
    # segment of a multi-segment workflow left running on it counts nothing again.
    earlier = next(
        (
            s
            for s in segments
            if s.seq < running.seq
            and any(a.get("workflow_id") == running.swarm_workflow_id for a in _art(s)["attempts"])
        ),
        None,
    )
    if art["attempts"]:
        # The running workflow's attempt (one found later may sit after it). On an earlier
        # segment's workflow it keeps what its own agents spent (:func:`_take_cost`).
        current = _current_attempt(art, running)
        if earlier is None:
            current["cost_usd"] = _higher(status.cost_usd, current.get("cost_usd"))
        current["state"] = status.state
    running.cost_usd = sum(
        (Decimal(str(a.get("cost_usd") or 0)) for a in art["attempts"]), Decimal(0)
    )
    _set_art(running, art)
    if earlier is not None:
        # The rest of the workflow's cost, counted once.
        _cost_on(
            run, segments, {"seq": earlier.seq, "id": running.swarm_workflow_id}, status.cost_usd
        )
    _recompute_spend(run, segments)
    _record_agents(running, workflow_id, status)
    _record_wait(
        run, running, workflow_id, _current_attempt(art, running).get("submitted_at"), status
    )
    art = _art(running)

    if status.terminal:
        stats.finished += 1
        running.finished_at = _now()
        if status.state == "succeeded":
            art["files"] = {**art["files"], **files}
            running.status = "succeeded"
            await revoke_run_tokens(db, run.id)
        else:
            running.status = "failed" if status.state == "failed" else "cancelled"
            running.error = status.error or f"the workflow ended {status.state}"
            _set_art(running, art)
            await _finish(db, run, "failed", f"{running.name}: {running.error}")
            await audit.record(db, None, "run.failed", "run", run.id, {"segment": running.name})
            await db.commit()
            return
    _set_art(running, art)

    ceiling = _ceiling(run)
    if run.status == "running" and ceiling is not None and run.spent_usd > ceiling:
        run.status = "paused_overrun"
        stats.paused += 1
        await audit.record(
            db,
            None,
            "run.paused_overrun",
            "run",
            run.id,
            {"spent_usd": str(run.spent_usd), "ceiling_usd": str(ceiling)},
        )
        await webhooks.capture(db, "run.paused_overrun", audit.ORACLE, run_id=run.id)
        await db.commit()
        return
    advanced = False
    if run.status == "running" and running.status == "succeeded":
        advanced = await _advance(db, run, running, segments)
        stats.advanced += advanced
    await db.commit()


def _take_cost(
    run: Run, wf: dict[str, Any], status: WorkflowStatus, segments: list[RunSegment]
) -> RunSegment | None:
    """The live workflow's cost, on the attempt of the segment it was submitted for, and
    the run's spend from it. Returns that segment.

    #258: a later segment started in the workflow carries what its own steps cost; the
    rest of the workflow's cost goes on the first attempt of the segment it was submitted
    for: a revision inside the workflow is another attempt on the same workflow, and
    counts nothing again. The workflow's cost and a step's are never lowered."""
    start = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    others = Decimal(0)
    for entry in wf.get("segments") or []:
        later = next((s for s in segments if s.seq == entry.get("seq")), None)
        if later is None or later is start:
            continue
        own = {*entry.get("work", []), *entry.get("reviews", []), *entry.get("revises", [])}
        spent = sum((st.cost_usd or 0 for st in status.steps if st.step_id in own), Decimal(0))
        art = _art(later)
        first = True
        for a in art["attempts"]:
            if a.get("workflow_id") == wf["id"]:
                a["cost_usd"] = _higher(spent, a.get("cost_usd")) if first else 0
                others += Decimal(str(a["cost_usd"]))
                first = False
        later.cost_usd = sum(
            (Decimal(str(a.get("cost_usd") or 0)) for a in art["attempts"]), Decimal(0)
        )
        _set_art(later, art)
    if start is not None:
        art = _art(start)
        first = True
        for a in art["attempts"]:
            if a.get("workflow_id") == wf["id"]:
                # Never lowered: a read made earlier (cancel() reads before it takes the
                # run's row lock) is not newer than one the tick recorded meanwhile.
                if first:
                    total = _higher(status.cost_usd, a.get("workflow_cost_usd", a.get("cost_usd")))
                    a["workflow_cost_usd"] = total
                    a["cost_usd"] = max(total - float(others), 0)
                else:
                    a["cost_usd"] = 0
                first = False
        start.cost_usd = sum(
            (Decimal(str(a.get("cost_usd") or 0)) for a in art["attempts"]), Decimal(0)
        )
        _set_art(start, art)
    _recompute_spend(run, segments)
    return start


def _overrun(run: Run) -> Decimal | None:
    """The ceiling when the run's spend is over it."""
    ceiling = _ceiling(run)
    return ceiling if ceiling is not None and run.spent_usd > ceiling else None


async def _pause_overrun(
    db: AsyncSession, run: Run, ceiling: Decimal, stats: _TickStats | None = None
) -> None:
    run.status = "paused_overrun"
    if stats is not None:
        stats.paused += 1
    await audit.record(
        db,
        None,
        "run.paused_overrun",
        "run",
        run.id,
        {"spent_usd": str(run.spent_usd), "ceiling_usd": str(ceiling)},
    )
    await webhooks.capture(db, "run.paused_overrun", audit.ORACLE, run_id=run.id)


# Run states the ceiling pauses (a run waiting on a checkpoint can spend too).
_SPENDING = ("running", "awaiting_checkpoint")


def _rested(pending: dict[str, Any]) -> bool:
    """A cancel past :data:`NOT_FOUND_TRIES` (in the Inbox) is tried again now and then
    (only the cancel call rests: the workflow's status and cost are read every tick)."""
    tried = _parse_at(pending.get("tried_at"))
    return (
        bool(pending.get("stuck"))
        and tried is not None
        and (_now() - tried).total_seconds() < STUCK_LOOKUP_SECONDS
    )


async def _retry_pending_cancel(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    segments: list[RunSegment],
    stats: _TickStats,
) -> bool:
    """A workflow Oracle is cancelling and SwarmCloud has not confirmed it: read its cost
    (it may still be spending) and cancel it again. True once it is cancelled or ended.
    A lost submission (no id yet) is looked up by its label first; a workflow SwarmCloud
    does not know (404) is given up, and recorded. A 404 that proves nothing is counted:
    past :data:`NOT_FOUND_TRIES` the run shows in the Inbox with Cancel, and is tried
    again every :data:`STUCK_LOOKUP_SECONDS`."""
    runtime = _rt()
    pending = wf.get("cancel_pending") or {}
    state = pending.get("state") or "ended"
    # Past the cap only the cancel call rests: its status and cost are read every tick.
    rested = _rested(pending)
    if not wf.get("id"):
        label = wf.get("lookup") or ""
        try:
            found = await runtime.find_by_label(label, since=_parse_at(wf.get("lookup_since")))
        except RuntimeUnavailable as exc:
            log.warning("run %s: looking up %s to cancel it: %s", run.id, label, exc)
            lookups = int(pending.get("lookups") or 0) + 1
            since = wf.get("lookup_since") or pending.get("since")
            if _lookup_exhausted({"submitted_at": since, "lookups": lookups}):
                # Never found, never ruled out: looked for in the background instead.
                await _stop_looking(db, run, wf, segments, state, exc)
                return True
            _set_knob(run, "workflow", {**wf, "cancel_pending": {**pending, "lookups": lookups}})
            return False
        if not found:
            await _end_workflow(db, run, wf, state)
            return True
        wf = {**wf, "id": found}
        _set_knob(run, "workflow", wf)
        _adopt(segments, wf)
    try:
        status = await runtime.status(wf["id"])
    except RuntimeUnavailable as exc:
        if exc.gone and pending.get("confirmed"):
            # Its cancel was confirmed: read once more before it is taken as ended.
            _read_once_more(run, wf)
            await _end_workflow(db, run, wf, state)
            return True
        if exc.gone:
            await _give_up(db, run, wf, state)
            return True
        if rested:
            log.warning("run %s: %s not read (resting): %s", run.id, wf["id"], exc)
            return False
        if pending.get("confirmed"):
            # Its cancel was confirmed and this was the one more read of its last cost:
            # read on in the background, so that nothing waits on it here.
            note = (
                f"SwarmCloud confirmed cancelling workflow {wf['id']}, but its last cost could "
                f"not be read ({_shown(exc)}); Oracle reads it in the background until it "
                "ends and counts it on the run."
            )
            target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
            _note(target or segments[0], note)
            _read_on(run, wf)
            await _end_workflow(db, run, wf, state)
            return True
        if _not_found(exc):
            # Proves nothing: counted (kept, not rolled back), and tried again.
            marker = {**pending, "tried_at": _now().isoformat(), "error": _shown(exc)}
            _count_not_found(marker, pending, True)
            _set_knob(run, "workflow", {**wf, "cancel_pending": marker})
            stats.errors.append(f"run {run.id}: {exc}")
            return False
        raise
    _take_cost(run, wf, status, segments)
    if status.terminal:
        await _end_workflow(db, run, wf, state)
        return True
    if pending.get("confirmed"):
        # Confirmed and winding down: read on in the background until it ends.
        _read_on(run, wf, costed=True)
        await _end_workflow(db, run, wf, state)
        return True
    if not rested and await _detach(db, run, cancel=True, state=state):
        return True
    if run.status in _SPENDING and (ceiling := _overrun(run)) is not None:
        await _pause_overrun(db, run, ceiling, stats)
    return False


async def _stop_looking(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    segments: list[RunSegment],
    state: str,
    exc: RuntimeUnavailable,
) -> None:
    """A lost submission of a run that ended, looked for past the lookup cap without an
    answer either way: no longer looked up on every tick, but in the background
    (:func:`_search_earlier`) until found (then cancelled, its cost counted) or ruled
    out, within its credential's lifetime. Its token is revoked."""
    label = wf.get("lookup") or ""
    _search_for(
        run,
        label=label,
        seq=wf.get("start_seq"),
        submitted_at=wf.get("lookup_since") or (wf.get("cancel_pending") or {}).get("since"),
        until=wf.get("lookup_until"),
        why="cancel",
    )
    note = (
        f"After {_duration(LOST_LOOKUP_SECONDS)} SwarmCloud's task listing still neither shows "
        f"submission {label} nor rules it out ({_shown(exc)}). Its run token is revoked, and "
        f"Oracle keeps looking for it in the background every "
        f"{_duration(STUCK_LOOKUP_SECONDS)}: if it landed, Oracle cancels it and counts its "
        "cost."
    )
    log.warning("run %s: %s", run.id, note)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        _note(target or segments[0], note)
    await _end_workflow(db, run, wf, state)


def _attempt_of(label: str | None, fallback: int) -> int:
    """The attempt number in a submission's key (``oracle-<run>-<segment>-<attempt>``)."""
    tail = (label or "").rsplit("-", 1)[-1]
    return int(tail) if tail.isdigit() else fallback


def _add_attempt(
    segment: RunSegment, workflow_id: str, label: str | None, state: str, **extra: Any
) -> None:
    """A workflow found for the segment (a lost submission), as one of its attempts in
    the order of their numbers, so that its cost counts in the run's spend."""
    art = _art(segment)
    if any(a.get("workflow_id") == workflow_id for a in art["attempts"]):
        return
    number = _attempt_of(label, len(art["attempts"]) + 1)
    at = next(
        (i for i, a in enumerate(art["attempts"]) if int(a.get("attempt") or 0) > number),
        len(art["attempts"]),
    )
    art["attempts"].insert(
        at,
        {
            "attempt": number,
            "workflow_id": workflow_id,
            "submitted_at": _now().isoformat(),
            "cost_usd": 0,
            "note": None,
            "state": state,
            "label": label,
            **extra,
        },
    )
    _set_art(segment, art)


def _adopt(segments: list[RunSegment], wf: dict[str, Any]) -> None:
    """A lost submission found while cancelling: an attempt of its segment, so that its
    cost is counted in the run's spend."""
    segment = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if segment is not None:
        _add_attempt(segment, wf["id"], wf.get("label"), "cancelled", mode=wf.get("mode"))


# --------------------------------------------------------------------------- searches


def _credential_end(info: dict[str, Any]) -> str | None:
    """When a submission's run credential ends, if it was sent one (attached): its agents
    lose Oracle's data then. A submission sent without it is not bounded by the run
    token's lifetime: None (the default bound applies, :data:`SEARCH_SECONDS`)."""
    if info.get("credential_seconds"):
        return info.get("expires_at")
    return info.get("lookup_until")


def _search_end(entry: dict[str, Any]) -> datetime:
    """Past this, a search gives up while SwarmCloud neither shows the submission nor
    rules it out, or does not serve its status: the credential's end (else
    :data:`SEARCH_SECONDS` after it was sent) plus a step's timeout of slack, for a step
    already running then. A workflow whose status reads is followed until it ends."""
    sent = _parse_at(entry.get("submitted_at")) or _now()
    end = _parse_at(entry.get("until")) or sent + timedelta(seconds=SEARCH_SECONDS)
    return end + timedelta(seconds=get_runtime_settings().step_seconds)


def _cost_cap(entry: dict[str, Any]) -> datetime:
    """A searched workflow whose cost is unknown (its status does not read) is read again
    now and then until this, shown in the Inbox with it: :func:`_search_end` plus
    :data:`COST_UNKNOWN_SECONDS`."""
    return _search_end(entry) + timedelta(seconds=COST_UNKNOWN_SECONDS)


def _search_for(
    run: Run,
    *,
    label: str,
    seq: int | None,
    submitted_at: str | None,
    until: str | None,
    why: str,
    workflow_id: str | None = None,
    cancel: bool = True,
    cancelled: bool = False,
    costed: bool = False,
) -> None:
    """Keep checking work the run gave up on: the run's ``searches``. A submission whose
    answer was lost (Retry submitted the segment again, or a cancelled run stopped looking
    for it on every tick) is looked for by its label; a workflow known by its id (found,
    or one an approver stopped cancelling: ``cancel`` False; ``cancelled``: its cancel was
    confirmed and only its status and cost are left to read) has its status and cost read
    until it ends. The first look is on the next tick. One entry per submission (its id,
    or its label and when it was sent, compared as times; a label-only look that does
    not say when merges into the label's): a second call merges into it."""
    entries = copy.deepcopy(list((run.knobs or {}).get("searches") or []))
    if not label:
        return
    at = _parse_at(submitted_at)
    for e in entries:
        same_id = bool(workflow_id) and e.get("id") == workflow_id
        same_sent = (
            e.get("label") == label
            and at is not None
            and _parse_at(e.get("submitted_at")) == at
            and (not workflow_id or not e.get("id") or e.get("id") == workflow_id)
        )
        # Two looks for the same label, neither known by its id: when this one does not
        # say when it was sent, it is the one already looked for.
        same_label = not workflow_id and not e.get("id") and e.get("label") == label and at is None
        if same_id or same_sent or same_label:
            if workflow_id and not e.get("id"):
                e["id"] = workflow_id
            if not cancel:
                e["cancel"] = False
            if cancelled:
                e["cancelled"] = True
            if costed:
                e["costed"] = True
            _set_knob(run, "searches", entries)
            return
    sent = at or _now()
    end = _parse_at(until) or sent + timedelta(seconds=SEARCH_SECONDS)
    entry: dict[str, Any] = {
        "label": label,
        "seq": seq,
        "submitted_at": sent.isoformat(),
        "until": end.isoformat(),
        "why": why,
        "looked_at": None,
        "lookups": 0,
    }
    if workflow_id:
        entry["id"] = workflow_id
    if not cancel:
        entry["cancel"] = False
    if cancelled:
        entry["cancelled"] = True
    if costed:
        entry["costed"] = True
    entries.append(entry)
    _set_knob(run, "searches", entries)


def _searching(run: Run) -> str | None:
    """What the Inbox says while Oracle checks work the run gave up on."""
    entries = (run.knobs or {}).get("searches") or []
    if not entries:
        return None
    every = _duration(STUCK_LOOKUP_SECONDS)
    says: list[str] = []
    lost = [str(e.get("label")) for e in entries if not e.get("id")]
    if lost:
        says.append(
            f"Oracle is looking for an earlier submission ({', '.join(lost)}) every {every}: "
            "if it landed, Oracle cancels it and counts its cost in the run's spend; it stops "
            "once it is ruled out, or when its credential would have expired."
        )
    for e in entries:
        if not e.get("id"):
            continue
        if e.get("cancel") is False:
            says.append(
                f"Oracle stopped cancelling workflow {e['id']} ({e.get('label')}), and reads "
                "its status and cost on every tick until it ends, counting its spend on the "
                "run."
            )
        else:
            says.append(
                f"Oracle cancels workflow {e['id']} ({e.get('label')}), given up on earlier, "
                "and reads its status and cost on every tick until it ends, counting its "
                "spend on the run."
            )
    return " ".join(says)


def _cost_on(run: Run, segments: list[RunSegment], entry: dict[str, Any], cost: Decimal) -> None:
    """A searched workflow's cost on its segment's first attempt with its id (a revision
    inside a workflow counts nothing again), never lower than one already recorded.

    #258: what other segments started in the workflow carry (their own agents' spend,
    :func:`_take_cost`) is not counted again: the segment carries the rest."""
    segment = next((s for s in segments if s.seq == entry.get("seq")), None)
    if segment is None:
        return
    others = sum(
        (
            Decimal(str(a.get("cost_usd") or 0))
            for s in segments
            if s is not segment
            for a in _art(s)["attempts"]
            if a.get("workflow_id") == entry["id"]
        ),
        Decimal(0),
    )
    art = _art(segment)
    first = True
    for a in art["attempts"]:
        if a.get("workflow_id") == entry["id"]:
            if first:
                total = _higher(cost, a.get("workflow_cost_usd", a.get("cost_usd")))
                a["workflow_cost_usd"] = total
                a["cost_usd"] = max(total - float(others), 0)
            else:
                a["cost_usd"] = 0
            first = False
    segment.cost_usd = sum(
        (Decimal(str(a.get("cost_usd") or 0)) for a in art["attempts"]), Decimal(0)
    )
    _set_art(segment, art)
    _recompute_spend(run, segments)


def _higher(cost: Decimal, recorded: Any) -> float:
    """A cost read now, never lower than the one recorded: SwarmCloud's costs only grow,
    so a lower reading is an older one (read before a newer one was recorded)."""
    return max(float(cost), float(recorded or 0))


def _rests(at: Any) -> bool:
    looked = _parse_at(at)
    return looked is not None and (_now() - looked).total_seconds() < STUCK_LOOKUP_SECONDS


async def _read_call(workflow_id: str) -> _Cancelled:
    """Read a workflow Oracle no longer cancels (stopped, or its cancel confirmed): its
    cost and whether it ended. A call only, nothing written."""
    out = _Cancelled()
    try:
        out.final = await _rt().status(workflow_id)
    except RuntimeUnavailable as exc:
        if exc.gone:
            out.gone = True
        else:
            out.unread = exc
    return out


async def _search_earlier(
    db: AsyncSession, run: Run, segments: list[RunSegment], stats: _TickStats
) -> None:
    """Check the work the run gave up on (``searches``), each every
    :data:`STUCK_LOOKUP_SECONDS` (the first on the next tick). A submission looked for by
    its label: found, it is cancelled and its cost counted in the run's spend (as
    :func:`_adopt` does); ruled out by the listing, it is dropped; neither, past
    :func:`_search_end`, dropped (noted). A workflow known by its id (:func:`_read_found`)
    is cancelled (unless an approver stopped cancelling it) and its status and cost read
    until it ends. Whatever the run's state: a landed one spends otherwise."""
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    if not entries:
        return
    runtime = _rt()
    target = segments[0] if segments else None
    keep: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    for e in entries:
        label = str(e.get("label") or "")
        segment = next((s for s in segments if s.seq == e.get("seq")), target)
        if not e.get("id"):
            if _rests(e.get("looked_at")):
                keep.append(e)
                continue
            e["looked_at"] = _now().isoformat()
            try:
                found = await runtime.find_by_label(label, since=_parse_at(e.get("submitted_at")))
            except RuntimeUnavailable as exc:
                e["lookups"] = int(e.get("lookups") or 0) + 1
                e["error"] = _shown(exc)
                if _now() >= _search_end(e):
                    if segment is not None:
                        _note(
                            segment,
                            f"Oracle stopped looking for submission {label}: its credential "
                            "would have expired, and SwarmCloud's task listing never showed "
                            f"it nor ruled it out ({_shown(exc)}). If it landed, cancel it in "
                            "SwarmCloud's console; its cost is not counted here.",
                        )
                    continue
                keep.append(e)
                continue
            if not found:
                log.info("run %s: submission %s ruled out", run.id, label)
                continue
            e["id"] = found
            if segment is not None:
                _add_attempt(segment, found, label, "cancelled", mode="abandoned")
        elif e.get("unread") and _rests(e.get("read_at")):
            # Its last read failed: read again now and then. One that reads is read on
            # every tick until it ends, so the ceiling is never overshot by a rest.
            keep.append(e)
            continue
        e["read_at"] = _now().isoformat()
        if await _read_found(run, segments, segment, e):
            keep.append(e)
        elif e.get("dropped"):
            dropped.append(e)
    _set_knob(run, "searches", keep or None)
    await _after_search(db, run, target, stats, dropped)


async def _after_search(
    db: AsyncSession,
    run: Run,
    target: RunSegment | None,
    stats: _TickStats,
    dropped: list[dict[str, Any]],
) -> None:
    """After a look at the run's searches: workflows dropped at their cap are audited,
    and the spend is held to the ceiling (a run still spending pauses; one that ended
    records the overrun, whether or not anything is left to read)."""
    for e in dropped:
        await audit.record(
            db,
            None,
            "run.search_dropped",
            "run",
            run.id,
            {
                "workflow_id": e.get("id"),
                "label": e.get("label"),
                "reason": e.get("dropped"),
                "cost_unknown_since": e.get("cost_unknown"),
                "cancelling_since": e.get("winding_since"),
            },
        )
    if (ceiling := _overrun(run)) is not None:
        if run.status in _SPENDING:
            await _pause_overrun(db, run, ceiling, stats)
        elif run.status in FINAL and _new_overrun_after_end(run, ceiling):
            await _overrun_after_end(db, run, ceiling, target)


def _new_overrun_after_end(run: Run, ceiling: Decimal) -> bool:
    """Whether an ended run's spend over its ceiling is an overrun after its end to
    record: spend that arrived after the end (past the spend it ended with, when that was
    over the ceiling already: an earlier overrun keeps its own kind and wording), and
    past the last one recorded. One recorded and not dismissed is shown already; a
    dismissed one does not block a new one once the spend grows past it."""
    knobs = run.knobs or {}
    at_end = knobs.get("spent_at_end")
    if at_end is not None and run.spent_usd <= Decimal(str(at_end)):
        return False
    over = knobs.get("overrun_after_end")
    if not isinstance(over, dict):
        return True
    return bool(over.get("dismissed_at")) and run.spent_usd > Decimal(
        str(over.get("spent_usd") or 0)
    )


def _usd_text(value: Any) -> str:
    return f"${Decimal(str(value or 0)):.2f}"


async def _overrun_after_end(
    db: AsyncSession, run: Run, ceiling: Decimal, segment: RunSegment | None
) -> None:
    """The ceiling trips on a run that ended (P3d: a workflow it no longer cancels, or
    one read for its last cost, counts on the run): nothing is left to pause, so the
    overrun is recorded, audited and shown in the Inbox, with Cancel again for a stopped
    workflow that still runs, until an owner or the run's creator dismisses it (once
    nothing is left to read). Kept on the run after that."""
    knobs = run.knobs or {}
    running = [str(e["id"]) for e in knobs.get("searches") or [] if e.get("id")]
    record: dict[str, Any] = {
        "spent_usd": str(run.spent_usd),
        "ceiling_usd": str(ceiling),
        "at": _now().isoformat(),
        "running": running,
    }
    at_end = knobs.get("spent_at_end")
    already = at_end is not None and Decimal(str(at_end)) > ceiling
    if already:
        record["spent_at_end"] = str(at_end)
    previous = knobs.get("overrun_after_end")
    if isinstance(previous, dict) and previous.get("dismissed_at"):
        record["earlier"] = [*(previous.get("earlier") or []), previous]
    _set_knob(run, "overrun_after_end", record)
    if segment is not None:
        still = (
            f"workflow {', '.join(running)} still runs in SwarmCloud"
            if running
            else "the last read of a workflow it no longer drives found it"
        )
        if already:
            said = (
                f"The run was already over its {_usd_text(ceiling)} ceiling when it ended "
                f"({_usd_text(at_end)}); after it ended its spend grew to "
                f"{_usd_text(run.spent_usd)}: {still}."
            )
        else:
            said = (
                f"After the run ended its spend reached {_usd_text(run.spent_usd)}, over its "
                f"{_usd_text(ceiling)} ceiling: {still}."
            )
        _note(segment, said)
    await audit.record(
        db,
        None,
        "run.overrun_after_end",
        "run",
        run.id,
        {"spent_usd": str(run.spent_usd), "ceiling_usd": str(ceiling)},
    )


def _found_cancels(e: dict[str, Any]) -> bool:
    """Whether the next look at a searched workflow cancels it: not one an approver
    stopped cancelling, not one whose cancel was confirmed, and the cancel call rests
    between tries (its status and cost are read every tick)."""
    return bool(
        e.get("cancel", True) and not e.get("cancelled") and not _rests(e.get("cancel_tried_at"))
    )


async def _found_call(e: dict[str, Any]) -> _Cancelled:
    """The network half of a look at a searched workflow (:func:`_found_apply` records
    it): calls only, nothing written, so the caller may hold no lock."""
    wid = e["id"]
    return await (_cancel_call({"id": wid}) if _found_cancels(e) else _read_call(wid))


def _last_cost(segment: RunSegment | None, wid: str) -> float:
    if segment is None:
        return 0.0
    return sum(
        float(a.get("cost_usd") or 0)
        for a in _art(segment)["attempts"]
        if a.get("workflow_id") == wid
    )


def _found_apply(
    run: Run,
    segments: list[RunSegment],
    segment: RunSegment | None,
    e: dict[str, Any],
    out: _Cancelled,
    cancelling: bool,
) -> bool:
    """Record one look at a searched workflow (:func:`_found_call`; ``cancelling``: it
    was a cancel). Returns True to keep it. A workflow dropped at its cap is marked
    ``dropped`` (audited by the caller)."""
    label, wid = e.get("label"), e["id"]
    if cancelling:
        e["cancel_tried_at"] = _now().isoformat()
        if out.error is None and not out.gone:
            e["cancelled"] = True  # confirmed: its status and cost are left to read
    final = out.final
    if final is not None:
        _cost_on(run, segments, e, final.cost_usd)
        e["costed"] = True
        e.pop("gone_reads", None)
        if final.terminal:
            if segment is not None:
                if e.get("cancel") is False:
                    said = (
                        f"Workflow {wid}, which an approver stopped cancelling, ended "
                        f"{final.state} in SwarmCloud: ${final.cost_usd} counted in the "
                        "run's spend."
                    )
                else:
                    said = (
                        f"Oracle cancelled workflow {wid} (submission {label}), given up on "
                        f"earlier; it ended {final.state} (${final.cost_usd} counted in the "
                        "run's spend)."
                    )
                _note(segment, said)
            return False
        for key in ("unread", "not_found", "stuck", "error", "cost_unknown"):
            e.pop(key, None)
        if e.get("cancelled") and _now() >= _search_end(e):
            # P3d 'Stuck cancels' (owner, 2026-10-20): its cancel was confirmed long ago
            # and it still reads as not ended. Its cost reads, so it is counted and not
            # 'cost unknown'; it is dropped at the same cap, with a note on the run.
            e["winding"] = True
            e.setdefault("winding_since", _now().isoformat())
            return _under_cap(segment, e)
        e.pop("winding", None)
        e.pop("winding_since", None)
        return True  # still running, or winding down: read again (its cost counts)
    if (out.forgotten or (out.gone and e.get("cancelled"))) and not e.get("gone_reads"):
        # After its confirmed cancel SwarmCloud does not know it: its cost is read once
        # more before it is taken as ended, so that what it spent since Oracle's last
        # read (up to the cancel) is counted, and SwarmCloud may lag. That read failing,
        # the cost-unknown rules apply.
        e["gone_reads"] = 1
        e["error"] = "SwarmCloud did not know it right after confirming its cancel"
        return True
    if out.forgotten or (out.gone and e.get("cancelled")):
        if segment is not None:
            _note(
                segment,
                f"SwarmCloud no longer knows workflow {wid} (submission {label}, HTTP 404) "
                "after it confirmed its cancel: Oracle takes it as ended, its cost what "
                f"Oracle last read (${_last_cost(segment, wid):g} counted in the run's "
                "spend).",
            )
        return False
    if out.gone:
        if segment is not None:
            _note(
                segment,
                f"SwarmCloud does not know workflow {wid} (submission {label}, HTTP 404): "
                "Oracle stopped checking it; its cost is what Oracle last read.",
            )
        return False
    # Nothing read this time: its cost is unknown (whether or not it was winding down).
    e.pop("winding", None)
    e["error"] = _shown(out.error or out.unread) or "its status was not read"
    e["unread"] = int(e.get("unread") or 0) + 1
    if _not_found(out.error) or _not_found(out.unread):
        e["not_found"] = int(e.get("not_found") or 0) + 1
        if e["not_found"] >= NOT_FOUND_TRIES:
            e["stuck"] = True
    if e.get("stuck") or _now() >= _search_end(e):
        e.setdefault("cost_unknown", _now().isoformat())
    return _under_cap(segment, e)


def _under_cap(segment: RunSegment | None, e: dict[str, Any]) -> bool:
    """A searched workflow whose cost is unknown, or whose confirmed cancel still reads
    CANCELLING past its search's end (its cost read and counted), is kept until
    :func:`_cost_cap`, then dropped (noted, and marked ``dropped`` for the audit)."""
    if not (e.get("cost_unknown") or e.get("winding")) or _now() < _cost_cap(e):
        return True
    wid, label = e["id"], e.get("label")
    stopped = f"Oracle stopped reading it at its cap ({_cost_cap(e).isoformat(timespec='minutes')})"
    if segment is not None:
        if e.get("winding") and not e.get("cost_unknown"):
            _note(
                segment,
                f"Workflow {wid} (submission {label}) still read CANCELLING after SwarmCloud "
                f"confirmed its cancel, since {str(e.get('winding_since'))[:16]}. {stopped}; "
                f"its cost was read and counted until then (${_last_cost(segment, wid):g} "
                "in the run's spend). If it still runs, cancel it in SwarmCloud's console.",
            )
        else:
            _note(
                segment,
                f"Cost unknown for workflow {wid} (submission {label}): SwarmCloud has not "
                f"served its status since {str(e.get('cost_unknown'))[:16]} "
                f"({e.get('error')}). {stopped}, and the run's spend has what Oracle last "
                "read. If it still runs, cancel it in SwarmCloud's console.",
            )
    e["dropped"] = "cost_unknown_cap"
    return False


async def _read_found(
    run: Run, segments: list[RunSegment], segment: RunSegment | None, e: dict[str, Any]
) -> bool:
    """One look at a searched workflow known by its id: cancel it (until SwarmCloud
    confirms; not one an approver stopped cancelling) and read its status and cost, the
    cost counted in the run's spend. Returns True to keep it: until its status reads
    terminal (a confirmed cancel still winding down is read on, its cost counted, until
    :func:`_search_end`; past it, it is capped like a cost unknown), or SwarmCloud says
    it does not exist (after a confirmed cancel: read once more first, then it ended,
    its last read cost counted, noted). When nothing could be
    read, 404s that prove nothing are counted; past :data:`NOT_FOUND_TRIES` of them, or
    past :func:`_search_end`, its cost is unknown: shown in the Inbox (Retry lookup) and
    read again now and then until :func:`_cost_cap`, then dropped (noted, audited)."""
    cancelling = _found_cancels(e)
    out = await _found_call(e)
    return _found_apply(run, segments, segment, e, out, cancelling)


async def _harvest(run: Run, segment: RunSegment, workflow_id: str, steps: tuple[str, ...]) -> None:
    """A segment's files from the steps that wrote them (read by task id), in step order:
    a later step's file of the same name wins."""
    files = await _rt().artifacts(workflow_id, steps)
    art = _art(segment)
    art["files"] = {**art["files"], **files}
    if art["attempts"]:
        _current_attempt(art, segment)["state"] = "succeeded"
    _set_art(segment, art)
    segment.status = "succeeded"
    segment.finished_at = _now()


# A step state that is neither a failure nor an expiry.
_OPEN_OR_DONE = ("PENDING", "RUNNING", "PARKED", "SUCCEEDED", "SKIPPED")


async def _tick_workflow(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    segments: list[RunSegment],
    stats: _TickStats,
    status: WorkflowStatus | None = None,
) -> None:
    """Advance a run that is one live workflow: record its cost, take each segment's files
    when the wait after it opens (or when it is done, checkpoint off), open the checkpoint
    with the wait to answer, and notice expiry, failures and the end. ``status``: the
    workflow's status, when the pass read it already."""
    if status is None:
        status = await _rt().status(wf["id"])
    start = _take_cost(run, wf, status, segments)
    current = next((s for s in segments if s.status == "running"), None)
    _record_running(wf, status, segments)
    _record_workflow_wait(run, wf, status, segments)
    expired = [p for p in status.parked if p.mcp_expired]
    if expired:
        # Its key expired while the step waited in SwarmCloud's queue: renewed after this
        # pass commits (:func:`refresh_key`), once per park.
        wf = _mark_key_refresh(run, wf, status, expired)
    for parked in status.parked:
        if parked.reason == "CREDENTIAL_MISSING" and not parked.mcp_expired:
            _note(current or start or segments[0], workflow.ADVICE[_key_park_advice(parked)])
    if run.status == "paused_overrun":
        await _pause_workflow(db, run, wf, status, segments)
        return
    # The ceiling first, before anything that follows an answer or submits: it holds while
    # the run waits too (a workflow can spend while its run waits on a checkpoint).
    if (ceiling := _overrun(run)) is not None:
        await _pause_overrun(db, run, ceiling, stats)
        await _pause_workflow(db, run, wf, status, segments)
        return
    if run.status == "awaiting_checkpoint":
        # An answer given outside the Inbox is followed; the workflow ending is noticed.
        await _watch_wait(db, run, wf, status, segments)
        followed = _drivable(run)
        if run.status != "running" or followed is None or followed["id"] != wf["id"]:
            _record_running(wf, status, segments)
            return  # still waiting, or done with this workflow
        wf = followed

    while run.status == "running":
        current = next((s for s in segments if s.status == "running"), None)
        entry = _plan_entry(wf, current.seq) if current is not None else None
        if current is None or entry is None:
            break
        round_ = int(entry.get("round") or 1)
        producers = tuple(entry["work"]) if round_ == 1 else (entry["revises"][round_ - 2],)
        done = status.step(producers[-1])
        if done is None or done.state != "SUCCEEDED":
            break
        reviews = entry.get("reviews") or []
        if entry.get("checkpoint") and round_ <= len(reviews):
            review = reviews[round_ - 1]
            parked = next(
                (p for p in status.parked if p.step_id == review and p.reason == "AWAITING_INPUT"),
                None,
            )
            ended = status.step(review)
            # Answered before Oracle opened its checkpoint (in SwarmCloud's console): the
            # checkpoint opens, and the next look at the wait follows that answer.
            answered = ended is not None and ended.state == "SUCCEEDED"
            closed = status.terminal and ended is not None and ended.state not in _OPEN_OR_DONE
            if parked is None and not answered and not closed:
                break
            await _harvest(run, current, wf["id"], producers)
            wait: dict[str, Any] = {
                "workflow_id": wf["id"],
                "step_id": review,
                "round": round_,
                "artifact": workflow.review_artifact(round_),
            }
            if parked is not None:
                wait["task_id"] = parked.task_id
                wait["opened_at"] = parked.opened_at.isoformat() if parked.opened_at else None
                wait["expires_at"] = parked.expires_at.isoformat() if parked.expires_at else None
            elif answered:
                wait["task_id"] = ended.task_id  # type: ignore[union-attr]
                # W5: answered and not read yet, so held from the start; the next look
                # at the wait reads it and applies the approver rule.
                wait["console"] = _unread_console(
                    run, current, wf, wait, "answered before Oracle opened the checkpoint"
                )
            else:
                # The wait ended before Oracle opened its checkpoint (it expired while the
                # run was paused): the checkpoint opens in the Inbox only.
                wait["ended"] = "expired"
                wait["ended_at"] = _now().isoformat()
                _note(current, workflow.ADVICE["expired"])
                await _detach(db, run, cancel=False, state="expired")
            stats.finished += 1
            if await _advance(db, run, current, segments, wait=wait):
                stats.advanced += 1
            break
        # Checkpoint off, or the last round's revision is done: the files are final.
        await _harvest(run, current, wf["id"], producers)
        stats.finished += 1
        if entry.get("checkpoint"):
            # Its checkpoint waits in the Inbox only: the workflow has nothing left.
            await _detach(db, run, cancel=False, state="ended")
        if await _advance(db, run, current, segments):
            stats.advanced += 1
    # A segment that started during this check shows what the check read.
    _record_running(wf, status, segments)
    _record_workflow_wait(run, wf, status, segments)

    if status.terminal and run.status == "running" and _live(run) is not None:
        current = next((s for s in segments if s.status == "running"), None)
        if status.state == "succeeded":
            if current is None:
                await _detach(db, run, cancel=False, state="ended")
                return
            error = f"the workflow ended before '{current.name}' wrote its files"
        else:
            fallback = f"the workflow ended {status.state}: {status.error or 'no reason given'}"
            error = workflow.advice(status.error_code, fallback)
            waited = (
                _queued_expiry(run, wf, status)
                if status.error_code == "mcp_credential_expired" and current is not None
                else None
            )
            if waited is not None and current is not None:
                if _may_restart(run, wf, status, current):
                    await _restart_queued(db, run, wf, current, segments, waited)
                    return
                error = waits.queued_expiry(waited, restarted="queue_restart" in run.knobs)
        if current is not None:
            current.status = "failed" if status.state != "cancelled" else "cancelled"
            current.error = error
            current.finished_at = _now()
        await _finish(db, run, "failed", f"{current.name if current else 'workflow'}: {error}")
        await audit.record(db, None, "run.failed", "run", run.id, {"workflow": wf["id"]})


def _queued_expiry(run: Run, wf: dict[str, Any], status: WorkflowStatus) -> float | None:
    """How long the failing step waited in SwarmCloud's queue when the workflow's key
    expired before it started (mcp_credential_expired), else None: it started before
    the key's ``expires_at`` (SwarmCloud's start time, else Oracle saw it working), or
    the failure came before that moment (its start time not served)."""
    expires = _parse_at(wf.get("expires_at"))
    failed = next((st for st in status.steps if st.state in ("FAILED", "DEAD_LETTERED")), None)
    if expires is None or failed is None:
        return None
    qw = (run.knobs or {}).get("queue_wait") or {}
    if qw.get("workflow_id") != wf.get("id"):
        qw = {}
    if failed.step_id in (qw.get("started_steps") or []):
        return None
    if failed.started_at is not None:
        if failed.started_at < expires:
            return None
    elif _now() < expires:
        return None
    submitted = _parse_at(wf.get("submitted_at"))
    since = _parse_at((qw.get("waiting") or {}).get(failed.step_id)) or submitted or expires
    if submitted is not None:
        since = max(since, submitted)
    return max((expires - since).total_seconds(), 0.0)


def _may_restart(run: Run, wf: dict[str, Any], status: WorkflowStatus, current: RunSegment) -> bool:
    """A queued expiry restarts once per run, and never when the segment's failed attempt
    (or its failing step) cost anything."""
    if "queue_restart" in (run.knobs or {}):
        return False
    spent = sum(
        Decimal(str(a.get("cost_usd") or 0))
        for a in _art(current)["attempts"]
        if a.get("workflow_id") == wf.get("id")
    )
    failed = next((st for st in status.steps if st.state in ("FAILED", "DEAD_LETTERED")), None)
    return spent == 0 and not (failed is not None and failed.cost_usd)


async def _restart_queued(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    current: RunSegment,
    segments: list[RunSegment],
    waited: float,
) -> None:
    """Owner, 2026-10-26: a run whose key expired while its step waited in SwarmCloud's
    queue is submitted again once, as a new attempt of the same segment with the same
    knobs and a fresh key (:func:`_submit`, which the spend ceiling rules as any other)."""
    art = _art(current)
    attempt = _current_attempt(art, current)
    if attempt:
        attempt["state"] = "failed"
    _set_art(current, art)
    _note(current, waits.restarted_note(waited))
    _set_knob(
        run,
        "queue_restart",
        {
            "seq": current.seq,
            "workflow_id": wf.get("id"),
            "at": _now().isoformat(),
            "waited_seconds": round(waited),
        },
    )
    _set_knob(run, "queue_wait", None)
    await _detach(db, run, cancel=False, state="ended")
    await _submit(db, run, current, segments)
    await audit.record(
        db,
        None,
        "run.restarted",
        "run",
        run.id,
        {"workflow": wf.get("id"), "reason": "mcp_credential_expired"},
    )


# --------------------------------------------------------------- the run's key renewed
#
# SwarmCloud #2498: a step that starts after the workflow's MCP credential expired (it
# waited in SwarmCloud's queue past the run token's lifetime) is parked CREDENTIAL_MISSING
# with code mcp_credential_expired, not failed. The tick marks the park on the run's
# workflow (``key_refresh``); after the pass commits, :func:`refresh_key` revokes the run's
# token, mints one with the same scopes and a lifetime sized for the steps still to run,
# and re-stores it (``PUT /v1/workflows/{id}/mcp-credentials``), which returns the parked
# steps to READY. Once per park, and never twice within KEY_REFRESH_SECONDS. A SwarmCloud
# that fails the step instead of parking it fails the run as before (``mcp_credential_
# expired``'s advice): the two paths never both act on one step, since a parked step has
# not failed and a failed one is never parked again.

# The least time between two renewals of a run's key.
KEY_REFRESH_SECONDS = 60
# The parks remembered as handled (the newest).
_KEY_REFRESH_PARKS = 20
_FINISHED_STEPS = frozenset({"SUCCEEDED", "SKIPPED", "FAILED", "CANCELLED", "DEAD_LETTERED"})


def _key_park_advice(parked: Parked) -> str:
    """The advice for a CREDENTIAL_MISSING park Oracle does not renew: a missing key, an
    expired one without a server to name, else (no detail) a switched-off server."""
    if parked.credential == "mcp" and parked.code == "mcp_credential_missing":
        return "key_missing"
    if parked.credential == "mcp" and parked.code == "mcp_credential_expired":
        return "key_expired_unnamed"
    return "CREDENTIAL_MISSING"


def _park_key(parked: Parked) -> str:
    at = parked.parked_at or parked.expired_at
    return f"{parked.task_id or parked.step_id}@{at.isoformat() if at else ''}"


def _mark_key_refresh(
    run: Run, wf: dict[str, Any], status: WorkflowStatus, parks: list[Parked]
) -> dict[str, Any]:
    """Mark the run's workflow for a key renewal when a park not handled yet is seen; the
    lifetime is sized as at submission, for the steps still to run. Returns the workflow
    as marked (unchanged when every park was handled, when SwarmCloud refused a renewal
    of this workflow already, or when the key stored last is newer than the park's
    expiry: the steps it promoted use it)."""
    refresh = dict(wf.get("key_refresh") or {})
    if refresh.get("state") == "refused":
        return wf
    minted = _parse_at(refresh.get("minted_at")) if refresh.get("state") == "stored" else None
    if minted is not None:
        parks = [p for p in parks if p.expired_at is None or p.expired_at > minted]
    handled = list(refresh.get("parks") or [])
    new = [k for k in (_park_key(p) for p in parks) if k not in handled]
    if not new:
        return wf
    wait_steps = (
        set(wf["waits"])
        if "waits" in wf
        else {r for e in wf.get("segments") or [] for r in e.get("reviews") or []}
    )
    left = [s for s in status.steps if s.state not in _FINISHED_STEPS]
    agents = sum(1 for s in left if s.step_id not in wait_steps)
    ttl = workflow.credential_seconds(agents, len(left) - agents, get_runtime_settings())
    refresh.update(
        parks=(handled + new)[-_KEY_REFRESH_PARKS:],
        park=new[-1],
        server=parks[0].server,
        seconds=ttl,
        state="due",
        seen_at=_now().isoformat(),
    )
    wf = {**wf, "key_refresh": refresh}
    _set_knob(run, "workflow", wf)
    return wf


def _renewed_note(at: datetime, zone: str) -> str:
    return (
        f"Key renewed at {company_time.stamp(at, zone)}: the step started after its key "
        "expired while it waited in SwarmCloud's queue"
    )


async def refresh_key(
    db: AsyncSession, run_id: uuid.UUID, *, deadline: float | None = None
) -> str | None:
    """Renew the run's key for a park :func:`_mark_key_refresh` marked (nothing when none
    is due): commits the new token before the call, so no lock is held across it, then
    records what SwarmCloud answered. The token goes only in the call's body. Returns an
    error to report once (a 403 or a 422), else None. Commits."""
    run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
    wf = _drivable(run) if run is not None else None
    refresh = dict((wf or {}).get("key_refresh") or {})
    if (
        run is None
        or wf is None
        or run.status not in ("running", "awaiting_checkpoint")
        or refresh.get("state") not in ("due", "retry", "storing")
    ):
        await db.rollback()
        return None
    minted = _parse_at(refresh.get("minted_at"))
    if minted is not None and (_now() - minted).total_seconds() < KEY_REFRESH_SECONDS:
        await db.rollback()
        return None
    # The same scopes as the run's token (its newest): never wider.
    scopes = await db.scalar(
        select(RunToken.scopes)
        .where(RunToken.run_id == run.id)
        .order_by(RunToken.created_at.desc())
        .limit(1)
    )
    if not scopes:
        _set_knob(run, "workflow", {**wf, "key_refresh": {**refresh, "state": "ended"}})
        await db.commit()
        return None
    seconds = int(refresh.get("seconds") or 0) or int(wf.get("credential_seconds") or 0)
    seconds = max(MIN_CREDENTIAL_SECONDS, min(MAX_CREDENTIAL_SECONDS, seconds))
    await revoke_run_tokens(db, run.id)
    token = await mint_run_token(db, run.id, scopes, seconds)
    workflow_id, server = wf["id"], str(refresh.get("server") or MCP_SERVER)
    refresh.update(state="storing", minted_at=_now().isoformat())
    _set_knob(run, "workflow", {**wf, "key_refresh": refresh})
    await db.commit()
    refused: RuntimeUnavailable | None = None
    try:
        await _within(
            get_runtime().store_mcp_credentials(workflow_id, server, token, seconds), deadline
        )
    except RuntimeUnavailable as exc:
        refused = exc
    run, segments = await _locked(db, run_id)
    wf = _live(run) if run is not None else None
    if run is None or wf is None or wf["id"] != workflow_id:
        await db.commit()
        return None
    refresh = dict(wf.get("key_refresh") or {})
    target = next(
        (s for s in segments if s.status == "running"),
        next((s for s in reversed(segments) if s.swarm_workflow_id == workflow_id), segments[0]),
    )
    status = refused.status if refused is not None else 200
    error: str | None = None
    if refused is None:
        refresh["state"] = "stored"
        # The decision's tail rule (:func:`_left`) counts from the renewed key.
        minted_at = _parse_at(refresh.get("minted_at")) or _now()
        wf["expires_at"] = workflow.expires_at(minted_at, seconds).isoformat()
        _note(target, _renewed_note(_now(), await company_time.company_time_zone(db)))
        await audit.record(
            db, None, "run.key_renewed", "run", run.id,
            {"workflow_id": workflow_id, "server": server, "expires_in": seconds},
        )  # fmt: skip
        log.info("run %s: key renewed for workflow %s (%s s)", run.id, workflow_id, seconds)
    elif status in (404, 409):
        # The workflow finished, or SwarmCloud does not know it: the run's own end
        # handling follows on the next read.
        refresh["state"] = "ended"
        log.info("run %s: key renewal not needed (HTTP %s)", run.id, status)
    elif status in (403, 422):
        refresh["state"] = "refused"
        # The key SwarmCloud refused was sent nowhere else: it is not left valid.
        await revoke_run_tokens(db, run.id)
        code = "key_refresh_forbidden" if status == 403 else "key_refresh_refused"
        _note(target, workflow.ADVICE[code])
        error = f"run {run_id}: SwarmCloud refused the run's key renewal (HTTP {status})"
        log.warning("run %s: key renewal refused: %s", run.id, refused)
    else:
        # Not answered, or SwarmCloud unavailable: tried again after KEY_REFRESH_SECONDS.
        refresh["state"] = "retry"
        log.warning("run %s: key renewal not confirmed: %s", run.id, refused)
    _set_knob(run, "workflow", {**wf, "key_refresh": refresh})
    await db.commit()
    return error


async def _pause_workflow(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    status: WorkflowStatus,
    segments: list[RunSegment],
) -> None:
    """Paused on overrun: cancel the live workflow, so that nothing more is spent (its
    checkpoint-off segments would run on, one after another). The segment it was on keeps
    its files when they are written (resuming opens its checkpoint in the Inbox), else it
    is submitted again as a new workflow once the run is resumed."""
    current = next((s for s in segments if s.status == "running"), None)
    entry = _plan_entry(wf, current.seq) if current is not None else None
    if current is not None and entry is not None:
        round_ = int(entry.get("round") or 1)
        producers = tuple(entry["work"]) if round_ == 1 else (entry["revises"][round_ - 2],)
        done = status.step(producers[-1])
        if done is not None and done.state == "SUCCEEDED":
            await _harvest(run, current, wf["id"], producers)
        else:
            art = _art(current)
            if art["attempts"]:
                _current_attempt(art, current)["state"] = "cancelled"
            _set_art(current, art)
            current.status = "pending"
            current.error = (
                "Paused on overrun before this segment finished: Oracle cancelled its "
                "workflow, and resuming submits the segment again."
            )
    for cp in await _checkpoints(db, [run.id]):
        wait = (cp.payload or {}).get("wait") or {}
        if cp.status == "pending" and wait.get("workflow_id") == wf["id"]:
            # Its wait goes with the workflow: the checkpoint stays open in the Inbox.
            wait = {**wait, "ended": "paused", "ended_at": _now().isoformat()}
            console = wait.get("console") or {}
            if console.get("needs") == "unread":
                # Never read now (the workflow is cancelled): an approver decides.
                wait["console"] = {
                    **console,
                    "needs": "unreadable",
                    "reason": "the run was paused on overrun before Oracle could read the "
                    "recorded answer (its workflow was cancelled), so an Oracle approver "
                    "decides",
                }
            cp.payload = {**(cp.payload or {}), "wait": wait}
    _note(
        current or segments[0],
        "Paused on overrun: Oracle cancelled the run's SwarmCloud workflow so that nothing "
        "more is spent; resuming continues as a new workflow.",
    )
    if not await _detach(db, run, cancel=True, state="paused"):
        _note(
            current or segments[0],
            "SwarmCloud did not confirm cancelling the workflow: Oracle cancels it again on "
            "every tick and keeps counting its cost, and submits nothing after it until "
            "the cancel is confirmed.",
        )


# How often the tick reads a wait while its run waits on it (GET .../input).
WATCH_SECONDS = 60


async def _waiting_on(db: AsyncSession, run: Run, wf: dict[str, Any]) -> Checkpoint | None:
    """The run's open checkpoint whose wait is in workflow ``wf``."""
    return next(
        (
            c
            for c in await _checkpoints(db, [run.id])
            if c.status == "pending"
            and ((c.payload or {}).get("wait") or {}).get("workflow_id") == wf["id"]
        ),
        None,
    )


async def _watch_wait(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    status: WorkflowStatus,
    segments: list[RunSegment],
) -> None:
    """While the run waits on a checkpoint in its workflow: read the wait (at most once
    a minute) and, when it was answered without the Inbox (in SwarmCloud's console, or
    by an earlier post of Oracle's whose response was lost), take that answer (W5: it is
    the decision only if it counts, and a counted change request the workflow has no
    revision for waits for an approver's Redo or Continue). A workflow that ended
    unanswered leaves the checkpoint in the Inbox.

    A read SwarmCloud did not serve is tried again on the next tick (the tick keeps this
    one's cost reading); a refused read of a step that SUCCEEDED is an answer Oracle
    cannot read, never "unanswered"."""
    cp = await _waiting_on(db, run, wf)
    if cp is None:
        if status.terminal:
            await _wait_ended(db, run, wf, status, segments)
        return
    wait = dict((cp.payload or {}).get("wait") or {})
    if ((wait.get("console") or {}).get("needs")) in ("confirm", "redo_or_continue"):
        return  # answered, and the first answer is final: an approver decides in the Inbox
    try:
        checked = datetime.fromisoformat(wait["checked_at"])
    except (KeyError, TypeError, ValueError):
        checked = None
    if checked is not None and (_now() - checked).total_seconds() < WATCH_SECONDS:
        return
    round_ = int(wait.get("round") or 1)
    step = status.step(wait.get("step_id", ""))
    answered_step = step is not None and step.state == "SUCCEEDED"
    seq = (cp.payload or {}).get("segment_seq")
    segment = next(s for s in segments if s.seq == seq)
    try:
        record = await _rt().answer_record(
            wf["id"], wait["step_id"], wait.get("artifact") or workflow.review_artifact(round_)
        )
    except RuntimeUnavailable as exc:
        if exc.retryable:
            log.warning(
                "run %s: wait %s not read, again next tick: %s", run.id, wait["step_id"], exc
            )
            if answered_step:
                # W5: answered, not read yet: held until it is (read again next tick).
                _unread(run, cp, segment, wf, wait, f"SwarmCloud did not serve it ({_shown(exc)})")
            return
        log.warning("run %s: cannot read wait %s: %s", run.id, wait.get("step_id"), exc)
        record = RecordedAnswer(state="answered") if answered_step else RecordedAnswer()
    wait["checked_at"] = _now().isoformat()
    _set_wait(cp, wait)
    if record.answered:
        if record.verdict is None:
            # Never guessed: shown in the Inbox, and read again next time.
            _unreadable(run, cp, segment, wf, wait, record)
            return
        await _take_answer(db, run, cp, segment, segments, wf, wait, record)
        return
    if answered_step:
        # The record lags the step: answered, not read yet (W5), held; read again.
        _unread(run, cp, segment, wf, wait, "SwarmCloud's record does not show the answer yet")
        return
    if status.terminal:
        await _wait_ended(db, run, wf, status, segments)


async def _take_answer(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    wait: dict[str, Any],
    record: RecordedAnswer,
) -> None:
    """A wait answered without the Inbox, noticed by the tick. SwarmCloud's first answer
    is final and the workflow goes on with it; what Oracle does follows W5:

    - Oracle's own answer (a post whose response was lost), or a console answer whose
      answerer (``answered_by``, never the unverified ``on_behalf_of``) is an Oracle member
      with the checkpoint's approver role: the checkpoint's decision, followed;
    - any other console answer: recorded, and the checkpoint stays open in the Inbox for
      an approver to confirm it or request changes;
    - a counted NOT_YET where the workflow has no revision step (an earlier checkpoint:
      it went on into the next segment regardless): never re-run on its own; the
      checkpoint stays open with the findings for an approver's Redo or Continue."""
    round_ = int(wait.get("round") or 1)
    ours = record.answer_id == str(cp.id) and record.by_oracle
    # Oracle's own post of a decision voided while it was delivered (its decider lost
    # standing, :func:`_void_owed`): it landed, but it is never the decision on its own.
    voided = ours and isinstance(wait.get("voided"), dict)
    at = record.answered_at.isoformat() if record.answered_at else _now().isoformat()
    findings = list(record.findings)
    applied = "; ".join(findings) or None
    by = record.answered_by
    wait["recorded"] = _recorded(record, by, at, record.via, ours)
    entry = _plan_entry(wf, segment.seq) or {}
    approved = record.verdict == MERGE
    revise = round_ <= len(entry.get("revises") or [])
    if voided:
        ours = False
        member, reason = (
            None,
            "Oracle posted it for a decision that was voided because its decider lost standing",
        )
    else:
        member, reason = (
            (None, None)
            if ours
            else await _console_member(
                db, cp, by, flow=run.flow, altered=record.answered_by_altered
            )
        )
    counted = ours or reason is None
    if counted and approved and not ours and cp.kind == "feature_set":
        # The gate below reads the scope as stored, re-checked now (C6).
        await _recheck_scope(db, cp)
    if counted and approved and not ours:
        # D3 "Console gate": held while a blocking reason is not fixed or waived.
        shut = await approve_gate_of(db, cp)
        if shut is not None and not shut.open:
            await _hold_console_approval(db, run, cp, segment, record, wait, at, revise, member)
            return
        if cp.kind in apply_edits.FILES and (
            unapplied := apply_edits.edit_count((await _staged_actions(db, [cp])).get(cp.id, []))
        ):
            _note(segment, _unapplied_note(unapplied))
    if not counted or (not approved and not revise):
        console = _console_record(run, segment, record, at, revise)
        console.update(
            counted=counted,
            reason=reason,
            needs="redo_or_continue" if counted else "confirm",
            role=member.role if member is not None else None,
        )
        wait["console"] = console
        _set_wait(cp, wait)
        await audit.record(
            db,
            None,
            "checkpoint.console_answer",
            "checkpoint",
            cp.id,
            {
                "run_id": str(run.id),
                "kind": cp.kind,
                "answered_in": "swarmcloud",
                "answered_by": by,
                "verdict": record.verdict,
                "counted": counted,
            },
        )
        if not counted:
            label = f" (labelled for {record.on_behalf_of})" if record.on_behalf_of else ""
            _note(
                segment,
                f"{cp.kind} (round {round_}) was answered in SwarmCloud by {by or 'someone'}"
                f"{label}: {_said(record, at)}. It does not count ({reason}), so the "
                "checkpoint stays open in the Inbox for an approver to confirm it or request "
                "changes.",
            )
        else:
            _note(
                segment,
                f"{_outside_note(cp, round_, record, at)} The workflow has no revision step "
                "there and went on regardless; "
                f"nothing is re-run on its own. In the Inbox an approver chooses Redo from "
                f"'{console['redo_segment']}' (a new workflow: one more segment, about "
                f"${console['redo_cost_usd']:g}) or Continue.",
            )
        return
    wait.pop("console", None)
    wait["answered"] = {
        "verdict": record.verdict,
        "at": at,
        "replayed": False,
        "answer_id": record.answer_id,
        "answered_by": by,
        "on_behalf_of": record.on_behalf_of,
        "via": record.via,
        "seen_by": "tick",
    }
    cp.status = "approved" if approved else "changes_requested"
    cp.decided_at = record.answered_at or _now()
    cp.note = applied
    if not ours:
        _record_decider(cp, member.role if member is not None else None, "swarmcloud_console")
    if member is not None:
        cp.decided_by = member.id
    elif ours and record.on_behalf_of:
        # Oracle's own post: the label is the one Oracle sent, for its Inbox user.
        cp.decided_by = await db.scalar(select(User.id).where(User.email == record.on_behalf_of))
    _set_wait(cp, wait)
    if approved and cp.kind == eng_dates.KIND:
        # F4 lane B: a counted console approval records the dates as Oracle's Approve does
        # (decide_checkpoint), for the member who answered (or Oracle's own Inbox user).
        decider = member or (await db.get(User, cp.decided_by) if cp.decided_by else None)
        if decider is not None and decider.disabled_at is None:
            staged = await db.scalars(
                select(CheckpointAction)
                .where(CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged")
                .order_by(CheckpointAction.created_at, CheckpointAction.id)
            )
            principal = _creator(current_tenant(db), decider, None)
            await eng_dates.on_approved(db, principal, run, cp, list(staged))
    # H1: a counted answer from the console (or Oracle's own lost post) is the stop's
    # decision: a checkpoint record, unless one was recorded when it was decided here.
    await decisions_capture.checkpoint(
        db, None, run, cp, decided_via="oracle" if ours else "swarmcloud_console"
    )
    await _scope_decided(db, None, run, cp)
    await audit.record(
        db,
        None,
        f"checkpoint.{cp.status}",
        "checkpoint",
        cp.id,
        {"run_id": str(run.id), "kind": cp.kind, "answered_in": "swarmcloud", "answered_by": by},
    )
    if ours:
        what = (
            f"{cp.kind} (round {round_}): SwarmCloud recorded Oracle's own answer "
            f"{record.verdict}{f' for {record.on_behalf_of}' if record.on_behalf_of else ''}, "
            "whose response was lost; Oracle follows it."
        )
    else:
        what = (
            _outside_note(cp, round_, record, at)
            + f" {by} is an Oracle {member.role if member else 'member'}, so it counts: "
            "Oracle follows that answer."
        )
    _note(segment, what)
    await _follow(
        db,
        run,
        cp,
        segment,
        segments,
        wf,
        entry,
        round_,
        approved,
        note=applied or "",
        note_by=by if applied else None,
        strict=False,
    )


async def _console_member(
    db: AsyncSession,
    cp: Checkpoint,
    answered_by: str | None,
    *,
    flow: str = "",
    altered: bool = False,
) -> tuple[User | None, str | None]:
    """The Oracle member who answered in SwarmCloud, and why their answer does not count
    (None when it does): matched by ``answered_by`` only, never one that redaction
    altered. Emails match case-insensitively; an exact match wins, and two members that
    differ only by case with neither exact is no match (the same answer every time). An
    engineering stop with a lead named counts only a lead's or an owner's (A3); ``flow``
    is the run's (prd_to_spec keeps its own rule)."""
    if not answered_by:
        return None, "SwarmCloud recorded no answerer"
    if altered:
        return None, "SwarmCloud's answerer could not be read as recorded"
    users = list(
        await db.scalars(
            select(User)
            .where(func.lower(User.email) == answered_by.lower())
            .order_by(User.email, User.id)
        )
    )
    exact = [u for u in users if u.email == answered_by]
    if exact:
        user = exact[0]
    elif len(users) == 1:
        user = users[0]
    elif users:
        return None, f"{answered_by} matches more than one Oracle member (by case)"
    else:
        return None, f"{answered_by} is not an Oracle member"
    leads = await engineering_leads(db)
    if lead_stop(cp.kind, flow, leads):
        if user.disabled_at is not None or not decides(user.role, user.id, cp, flow, leads):
            return user, f"{answered_by} is not an engineering lead"
        return user, None
    if not has_role(user.role, cp.approver_role):  # type: ignore[arg-type]
        return user, (
            f"{answered_by} is an Oracle {user.role}, below the checkpoint's "
            f"{cp.approver_role} role"
        )
    return user, None


def _console_record(
    run: Run, segment: RunSegment, record: RecordedAnswer, at: str | None, revise: bool
) -> dict[str, Any]:
    """What the console said, as the Inbox shows it, with what a Redo would cost."""
    return {
        "answer_id": record.answer_id,
        "answered_by": record.answered_by,
        "on_behalf_of": record.on_behalf_of,
        "answered_at": at,
        "via": record.via,
        "verdict": record.verdict,
        "findings": list(record.findings),
        "revise": revise,
        "redo_segment": _flow(run).segment(segment.name).title,
        "redo_cost_usd": float(segment.estimate_usd or 0),
        "seen_at": _now().isoformat(),
    }


def _unreadable(
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    wf: dict[str, Any],
    wait: dict[str, Any],
    record: RecordedAnswer,
) -> None:
    """The wait was answered, and Oracle cannot read the verdict (the form artifact is
    missing, too large or odd, or the record was refused): shown in the Inbox, where an
    approver may approve (the workflow did what an approval needs, whatever was recorded)
    or Redo the segment as a new workflow. Read again each minute meanwhile."""
    round_ = int(wait.get("round") or 1)
    entry = _plan_entry(wf, segment.seq) or {}
    at = record.answered_at.isoformat() if record.answered_at else None
    first = (wait.get("console") or {}).get("needs") != "unreadable"
    console = _console_record(run, segment, record, at, round_ <= len(entry.get("revises") or []))
    console.update(
        counted=None, reason="the recorded verdict could not be read", needs="unreadable"
    )
    wait["console"] = console
    _set_wait(cp, wait)
    log.warning("run %s: wait %s answered, verdict not readable", run.id, wait.get("step_id"))
    if first:
        artifact = wait.get("artifact") or workflow.review_artifact(round_)
        _note(
            segment,
            f"{cp.kind} (round {round_}) was answered in SwarmCloud"
            f"{f' by {record.answered_by}' if record.answered_by else ''}, but Oracle could not "
            f"read the recorded verdict ({artifact}); it reads it again each minute. In the "
            "Inbox an approver can approve (the workflow already did what an approval needs) "
            f"or choose Redo from '{console['redo_segment']}' as a new workflow.",
        )


def _unread_console(
    run: Run,
    segment: RunSegment,
    wf: dict[str, Any] | None,
    wait: dict[str, Any],
    why: str,
    *,
    by: str | None = None,
    at: str | None = None,
    via: str | None = None,
) -> dict[str, Any]:
    """What the Inbox shows of a wait answered in SwarmCloud that Oracle has not read
    yet (``needs: unread``)."""
    round_ = int(wait.get("round") or 1)
    entry = (_plan_entry(wf, segment.seq) or {}) if wf is not None else {}
    earlier = wait.get("console") or {}
    console = _console_record(
        run, segment, RecordedAnswer(), None, round_ <= len(entry.get("revises") or [])
    )
    console.update(
        answered_by=by or earlier.get("answered_by"),
        answered_at=at or earlier.get("answered_at"),
        via=via or earlier.get("via"),
        counted=None,
        reason=f"Oracle has not read the recorded answer yet: {why}",
        needs="unread",
        seen_at=earlier.get("seen_at") or console["seen_at"],
    )
    return console


def _unread(
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    wf: dict[str, Any],
    wait: dict[str, Any],
    why: str,
) -> None:
    """W5 (owner, 2026-10-19): the wait was answered (its step SUCCEEDED) and Oracle
    cannot read the answer yet (SwarmCloud errors, a 404, a lagging record): it counts as
    unconfirmed, so the run's token is read-only until the answer is read, and the Inbox
    shows the checkpoint waiting to read it. Read again on every tick; once read, the
    approver rule applies. An answer already shown (one that did not count, or could not
    be read) stays as it is."""
    needs = (wait.get("console") or {}).get("needs")
    if needs not in (None, "unread"):
        return
    wait["console"] = _unread_console(run, segment, wf, wait, why)
    _set_wait(cp, wait)
    if needs is None:
        round_ = int(wait.get("round") or 1)
        _note(
            segment,
            f"{cp.kind} (round {round_}) was answered in SwarmCloud, and Oracle cannot read "
            f"the answer yet ({_clip(why)}). Until it does, the run's agents may read Oracle "
            "but not write to it; Oracle reads it again on every tick, then applies the "
            "approver rule.",
        )


def _recorded(
    record: RecordedAnswer, by: str | None, at: str | None, via: str | None, ours: bool
) -> dict[str, Any]:
    return {
        "answer_id": record.answer_id,
        "answered_by": by,
        "on_behalf_of": record.on_behalf_of,
        "answered_at": at,
        "via": via,
        "verdict": record.verdict,
        "findings": list(record.findings),
        "outside_oracle": not ours,
    }


def _said(record: RecordedAnswer, at: str | None) -> str:
    """What was answered in SwarmCloud, for a note: the verdict, findings, via and when."""
    findings = f" ({_clip('; '.join(record.findings))})" if record.findings else ""
    return (
        f"{record.verdict or 'it'}{findings} in SwarmCloud"
        f"{f' via {record.via}' if record.via else ''}{f' at {at}' if at else ''}"
    )


def _outside_note(cp: Checkpoint, round_: int, record: RecordedAnswer, at: str | None) -> str:
    who = record.answered_by or "someone"
    if record.on_behalf_of:
        who += f" for {record.on_behalf_of}"
    return (
        f"{cp.kind} (round {round_}) was decided outside Oracle: {who} answered "
        f"{_said(record, at)}."
    )


async def _wait_ended(
    db: AsyncSession,
    run: Run,
    wf: dict[str, Any],
    status: WorkflowStatus,
    segments: list[RunSegment],
) -> None:
    """The workflow ended while a checkpoint waited in it, unanswered (W2b: the wait
    expired, or it ended otherwise; :func:`_watch_wait` read the wait first, and an
    answered one is followed, its finished steps harvested, instead). The checkpoint
    stays open in the Inbox; deciding it continues the run as a new workflow."""
    cp = await _waiting_on(db, run, wf)
    step = status.step(((cp.payload or {}).get("wait") or {}).get("step_id", "")) if cp else None
    expired = status.error_code == "expired" or (
        status.state == "failed" and step is not None and step.state != "SUCCEEDED"
    )
    if expired:
        note = workflow.ADVICE["expired"]
    else:
        note = (
            f"The workflow waiting on this run's checkpoint ended {status.state} in SwarmCloud"
            f"{f' ({status.error})' if status.error else ''}. The checkpoint stays open in the "
            "Inbox; deciding it continues the run as a new workflow."
        )
    if cp is not None:
        wait = dict((cp.payload or {}).get("wait") or {})
        wait["ended"] = "expired" if expired else status.state
        wait["ended_at"] = _now().isoformat()
        _set_wait(cp, wait)
        seq = (cp.payload or {}).get("segment_seq")
        target = next((s for s in segments if s.seq == seq), segments[0])
        _note(target, note)
    await _detach(db, run, cancel=False, state="expired" if expired else "ended")


async def _tick_searches(db: AsyncSession, run_id: uuid.UUID, stats: _TickStats) -> bool:
    """Look for the submissions Oracle gave up on (:func:`_search_earlier`), committed on
    its own: what was found, cancelled and counted stays so, whatever the rest of this
    tick does, and is never counted again by a pass run again for a runtime call."""
    run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
    if run is None or not (run.knobs or {}).get("searches"):
        await db.rollback()
        return False
    await _search_earlier(db, run, await _segments(db, run_id), stats)
    await db.commit()
    return True


async def _tick_one(
    db: AsyncSession, run_id: uuid.UUID, stats: _TickStats, deadline: float
) -> bool:
    """One run's pass under its row lock (skipped when another transaction holds it, or
    nothing there needs a tick); False when the run was skipped. Run inside
    :func:`_replay`: it reads the run afresh every time it starts."""
    run = await db.scalar(select(Run).where(Run.id == run_id).with_for_update(skip_locked=True))
    if run is None or not (
        run.status in ("running", "paused_overrun")
        or _live(run) is not None
        or (run.knobs or {}).get("searches")
    ):
        await db.rollback()
        return False
    stats.checked += 1
    await _tick_run(db, run, stats, deadline)
    await db.commit()
    return True


async def _has_waiting(db: AsyncSession, run_id: uuid.UUID) -> bool:
    """Whether a segment of the run waits to be submitted (:func:`_waiting`), read without
    a lock: :func:`submit_queued` locks the run and looks again."""
    segments = await _segments(db, run_id)
    waiting = any(_waiting(s) for s in segments)
    await db.rollback()
    return waiting


async def tick(db: AsyncSession, principal: Principal | None = None) -> TickOut:
    """Advance every active run of the session's tenant; within :data:`TICK_RUN_SECONDS`
    of runtime calls per run, and never with a run's row lock held across one."""
    stats = _TickStats()
    errors: list[str] = []
    # E1: queued derivations of PRD drafts start first, so this pass submits them.
    from oracle.roadmap import draft_items

    errors += await draft_items.start_due(db)
    # Runs with a live workflow are watched whatever their state: a wait may be answered
    # outside Oracle or expire, the workflow may end in SwarmCloud, and one Oracle is
    # cancelling (even for a run that ended) has its cost read until the cancel holds.
    live = Run.knobs["workflow"]["state"].astext == "live"
    # And runs looking for a submission given up on, ended ones too: if it landed, it
    # spends until Oracle finds and cancels it.
    searching = Run.knobs.has_key("searches")
    # And runs owing SwarmCloud an Inbox decision recorded but not posted yet.
    owing = Run.id.in_(
        select(Checkpoint.run_id).where(
            Checkpoint.status.in_(DECIDED), Checkpoint.payload["wait"].has_key("posting")
        )
    )
    ids = list(
        await db.scalars(
            select(Run.id)
            .where(Run.status.in_(("running", "paused_overrun")) | live | searching | owing)
            .order_by(Run.started_at, Run.id)
        )
    )
    await db.rollback()
    loop = asyncio.get_running_loop()
    for run_id in ids:
        # One cap on the runtime calls of this run's whole pass, its submission included.
        deadline = loop.time() + TICK_RUN_SECONDS
        stats.pass_id = uuid.uuid4().hex
        try:
            # Its parses count against the run (oracle.safe_yaml.MAX_PER_OWNER).
            with safe_yaml.parse_owner(str(run_id)):
                owed = await _owed_decision(db, run_id)
                if owed is not None:
                    # An Inbox decision recorded, its post to SwarmCloud not finished: tried
                    # first. Whether or not SwarmCloud takes it, the run's pass still runs
                    # (its cost, the ceiling, its workflow's end): a post that keeps failing
                    # must not stop Oracle from watching the run.
                    try:
                        await _complete_decision(db, run_id, owed, deadline, stats)
                    except Unavailable as exc:
                        errors.append(f"run {run_id}: {exc}")
                # Each replay puts back only what its own unfinished passes counted: what an
                # earlier one committed (the searches' pause, say) stays counted.
                await _replay(
                    db,
                    deadline,
                    lambda run_id=run_id: _tick_searches(db, run_id, stats),
                    reset=_resetter(stats),
                )
                ran = await _replay(
                    db,
                    deadline,
                    lambda run_id=run_id, deadline=deadline: _tick_one(db, run_id, stats, deadline),
                    reset=_resetter(stats),
                )
                if not ran:
                    if owed is None:
                        continue
                    stats.checked += 1  # counted once: by its pass when that ran
                if (refused := await refresh_key(db, run_id, deadline=deadline)) is not None:
                    errors.append(refused)
                if await _has_waiting(db, run_id):
                    await submit_queued(db, run_id, deadline=deadline)
        except safe_yaml.ParseBusy as exc:
            # No free worker for its import within the wait: the run stays as it was
            # (retryable), the tick gives up on it and the next tick tries again. The
            # run's row lock and transaction end here, not after the wait.
            await db.rollback()
            errors.append(f"run {run_id}: {exc.code}")
        except RuntimeUnavailable as exc:
            await db.rollback()
            errors.append(f"run {run_id}: {exc}")
        except Exception as exc:  # one broken run must not stop the others
            if _dates_pending(exc):
                # The run stays as it was and the next tick tries again: never a failed
                # run. Its row lock and transaction end here.
                await db.rollback()
                errors.append(f"run {run_id}: dates_pending")
                continue
            log.exception("tick failed for run %s", run_id)
            await db.rollback()
            errors.append(f"run {run_id}: {type(exc).__name__}")
    errors += stats.errors
    return TickOut(
        runs_checked=stats.checked,
        segments_finished=stats.finished,
        runs_advanced=stats.advanced,
        runs_paused=stats.paused,
        errors=errors,
    )


# --------------------------------------------------------------------------- decisions


async def decide_checkpoint(
    db: AsyncSession,
    principal: Principal,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    decision: str,
    note: str | None,
    expected_revision: int | None = None,
    audit_via: str | None = None,
) -> None:
    """``audit_via``: ``document_review`` when the version's review decided it (D10)."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    # Approving starts the next segment and spends money: the caller must hold the
    # checkpoint's role when the decision lands, read under the gate (a disable or a
    # demotion that commits first wins). A disable voids a decision whose segment has
    # not been submitted yet (oracle.members.service._void_checkpoint_decisions).
    await publish.gate_lock(db, shared=True)
    run = await _get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is None:
        raise NotFound(f"checkpoint {checkpoint_id} not found")
    # A3: an engineering stop waits for the engineering leads and owners once a lead is
    # named (C2 Multiple reviewers); the flag is re-read here, under the run's lock.
    leads = await engineering_leads(db)
    by_lead = lead_stop(cp.kind, run.flow, leads)
    if not may_decide(principal, cp, run.flow, leads):
        raise Forbidden(LEAD_ONLY if by_lead else f"Requires the {cp.approver_role} role")
    refusal = (
        await lead_refusal(db, principal)
        if by_lead
        else await caller_refusal(db, principal, cp.approver_role)  # type: ignore[arg-type]
    )
    if refusal is not None:
        raise Forbidden(refusal)
    if (
        audit_via is None
        and cp.kind in review_link.KINDS
        and not review_link.is_decider(principal, await review_link.decider_of(db, cp))
    ):
        # D10: Approve draft and Send back are the designated decider's, as approve_version.
        raise Forbidden(review_link.DECIDER_ONLY)
    if cp.status in DECIDED:
        # A recorded decision is final (owner, 2026-10-20), delivered to the run or not
        # yet: the same decision again, or the other one, changes nothing. A different
        # verdict entered in SwarmCloud's console is still taken as a correction.
        raise RunError(
            f"already decided: this checkpoint is {cp.status.replace('_', ' ')}; a recorded "
            "decision is final"
        )
    if cp.status != "pending" or run.status != "awaiting_checkpoint":
        raise RunError(f"checkpoint is {cp.status}; run is {run.status}")
    if expected_revision is not None and expected_revision != (cp.draft_revision or 0):
        # D8: the shared draft changed since the decider loaded it (a console confirm
        # too): nothing is decided; they look again.
        from oracle.runs import actions

        raise await actions.review_changed(db, cp, expected_revision)
    # The note defaults to the shared draft's (D8).
    note = (note if note is not None else cp.draft_note or "").strip() or None
    # D4: an Inbox send-back delivers a structured review of the shared draft (a console
    # Redo carries the console's findings instead).
    send_back = decision == "changes_requested"
    wait = (cp.payload or {}).get("wait") or {}
    redo = False
    # A choice about an answer SwarmCloud's console recorded is decided through it (H1).
    via = "swarmcloud_console" if decision in ("confirm", "redo", "continue") else "oracle"
    # Who decided, as the run's agents read it (list_decisions): the Inbox's decider, or
    # for a confirmed console answer its author, by role.
    decider: tuple[str | None, str] = (principal.role, "oracle")
    if decision in ("confirm", "redo", "continue"):
        if decision == "confirm":
            decider = ((wait.get("console") or {}).get("role"), "swarmcloud_console")
        decision, note, redo = _console_choice(cp, wait, decision, note)
        if decision == "confirm":
            # A console change request where the workflow has no revision step: now
            # counted, it waits for Redo or Continue.
            console = {
                **wait["console"],
                "counted": True,
                "needs": "redo_or_continue",
                "confirmed_by": str(principal.id),
                "confirmed_at": _now().isoformat(),
            }
            cp.payload = {**(cp.payload or {}), "wait": {**wait, "console": console}}
            await audit.record(
                db,
                principal,
                "checkpoint.console_confirmed",
                "checkpoint",
                cp.id,
                {"run_id": str(run.id), "kind": cp.kind, "answered_by": console["answered_by"]},
            )
            await db.commit()
            return
    if decision == "approved" and cp.kind == "feature_set" and await _recheck_scope(db, cp):
        # The scope as stored still has blocking problems: unless each is waived, the
        # refreshed check is kept for the run page and the Inbox, and nothing is decided.
        if (shut := await approve_gate_of(db, cp)) and not shut.open:
            await db.commit()
            raise blocking_open(shut)
    if decision == "approved" and (blocked := _cannot_approve(cp)):
        # Approve, a confirmed console approval and Continue alike: nothing is decided.
        raise RunError(blocked)
    edited: _Edited | None = None
    if decision == "approved" and via == "oracle" and cp.kind in apply_edits.FILES:
        # D7: the staged edits are applied to the file and the result re-checked under the
        # same gate; a refusal raises before anything is written.
        edited = await _apply_staged_edits(db, principal, run, cp)
    if (
        decision == "approved"
        and edited is None
        and (shut := await approve_gate_of(db, cp))
        and not shut.open
    ):
        # D3: the same for a blocking reason not fixed or waived (one gate for every path).
        raise blocking_open(shut)
    # D7: a console approval never applies staged edits (its answerer did not see them).
    unapplied = (
        apply_edits.edit_count((await _staged_actions(db, [cp])).get(cp.id, []))
        if decision == "approved" and via == "swarmcloud_console"
        else 0
    )
    # D10: a PRD or roadmap review sends back D4's review of the document's own feedback,
    # the note optional (cp.note stays the person's).
    document_review = (
        await review_link.review_file(db, cp, note) if decision == "changes_requested" else None
    )
    if decision == "changes_requested" and not note and document_review is None:
        if not send_back:
            raise Invalid("say what to change: a note is required to request changes")
        sent = select(func.count()).where(
            CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged"
        )
        if cp.kind == "feature_set":
            # C7: an edit or an add is the scope's rows (counted below), never a staged
            # action the review file carries.
            sent = sent.where(CheckpointAction.kind.not_in(("edit", "add")))
        staged = await db.scalar(sent.select_from(CheckpointAction))
        if not staged and cp.kind == "feature_set":
            # C7: the rows a person changed are what is sent back.
            from oracle.runs import scope_review

            staged = await scope_review.edits_count(db, cp)
        if not staged:
            raise Invalid(NOTHING_TO_SEND)
    segments = await _segments(db, run.id)
    seq = (cp.payload or {}).get("segment_seq")
    segment = next((s for s in segments if s.seq == seq), None)
    # Only a segment in the state its checkpoint expects is started: the checkpoint's
    # segment succeeded, and the next one (approved) has not run.
    later = next(
        (s for s in segments if segment and s.seq > segment.seq and s.status != "skipped"), None
    )
    if segment is None or segment.status != "succeeded":
        raise RunError(f"the checkpoint's segment is {segment.status if segment else 'missing'}")
    if decision == "approved" and later is not None and later.status != "pending":
        raise RunError(f"the next segment is {later.status}, not waiting to start")
    cp.status = decision
    cp.decided_by = principal.id
    cp.decided_at = _now()
    cp.note = note
    if document_review is not None:
        cp.review = document_review
    elif send_back:
        from oracle.runs import review_file

        cp.review = await review_file.sent_review(db, principal, run, cp, note)
    if edited is not None:
        _write_edits(run, cp, segment, edited)
    if unapplied:
        _note(segment, _unapplied_note(unapplied))
    _record_decider(cp, *decider)
    data: dict[str, Any] = {"run_id": str(run.id), "kind": cp.kind}
    if edited is not None:
        data.update(edited.audit)
    if audit_via is not None:
        data["via"] = audit_via
    if cp.kind in ENGINEERING_KINDS and run.flow != SPEC_FLOW:
        # F4 Engineering review stop reads whether a lead was named when it was decided.
        data["engineering_lead_named"] = bool(leads)
    if via == "swarmcloud_console":
        data["via"] = via
    await audit.record(db, principal, f"checkpoint.{decision}", "checkpoint", cp.id, data)
    await webhooks.capture(
        db, "run.checkpoint_decided", principal, run_id=run.id, checkpoint_id=cp.id,
        outcome=decision,
    )  # fmt: skip
    # H1: the stop's decision is a checkpoint record, in this transaction.
    await decisions_capture.checkpoint(db, principal, run, cp, decided_via=via)
    await _scope_decided(db, principal, run, cp)
    # G4: the discussion changes behind the shared draft's actions follow the decision.
    from oracle.staging import hooks as staging_hooks

    await staging_hooks.decided(db, cp, decision)
    if decision == "approved" and cp.kind == eng_check.KIND and run.flow != SPEC_FLOW:
        # F4: the lead's verdicts, answers and sizes, in this transaction.
        staged = await db.scalars(
            select(CheckpointAction).where(
                CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged"
            )
        )
        await eng_check.on_approved(db, principal, run, cp, list(staged))
    if decision == "approved" and cp.kind == eng_dates.KIND:
        # F4 lane B: the lead's dates become verified bases, the draft's items re-checked.
        staged = await db.scalars(
            select(CheckpointAction)
            .where(CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged")
            .order_by(CheckpointAction.created_at, CheckpointAction.id)
        )
        await eng_dates.on_approved(db, principal, run, cp, list(staged))
    if decision == "approved":
        # F5-1: an approved Engineering check registers its tech briefs when the run's
        # PRD exists (else the prd_draft import does), in this transaction.
        from oracle.engineering import store as brief_store

        await brief_store.on_checkpoint_approved(db, principal, run, cp, segment)
    wf = _drivable(run)
    live = (
        (redo and wf is not None)
        or (wf is not None and wait.get("workflow_id") == wf["id"])
        or _cancel_pending(run)
    )
    if redo:
        title = _flow(run).segment(segment.name).title
        _note(
            segment,
            f"An approver chose Redo from '{title}' at {cp.kind}: Oracle cancels the run's "
            "workflow and runs the segment again as a new workflow with the findings (one more "
            f"segment, about ${float(segment.estimate_usd or 0):g}).",
        )
    if live:
        # SwarmCloud is called after this commits: the decision is recorded under the gate
        # (the caller was checked above), and its post, or the cancel it needs, is made
        # with the gate and the run's row lock released (:func:`_finish_decision`). A post
        # that does not finish leaves this marker for the tick to complete.
        _set_wait(
            cp,
            {
                **wait,
                "posting": {
                    "redo": redo,
                    # Who decided, as they authenticated: re-read under the gate before
                    # each try (_finish_decision_now), so a decider who lost standing
                    # meanwhile never has the decision delivered.
                    "user_id": str(principal.user_id) if principal.user_id else None,
                    "token_id": str(principal.token_id) if principal.token_id else None,
                    "grant_id": str(principal.grant_id) if principal.grant_id else None,
                    "at": _now().isoformat(),
                    "tries": 0,
                },
            },
        )
        await db.commit()
        checkpoint_id = cp.id
        await _complete_decision(db, run_id, checkpoint_id, None)
        voided = await _voided_while_delivered(db, checkpoint_id)
        if voided is not None:
            raise Forbidden(f"{voided}: the decision was voided before it reached the run")
        return
    await _continue_decided(db, run, cp, segment, segments, later, decision, note)
    if _cancel_pending(run):
        # Nothing is submitted after a workflow SwarmCloud may still be running.
        raise _unconfirmed("continue the run as a new workflow")
    await db.commit()  # the router submits it (submit_queued), outside the gate


def _unapplied_note(n: int) -> str:
    return (
        f"Approved in the runtime's console: {n} staged edit{' was' if n == 1 else 's were'} "
        "not applied"
    )


@dataclass
class _Edited:
    """Staged edits applied and re-checked (D7), not written yet."""

    name: str
    agents: str
    text: str
    attempt: int
    check: dict[str, Any]
    revision: dict[str, Any]
    review: dict[str, Any]
    audit: dict[str, Any]


def _edits_refused(code: str, message: str, **extra: Any) -> RunError:
    error = RunError(message)
    error.detail = {"code": code, "message": message, **extra}  # type: ignore[attr-defined]
    return error


async def _member_name(db: AsyncSession, principal: Principal) -> str:
    user = await db.get(User, principal.user_id) if principal.user_id else None
    if user is None:
        return "an API token"
    from oracle.members.names import display_name

    return display_name(user.email)


async def _apply_staged_edits(
    db: AsyncSession, principal: Principal, run: Run, cp: Checkpoint
) -> _Edited | None:
    """D7 Approve with edits: the staged actions of ``cp``'s draft applied to the agents'
    file (no model, nothing spent), re-checked (``check_items`` and the D2 reasons) and
    gated (D3) on that check. None when nothing staged changes the file (a plain
    approval). Raises 409 ``needs_agents`` or ``edits_leave_problems`` having written
    nothing: the edits stay staged."""
    staged = list(
        await db.scalars(
            select(CheckpointAction)
            .where(CheckpointAction.checkpoint_id == cp.id, CheckpointAction.state == "staged")
            .order_by(CheckpointAction.created_at, CheckpointAction.id)
        )
    )
    blocked = apply_edits.needs_agents(staged, await _open_questions(db, {cp.id: staged}))
    if blocked:
        raise _edits_refused(
            "needs_agents", apply_edits.refusal(blocked), actions=[str(a.id) for a in blocked]
        )
    n = apply_edits.edit_count(staged)
    if not n:
        return None
    name = apply_edits.FILES[cp.kind]
    segment = await db.scalar(
        select(RunSegment).where(
            RunSegment.run_id == run.id, RunSegment.seq == (cp.payload or {}).get("segment_seq")
        )
    )
    art = (segment.artifacts or {}) if segment is not None else {}
    agents = (art.get("files") or {}).get(name)
    if not isinstance(agents, str):
        raise RunError(f"the checkpoint's segment left no {name} to apply the edits to")
    _, base = await reasons._base(db, run)
    try:
        body, applied = apply_edits.apply(
            agents, staged, {k: v.get("raw") or {} for k, v in base.items()}
        )
    except apply_edits.EditError as exc:
        raise _edits_refused(
            "edit_cannot_apply", f"{exc}: remove that edit, or send back to the agents",
            actions=[str(exc.action_id)],
        ) from None  # fmt: skip
    except safe_yaml.SafeYamlError as exc:
        raise _edits_refused(
            "edit_cannot_apply", f"{name} cannot be edited ({exc}): send back to the agents"
        ) from None
    attempts = art.get("attempts") or []
    attempt = int(attempts[-1].get("attempt") or len(attempts)) if attempts else 1
    now = _now()
    on = now.astimezone(apply_edits.COMPANY_ZONE).date()
    text = apply_edits.header(await _member_name(db, principal), on, n, attempt) + body
    check = await _check_items(db, run, text)
    # The gate on the re-checked file, read from a copy: a refusal leaves the stored check.
    shut = gate.approve_gate(
        Checkpoint(kind=cp.kind, payload={**(cp.payload or {}), "items_check": check}),
        None,
        staged,
    )
    if shut is not None and not shut.open:
        left = gate.left_count(shut)
        what = "; ".join(f"{x.item}: {x.label}" for x in shut.left) or "a problem of the file"
        raise _edits_refused(
            "edits_leave_problems",
            f"After the edits, {left} blocking problem{' is' if left == 1 else 's are'} left: "
            f"{what}",
            left=[x.model_dump() for x in shut.left],
        )
    ids = [str(a.id) for a in staged]
    sha = hashlib.sha256(text.encode()).hexdigest()
    revision = {
        "attempt": attempt,
        "by": str(principal.user_id or principal.token_id),
        "at": now.isoformat(),
        "actions": ids,
        "agent_sha256": hashlib.sha256(agents.encode()).hexdigest(),
        "edited_sha256": sha,
    }
    review = {
        "kind": "edits",
        "file": name,
        "applied": applied,
        "edits": n,
        "summary": apply_edits.summary(applied),
    }
    audit_data = {"edits": n, "actions": ids, "edited_sha256": sha}
    return _Edited(name, agents, text, attempt, check, revision, review, audit_data)


def _write_edits(run: Run, cp: Checkpoint, segment: RunSegment, edited: _Edited) -> None:
    """The edited file as the segment's current one; the agents' text kept per attempt."""
    art = _art(segment)
    agent_files = copy.deepcopy(art.get("agent_files") or {})
    agent_files.setdefault(str(edited.attempt), {}).setdefault(edited.name, edited.agents)
    revisions = [*(art.get("revisions") or []), edited.revision]
    art["files"] = {**(art.get("files") or {}), edited.name: edited.text}
    art["agent_files"] = agent_files
    art["revisions"] = revisions
    art["items_check"] = edited.check
    _set_art(segment, art)
    cp.payload = {**(cp.payload or {}), "items_check": edited.check}
    cp.review = {**edited.review, "revision": len(revisions)}


async def _restore_agents_file(db: AsyncSession, run: Run, cp: Checkpoint) -> None:
    """A voided approval with edits (D7): the agents' file is the current one again,
    re-checked; the edits are staged as they were."""
    if not isinstance(cp.review, dict) or cp.review.get("kind") != "edits":
        return
    name = cp.review.get("file") or apply_edits.FILE
    segment = await db.scalar(
        select(RunSegment).where(
            RunSegment.run_id == run.id, RunSegment.seq == (cp.payload or {}).get("segment_seq")
        )
    )
    art = _art(segment) if segment is not None else {}
    revisions = art.get("revisions") or []
    attempt = str(revisions[-1].get("attempt")) if revisions else "1"
    agents = ((art.get("agent_files") or {}).get(attempt) or {}).get(name)
    if segment is None or not isinstance(agents, str):
        return
    check = await _check_items(db, run, agents)
    art["files"] = {**(art.get("files") or {}), name: agents}
    art["items_check"] = check
    _set_art(segment, art)
    cp.payload = {**(cp.payload or {}), "items_check": check}


async def read_review_file(db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID) -> str:
    """The ``review.yaml`` a send-back at the checkpoint delivered (D4)."""
    from oracle.runs import review_file

    run = await _get_run(db, run_id)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is None:
        raise NotFound(f"checkpoint {checkpoint_id} not found")
    if cp.status == "pending" or not cp.review or cp.review.get("kind") == "edits":
        raise NotFound("no review was sent back at this checkpoint")
    zone = await company_time.company_time_zone(db)
    return review_file.render_yaml(cp.review, cp.decided_at, zone)


async def _continue_decided(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    later: RunSegment | None,
    decision: str,
    note: str | None,
) -> None:
    """The run goes on with a decided checkpoint as a new workflow (the caller commits;
    the next segment is queued, :func:`submit_queued` submits it): the next segment when
    approved, the checkpoint's segment again (with the note) when changes were requested,
    the end of the run when there is none."""
    run.status = "running"
    if decision == "approved":
        target = later
        restore = "pending"
    else:
        target, restore = segment, segment.status
        segment.status = "pending"
    if target is None:
        await _finish(db, run, "succeeded")
        return
    # Until its workflow is submitted, the segment remembers the decision that started
    # it: a disable of the decider voids it.
    art = _art(target)
    if target is segment and art.pop("reused_items", None) is not None:
        # E1 part B: a send-back derives the reused items again; they are no longer reused.
        art.pop("note", None)
    art["decision"] = {
        "checkpoint_id": str(cp.id),
        "decided_by": str(cp.decided_by),
        "restore": restore,
    }
    _set_art(target, art)
    review = None
    if decision != "approved" and cp.review:
        from oracle.runs import review_file

        zone = await company_time.company_time_zone(db)
        review = review_file.change_request(cp.review, cp.decided_at, zone)
    await _submit(db, run, target, segments, change_request=note, review=review)


def _owes(cp: Checkpoint) -> bool:
    """A decision recorded on ``cp`` whose post to SwarmCloud (or the cancel it needs) is
    not finished (:func:`_finish_decision`)."""
    return cp.status in DECIDED and isinstance(
        ((cp.payload or {}).get("wait") or {}).get("posting"), dict
    )


async def _owed_decision(db: AsyncSession, run_id: uuid.UUID) -> uuid.UUID | None:
    """The run's checkpoint whose recorded decision is owed (:func:`_owes`), read without
    a lock."""
    owed = next((c.id for c in await _checkpoints(db, [run_id]) if _owes(c)), None)
    await db.rollback()
    return owed


async def _complete_decision(
    db: AsyncSession,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    deadline: float | None,
    stats: _TickStats | None = None,
) -> None:
    """Finish a recorded decision: the request that recorded it does so right after its
    commit; the tick does for one that never finished (a crash, a failed post). The calls
    to SwarmCloud are made outside the review gate and the run's row lock
    (:func:`_replay`). Commits; raises Unavailable when it did not finish (the marker
    stays with the failed try counted, the tick tries again), a runtime failure outside
    the post itself (the replay limit, say) included. ``stats``: the tick's, for what the
    cancel it may need counts (its errors, a pause on the ceiling); a request logs those."""
    mine = stats or _TickStats()
    try:
        await _replay(
            db,
            deadline,
            lambda: _finish_decision(db, run_id, checkpoint_id, mine),
            reset=_resetter(mine),
        )
    except (_PostNotFound, _Unread):
        raise  # the decision was undone: a person decides again (_finish_decision)
    except (Unavailable, RuntimeUnavailable) as exc:
        await _failed_try(db, run_id, checkpoint_id, exc)
        if isinstance(exc, RuntimeUnavailable):
            raise Unavailable(
                f"SwarmCloud did not confirm the decision ({_shown(exc)}); the decision is "
                "recorded and Oracle delivers it on its next tick, there is no need to decide "
                "again",
                cause=exc,
            ) from None
        raise
    finally:
        if stats is None:
            for error in mine.errors:
                log.warning("decision on run %s: %s", run_id, error)


async def _failed_try(
    db: AsyncSession,
    run_id: uuid.UUID,
    checkpoint_id: uuid.UUID,
    exc: Unavailable | RuntimeUnavailable,
) -> None:
    """A try at delivering a recorded decision that did not finish, nothing of it written:
    what is left is the marker, with the try counted and why (shown on the run page and
    in the Inbox), and the cancel marker the failed pass left (``exc.held``). Commits."""
    await db.rollback()
    run = await _get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    wait = dict(((cp.payload or {}).get("wait") or {}) if cp is not None else {})
    posting = wait.get("posting")
    held = exc.held if isinstance(exc, Unavailable) else None
    now_wf = _live(run)
    if held is not None and now_wf is not None and now_wf.get("id") == held["id"]:
        # The cancel's marker (its tries, a 404 count), as the failed pass left it.
        _set_knob(run, "workflow", {**now_wf, "cancel_pending": held["cancel_pending"]})
        await revoke_run_tokens(db, run.id)
    if cp is not None and cp.status in DECIDED and isinstance(posting, dict):
        first = not posting.get("error")
        why = _cause(exc)
        wait["posting"] = {
            **posting,
            "tries": int(posting.get("tries") or 0) + 1,
            "error": why,
            "tried_at": _now().isoformat(),
        }
        _set_wait(cp, wait)
        if first:
            segments = await _segments(db, run.id)
            seq = (cp.payload or {}).get("segment_seq")
            target = next((x for x in segments if x.seq == seq), None) or segments[0]
            _note(
                target,
                f"The decision at {cp.kind} is recorded; SwarmCloud did not take it yet "
                f"({why}). Oracle tries again on every tick.",
            )
    await db.commit()


async def _finish_decision(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, stats: _TickStats
) -> None:
    """The follow-through of a decision recorded by :func:`decide_checkpoint`, on the run
    as it is now (locked, read afresh): post it to the wait in the live workflow (the same
    answer id and body every time, so a post made twice is one answer), or cancel the
    workflow and go on as a new one. Done, the marker is dropped, in the same commit as
    its effect. A try that does not finish is counted by :func:`_complete_decision`."""
    try:
        await _finish_decision_now(db, run_id, checkpoint_id, stats)
    except _PostNotFound as exc:
        await _count_post_404(db, run_id, checkpoint_id, exc.cause)  # decided again by a person
        raise
    except _Unread as exc:
        await _hold_unread(db, run_id, checkpoint_id, exc)  # decided again by a person
        raise


async def _finish_decision_now(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, stats: _TickStats
) -> None:
    from oracle.review import publish

    # Under the review gate, every pass (each try, and each replay after a runtime call):
    # the decider is read again, so a decision whose decider lost standing since it was
    # recorded is never delivered (a disable and a demotion also void it as they commit,
    # void_owed_decisions). The gate is released with every runtime call (_replay).
    await publish.gate_lock(db, shared=True)
    run = await _get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    wait = dict(((cp.payload or {}).get("wait") or {}) if cp is not None else {})
    posting = wait.get("posting")
    if cp is None or not isinstance(posting, dict):
        await db.rollback()
        return
    if cp.status not in DECIDED or run.status not in ("awaiting_checkpoint", "paused_overrun"):
        # Voided, or the run ended meanwhile (cancelled, failed): nothing is owed.
        wait.pop("posting")
        _set_wait(cp, wait)
        await db.commit()
        return
    if run.status == "paused_overrun":
        # Paused on overrun (its workflow cancelled): the decision stays owed, and is
        # delivered once an owner resumes the run (resume: awaiting_checkpoint again).
        await db.rollback()
        return
    role = cp.approver_role
    lead = _posting_id(posting, "user_id")
    if cp.kind in ENGINEERING_KINDS and run.flow != SPEC_FLOW and lead is not None:
        # A3: an engineering lead decided it (any commenter or above may carry the flag);
        # an unflagged lead's owed decision was voided with the flag (set_engineering_lead).
        if await lead_now(db, lead):
            role = "commenter"
    refusal = await _decider_refusal(db, posting, role)
    if refusal is not None:
        await _void_owed(db, None, run, cp, refusal, {"via": "decision.recheck"})
        await db.commit()
        return
    try:
        await _deliver_decision(db, run, cp, wait, posting, stats)
    except Unavailable as exc:
        held = _live(run)
        if held is not None and held.get("cancel_pending"):
            # A cancel SwarmCloud did not confirm: its marker outlives the rollback, so
            # its tries are counted and a cancel stuck on 404s reaches the Inbox.
            exc.held = {"id": held.get("id"), "cancel_pending": held["cancel_pending"]}
        raise


async def _deliver_decision(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    wait: dict[str, Any],
    posting: dict[str, Any],
    stats: _TickStats,
) -> None:
    segments = await _segments(db, run.id)
    seq = (cp.payload or {}).get("segment_seq")
    segment = next((x for x in segments if x.seq == seq), None)
    if segment is None:
        await db.rollback()
        raise RunError("the checkpoint's segment is missing")
    later = next((x for x in segments if x.seq > segment.seq), None)
    decision, note, redo = cp.status, cp.note, bool(posting.get("redo"))
    user_id = uuid.UUID(posting["user_id"]) if posting.get("user_id") else None
    held = _live(run)
    if held is not None and held.get("cancel_pending"):
        # A cancel not confirmed yet (an earlier try, or the one the run was cancelled
        # with): made again; nothing is submitted after a workflow that may still run.
        if not await _retry_pending_cancel(db, run, held, segments, stats):
            await db.commit()  # the cancel's tries and cost, counted
            raise _unconfirmed("go on with the decision")
    wf = _drivable(run)
    if redo:
        if wf is not None and not await _detach(db, run, cancel=True, state="redo"):
            raise _unconfirmed("redo the segment")
    elif wf is not None and wait.get("workflow_id") == wf["id"]:
        posted = await _decide_in_workflow(db, run, cp, segment, segments, wf, user_id)
        if posted:
            if _cancel_pending(run):
                raise _unconfirmed("go on with the decision")
            _finished_posting(cp)
            await db.commit()
            return
    await _continue_decided(db, run, cp, segment, segments, later, decision, note)
    if _cancel_pending(run):
        # Nothing is submitted after a workflow SwarmCloud may still be running.
        raise _unconfirmed("continue the run as a new workflow")
    _finished_posting(cp)
    await db.commit()  # the router submits it (submit_queued), outside the gate


def _finished_posting(cp: Checkpoint) -> None:
    wait = dict((cp.payload or {}).get("wait") or {})
    wait.pop("posting", None)
    wait.pop("voided", None)
    _set_wait(cp, wait)


def _posting_id(posting: dict[str, Any], key: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(posting[key])) if posting.get(key) else None
    except ValueError:
        return None


async def _decider_refusal(db: AsyncSession, posting: dict[str, Any], role: str) -> str | None:
    """Why the decider of an owed decision may no longer decide a checkpoint of ``role``,
    read now (the caller holds the gate), or None: their API token or grant still active,
    the person behind it still an active member with the role. A decision that names no
    decider is never delivered."""
    from oracle.auth.service import caller_refusal

    user_id = _posting_id(posting, "user_id")
    token_id = _posting_id(posting, "token_id")
    if user_id is None and token_id is None:
        return "The decision names no decider"
    decider = Principal(
        tenant_id=current_tenant(db),
        kind="user" if user_id is not None else "token",
        role=role,  # type: ignore[arg-type]
        user_id=user_id,
        token_id=token_id,
        grant_id=_posting_id(posting, "grant_id"),
    )
    return await caller_refusal(db, decider, role)  # type: ignore[arg-type]


async def _void_owed(
    db: AsyncSession,
    principal: Principal | None,
    run: Run,
    cp: Checkpoint,
    why: str,
    via: dict[str, str],
) -> None:
    """Undo a decision recorded and not delivered yet (both locked by the caller, who
    commits): the checkpoint waits for a decision again, nothing of the decision is
    posted or submitted. ``voided`` stays on the wait: should the post have landed in
    SwarmCloud while its decider lost standing, the tick never follows that answer on its
    own (an approver confirms it in the Inbox, :func:`_take_answer`)."""
    wait = dict((cp.payload or {}).get("wait") or {})
    wait.pop("posting", None)
    wait["voided"] = {"decided_by": str(cp.decided_by), "why": why, "at": _now().isoformat()}
    _set_wait(cp, wait)
    decided_by, kind = cp.decided_by, cp.status
    await _restore_agents_file(db, run, cp)
    cp.status = "pending"
    cp.decided_by = None
    cp.decided_at = None
    cp.note = None
    cp.review = None
    # H1: a decision voided before it reached the run is not in the decision log.
    await decisions_capture.checkpoint_voided(db, cp.id)
    await _scope_reopened(db, cp)
    segments = await _segments(db, run.id)
    target = next((s for s in segments if s.seq == (cp.payload or {}).get("segment_seq")), None)
    if target is not None:
        _note(
            target,
            f"The decision at {cp.kind} was voided before it reached the run ({why}): "
            "the checkpoint waits for an approver's decision again.",
        )
    await audit.record(
        db, principal, "checkpoint.decision_voided", "checkpoint", cp.id,
        {"run_id": str(run.id), "decision": kind, "decided_by": str(decided_by),
         "reason": why, **via},
    )  # fmt: skip
    await webhooks.capture(
        db, "run.checkpoint_voided", principal, run_id=run.id, checkpoint_id=cp.id
    )


async def void_owed_decisions(
    db: AsyncSession,
    principal: Principal | None,
    deciders: set[uuid.UUID],
    why: str,
    via: dict[str, str],
    *,
    role: str | None = None,
    kinds: tuple[str, ...] | None = None,
) -> list[uuid.UUID]:
    """Void the decisions ``deciders`` recorded that are not delivered to their run yet
    (``wait.posting``): a disable (every one), or a demotion to ``role`` (those whose
    checkpoint needs more than ``role``). With ``kinds`` (an engineering lead unflagged,
    A3), only those kinds outside prd_to_spec. The caller holds the gate exclusively and
    commits; a delivery under way re-reads the checkpoint under the gate and finds nothing
    owed (:func:`_finish_decision_now`). Returns the checkpoints voided."""
    if not deciders:
        return []
    candidates = list(await db.execute(_owed_q(deciders)))
    voided: list[uuid.UUID] = []
    for checkpoint_id, run_id in candidates:
        fresh = {"populate_existing": True}
        run = await db.scalar(
            select(Run).where(Run.id == run_id).with_for_update().execution_options(**fresh)
        )
        cp = await db.scalar(
            select(Checkpoint)
            .where(Checkpoint.id == checkpoint_id)
            .with_for_update()
            .execution_options(**fresh)
        )
        if not _owed_voids(run, cp, deciders, role, kinds):
            continue
        await _void_owed(db, principal, run, cp, why, via)
        voided.append(cp.id)
    return voided


def _owed_q(deciders: set[uuid.UUID]):
    return (
        select(Checkpoint.id, Checkpoint.run_id)
        .where(
            Checkpoint.status.in_(DECIDED),
            Checkpoint.payload["wait"].has_key("posting"),
            Checkpoint.decided_by.in_(deciders),
        )
        .order_by(Checkpoint.run_id, Checkpoint.id)
    )


def _owed_voids(
    run: Run | None,
    cp: Checkpoint | None,
    deciders: set[uuid.UUID],
    role: str | None,
    kinds: tuple[str, ...] | None,
) -> bool:
    """Whether :func:`void_owed_decisions` voids ``cp`` (read under its locks there,
    without them in :func:`select_owed_decisions`)."""
    if run is None or cp is None or cp.status not in DECIDED or run.status in FINAL:
        return False  # an ended run drops what it owed (_finish_decision_now)
    if not isinstance(((cp.payload or {}).get("wait") or {}).get("posting"), dict):
        return False
    if cp.decided_by not in deciders:
        return False
    if kinds is not None and (cp.kind not in kinds or run.flow == SPEC_FLOW):
        return False
    # The new role still decides this checkpoint: kept.
    return not (role is not None and has_role(role, cp.approver_role))  # type: ignore[arg-type]


async def select_owed_decisions(
    db: AsyncSession,
    deciders: set[uuid.UUID],
    *,
    role: str | None = None,
    kinds: tuple[str, ...] | None = None,
) -> list[tuple[Run, Checkpoint]]:
    """The (run, checkpoint) :func:`void_owed_decisions` would void: no locks, no writes
    (A5's preview)."""
    if not deciders:
        return []
    out = []
    for checkpoint_id, run_id in list(await db.execute(_owed_q(deciders))):
        run = await db.get(Run, run_id)
        cp = await db.get(Checkpoint, checkpoint_id)
        if _owed_voids(run, cp, deciders, role, kinds):
            out.append((run, cp))
    return out


async def _voided_while_delivered(db: AsyncSession, checkpoint_id: uuid.UUID) -> str | None:
    """Why the decision just recorded on ``checkpoint_id`` was voided while Oracle
    delivered it (its decider lost standing), or None."""
    cp = await db.scalar(
        select(Checkpoint)
        .where(Checkpoint.id == checkpoint_id)
        .execution_options(populate_existing=True)
    )
    voided = (((cp.payload or {}).get("wait") or {}).get("voided")) if cp is not None else None
    why = (
        str(voided.get("why") or "its decider lost standing")
        if cp is not None and cp.status == "pending" and isinstance(voided, dict)
        else None
    )
    await db.rollback()
    return why


async def void_decision(
    db: AsyncSession,
    principal: Principal | None,
    run: Run,
    segment: RunSegment,
    cp: Checkpoint,
    via: dict[str, str],
) -> None:
    """Undo a checkpoint decision whose segment has not been submitted (both locked by
    the caller, who commits): the checkpoint waits again, the segment is as before the
    decision, the run's tokens die. A submission under way finds it so and cancels its
    workflow (:func:`submit_queued`)."""
    decision = (segment.artifacts or {}).get("decision") or {}
    unqueue(segment)
    art = _art(segment)
    art.pop("pending_note", None)
    art.pop("pending_review", None)
    _set_art(segment, art)
    segment.status = decision.get("restore") or "pending"
    decided_by, kind = cp.decided_by, cp.status
    await _restore_agents_file(db, run, cp)
    cp.status = "pending"
    cp.decided_by = None
    cp.decided_at = None
    cp.note = None
    cp.review = None
    # H1: a decision voided before it reached the run is not in the decision log.
    await decisions_capture.checkpoint_voided(db, cp.id)
    await _scope_reopened(db, cp)
    run.status = "awaiting_checkpoint"
    await revoke_run_tokens(db, run.id)
    await audit.record(
        db, principal, "checkpoint.decision_voided", "checkpoint", cp.id,
        {"run_id": str(run.id), "decision": kind, "decided_by": str(decided_by), **via},
    )  # fmt: skip
    for event_type in ("run.checkpoint_voided", "run.checkpoint_waiting"):
        await webhooks.capture(db, event_type, principal, run_id=run.id, checkpoint_id=cp.id)


class _PostNotFound(Unavailable):
    """An answer post SwarmCloud answered with a 404 that proves nothing (not its
    not_found envelope): nothing recorded, "decide again", and counted."""

    def __init__(self, cause: RuntimeUnavailable) -> None:
        super().__init__(
            f"SwarmCloud did not confirm the decision ({cause}); decide again, it is safe to repeat"
        )
        self.cause = cause


class _Unread(Unavailable):
    """The wait was answered (409 already_answered, or the answer the Inbox showed) and
    Oracle cannot read the recorded answer: "decide again", nothing recorded, and the
    run's token is held read-only until it is read (W5; :func:`_hold_unread`)."""

    def __init__(
        self,
        message: str,
        *,
        needs: str,
        by: str | None = None,
        at: str | None = None,
        via: str | None = None,
    ) -> None:
        super().__init__(message)
        self.needs, self.by, self.at, self.via = needs, by, at, via


async def _undecide(db: AsyncSession, run: Run, cp: Checkpoint) -> bool:
    """A decision recorded for posting (:func:`decide_checkpoint`) that needs a person
    again (the wait was answered and the answer cannot be read, or SwarmCloud answered a
    404 that proves nothing): the checkpoint waits again, as if not decided. False when
    it holds no such decision."""
    wait = dict((cp.payload or {}).get("wait") or {})
    if cp.status not in DECIDED or not isinstance(wait.get("posting"), dict):
        return False
    wait.pop("posting")
    _set_wait(cp, wait)
    decided_by, kind = cp.decided_by, cp.status
    await _restore_agents_file(db, run, cp)
    cp.status = "pending"
    cp.decided_by = None
    cp.decided_at = None
    cp.note = None
    cp.review = None
    # H1: a decision voided before it reached the run is not in the decision log.
    await decisions_capture.checkpoint_voided(db, cp.id)
    await _scope_reopened(db, cp)
    await audit.record(
        db, None, "checkpoint.decision_not_posted", "checkpoint", cp.id,
        {"run_id": str(run.id), "decision": kind, "decided_by": str(decided_by)},
    )  # fmt: skip
    return True


async def _hold_unread(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, exc: _Unread
) -> None:
    """W5 (owner, 2026-10-19): an answered checkpoint Oracle cannot read yet counts as
    unconfirmed. The decision itself rolls back; the hold is written on its own (the
    checkpoint shows in the Inbox waiting to read the answer, the tick reads it again),
    unless the checkpoint already shows what the console recorded."""
    await db.rollback()
    run = await _get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    # The decision was recorded before it was posted: not posted, an approver decides again.
    undone = cp is not None and await _undecide(db, run, cp)
    wait = dict(((cp.payload or {}).get("wait") or {}) if cp is not None else {})
    if cp is None or cp.status != "pending" or not wait:
        await db.commit() if undone else await db.rollback()
        return
    if ((wait.get("console") or {}).get("needs")) not in (None, "unread"):
        await db.commit() if undone else await db.rollback()
        return
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == (cp.payload or {}).get("segment_seq")), None)
    if segment is None:
        await db.commit() if undone else await db.rollback()
        return
    why = "SwarmCloud did not serve it" if exc.needs == "unread" else "its verdict is unreadable"
    console = _unread_console(
        run, segment, _live(run), wait, why, by=exc.by, at=exc.at, via=exc.via
    )
    if exc.needs == "unreadable":
        console.update(reason="the recorded verdict could not be read", needs="unreadable")
    wait["console"] = console
    _set_wait(cp, wait)
    _note(
        segment,
        f"{cp.kind} was already answered in SwarmCloud, and Oracle could not read the answer "
        f"({why}). Until it does, the run's agents may read Oracle but not write to it; "
        "Oracle reads it again on every tick, and an approver may decide again.",
    )
    await db.commit()


async def _count_post_404(
    db: AsyncSession, run_id: uuid.UUID, checkpoint_id: uuid.UUID, cause: RuntimeUnavailable
) -> None:
    """Count a 404 on an answer post (the decision itself rolled back): past
    :data:`NOT_FOUND_TRIES` for the checkpoint, the run shows in the Inbox with Cancel."""
    await db.rollback()
    run = await _get_run(db, run_id, lock=True)
    cp = await db.scalar(
        select(Checkpoint).where(Checkpoint.id == checkpoint_id, Checkpoint.run_id == run.id)
    )
    if cp is not None:
        await _undecide(db, run, cp)  # recorded before it was posted, not posted: decide again
    post = (run.knobs or {}).get("post_404") or {}
    same = post.get("checkpoint_id") == str(checkpoint_id)
    tries = (int(post.get("tries") or 0) if same else 0) + 1
    _set_knob(
        run,
        "post_404",
        {
            "checkpoint_id": str(checkpoint_id),
            "tries": tries,
            "error": _shown(cause),
            "at": _now().isoformat(),
        },
    )
    await db.commit()
    if tries >= NOT_FOUND_TRIES:
        raise Unavailable(
            f"SwarmCloud did not confirm the decision: it answered HTTP 404 {tries} times "
            f"without saying the wait does not exist ({_shown(cause)}). Decide again later, "
            "or in the Inbox, Cancel ends the run."
        ) from None


def _console_choice(
    cp: Checkpoint, wait: dict[str, Any], choice: str, note: str | None
) -> tuple[str, str | None, bool]:
    """An Inbox choice about what SwarmCloud's console recorded (W5), as a decision:
    (decision, note, redo). ``confirm`` takes an answer that did not count as the decision
    (a change request where the workflow has no revision step comes back as ``confirm``:
    it then waits for Redo or Continue); ``redo`` re-runs the segment as a new workflow
    with the findings; ``continue`` follows the workflow, which went on regardless."""
    console = wait.get("console") or {}
    needs = console.get("needs")
    findings = "; ".join(_console_findings(console))
    with_note = "\n\n".join(x for x in (findings, note) if x) or None
    if choice == "confirm":
        if needs != "confirm" or console.get("verdict") not in (MERGE, NOT_YET):
            raise Invalid("nothing recorded in SwarmCloud's console waits to be confirmed here")
        if console["verdict"] == MERGE:
            return "approved", note, False
        if console.get("revise"):
            return "changes_requested", with_note, False
        return "confirm", None, False
    if needs not in ("redo_or_continue", "unreadable", "unread"):
        raise Invalid(
            f"{choice} answers a change request recorded in SwarmCloud's console that the "
            "workflow has no revision step for (or one Oracle could not read); there is none "
            "here"
        )
    if choice == "redo":
        if not with_note:
            raise Invalid("say what to change: a note is required to redo the segment")
        return "changes_requested", with_note, True
    return "approved", note, False


def _left(wf: dict[str, Any]) -> float:
    """Seconds left of the live workflow's run credential."""
    try:
        expires = datetime.fromisoformat(wf["expires_at"])
    except (KeyError, TypeError, ValueError):
        return 0.0
    return (expires - _now()).total_seconds()


def _duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    return f"{hours} h {rest // 60} min" if hours else f"{rest // 60} min {rest % 60} s"


async def _email(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    """The deciding user's email, recorded by SwarmCloud as ``on_behalf_of``."""
    if user_id is None:
        return None
    user = await db.get(User, user_id)
    return user.email if user is not None else None


async def _decide_in_workflow(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    user_id: uuid.UUID | None,
) -> bool:
    """Post an Inbox decision (recorded already, :func:`decide_checkpoint`) to the wait in
    the live workflow, by the user who decided it (``user_id``). Returns False when the
    run continues as a new workflow instead (the caller does that, carrying the decision):
    the workflow has no step for the decision, too little of the credential is left for
    the agent steps after the wait (the tail rule), the wait is closed, SwarmCloud refuses
    the answer, or it holds a different verdict (Oracle's decision is then a correction).
    In every such case the live workflow is cancelled first, so a segment never runs in
    two workflows. Raises Unavailable only when nothing was recorded and the same decision
    may simply be sent again."""
    settings = get_runtime_settings()
    wait = dict((cp.payload or {}).get("wait") or {})
    entry = _plan_entry(wf, segment.seq) or {}
    round_ = int(wait.get("round") or 1)
    approved = cp.status == "approved"
    answered = bool(wait.get("console")) and (approved or round_ <= len(entry.get("revises") or []))
    if answered:
        # Answered in SwarmCloud already (the Inbox shows it): nothing to post, and the
        # steps after the wait already have the credential they had; the recorded
        # answer is followed, or corrected.
        verdict = MERGE if approved else NOT_YET
        return await _already_answered(db, run, cp, segment, segments, wf, wait, verdict, None)
    if not approved and round_ > len(entry.get("revises") or []):
        # The workflow's next steps assume approval: re-run the segment on its own.
        _note(
            segment,
            f"Changes requested at {cp.kind} (round {round_}): the workflow had no revision "
            "step for it, so Oracle cancelled it and re-runs the segment as a new workflow.",
        )
        if not await _detach(db, run, cancel=True, state="cancelled"):
            raise _unconfirmed("re-run the segment")
        return False
    left = _left(wf)
    steps = workflow.agent_steps_after(wf.get("segments") or [], segment.seq, approved, round_)
    tail = workflow.tail_seconds(steps, settings)
    if left < tail:
        _note(
            segment,
            f"Decided at {cp.kind} with {_duration(left)} of the run's credential left, under "
            f"the {_duration(tail)} tail that the {steps} agent step(s) after the wait need: "
            "Oracle did not post the decision to SwarmCloud, cancelled the waiting workflow "
            "and continued as a new workflow with a fresh run token.",
        )
        if not await _detach(db, run, cancel=True, state="tail"):
            raise _unconfirmed("continue the run as a new workflow")
        return False
    edits = cp.review if isinstance(cp.review, dict) and cp.review.get("kind") == "edits" else None
    payload: dict[str, Any] = (
        {"verdict": MERGE, "findings": [edits["summary"]] if edits else []}
        if approved
        else {
            "verdict": NOT_YET,
            "findings": await _send_back_findings(db, run, cp),
        }
    )
    on_behalf_of = await _email(db, user_id)
    runtime = _rt()
    try:
        answer = await runtime.answer(
            wf["id"],
            wait["step_id"],
            answer_id=str(cp.id),
            payload=payload,
            on_behalf_of=on_behalf_of,
        )
    except RuntimeUnavailable as exc:
        if exc.code == "already_answered":
            return await _already_answered(
                db, run, cp, segment, segments, wf, wait, payload["verdict"], exc
            )
        if _not_found(exc):
            # Proves nothing, and is counted (decide_checkpoint): past NOT_FOUND_TRIES the
            # run shows in the Inbox with Cancel.
            raise _PostNotFound(exc) from None
        if exc.retryable:
            # Nothing was recorded: the same decision is safe to send again (same
            # answer_id, same body).
            raise Unavailable(
                f"SwarmCloud did not confirm the decision ({exc}); the decision is recorded "
                "and Oracle posts it again on its next tick, there is no need to decide again",
                cause=exc,
            ) from None
        # Refused (the wait is closed, a person is required, or another refusal): not
        # posted, so the run continues as a new workflow with the decision.
        fallback = (
            f"SwarmCloud refused Oracle's answer to {cp.kind} ({exc}), so the decision was not "
            "posted: Oracle cancelled the workflow and continued the run as a new workflow "
            "from the Inbox decision."
        )
        _note(segment, workflow.advice(exc.code, fallback))
        if not await _detach(db, run, cancel=True, state=_shown(exc.code) or "refused"):
            raise _unconfirmed("continue the run as a new workflow") from None
        return False
    _set_knob(run, "post_404", None)
    wait["answered"] = {
        "verdict": payload["verdict"],
        "at": _now().isoformat(),
        "replayed": answer.replayed,
        "answer_id": str(cp.id),
        "on_behalf_of": on_behalf_of,
        "via": "mcp",
    }
    _set_wait(cp, wait)
    if not await _follow(
        db, run, cp, segment, segments, wf, entry, round_, approved, note_by=on_behalf_of
    ):
        raise _unconfirmed("end the run")
    return True


async def _send_back_findings(db: AsyncSession, run: Run, cp: Checkpoint) -> list[str]:
    """What a send-back posts to the revise step: the structured review (D4), one line per
    entry, with Oracle's check; the note and the check for a decision stored without one."""
    problems = await _problem_findings(db, run, cp)
    if cp.review:
        from oracle.runs import review_file

        return review_file.findings(cp.review, problems)
    return ([cp.note] if cp.note else []) + problems


async def _problem_findings(db: AsyncSession, run: Run, cp: Checkpoint) -> list[str]:
    """What Oracle's check found in the files a review shows (D5): the items check's
    blocking problems and a refused draft's import problems, after the person's note."""
    payload = cp.payload or {}
    imported = payload.get("import") or {}
    return workflow.check_findings(
        ITEMS_FILE, payload.get("items_check"), []
    ) + workflow.check_findings(
        flows.draft_file(await _target_kind(db, run)),
        None,
        list(imported.get("problems") or []),
    )


async def _already_answered(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    wait: dict[str, Any],
    verdict: str,
    exc: RuntimeUnavailable | None,
) -> bool:
    """409 already_answered: Oracle's post was not recorded, but the wait was answered
    (someone in SwarmCloud's console, or an earlier, different post of Oracle's whose
    response was lost), and the workflow already goes on with that first answer.

    Oracle follows the workflow whenever it ran what the Inbox decision needs: the same
    verdict, or an approval over a recorded NOT_YET (at a checkpoint that is not the
    last, the next segment depends on the wait whatever its verdict, so the workflow went
    on into it; at the last, the approval ends the run on the draft it showed and stops
    the workflow's revision). Only a change request over a recorded MERGE needs work the
    workflow did not do: that is a correction, so the workflow is cancelled and the run
    continues as a new workflow carrying it. A verdict Oracle cannot read is never taken
    for either: it says "decide again", unless the decision is an approval, which needs
    nothing the workflow did not do whatever was recorded (or the approver chooses Redo).

    ``exc``: the 409 (None when the Inbox already showed the recorded answer)."""
    round_ = int(wait.get("round") or 1)
    artifact = wait.get("artifact") or workflow.review_artifact(round_)
    record = await _read_recorded(cp, wf, wait, artifact)
    detail = exc.detail if exc is not None else {}
    console = wait.get("console") or {}
    by = record.answered_by or _shown(detail.get("answered_by")) or console.get("answered_by")
    at = (
        record.answered_at.isoformat()
        if record.answered_at
        else _shown(detail.get("answered_at")) or console.get("answered_at")
    )
    via = record.via or _shown(detail.get("via")) or console.get("via")
    ours = record.answer_id == str(cp.id) and record.by_oracle
    approved = verdict == MERGE
    if record.verdict is None and not approved:
        title = _flow(run).segment(segment.name).title
        raise _Unread(
            f"SwarmCloud says {cp.kind} was already answered, but Oracle could not read the "
            f"recorded verdict ({artifact}); decide again, it is safe to repeat, or choose "
            f"Redo from '{title}' to run it again as a new workflow",
            needs="unreadable" if record.answered else "unread",
            by=by,
            at=at,
            via=via,
        )
    wait.pop("console", None)
    wait["recorded"] = _recorded(record, by, at, via, ours)
    if not ours:
        _note(segment, _outside_note(cp, round_, replace(record, answered_by=by, via=via), at))
    if record.verdict is None:
        _note(
            segment,
            f"Oracle could not read the verdict SwarmCloud recorded for {cp.kind} (round "
            f"{round_}); the Inbox approved, which needs no work the workflow did not do "
            "whatever was recorded, so the run follows the workflow.",
        )
    if record.verdict == verdict or approved:
        # What SwarmCloud recorded is what the revision (if any) applies; the Inbox
        # note, when it differs, is kept apart as not applied. No recorded findings
        # means none were applied, never the Inbox note.
        applied = "; ".join(record.findings) or None
        not_applied = cp.note if not approved and cp.note and cp.note != applied else None
        if record.verdict is None:
            pass
        elif record.verdict == verdict:
            _note(
                segment,
                f"SwarmCloud already held a {verdict} answer for {cp.kind} (round {round_}), "
                "the same verdict as the Inbox decision, so the run follows the workflow on "
                "it. SwarmCloud kept the earlier wording: its findings, notes and on_behalf_of "
                "stand, not this decision's.",
            )
        else:
            last = bool(wf.get("segments")) and wf["segments"][-1].get("seq") == segment.seq
            how = (
                "the run ends on the draft the checkpoint showed, and Oracle stops the "
                "workflow's revision"
                if last
                else "the next segment depends on this wait whatever its verdict, so the "
                "workflow went on into it, as the approval needs, and Oracle follows it"
            )
            _note(
                segment,
                f"SwarmCloud's console recorded NOT_YET for {cp.kind} (round {round_})"
                f" ({by or 'someone'}{f' via {via}' if via else ''}"
                f"{': ' + _clip(applied) if applied else ''}), but the Inbox approved. The "
                f"approval needs no work the workflow did not do: {how}.",
            )
        wait["answered"] = {
            "verdict": record.verdict,
            "decision": verdict,
            "at": at or _now().isoformat(),
            "replayed": False,
            "answer_id": record.answer_id,
            "answered_by": by,
            "on_behalf_of": record.on_behalf_of,
            "via": via,
            "kept_earlier": True,
            "not_applied": not_applied,
        }
        _set_wait(cp, wait)
        entry = _plan_entry(wf, segment.seq) or {}
        if not await _follow(
            db,
            run,
            cp,
            segment,
            segments,
            wf,
            entry,
            round_,
            approved,
            note=applied or "",
            note_by=by if applied else None,
            not_applied=not_applied,
            stop_rest=record.verdict != verdict,
        ):
            raise _unconfirmed("end the run")
        return True
    _note(
        segment,
        f"SwarmCloud held {record.verdict} for {cp.kind} (round {round_}), but the latest "
        f"Inbox decision is {verdict}, which needs a revision the workflow did not run: Oracle "
        "takes its decision as a correction, cancelled the workflow (which had gone on with "
        "the recorded answer) and continued as a new workflow carrying the decision.",
    )
    _set_wait(cp, wait)
    if not await _detach(db, run, cancel=True, state="corrected"):
        raise _unconfirmed("continue the run as a new workflow")
    return False


async def _read_recorded(
    cp: Checkpoint, wf: dict[str, Any], wait: dict[str, Any], artifact: str
) -> RecordedAnswer:
    """The answer the wait holds, read twice at most for its verdict; still unreadable,
    it comes back without one (never taken for a correction: the caller says "decide
    again", or follows an approval)."""
    record = RecordedAnswer()
    for _ in range(2):
        try:
            record = await _rt().answer_record(wf["id"], wait["step_id"], artifact)
        except RuntimeUnavailable as read:
            if read.retryable:
                # Answered, not read yet (W5): held until it is (decide_checkpoint).
                raise _Unread(
                    f"SwarmCloud says {cp.kind} was already answered but did not show the "
                    f"answer ({read}); decide again, it is safe to repeat",
                    needs="unread",
                ) from None
            record = RecordedAnswer()
        if record.verdict is not None:
            return record
    return record


async def _follow(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint | None,
    segment: RunSegment,
    segments: list[RunSegment],
    wf: dict[str, Any],
    entry: dict[str, Any],
    round_: int,
    approved: bool,
    *,
    note: str | None = None,
    note_by: str | None = None,
    not_applied: str | None = None,
    stop_rest: bool = False,
    strict: bool = True,
) -> bool:
    """The wait is answered with the run's verdict: keep following the workflow.

    ``note``/``note_by``: the findings the revision applies and whose they are; None for
    the Inbox note (Oracle's own answer was posted), "" for none (SwarmCloud recorded no
    findings: the Inbox note is not what was applied). ``cp`` None: no checkpoint stands
    for the wait (Oracle sent a refused draft back, :func:`_send_back`). ``stop_rest``:
    after an approval at the last checkpoint, the workflow's rest is work nobody uses (a
    recorded NOT_YET's revision). Returns False, when ``strict`` (the Inbox decision
    path), if stopping the rest was not confirmed: the caller says "decide again".
    Otherwise the run goes on and the tick cancels the workflow again."""
    run.status = "running"
    last = wf["segments"][-1].get("seq") == segment.seq if wf.get("segments") else True
    if approved:
        if last:
            # What follows a MERGE in the last round's shape is pass-through: stop it.
            more = round_ < len(entry.get("reviews") or []) or stop_rest
            if not await _detach(db, run, cancel=more, state="ended") and strict:
                return False
        await _next(db, run, segment, segments)
        return True
    # NOT_YET: the revision step runs in the workflow, then the next round's wait.
    entry["round"] = round_ + 1
    _set_knob(
        run,
        "workflow",
        {
            **wf,
            "segments": [entry if e.get("seq") == segment.seq else e for e in wf["segments"]],
        },
    )
    art = _art(segment)
    art["attempts"].append(
        {
            "attempt": len(art["attempts"]) + 1,
            "workflow_id": wf["id"],
            "submitted_at": _now().isoformat(),
            "cost_usd": 0,
            "note": (cp.note if cp is not None else None) if note is None else (note or None),
            "note_by": note_by,
            "not_applied": not_applied,
            "state": "running",
            "label": wf.get("label"),
            "mode": "workflow",
        }
    )
    _set_art(segment, art)
    segment.status = "running"
    segment.finished_at = None
    return True


def _attach_for_cancel(
    run: Run,
    segment: RunSegment,
    workflow_id: str | None,
    lookup: str | None = None,
    lookup_since: str | None = None,
    lookup_until: str | None = None,
) -> dict[str, Any]:
    """A workflow Oracle does not drive as the run's (one per segment, or a lost
    submission), attached so that cancelling the run cancels it the same way: retried by
    the tick, its cost counted, given up on SwarmCloud's 404. ``lookup``: the label to
    find it by while its id is unknown, and ``lookup_since`` when it was submitted (the
    search ends at an older task, and moves to the background past the lookup cap, until
    ``lookup_until``, its credential's end)."""
    last = (_art(segment)["attempts"] or [{}])[-1]
    wf = {
        "id": workflow_id,
        "label": lookup or last.get("label"),
        # When it was sent: a search for it is bounded from then (_credential_end).
        "submitted_at": lookup_since or (last.get("submitted_at") if workflow_id else None),
        "lookup": lookup,
        "lookup_since": lookup_since,
        "lookup_until": lookup_until,
        "state": "live",
        "start_seq": segment.seq,
        "mode": "segment",
        "segments": [],
    }
    _set_knob(run, "workflow", wf)
    return wf


async def _may_manage(db: AsyncSession, principal: Principal, run: Run) -> bool:
    """An owner, or the approver who created the run; the role read now (the caller
    holds the gate), not the one the request authenticated with."""
    from oracle.auth.service import caller_refusal

    if await caller_refusal(db, principal, "owner") is None:
        return True
    return principal.id == run.created_by and (
        await caller_refusal(db, principal, "approver") is None
    )


async def _still_manages(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, what: str
) -> Run:
    """After a runtime call made with nothing held: the review gate taken again (shared),
    the run locked and read as it is now, and the caller re-read under the gate (CR-06),
    as :func:`cancel` does: the transaction that checked them ended before the call, and a
    disable or a demotion may have committed while SwarmCloud answered. 403 if they may no
    longer ``what``."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(db, shared=True)
    run = await _get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden(f"Only an owner or the approver who created the run can {what}")
    refusal = await caller_refusal(db, principal, "approver")
    if refusal is not None:
        raise Forbidden(refusal)
    return run


def _manages(principal: Principal, run: Run) -> bool:
    """:func:`_may_manage` by the role the request authenticated with: for what the
    Inbox lists (every action re-reads the role)."""
    return principal.role == "owner" or (
        has_role(principal.role, "approver") and principal.id == run.created_by
    )


def _cancel_stuck(run: Run) -> dict[str, Any] | None:
    """The live workflow whose cancel is past :data:`NOT_FOUND_TRIES` 404s that prove
    nothing (in the Inbox with Cancel), if any."""
    wf = _live(run)
    return wf if wf is not None and (wf.get("cancel_pending") or {}).get("stuck") else None


async def _stop_cancelling(db: AsyncSession, run: Run) -> bool:
    """Stop cancelling a workflow whose cancel is stuck on 404s (P3d, owner 2026-10-19):
    the cancel calls stop and the Inbox item clears, but the workflow is never detached
    from the run's spend. It goes on ``searches`` with its id, so its status and cost are
    still read (on every tick) until SwarmCloud says it ended, its cost counted in the
    run's spend against the ceiling. A run that has not ended ends (:func:`_end_stopped`):
    no second workflow starts for that segment."""
    wf = _cancel_stuck(run)
    if wf is None:
        return False
    pending = wf.get("cancel_pending") or {}
    stopped = (
        f"An approver stopped cancelling workflow {wf.get('id')}: SwarmCloud answered HTTP "
        f"404 {pending.get('not_found')} times without saying it does not exist "
        f"({pending.get('error')}). Oracle no longer cancels it, but keeps reading its status "
        "and cost on every tick until it ends, and counts its spend on the run. If it still "
        "runs, cancel it in SwarmCloud's console."
    )
    log.warning("run %s: %s", run.id, stopped)
    _search_for(
        run,
        label=wf.get("label") or wf["id"],
        seq=wf.get("start_seq"),
        submitted_at=wf.get("submitted_at") or pending.get("since"),
        until=_credential_end(wf),
        why="stopped",
        workflow_id=wf["id"],
        cancel=False,
    )
    segments = await _segments(db, run.id)
    target = next((s for s in segments if s.seq == wf.get("start_seq")), None)
    if target is not None or segments:
        _note(target or segments[0], stopped)
    await _end_workflow(db, run, wf, pending.get("state") or "cancelled", stopped=True)
    if run.status not in FINAL:
        await _end_stopped(db, run, segments, wf)
    return True


async def _end_stopped(
    db: AsyncSession, run: Run, segments: list[RunSegment], wf: dict[str, Any]
) -> None:
    """P3d (owner, 2026-10-19): Stop cancelling on a run that has not ended ends the run
    (cancelled, the reason recorded). The stopped workflow stays on ``searches``; a lost
    submission of a pending segment is looked for in the background, as Cancel does."""
    for s in segments:
        if s.status not in ("running", "pending"):
            continue
        lost = _art(s).get("lost")
        if s.status == "pending" and isinstance(lost, dict) and lost.get("label"):
            _search_for(
                run,
                label=lost["label"],
                seq=s.seq,
                submitted_at=lost.get("submitted_at"),
                until=_credential_end(lost),
                why="cancel",
            )
        s.status = "cancelled"
        s.finished_at = s.finished_at or _now()
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run ended: an approver stopped cancelling its workflow."
            cp.decided_at = _now()
    _set_knob(run, "stuck_lookup", None)
    _set_knob(run, "post_404", None)
    _set_knob(run, "queue_wait", None)
    run.status = "cancelled"
    run.finished_at = _now()
    _set_knob(run, "spent_at_end", str(run.spent_usd or 0))
    run.error = (
        f"Stop cancelling ended the run: Oracle no longer cancels workflow {wf.get('id')}, "
        "and its spend still counts on the run until SwarmCloud stops it."
    )
    await revoke_run_tokens(db, run.id)


async def stop_cancelling(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Stop cancelling from the Inbox (a cancel stuck on 404s, whatever the run's state):
    see :func:`_stop_cancelling`."""
    run = await _get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can stop this")
    ended = run.status not in FINAL
    if not await _stop_cancelling(db, run):
        raise RunError("nothing to stop: no cancel of this run waits on SwarmCloud's 404s")
    await audit.record(db, principal, "run.cancel_stopped", "run", run.id, {"ended_run": ended})
    await db.commit()


class TooSoon(RunError):
    status = 429


# Retry lookup reads one workflow now; once per run in this long.
RETRY_LOOKUP_SECONDS = 30


async def retry_lookup(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Retry lookup from the Inbox: the searched workflow whose cost is unknown (its
    status does not read) is read now, not at its next rest; read, it is followed as
    before. That one workflow only, SwarmCloud called without the run's row lock, and at
    most once per :data:`RETRY_LOOKUP_SECONDS` per run."""
    run = await _get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can retry this")
    entry = _cost_unknown(run)
    if entry is None:
        raise RunError("nothing to look up: no workflow of this run has an unknown cost")
    last = _parse_at((run.knobs or {}).get("lookup_retried_at"))
    if last is not None and (_now() - last).total_seconds() < RETRY_LOOKUP_SECONDS:
        raise TooSoon(
            f"Retry lookup read this run's workflow less than {RETRY_LOOKUP_SECONDS} s ago; "
            "try again shortly"
        )
    _set_knob(run, "lookup_retried_at", _now().isoformat())
    entry = copy.deepcopy(entry)
    wid = entry["id"]
    # Committed: the cooldown holds for a second click, and the row lock is released
    # before SwarmCloud is called.
    await db.commit()
    cancelling = _found_cancels(entry)
    out = await _found_call(entry)

    # Under the gate and the lock, as the run and the caller are now.
    run = await _still_manages(db, principal, run_id, "retry this")
    segments = await _segments(db, run.id, fresh=True)
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    e = next((x for x in entries if x.get("id") == wid), None)
    if e is not None:
        target = segments[0] if segments else None
        segment = next((x for x in segments if x.seq == e.get("seq")), target)
        e["read_at"] = _now().isoformat()
        dropped: list[dict[str, Any]] = []
        if not _found_apply(run, segments, segment, e, out, cancelling):
            entries.remove(e)
            if e.get("dropped"):
                dropped.append(e)
        _set_knob(run, "searches", entries or None)
        await _after_search(db, run, target, _TickStats(), dropped)
    await audit.record(db, principal, "run.lookup_retried", "run", run.id, {"workflow_id": wid})
    await db.commit()


async def retry_import(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Retry from the Inbox's "Couldn't import" (owners only): the step whose resumed
    advance stopped at :data:`RESUME_TRIES` is advanced again by the next tick, with its
    count reset. Audited."""
    if principal.role != "owner":
        raise Forbidden("Only an owner can retry importing a run's output")
    run = await _get_run(db, run_id, lock=True)
    failed = _import_failed(run)
    if failed is None:
        raise RunError("nothing to retry: no import of this run has stopped")
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == failed.get("seq")), None)
    art = _art(segment) if segment is not None else {}
    attempt = _current_attempt(art, segment) if segment is not None else {}
    if segment is None or segment.status != "failed" or attempt.get("advanced") != "opening":
        _set_knob(run, "import_failed", None)
        await db.commit()
        raise RunError("nothing to retry: the run changed since its import stopped")
    attempt.pop("resume_failures", None)
    _note_art(
        art,
        f"An owner retried importing {segment.name}'s output (it failed with "
        f"{failed.get('error')} on {failed.get('count')} tries in a row).",
    )
    _set_art(segment, art)
    segment.status = "succeeded"
    segment.error = None
    _set_knob(run, "import_failed", None)
    await audit.record(
        db,
        principal,
        "run.import_retried",
        "run",
        run.id,
        {"segment": segment.name, "error": failed.get("error"), "tries": failed.get("count")},
    )
    await db.commit()


def _review_of(checkpoints: list[Checkpoint], seq: int) -> Checkpoint | None:
    """The segment's latest checkpoint (its review), open or decided."""
    ours = [c for c in checkpoints if (c.payload or {}).get("segment_seq") == seq]
    return ours[-1] if ours else None


async def _scope_of(db: AsyncSession, cp: Checkpoint) -> PrdScope | None:
    """The PRD scope a feature-set checkpoint decides (C6), if it has one."""
    if cp.kind != "feature_set":
        return None
    raw = (cp.payload or {}).get("scope_id")
    if raw:
        try:
            found = await db.get(PrdScope, uuid.UUID(str(raw)))
        except ValueError:
            found = None
        if found is not None:
            return found
    return await db.scalar(select(PrdScope).where(PrdScope.checkpoint_id == cp.id))


async def _recheck_scope(db: AsyncSession, cp: Checkpoint) -> int:
    """Re-check the scope a feature-set checkpoint decides as stored (C6 rule 3,
    :func:`feature_set.check_scope`) and keep the result on the checkpoint, so every
    approval path (the web, the Inbox, MCP, a console approval) refuses on the same
    problems. Returns the blocking problems now open (0 without a scope: a run from
    before scopes approves as before)."""
    scope = await _scope_of(db, cp)
    if scope is None:
        return 0
    check = (await feature_set.check_scope(db, scope)).as_json()
    cp.payload = {**(cp.payload or {}), "feature_set_check": check}
    return feature_set.blocking_of(check)


async def _scope_decided(
    db: AsyncSession, principal: Principal | None, run: Run, cp: Checkpoint
) -> None:
    """A feature-set checkpoint was decided (any path): approved, its scope is approved
    and supersedes the document's earlier approved one (rule 3); changes requested, the
    proposed scope is superseded (rule 4) and the re-run writes the next attempt's. A
    priority-order checkpoint's snapshot likewise (C8, :func:`_order_decided`)."""
    await _order_decided(db, principal, run, cp)
    scope = await _scope_of(db, cp)
    if scope is None:
        return
    if cp.status == "approved":
        # C7 Approve with edits: what people added or reworded becomes the approver's
        # own baseline writes, in this transaction (no agent round).
        from oracle.runs import scope_review

        edits = (
            await scope_review.approved(db, principal, run, cp, scope)
            if scope.status == "proposed"
            else {}
        )
        await feature_set.approve(db, scope, cp.decided_by, run.document_id)
        await audit.record(
            db,
            principal if principal is not None else audit.ORACLE,
            "prd_scope.approved",
            "prd_scope",
            scope.id,
            {"run_id": str(run.id), "checkpoint_id": str(cp.id), "by": str(cp.decided_by),
             **edits},
        )  # fmt: skip
    elif cp.status == "changes_requested" and scope.status == "proposed":
        scope.status = "superseded"
        scope.lock_version += 1


async def _scope_reopened(db: AsyncSession, cp: Checkpoint) -> None:
    """A feature-set decision was voided or not posted: its scope is proposed again (an
    earlier approved scope it superseded stays superseded until this one is decided). A
    priority-order decision's snapshot is proposed again too (C8)."""
    snapshot = await run_order.snapshot_for(db, cp)
    if snapshot is not None and snapshot.status != "proposed":
        run_order.reopen(snapshot)
    scope = await _scope_of(db, cp)
    if scope is None or scope.status == "proposed":
        return
    scope.status = "proposed"
    scope.approved_by = None
    scope.approved_at = None
    scope.lock_version += 1


async def _order_decided(
    db: AsyncSession, principal: Principal | None, run: Run, cp: Checkpoint
) -> None:
    """C8 rules 3 and 4: a priority-order checkpoint approved saves its snapshot for the
    PRD (audited ``priority_snapshot.approved``); changes requested discards it."""
    snapshot = await run_order.snapshot_for(db, cp)
    if snapshot is None or snapshot.status != "proposed":
        return
    if cp.status == "approved":
        run_order.approve(snapshot, cp.decided_by, run.document_id)
        await audit.record(
            db,
            principal if principal is not None else audit.ORACLE,
            "priority_snapshot.approved",
            "priority_snapshot",
            snapshot.id,
            {"run_id": str(run.id), "checkpoint_id": str(cp.id), "by": str(cp.decided_by)},
        )
    elif cp.status == "changes_requested":
        run_order.discard(snapshot, cp.decided_by)


# What the Inbox says of a console approval held while the feature set has blocking problems
# (D3 Approve blocked by problems, "Console gate", decided 2026-10-20).
CONSOLE_BLOCKED = "Blocking problems are open: fix or waive them, then confirm"


async def _hold_console_approval(
    db: AsyncSession,
    run: Run,
    cp: Checkpoint,
    segment: RunSegment,
    record: RecordedAnswer,
    wait: dict[str, Any],
    at: str | None,
    revise: bool,
    member: User | None,
) -> None:
    """A counted console approval of a feature set or a priority order with blocking
    problems open: recorded, not followed. The checkpoint stays pending with ``needs =
    "confirm"`` (so the run's token stays read-only, :func:`_holds_token`), nothing is
    posted to the workflow, and Confirm is refused like Approve until the problems are
    fixed or waived."""
    console = _console_record(run, segment, record, at, revise)
    console.update(
        counted=True,
        reason=CONSOLE_BLOCKED,
        needs="confirm",
        role=member.role if member is not None else None,
        blocking=True,
    )
    wait["console"] = console
    _set_wait(cp, wait)
    await audit.record(
        db,
        None,
        "checkpoint.console_answer",
        "checkpoint",
        cp.id,
        {
            "run_id": str(run.id),
            "kind": cp.kind,
            "answered_in": "swarmcloud",
            "answered_by": record.answered_by,
            "verdict": record.verdict,
            "counted": True,
            "held": "blocking_problems",
        },
    )
    _note(
        segment,
        f"{cp.kind} was approved in SwarmCloud by {record.answered_by or 'someone'}: "
        f"{_said(record, at)}. The {CHECKPOINT_TITLES.get(cp.kind, cp.kind).lower()} has "
        "blocking problems, so Oracle recorded the "
        "approval and did not follow it: the checkpoint stays open in the Inbox, and an "
        "approver confirms it once the problems are fixed or waived, or requests changes.",
    )


# Approving a review is refused while its draft is not imported (owner, 2026-10-20): a
# run approved past a refused draft finished with no document.
NOT_IMPORTED = "the draft was not imported: retry import, or request changes"


def _cannot_approve(cp: Checkpoint) -> str | None:
    """Why approving this checkpoint is refused now (web, Inbox and MCP alike): the draft
    its segment left was refused at import (until Retry import imports it). Blocking
    problems, the feature set's (C6) and the priority order's (C8) included, are the
    approve gate's (D3, oracle.runs.gate)."""
    imp = (cp.payload or {}).get("import")
    if cp.status == "pending" and isinstance(imp, dict) and imp.get("error"):
        return NOT_IMPORTED
    return None


def _run_version(segments: list[RunSegment], checkpoints: list[Checkpoint]) -> str | None:
    """A document version this run imported, any attempt (each attempt's import is on its
    checkpoint's payload, the current one on its segment), as ``slug vN``."""
    imports = [(s.artifacts or {}).get("import") for s in segments]
    imports += [(c.payload or {}).get("import") for c in checkpoints]
    for imp in imports:
        if isinstance(imp, dict) and imp.get("version") is not None and not imp.get("error"):
            return f"{imp.get('slug')} v{imp['version']}"
    return None


def one_version(version: str) -> str:
    """Why a finished run's refused draft is not imported once the run imported a version
    (owner, 2026-10-25), in plain words, with what to do instead."""
    return (
        f"this run already imported {version}, and a finished run imports one version only, "
        "so this draft is not imported. Start a new run to draft it again."
    )


def _draft_retry_refusal(
    run: Run,
    segment: RunSegment,
    review: Checkpoint | None,
    kind: str,
    version: str | None,
) -> str | None:
    """Why the segment's draft cannot be imported again now; None when it can: its import
    at segment end was refused, its draft file is kept, and either the run waits at its
    review, or the run finished (its review approved past the refusal) with no version
    imported by any of its attempts (``version``)."""
    name = flows.draft_file(kind)
    if not _flow(run).segment(segment.name).imports_draft:
        return f"{segment.name} imports no draft"
    art = segment.artifacts or {}
    imp = art.get("import")
    if not isinstance(imp, dict) or not imp.get("error"):
        if isinstance(imp, dict) and imp.get("version") is not None:
            return f"{name} of {segment.name} was imported ({imp.get('slug')} v{imp['version']})"
        return f"no import of {segment.name}'s {name} was refused"
    if run.status in ("cancelled", "failed"):
        return "the run was cancelled" if run.status == "cancelled" else "the run failed"
    if run.status == "succeeded":
        if review is None or review.status == "pending":
            return f"{segment.name} has no decided review"
        if version is not None:
            return one_version(version)
    elif review is not None and review.status != "pending":
        return f"{segment.name}'s review was decided ({review.status}); it is not waiting"
    elif review is None or run.status != "awaiting_checkpoint":
        return f"the run is {run.status}, not waiting at {segment.name}'s review"
    if (art.get("files") or {}).get(name) is None:
        return f"the segment left no {name} to import"
    return None


async def _slug_taken(db: AsyncSession, run: Run) -> str | None:
    """The slug of the document a run was to create (``knobs.document_slug``) when a
    document of it exists now that none of the run's versions is in: another document,
    which the run's import must not add a version to."""
    slug = None if run.document_id else (run.knobs or {}).get("document_slug")
    if not slug:
        return None
    doc = await docs_service.find_document(db, slug)
    if doc is None:
        return None
    # A version the run's agents imported themselves (push_draft) is the run's.
    return None if await docs_service.run_imported_into(db, doc.id, run.id) else slug


def _retry_refused(run: Run, segment: RunSegment, version: str | None) -> str | None:
    """The run page's plain why for a finished run's refused draft that stays refused
    because the run imported a version (owner, 2026-10-25): :func:`one_version`."""
    imp = (segment.artifacts or {}).get("import")
    if run.status != "succeeded" or version is None:
        return None
    if not isinstance(imp, dict) or not imp.get("error"):
        return None
    why = one_version(version)
    return why[:1].upper() + why[1:]


def _draft_retry_role(review: Checkpoint | None) -> str:
    """Who retries: the review's approver role or above while the run waits at it; once
    the run finished, owners only."""
    if review is not None and review.status == "pending":
        return review.approver_role
    return "owner"


def _draft_retries(
    run: Run,
    segments: list[RunSegment],
    checkpoints: list[Checkpoint],
    kind: str,
    principal: Principal | None,
) -> set[int]:
    """The segments whose refused draft ``principal`` may import again now (the run page's
    Retry import)."""
    if principal is None:
        return set()
    version = _run_version(segments, checkpoints)
    out: set[int] = set()
    for s in segments:
        review = _review_of(checkpoints, s.seq)
        if _draft_retry_refusal(run, s, review, kind, version) is None and has_role(
            principal.role,
            _draft_retry_role(review),  # type: ignore[arg-type]
        ):
            out.add(s.seq)
    return out


# A retry's import runs in a session of its own (:func:`_import_draft`), two connections
# each (no lock held): a burst imports this many at a time per process, the rest waiting
# with no connection held, so it cannot drain the pool.
DRAFT_RETRY_SLOTS = 2
_draft_retry_slots: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Semaphore] = (
    weakref.WeakKeyDictionary()
)


def _retry_slots() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    slots = _draft_retry_slots.get(loop)
    if slots is None:
        slots = _draft_retry_slots[loop] = asyncio.Semaphore(DRAFT_RETRY_SLOTS)
    return slots


async def retry_draft_import(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, seq: int
) -> None:
    """:func:`_retry_draft_import`, :data:`DRAFT_RETRY_SLOTS` at a time: the request's
    connection goes back to the pool while it waits for a slot."""
    await db.commit()
    async with _retry_slots():
        await _retry_draft_import(db, principal, run_id, seq)


async def _retry_checked(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, seq: int
) -> tuple[Run, RunSegment, Checkpoint, str]:
    """The run (its row locked, under the review gate), the segment, its review and the
    run's kind, when ``principal`` may retry that segment's import now; raises otherwise."""
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    await publish.gate_lock(db, shared=True)
    run = await _get_run(db, run_id, lock=True)
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == seq), None)
    if segment is None:
        raise NotFound(f"run {run_id} has no segment {seq}")
    checkpoints = await _checkpoints(db, [run.id])
    review = _review_of(checkpoints, seq)
    role = _draft_retry_role(review)
    if not has_role(principal.role, role):  # type: ignore[arg-type]
        if role == "owner":
            raise Forbidden("Only an owner can retry importing the draft of a finished run")
        raise Forbidden(f"Requires the {role} role")
    refused = await caller_refusal(db, principal, role)  # type: ignore[arg-type]
    if refused is not None:
        raise Forbidden(refused)
    kind = await _target_kind(db, run)
    refusal = _draft_retry_refusal(run, segment, review, kind, _run_version(segments, checkpoints))
    if refusal is not None or review is None:
        raise RunError(f"nothing to retry: {refusal}")
    return run, segment, review, kind


async def _retry_draft_import(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, seq: int
) -> None:
    """Retry import from the run page (owner, 2026-10-20): the draft a segment left, whose
    import at segment end was refused, is imported again as at segment end (an Oracle that
    now accepts it, or a cause that went away).

    While the run waits at that segment's review: by the review's approver role or above;
    the review stays open and its SwarmCloud wait is untouched, so the person still
    decides. After the run finished (the review was approved past the refusal, before that
    was refused): owners only, while no version from any of the run's attempts exists; the
    run's checkpoints do not change, and the new version goes through the document's own
    review. Refused on a cancelled or failed run.

    Imported, the run names the document and the import replaces the error on the segment
    and in the review's payload; refused again, the new error replaces the old. Either way
    noted on the segment and audited. Once imported there is nothing to retry (409).
    The import runs with nothing locked, as at segment end (:func:`_advance`): the checks
    are made under the run's row lock, committed, the draft imported in its own session,
    then the run locked and checked again before the result is written. A second retry
    that imported meanwhile finds nothing to retry then (its import of the same draft
    added nothing). The role the retry needs depends on the review (the checkpoint's
    approver role while it waits, an owner after the run finished), so it is read here:
    under the review gate, the caller is re-read with it (CR-06), before anything else."""
    run, segment, review, kind = await _retry_checked(db, principal, run_id, seq)
    if (taken := await _slug_taken(db, run)) is not None:
        raise RunError(f"{taken} now names another document: the run's draft is not added to it")
    name = flows.draft_file(kind)
    markdown = _art(segment)["files"][name]
    # Committed first: the import runs in its own transaction, with the run's row and the
    # review gate released (no second connection taken while they are held).
    await db.commit()
    imported = await _import_draft(db, run, kind, markdown)
    # Locked and checked again: the run may have been cancelled, or another retry imported.
    try:
        run, segment, review, kind = await _retry_checked(db, principal, run_id, seq)
    except RunError as exc:
        raise RunError(f"{exc} (the run changed while its draft was imported)") from exc
    finished = run.status == "succeeded"
    art = _art(segment)
    previous = art["import"]["error"]
    who = "An owner" if principal.role == "owner" else "An approver"
    after = " after the run finished" if finished else ""
    if imported.get("document_id"):
        # As at segment end (:func:`_advance`).
        run.document_id = uuid.UUID(imported["document_id"])
        _set_knob(run, "document_slug", None)
        await feature_set.fill_document(db, run.id, run.document_id)
        await run_order.fill_document(db, run.id, run.document_id)
        await _link_requests(db, run)
        _note_art(
            art,
            f"{who} retried importing {name}{after}: imported as {imported.get('slug')} "
            f"v{imported.get('version')}.",
        )
    else:
        _note_art(
            art,
            f"{who} retried importing {name}{after}: still not imported (the segment shows why).",
        )
    art["import"] = imported
    _set_art(segment, art)
    review.payload = {**(review.payload or {}), "import": imported}
    await audit.record(
        db,
        principal,
        "run.draft_import_retried",
        "run",
        run.id,
        {
            "segment": segment.name,
            "seq": seq,
            "file": name,
            "run_status": run.status,
            "previous_error": previous,
            "error": imported.get("error"),
            "document_id": imported.get("document_id"),
            "version": imported.get("version"),
        },
    )
    await db.commit()


async def cancel_again(
    db: AsyncSession, principal: Principal, run_id: uuid.UUID, workflow_id: str
) -> None:
    """Cancel again from the Inbox (P3d, owner 2026-10-19): a workflow an approver
    stopped cancelling has its cancel calls turned back on (the next tick cancels it,
    and they go on resting between tries as before). Its status and cost are still read
    on every tick until it ends; nothing restarts."""
    run = await _get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can cancel this")
    # What the Inbox offers (:func:`_cancel_again_ids`), enforced here: a workflow of this
    # run that an approver stopped cancelling, on a run that has ended, whose overrun is
    # recorded and not dismissed.
    over = (run.knobs or {}).get("overrun_after_end")
    if run.status not in FINAL:
        raise RunError(f"nothing to cancel again: the run has not ended (it is {run.status})")
    if not isinstance(over, dict):
        raise RunError("nothing to cancel again: no overrun is recorded on this run")
    if over.get("dismissed_at"):
        raise RunError("nothing to cancel again: this run's overrun was dismissed")
    entries = copy.deepcopy((run.knobs or {}).get("searches") or [])
    e = next((x for x in entries if x.get("id") == workflow_id and x.get("cancel") is False), None)
    if e is None or workflow_id not in _cancel_again_ids(run):
        raise RunError(
            "nothing to cancel again: that workflow is not one Oracle stopped cancelling for "
            "this run",
            refs={"workflow": workflow_id},
        )
    for key in ("cancel", "cancel_tried_at", "cancelled"):
        e.pop(key, None)
    e["cancel_again_at"] = _now().isoformat()
    _set_knob(run, "searches", entries)
    segments = await _segments(db, run.id)
    target = next((x for x in segments if x.seq == e.get("seq")), segments[0] if segments else None)
    if target is not None:
        _note(
            target,
            "Cancel again: Oracle cancels the workflow again (its cancel calls were stopped), "
            "and keeps reading its status and cost until it ends.",
        )
    await audit.record(
        db, principal, "run.cancel_again", "run", run.id, {"workflow_id": workflow_id}
    )
    await db.commit()


async def dismiss_overrun(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Dismiss an ended run's overrun from the Inbox once nothing of it is left to read:
    the item clears, the overrun stays recorded on the run."""
    run = await _get_run(db, run_id, lock=True)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can dismiss this")
    if not _can_dismiss_overrun(run):
        raise RunError(
            "nothing to dismiss: no overrun of this run is shown, or a workflow of it is still read"
        )
    over = dict((run.knobs or {}).get("overrun_after_end") or {})
    over["dismissed_at"] = _now().isoformat()
    _set_knob(run, "overrun_after_end", over)
    await audit.record(db, principal, "run.overrun_dismissed", "run", run.id, {})
    await db.commit()


async def end_as_oracle(db: AsyncSession, run_id: uuid.UUID, reason: str) -> bool:
    """Oracle ends a background run it started itself (INT2: a newer read of the same
    intake replaces it, or a read that could not start falls back to the built-in job):
    its live workflow is cancelled (one SwarmCloud does not confirm stays attached and the
    tick cancels it again), its open segments are cancelled and its tokens revoked. The
    caller commits. False when the run had already ended."""
    run = await _get_run(db, run_id, lock=True)
    if run.status in FINAL:
        return False
    for segment in await _segments(db, run.id):
        if segment.status in ("pending", "running"):
            unqueue(segment)
            segment.status = "cancelled"
            segment.finished_at = _now()
    await _finish(db, run, "cancelled", reason)
    await audit.record(db, audit.ORACLE, "run.cancelled", "run", run.id, {"reason": reason})
    return True


async def cancel(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Cancel the run: its workflows are cancelled (a lost submission looked up first, and
    cancelled if it landed), its checkpoints skipped. SwarmCloud is called without the
    run's row lock; the run is then read again under it and changed as it is now (what
    appeared meanwhile is called about under the lock, and a lookup is reused only for
    the very submission it was made for: its label and when it was sent). A cancel stuck
    on 404s is tried once more; still not confirmed, Oracle stops cancelling it and keeps
    reading its cost (:func:`_stop_cancelling`). On an ended run, Cancel is Stop
    cancelling."""
    run = await _get_run(db, run_id)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can cancel it")
    if run.status in FINAL and _cancel_stuck(run) is None:
        raise RunError(f"run is already {run.status}")
    runtime = get_runtime()
    # What to ask SwarmCloud, read without the lock.
    wf = _live(run)
    ids: list[str] = []
    # The segment each workflow is cancelled for (its follow-up's target).
    targets: dict[str, uuid.UUID] = {}
    segments = await _segments(db, run.id)
    if wf is not None and wf.get("id") and run.status not in FINAL:
        ids.append(wf["id"])  # a stuck cancel too: one more try
        seg = next((x for x in segments if x.seq == wf.get("seq")), None) or next(
            (x for x in segments if x.swarm_workflow_id == wf["id"]), None
        )
        if seg is not None:
            targets[wf["id"]] = seg.id
    lookups: dict[tuple[str, str | None], str | None] = {}
    lost_in: dict[tuple[str, str | None], uuid.UUID] = {}
    for s in segments:
        lost = _art(s).get("lost")
        if s.status == "running" and s.swarm_workflow_id:
            ids.append(s.swarm_workflow_id)
            targets.setdefault(s.swarm_workflow_id, s.id)
        elif s.status == "pending" and isinstance(lost, dict) and lost.get("label"):
            lookups[(lost["label"], lost.get("submitted_at"))] = lost.get("submitted_at")
            lost_in[(lost["label"], lost.get("submitted_at"))] = s.id
    member_id = run.created_by or run.id
    await db.rollback()
    found: dict[tuple[str, str | None], str | None | RuntimeUnavailable] = {}
    for key, since in lookups.items():
        try:
            found[key] = await runtime.find_by_label(key[0], since=_parse_at(since))
        except RuntimeUnavailable as exc:
            log.warning("run %s: looking up %s: %s", run_id, key[0], exc)
            found[key] = exc
        if isinstance(found[key], str):
            ids.append(found[key])  # type: ignore[arg-type]
            targets.setdefault(found[key], lost_in[key])  # type: ignore[arg-type]
    ids = list(dict.fromkeys(ids))
    # Each cancel is recorded as a follow-up before SwarmCloud is called (no lock held):
    # a crash in between leaves it for the tick, after a grace that keeps the tick off
    # the call this request is making. Settled below, with the run's change.
    follow_ups = {i: _cancel_follow_up(db, member_id, targets.get(i, run_id), i) for i in ids}
    for row in follow_ups.values():
        row.next_attempt_at = _now() + timedelta(seconds=CANCEL_FOLLOW_UP_GRACE_SECONDS)
    await db.commit()
    follow_up_ids = {i: row.id for i, row in follow_ups.items()}
    done = {i: await _cancel_call({"id": i}) for i in ids}

    # Under the review gate and the run's row lock, as the run is now: the caller is read
    # again (the transaction that checked it ended with the calls above), and what the run
    # shows now that was not asked about yet is asked about with nothing held, then the
    # run is locked and read again.
    from oracle.auth.service import caller_refusal
    from oracle.review import publish

    for _ in range(4):
        await publish.gate_lock(db, shared=True)
        run = await _get_run(db, run_id, lock=True)
        if not await _may_manage(db, principal, run):
            raise Forbidden("Only an owner or the approver who created the run can cancel it")
        refusal = await caller_refusal(db, principal, "approver")
        if refusal is not None:
            raise Forbidden(refusal)
        if run.status in FINAL:
            break
        now_wf = _live(run)
        want_cancel: list[str] = []
        want_find: dict[tuple[str, str | None], str | None] = {}
        if now_wf is not None and now_wf.get("id"):
            want_cancel.append(now_wf["id"])
        for seg in await _segments(db, run.id, fresh=True):
            lost = _art(seg).get("lost")
            if seg.status == "running" and seg.swarm_workflow_id:
                want_cancel.append(seg.swarm_workflow_id)
            elif seg.status == "pending" and isinstance(lost, dict) and lost.get("label"):
                want_find[(lost["label"], lost.get("submitted_at"))] = lost.get("submitted_at")
        new_cancel = [i for i in dict.fromkeys(want_cancel) if i not in done]
        new_find = {k: v for k, v in want_find.items() if k not in found}
        if not new_cancel and not new_find:
            break
        await db.rollback()
        for i in new_cancel:
            done[i] = await _cancel_call({"id": i})
        for key, since in new_find.items():
            try:
                found[key] = await runtime.find_by_label(key[0], since=_parse_at(since))
            except RuntimeUnavailable as exc:
                log.warning("run %s: looking up %s: %s", run_id, key[0], exc)
                found[key] = exc
            hit = found[key]
            if isinstance(hit, str):
                done[hit] = await _cancel_call({"id": hit})
    else:
        await db.rollback()
        raise Unavailable("the run kept changing while Oracle cancelled it; cancel it again")
    await _settle_cancel_follow_ups(db, follow_up_ids, done)
    if run.status in FINAL:
        if not await _stop_cancelling(db, run):
            await db.commit()  # the follow-ups' outcomes
            raise RunError(f"run is already {run.status}")
        await audit.record(db, principal, "run.cancel_stopped", "run", run.id, {})
        await db.commit()
        return
    segments = await _segments(db, run.id)
    wf = _live(run)
    for s in segments:
        if s.status == "running" and wf is not None and s.swarm_workflow_id == wf["id"]:
            s.status = "cancelled"
            s.finished_at = _now()
        elif s.status == "running" and s.swarm_workflow_id:
            if wf is None:
                # One workflow per segment: cancelled like the run's workflow below, and
                # cancelled again by the tick (its cost read) until SwarmCloud confirms.
                wf = _attach_for_cancel(run, s, s.swarm_workflow_id)
            else:
                out = done.get(s.swarm_workflow_id) or await _cancel_call(
                    {"id": s.swarm_workflow_id}
                )
                if out.final is not None:
                    _cost_on(
                        run, segments, {"seq": s.seq, "id": s.swarm_workflow_id}, out.final.cost_usd
                    )
                attempt = _current_attempt(_art(s), s)
                label = attempt.get("label") or s.swarm_workflow_id
                if out.error is not None and not out.ended and not out.gone:
                    s.error = f"cancel not confirmed by the runtime: {_shown(out.error)}"
                    # Not attached (one workflow is): cancelled and costed in the
                    # background until SwarmCloud confirms.
                    _search_for(
                        run,
                        label=label,
                        seq=s.seq,
                        submitted_at=attempt.get("submitted_at"),
                        until=None,
                        why="cancel",
                        workflow_id=s.swarm_workflow_id,
                    )
                elif not out.gone and (out.final is None or not out.final.terminal):
                    # Confirmed, its status not read or not terminal yet (winding down):
                    # read in the background until it ends, its last cost counted.
                    _search_for(
                        run,
                        label=label,
                        seq=s.seq,
                        submitted_at=attempt.get("submitted_at"),
                        until=None,
                        why="cancel",
                        workflow_id=s.swarm_workflow_id,
                        cancelled=True,
                        costed=out.final is not None,
                    )
            s.status = "cancelled"
            s.finished_at = _now()
        elif s.status == "pending":
            lost = _art(s).get("lost")
            if isinstance(lost, dict) and lost.get("label"):
                # A submission whose answer was lost may have landed: found, it is
                # cancelled; not looked up yet, the tick looks again and cancels it. Never
                # left behind: what cannot be attached is searched for in the background.
                label, since = lost["label"], lost.get("submitted_at")
                key = (label, since)
                if key in found:
                    result = found[key]
                else:
                    # Lost since Oracle looked (or sent again under the same label): the
                    # earlier lookup says nothing of it, so it is looked up now.
                    try:
                        result = await runtime.find_by_label(label, since=_parse_at(since))
                    except RuntimeUnavailable as exc:
                        result = exc
                until = _credential_end(lost)
                if isinstance(result, str):
                    if wf is None:
                        wf = _attach_for_cancel(run, s, result, label, since, until)
                        _adopt(segments, wf)
                    else:
                        _add_attempt(s, result, label, "cancelled", mode=lost.get("mode"))
                        _search_for(
                            run,
                            label=label,
                            seq=s.seq,
                            submitted_at=since,
                            until=until,
                            why="cancel",
                            workflow_id=result,
                        )
                elif result is not None:  # neither found nor ruled out
                    if wf is None:
                        wf = _attach_for_cancel(run, s, None, label, since, until)
                    else:
                        _search_for(
                            run,
                            label=label,
                            seq=s.seq,
                            submitted_at=since,
                            until=until,
                            why="cancel",
                        )
            s.status = "cancelled"
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run cancelled."
            cp.decided_at = _now()
    _set_knob(run, "stuck_lookup", None)
    # A cancel SwarmCloud does not confirm leaves the workflow attached: the tick cancels
    # it again and counts its cost. One stuck on 404s that this one more try did not
    # confirm either: Oracle stops cancelling it, and keeps reading its cost.
    await _finish(db, run, "cancelled", state="cancelled", done=done)
    await _stop_cancelling(db, run)
    if _cancel_pending(run) and segments:
        _note(
            segments[0],
            "Run cancelled; SwarmCloud did not confirm cancelling its workflow yet, so Oracle "
            "cancels it again on every tick and keeps counting its cost.",
        )
    await audit.record(db, principal, "run.cancelled", "run", run.id, {})
    await db.commit()


async def stop_run(
    db: AsyncSession,
    principal: Principal,
    run: Run,
    data: dict[str, Any] | None = None,
    *,
    deferred: list[RunSegment] | None = None,
) -> None:
    """Cancel a run that is not final (locked by the caller, who commits) without calling
    the runtime: its running segments are appended to ``deferred``, for the caller to
    cancel at the runtime after it commits (a disable, which holds the review gate); its
    pending segments and checkpoints end, its tokens die. The run's live workflow (adapter
    v2) stays attached as a cancel not confirmed yet: the tick cancels it again and reads
    its cost until SwarmCloud confirms (:func:`_apply_cancel`)."""
    segments = await _segments(db, run.id)
    for s in segments:
        if s.status == "running" and s.swarm_workflow_id:
            if deferred is not None:
                deferred.append(s)
            s.status = "cancelled"
            s.finished_at = _now()
        elif s.status == "pending":
            unqueue(s)
            s.status = "cancelled"
    for cp in await _checkpoints(db, [run.id]):
        if cp.status == "pending":
            cp.status = "skipped"
            cp.note = "Run cancelled."
            cp.decided_at = _now()
    wf = _live(run)
    done: dict[str, _Cancelled] = {}
    if wf is not None and wf.get("id"):
        done[wf["id"]] = _Cancelled(
            error=RuntimeUnavailable("cancelled at the runtime once the disable commits")
        )
    await _finish(db, run, "cancelled", state="cancelled", done=done)
    await audit.record(db, principal, "run.cancelled", "run", run.id, data or {})


async def retry(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    """Retry from the Inbox: a lost submission Oracle could neither find nor rule out
    past the lookup cap. Looked up once more (without the run's row lock, then the run
    is read again under it: changed meanwhile, nothing is retried); found, it is the
    segment's workflow; else the segment is submitted again under a new key. The approver
    accepts that the lost one, if it landed, may run too (the web asks first: it can
    start a paid duplicate run): its run token is revoked, and Oracle keeps looking for
    it in the background (:func:`_search_earlier`) to cancel it and count its cost."""
    run = await _get_run(db, run_id)
    if not await _may_manage(db, principal, run):
        raise Forbidden("Only an owner or the approver who created the run can retry it")
    stuck = (run.knobs or {}).get("stuck_lookup")
    if run.status != "running" or not isinstance(stuck, dict):
        raise RunError("nothing waits for a retry: no lost submission is past its lookup cap")
    segment = next((s for s in await _segments(db, run.id) if s.seq == stuck.get("seq")), None)
    lost = _art(segment).get("lost") if segment is not None else None
    if segment is None or segment.status != "pending" or not isinstance(lost, dict):
        # Resolved, as read without the lock: checked again under it before the marker
        # is cleared (the tick may have lost the submission again meanwhile).
        run = await _get_run(db, run_id, lock=True)
        now = (run.knobs or {}).get("stuck_lookup")
        segment = next(
            (s for s in await _segments(db, run.id, fresh=True) if s.seq == (now or {}).get("seq")),
            None,
        )
        lost = _art(segment).get("lost") if segment is not None else None
        if now == stuck and (
            segment is None or segment.status != "pending" or not isinstance(lost, dict)
        ):
            _set_knob(run, "stuck_lookup", None)
            await db.commit()
            raise RunError("nothing waits for a retry: the submission was resolved")
        await db.rollback()
        raise RunError(
            "nothing was retried: the run changed while Oracle read it; look at it again"
        )
    label, since = lost["label"], lost.get("submitted_at")
    await db.rollback()
    runtime = get_runtime()
    found: str | None = None
    try:
        found = await runtime.find_by_label(label, since=_parse_at(since))
    except RuntimeUnavailable as exc:
        log.warning("run %s: retry: %s still not resolved: %s", run_id, label, exc)

    # Under the gate and the lock, as the run and the caller are now.
    run = await _still_manages(db, principal, run_id, "retry it")
    stuck = (run.knobs or {}).get("stuck_lookup")
    segments = await _segments(db, run.id)
    segment = next((s for s in segments if s.seq == (stuck or {}).get("seq")), None)
    art = _art(segment) if segment is not None else {}
    lost = art.get("lost")
    if (
        run.status != "running"
        or not isinstance(stuck, dict)
        or stuck.get("label") != label
        or segment is None
        or segment.status != "pending"
        or not isinstance(lost, dict)
        or lost.get("label") != label
    ):
        raise RunError(
            f"nothing waits for a retry: the run changed while Oracle looked for {label} "
            f"(it is {run.status}); look at it again"
        )
    _set_knob(run, "stuck_lookup", None)
    if found:
        art.pop("lost", None)
        _accepted(run, segment, art, found, lost, art.pop("pending_note", None), runtime)
    else:
        art.pop("lost", None)
        art["abandoned"] = [*(art.get("abandoned") or []), label]
        _search_for(
            run,
            label=label,
            seq=segment.seq,
            submitted_at=since,
            until=_credential_end(lost),
            why="retry",
        )
        _note_art(
            art,
            f"Retried from the Inbox by an approver: submission {label} was neither found "
            "nor ruled out, so the segment was submitted again under a new key. If the lost "
            "one landed it runs without Oracle's data (its token is revoked) until Oracle "
            f"finds it: Oracle looks for it every {_duration(STUCK_LOOKUP_SECONDS)}, then "
            "cancels it and counts its cost.",
        )
        _set_art(segment, art)
        await revoke_run_tokens(db, run.id)
        await _submit(db, run, segment, segments)
    await audit.record(
        db, principal, "run.retried", "run", run.id, {"label": label, "found": found}
    )
    await db.commit()


async def resume(db: AsyncSession, principal: Principal, run_id: uuid.UUID) -> None:
    run = await _get_run(db, run_id, lock=True)
    if run.status != "paused_overrun":
        raise RunError(f"run is {run.status}, not paused on overrun")
    # The owner accepts the spend so far plus another half of the estimate. A Resume is
    # a spend approval (C2): who gave it and the ceiling it replaced are kept, so a
    # demotion or disable can void it (oracle.members.service._void_spend_approvals).
    allowance = (run.estimate_usd or Decimal(0)) * (flows.OVERRUN_FACTOR - 1)
    ceiling = ((run.spent_usd or Decimal(0)) + allowance).quantize(Decimal("0.0001"))
    run.resumed_from_ceiling_usd = _ceiling(run)
    run.resumed_by = principal.id
    run.resumed_at = _now()
    _set_knob(run, "spend_ceiling_usd", str(ceiling))
    run.status = "running"
    await audit.record(db, principal, "run.resumed", "run", run.id, {"ceiling_usd": str(ceiling)})
    await webhooks.capture(db, "run.resumed", principal, run_id=run.id)
    segments = await _segments(db, run.id)
    checkpoints = await _checkpoints(db, [run.id])
    if any(c.status == "pending" or _owes(c) for c in checkpoints):
        # Paused while it waited on a checkpoint: it waits on it again, in the Inbox; or
        # on a decision recorded and not delivered yet, which the tick delivers now.
        run.status = "awaiting_checkpoint"
        waiting = next((c for c in checkpoints if c.status == "pending"), None)
        if waiting is not None:
            await webhooks.capture(
                db, "run.checkpoint_waiting", principal, run_id=run.id, checkpoint_id=waiting.id
            )
    elif not any(s.status == "running" for s in segments):
        # A Resume voided before its segment was submitted left that segment unqueued
        # (marked): queue it again; otherwise advance past the last segment that ran.
        voided = [s for s in segments if s.status == "pending" and _art(s).get(RESUME_VOIDED)]
        if voided:
            art = _art(voided[0])
            art.pop(RESUME_VOIDED, None)
            _set_art(voided[0], art)
            await _submit(db, run, voided[0], segments)
        else:
            done = [s for s in segments if s.status == "succeeded"]
            if done:
                await _advance(db, run, done[-1], segments, gate=True)
    await db.commit()  # the router submits what it queued (submit_queued), outside the gate


# --------------------------------------------------------------------------- inbox


def _waits_for(item: FeedbackItem, suggestion: str | None) -> str:
    """The InboxFeedbackCounts field an open item counts under."""
    if suggestion == "open":
        return "suggestions"
    if suggestion == "accepted":
        return "accepted"
    if item.kind == "comment":
        return "comments"
    if item.kind == "section_review":
        return "verdicts"
    return "other"


async def _date_rows(db: AsyncSession, principal: Principal, leads: frozenset[uuid.UUID]) -> list:
    """F3 Date bases: the proposed schedule bases, for the engineering leads (and the owners
    while no lead is named), oldest first, each with its PRD."""
    from oracle.roadmap.models import ScheduleBasis
    from oracle.roadmap.schemas import DocumentRef, InboxDateBasis, ScheduleBasisOut

    lead = (
        principal.user_id is not None
        and principal.user_id in leads
        and has_role(principal.role, "commenter")
    )
    if not (lead or (principal.role == "owner" and not leads)):
        return []
    rows = (
        await db.execute(
            select(ScheduleBasis, Document.slug, Document.title)
            .join(Document, Document.id == ScheduleBasis.prd_document_id)
            .where(ScheduleBasis.status == "proposed")
            .order_by(ScheduleBasis.proposed_at, ScheduleBasis.id)
        )
    ).all()
    return [
        InboxDateBasis(
            **ScheduleBasisOut.model_validate(b).model_dump(),
            prd=DocumentRef(id=b.prd_document_id, slug=slug, title=title),
        )
        for b, slug, title in rows
    ]


# Runs that finished before the No document row shipped get none (#583 review): the Inbox
# does not fill with every past refused run at once. Their run pages still offer Retry
# import; the row is for runs that finish from here on.
NO_DOCUMENT_SINCE = datetime(2026, 10, 25, tzinfo=UTC)


async def _no_documents(db: AsyncSession) -> list[RunSummary]:
    """The owners' Inbox rows for runs that finished with no document (owner, 2026-10-25):
    a segment's draft was refused at import, the run succeeded past it (its review
    approved, e.g. by a console MERGE) and no attempt imported a version. Each carries
    ``no_document``: why, and the action (Retry import, else a new run).

    A row clears itself (#583 review): on a successful Retry import (the run imported a
    version), and once the run's document has a version made after the run finished (a
    later run imported it). Only runs that finished since :data:`NO_DOCUMENT_SINCE`.
    Filtered in SQL, reading only the refused import and the names of the kept files,
    never the drafts."""
    imp = RunSegment.artifacts["import"]
    imported_segment = (
        select(RunSegment.id)
        .where(
            RunSegment.run_id == Run.id,
            RunSegment.artifacts["import"]["version"].astext.is_not(None),
            func.coalesce(RunSegment.artifacts["import"]["error"].astext, "") == "",
        )
        .correlate(Run)
        .exists()
    )
    imported_review = (
        select(Checkpoint.id)
        .where(
            Checkpoint.run_id == Run.id,
            Checkpoint.payload["import"]["version"].astext.is_not(None),
            func.coalesce(Checkpoint.payload["import"]["error"].astext, "") == "",
        )
        .correlate(Run)
        .exists()
    )
    later_version = (
        select(DocumentVersion.id)
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(
            or_(
                Document.id == Run.document_id,
                Document.slug == Run.knobs["document_slug"].astext,
            ),
            DocumentVersion.created_at > Run.finished_at,
        )
        .correlate(Run)
        .exists()
    )
    rows = (
        await db.execute(
            select(
                Run,
                RunSegment.seq,
                RunSegment.name,
                imp,
                func.jsonb_path_query_array(
                    RunSegment.artifacts["files"], literal_column("'$.keyvalue().key'::jsonpath")
                ),
            )
            .join(RunSegment, RunSegment.run_id == Run.id)
            .where(
                Run.status == "succeeded",
                Run.finished_at >= NO_DOCUMENT_SINCE,
                func.coalesce(imp["error"].astext, "") != "",
                ~imported_segment,
                ~imported_review,
                ~later_version,
            )
            .order_by(Run.created_at, Run.id, RunSegment.seq)
        )
    ).all()
    refused: dict[uuid.UUID, tuple[Run, RunSegment]] = {}
    for run, seq, name, refusal, files in rows:
        # Only what the retry check reads: the refusal, and which files were kept.
        light = RunSegment(
            seq=seq,
            name=name,
            artifacts={"import": refusal, "files": dict.fromkeys(files or [], "")},
        )
        refused.setdefault(run.id, (run, light))
    if not refused:
        return []
    # Each segment's review: its latest checkpoint's status, nothing else.
    reviews: dict[tuple[uuid.UUID, int], Checkpoint] = {}
    for run_id, seq, status in (
        await db.execute(
            select(
                Checkpoint.run_id, Checkpoint.payload["segment_seq"].as_integer(), Checkpoint.status
            )
            .where(Checkpoint.run_id.in_(refused))
            .order_by(Checkpoint.created_at)
        )
    ).all():
        reviews[(run_id, seq)] = Checkpoint(status=status)
    runs = [run for run, _ in refused.values()]
    kinds = dict(
        (
            await db.execute(
                select(Document.id, Document.kind).where(
                    Document.id.in_({r.document_id for r in runs if r.document_id})
                )
            )
        ).all()
    )
    refs = await _refs(db, runs)
    out: list[RunSummary] = []
    for run, segment in refused.values():
        kind = _flow(run).target_kind or kinds.get(run.document_id) or "prd"
        review = reviews.get((run.id, segment.seq))
        retry = _draft_retry_refusal(run, segment, review, kind, None) is None
        out.append(
            _summary(run, refs, None).model_copy(
                update={"no_document": _no_document_text(run, refs, segment, retry)}
            )
        )
    return out


def _no_document_text(run: Run, refs: "_Refs", segment: RunSegment, retry: bool) -> str:
    """Why a run finished with no document, in plain words, and what to do."""
    name = (refs.get(run.document_id) if run.document_id else None) or (run.knobs or {}).get(
        "document_slug"
    )
    what = f"{name}" if name else f"The {_flow(run).title} run"
    imp = (segment.artifacts or {}).get("import") or {}
    why = imp.get("summary") or imp.get("error")
    action = (
        "Open the run and use Retry import once the problems are fixed, or start a new run."
        if retry
        else "Start a new run to draft it again."
    )
    return (
        f"{what} finished without a document: Oracle refused its draft ({why}) and the run "
        f"was approved past it. {action}"
    )


async def _revising(db: AsyncSession, principal: Principal) -> list[RunSummary]:
    """The Inbox's Revising rows (owner, 2026-10-20): runs whose refused draft Oracle sent
    back to the writer itself (:func:`_sent_back`), for those with that review's approver
    role or above, who would decide it otherwise. Shown only: nothing to decide, so not
    counted. Each carries ``sent_back``, the summary of what Oracle refused."""
    rows = (
        await db.execute(
            select(Run, RunSegment)
            .join(RunSegment, RunSegment.run_id == Run.id)
            .where(Run.status.not_in(FINAL), RunSegment.artifacts.has_key("import"))
            .order_by(Run.created_at, Run.id, RunSegment.seq)
        )
    ).all()
    runs: dict[uuid.UUID, Run] = {}
    leads = await engineering_leads(db) if rows else frozenset()
    for run, segment in rows:
        sdef = _flow(run).segment(segment.name)
        stop = SimpleNamespace(kind=sdef.checkpoint, approver_role=sdef.approver_role)
        if _sent_back(run, segment) and may_decide(principal, stop, run.flow, leads):
            runs.setdefault(run.id, run)
    for run_id in await _hidden_runs(db, principal, runs.values()):
        runs.pop(run_id)
    if not runs:
        return []
    refs = await _refs(db, list(runs.values()))
    segments: dict[uuid.UUID, list[RunSegment]] = {i: [] for i in runs}
    for seg in await db.scalars(
        select(RunSegment).where(RunSegment.run_id.in_(runs)).order_by(RunSegment.seq)
    ):
        segments[seg.run_id].append(seg)
    # Embedded in the Inbox: without its progress, as the Inbox's other run rows.
    return [
        _summary(r, refs, None, segments[r.id]).model_copy(update={"progress": None})
        for r in runs.values()
    ]


async def _hidden_runs(db: AsyncSession, principal: Principal, runs: Any) -> set[uuid.UUID]:
    """#541 part 5: the runs whose Inbox rows a reader who may not see approvers-only
    documents (oracle.docs.visibility.restricted: a commenter, a viewer, or a call made
    through a run that reads as a member, with its starter's cookie) is not shown: a run
    on such a document, or of a flow that writes only such documents (a pricing memo, an
    update), whose rows name it (its slug, its id)."""
    runs = list(runs)
    if not runs or not visibility.restricted(principal):
        return set()
    hidden_docs = await visibility.hidden_document_ids(db, [r.document_id for r in runs])
    only_hidden = {
        k
        for k, f in flows.FLOWS.items()
        if f.document_kinds
        and all(visibility.default_for(kind) == visibility.APPROVERS for kind in f.document_kinds)
    }
    return {r.id for r in runs if r.document_id in hidden_docs or r.flow in only_hidden}


async def inbox(db: AsyncSession, principal: Principal, mark_seen: bool = False) -> InboxOut:
    """``mark_seen``: record this visit as my last one (after reading what was new)."""
    pending = list(
        await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.status == "pending")
            .order_by(Checkpoint.created_at, Checkpoint.id)
        )
    )
    # Decisions recorded and not delivered to the run yet (shown, nothing to decide).
    owing = [
        c
        for c in await db.scalars(
            select(Checkpoint)
            .where(Checkpoint.status.in_(DECIDED), Checkpoint.payload["wait"].has_key("posting"))
            .order_by(Checkpoint.decided_at, Checkpoint.id)
        )
        if _owes(c)
    ]
    run_ids = {c.run_id for c in [*pending, *owing]}
    runs: dict[uuid.UUID, Run] = {}
    if run_ids:
        runs = {r.id: r for r in await db.scalars(select(Run).where(Run.id.in_(run_ids)))}
    # Who decides each (A3): the engineering stops go to the leads and owners once one is
    # named; the runs' flows come from the query above, the leads in one more.
    leads = await engineering_leads(db)
    hidden_runs = await _hidden_runs(db, principal, runs.values())
    mine = [
        c
        for c in pending
        if c.run_id not in hidden_runs and may_decide(principal, c, runs[c.run_id].flow, leads)
    ]
    owed = [
        c
        for c in owing
        if c.run_id not in hidden_runs and may_decide(principal, c, runs[c.run_id].flow, leads)
    ]
    names = await _decider_names(db, owed)
    staged = await _staged_actions(db, mine)
    live = await _live_reasons(db, mine)
    asked = await _open_questions(db, staged)
    owner = principal.role == "owner"
    waiting_runs: list[Run] = []
    if owner:
        waiting_runs = list(
            await db.scalars(
                select(Run)
                .where(Run.status.in_(("awaiting_approval", "paused_overrun")))
                .order_by(Run.created_at)
            )
        )
        hidden_waiting = await _hidden_runs(db, principal, waiting_runs)
        waiting_runs = [r for r in waiting_runs if r.id not in hidden_waiting]
    shown = {c.run_id for c in [*mine, *owed]}
    refs = await _refs(db, [*(r for r in runs.values() if r.id in shown), *waiting_runs])

    def item(c: Checkpoint) -> InboxCheckpoint:
        run = runs[c.run_id]
        seq = (c.payload or {}).get("segment_seq")
        sdef = _flow(run).segments[seq - 1] if seq else None
        return InboxCheckpoint(
            **_checkpoint_out(
                c,
                principal,
                names,
                flow=run.flow,
                leads=leads,
                staged=staged,
                live=live,
                open_questions=asked,
            ).model_dump(),
            flow=run.flow,  # type: ignore[arg-type]
            flow_title=_flow(run).title,
            document_slug=refs.get(run.document_id),
            segment_title=sdef.title if sdef else None,
        )

    checkpoints = [item(c) for c in mine]
    deliveries = [item(c) for c in owed]
    # D9: what each needs of me and how much, one review read each; the company-wide reads
    # and each item's trace once for them all.
    from oracle.runs import actions

    with batched():
        await actions.read_ahead(db, [c for c in mine if c.kind in actions.SUMMARIES], runs)
        for c, row in zip(mine, checkpoints, strict=True):
            row.summary = await actions.inbox_summary(
                db, c, principal, run=runs[c.run_id], console=row.console
            )

    feedback: list[InboxDocument] = []
    states: list[InboxFeedbackItem] = []
    counts = InboxCounts()
    staged: list[InboxStaged] = []
    from oracle.intake.read import inbox_due as intake_reads_due

    # INT2's intake-read rows, read below only for a reader who has one.
    seen, (has_intake_reads,) = await inbox_states.last_seen_and(
        db, principal.id, intake_reads_due(principal)
    )
    if has_role(principal.role, "approver"):
        states, counts = await inbox_states.feedback_states(db, seen)
        staged = await inbox_states.staged_rows(db)
        # Open feedback: what still needs a decision (staged, declined and done do not).
        waiting = {i.id for i in states if i.state in ("new", "open")}
        items = list(
            await db.scalars(
                select(FeedbackItem)
                .where(FeedbackItem.id.in_(waiting))
                .order_by(FeedbackItem.created_at.desc(), FeedbackItem.id)
            )
        )
        by_id = {i.id: i for i in states}
        by_doc: dict[uuid.UUID, list[FeedbackItem]] = {}
        for f in items:
            by_doc.setdefault(f.document_id, []).append(f)
        from oracle.jobs.service import latest_suggestions

        suggestion_status = {
            k: s.status for k, s in (await latest_suggestions(db, [f.id for f in items])).items()
        }
        if by_doc:
            docs = {
                d.id: d for d in await db.scalars(select(Document).where(Document.id.in_(by_doc)))
            }
            latest = dict(
                (
                    await db.execute(
                        select(DocumentVersion.document_id, func.max(DocumentVersion.number))
                        .where(DocumentVersion.document_id.in_(by_doc))
                        .group_by(DocumentVersion.document_id)
                    )
                ).all()
            )
            for doc_id, doc_items in by_doc.items():
                d = docs[doc_id]
                waits = InboxFeedbackCounts()
                for f in doc_items:
                    field = _waits_for(f, suggestion_status.get(f.id))
                    setattr(waits, field, getattr(waits, field) + 1)
                # The review panel lists items by version raised on, then age.
                first = min(
                    (f for f in doc_items if f.section_key),
                    key=lambda f: (f.raised_on_version, f.created_at, str(f.id)),
                    default=None,
                )
                feedback.append(
                    InboxDocument(
                        document_id=d.id,
                        slug=d.slug,
                        title=d.title,
                        latest_version=latest.get(d.id),
                        open_count=len(doc_items),
                        counts=waits,
                        first_section_key=first.section_key if first else None,
                        items=[by_id[f.id] for f in doc_items[:5]],
                    )
                )
            feedback.sort(key=lambda d: d.items[0].created_at, reverse=True)

    approvals = [_summary(r, refs, None) for r in waiting_runs if r.status == "awaiting_approval"]
    overruns = [_summary(r, refs, None) for r in waiting_runs if r.status == "paused_overrun"]
    revoke_failures = await _revoke_failures(db) if owner else []
    share_revocations: list[InboxShareRevocation] = []
    if owner:
        from oracle.shares.service import inbox_rows as share_rows

        share_revocations = [InboxShareRevocation.model_validate(r) for r in await share_rows(db)]
    access_failures = await _access_failures(db) if owner else []
    access_requests = await _access_requests(db, principal)
    strategy = None
    if owner:
        from oracle.strategy import drift

        row = await drift.inbox_row(db)
        strategy = InboxStrategy.model_validate(row) if row else None
    # Lost submissions past the lookup cap (Retry or Cancel), cancels past NOT_FOUND_TRIES
    # 404s (Stop cancelling), answer posts past them (Cancel), and searched workflows past
    # them (shown), by those who manage the run.
    live = Run.knobs["workflow"]["state"].astext == "live"
    managed = [
        r
        for r in await db.scalars(
            select(Run)
            .where(
                Run.knobs.has_key("stuck_lookup")
                | Run.knobs.has_key("post_404")
                | Run.knobs.has_key("searches")
                | Run.knobs.has_key("overrun_after_end")
                # A running run's wait, before any agent of its workflow started: the knob
                # stays while it runs (later steps' holds), never after it ended.
                | (
                    Run.knobs.has_key("queue_wait")
                    & (Run.status == "running")
                    & Run.knobs["queue_wait"]["started"].astext.is_distinct_from("true")
                )
                | live
            )
            .order_by(Run.created_at)
        )
        if _manages(principal, r)
    ]
    stuck_runs = [r for r in managed if _stuck(r)]
    # Submissions given up on, still looked for (shown, nothing to do): from the same read.
    searching_runs = [r for r in managed if "searches" in (r.knobs or {})]
    stuck_refs = await _refs(db, [*stuck_runs, *searching_runs])
    lookups = [_summary(r, stuck_refs, None) for r in stuck_runs]
    searches = [_summary(r, stuck_refs, None) for r in searching_runs]
    # Owners only: a run's output Oracle stopped trying to import (Retry).
    imports: list[RunSummary] = []
    if owner:
        failed_runs = [
            r
            for r in await db.scalars(
                select(Run).where(Run.knobs.has_key("import_failed")).order_by(Run.created_at)
            )
            if _import_failed(r) is not None
        ]
        failed_refs = await _refs(db, failed_runs)
        imports = [_summary(r, failed_refs, None) for r in failed_runs]
    no_documents = await _no_documents(db) if owner else []
    revising = await _revising(db, principal)
    from oracle.decisions.service import inbox_rows as decision_rows
    from oracle.reports.service import inbox_rows

    reports, report_failures = await inbox_rows(db, principal)
    decisions = await decision_rows(db, principal, seen)
    counted = sum(1 for d in decisions if d.counts)
    from oracle.launches import service as launches_service

    launch_rows = await launches_service.inbox_rows(db, principal)
    from oracle.rituals.service import inbox_rows as ritual_rows

    rituals = await ritual_rows(db, principal)
    counted += sum(1 for r in rituals if r.counts)
    from oracle.metrics.review import inbox_rows as metric_rows

    metrics = await metric_rows(db, principal)
    counted += sum(1 for m in metrics if m.counts)
    from oracle.quality.outcomes import inbox_rows as outcome_rows

    outcome_inbox = await outcome_rows(db, principal)
    # H11: what Oracle did on its own, for those it notified (open ones count).
    from oracle.autonomy_router import inbox_actions

    oracle_actions = await inbox_actions(db, principal)
    dates = await _date_rows(db, principal, leads)
    from oracle.roadmap.alerts import inbox_rows as track_rows

    track_groups = await track_rows(db, principal, seen)
    # G6: invitations, mentions and changes proposed in discussions I can read.
    from oracle.discussions import inbox as discussion_inbox

    discussions = await discussion_inbox.rows(db, principal, seen)
    # H10: replies to send, asked again, answers to my own requests.
    from oracle.requests.inbox import inbox_rows as request_rows

    request_inbox = await request_rows(db, principal)
    counted += sum(1 for r in request_inbox if r.counts)
    # INT2: intakes of mine Oracle couldn't read twice in a row.
    from oracle.intake.read import inbox_rows as intake_read_rows

    intake_reads = await intake_read_rows(db, principal) if has_intake_reads else []
    counted += len(intake_reads)
    # Simple S3a: proposals waiting for me, and the decisions on mine.
    from oracle.simple.changes import inbox_rows as simple_rows

    simple_proposals, simple_decisions = await simple_rows(db, principal, seen)
    counted += len(simple_proposals)
    # Simple S3b: versions from Simple drafts waiting for my approval as a required reviewer.
    from oracle.simple.drafts import inbox_rows as simple_approval_rows

    simple_approvals = await simple_approval_rows(db, principal, seen)
    counted += len(simple_approvals)
    # Simple S8: meeting minutes sent to me as an attendee (nothing to decide: not counted).
    from oracle.simple.meetings import inbox_rows as simple_minutes_rows

    simple_minutes = await simple_minutes_rows(db, principal, seen)
    if mark_seen:
        await inbox_states.mark_seen(db, principal.id)
        await db.commit()
    return InboxOut(
        checkpoints=checkpoints,
        # Not in ``total``: nothing to decide, Oracle delivers them on every tick.
        deliveries=deliveries,
        approvals=approvals,
        overruns=overruns,
        lookups=lookups,
        searches=searches,
        revising=revising,
        imports=imports,
        no_documents=no_documents,
        feedback=feedback,
        revoke_failures=revoke_failures,
        share_revocations=share_revocations,
        access_failures=access_failures,
        access_requests=access_requests,
        reports=reports,
        report_failures=report_failures,
        strategy=strategy,
        oracle_actions=oracle_actions,
        dates=dates,
        # Every new or open item (C1e, owner 2026-10-20): the rail badge, = New + Open.
        total=len(checkpoints)
        + len(dates)
        + len(approvals)
        + len(overruns)
        + len(lookups)
        + len(imports)
        + len(no_documents)
        + counts.new
        + counts.open
        + len(revoke_failures)
        + len(share_revocations)
        + len(access_failures)
        # Pending access requests (A5), for those who may approve them.
        + len(access_requests)
        + sum(1 for r in reports if not r.read)
        + len(report_failures)
        # Strategy drift: one row, however many findings.
        + (1 if strategy else 0)
        + sum(1 for r in launch_rows if r.counted)
        + sum(1 for r in outcome_inbox if r.counts)
        + sum(a.counts for a in oracle_actions)
        + sum(1 for r in discussions if r.state in ("new", "open"))
        # A track is one row, its open alerts its children (#514: as a checkpoint's items).
        + sum(1 for t in track_groups if t.counts.new + t.counts.open > 0)
        + counted,
        tracks=track_groups,
        launches=launch_rows,
        rituals=rituals,
        metrics=metrics,
        outcomes=outcome_inbox,
        items=states,
        counts=counts,
        staged=staged,
        decisions=decisions,
        needs_me=counts.new + counts.open + counted,
        last_seen_at=seen,
        discussions=discussions,
        requests=request_inbox,
        intake_reads=intake_reads,
        simple_proposals=simple_proposals,
        simple_decisions=simple_decisions,
        simple_approvals=simple_approvals,
        simple_minutes=simple_minutes,
    )


async def _access_requests(db: AsyncSession, principal: Principal) -> list[InboxAccessRequest]:
    """Pending access requests, oldest first, for callers who may approve them (A5)."""
    from oracle.members import access
    from oracle.members.models import AccessRequest

    roles = list(access.invite_roles(principal))
    preset = await access.preset_role(db, principal)
    if preset is None:
        return []
    rows = await db.scalars(
        select(AccessRequest)
        .where(AccessRequest.status == "pending")
        .order_by(AccessRequest.created_at, AccessRequest.id)
    )
    return [
        InboxAccessRequest(
            id=r.id, email=r.email, note=r.note, requested_at=r.created_at,
            last_seen_at=r.last_seen_at, default_role=preset, roles=roles,
        )
        for r in rows
    ]  # fmt: skip


async def _access_failures(db: AsyncSession) -> list[InboxAccessFailure]:
    """IAP access changes still failing after 24 hours (#245): marked failed, retried
    once a day; done or no longer needed closes them."""
    from oracle.members.models import MemberFollowUp
    from oracle.members.service import ACCESS_KINDS

    rows = await db.scalars(
        select(MemberFollowUp)
        .where(MemberFollowUp.kind.in_(ACCESS_KINDS), MemberFollowUp.status == "failed")
        .order_by(MemberFollowUp.created_at, MemberFollowUp.id)
    )
    return [
        InboxAccessFailure(
            id=row.id,
            kind=row.kind,  # type: ignore[arg-type]
            email=row.email or "",
            owed="Access not removed" if row.kind == "iap_revoke" else "Access not granted",
            last_error=row.last_error,
            attempts=row.attempts,
            created_at=row.created_at,
            next_attempt_at=row.next_attempt_at,
        )
        for row in rows
    ]


async def _revoke_failures(db: AsyncSession) -> list[InboxRevokeFailure]:
    """Provider revokes a disable still owes whose last attempt did not revoke."""
    from oracle.auth.models import User
    from oracle.connections.providers import get_provider
    from oracle.members.models import MemberFollowUp
    from oracle.members.service import CALL_DONE, FOLLOW_UP_OPEN, FOLLOW_UP_RETRY_WINDOW

    rows = (
        await db.execute(
            select(MemberFollowUp, User.email)
            .outerjoin(User, User.id == MemberFollowUp.member_id)
            .where(
                MemberFollowUp.kind == "provider_revoke",
                MemberFollowUp.status.in_(FOLLOW_UP_OPEN),
                MemberFollowUp.attempts > 0,
                # Revoked, only the saving of it failed: done at the next attempt.
                or_(MemberFollowUp.outcome.is_(None), MemberFollowUp.outcome.not_in(CALL_DONE)),
            )
            .order_by(MemberFollowUp.created_at, MemberFollowUp.id)
        )
    ).all()
    out = []
    for row, email in rows:
        provider = get_provider(row.provider or "")
        name = provider.name if provider else (row.provider or "the provider")
        out.append(
            InboxRevokeFailure(
                id=row.id,
                member_id=row.member_id,
                member_email=email,
                provider=row.provider,
                provider_name=name,
                title=f"Couldn't revoke {email or 'a removed member'}'s {name} access at {name}",
                status=row.status,  # type: ignore[arg-type]
                outcome=row.outcome,
                last_error=row.last_error,
                attempts=row.attempts,
                created_at=row.created_at,
                next_attempt_at=row.next_attempt_at,
                retry_until=row.created_at + FOLLOW_UP_RETRY_WINDOW,
            )
        )
    return out
