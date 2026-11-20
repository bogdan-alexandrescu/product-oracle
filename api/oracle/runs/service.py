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

from sqlalchemy import ColumnElement, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import company_time, wording
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.baseline.models import Proposal
from oracle.claude_accounts.pool import readable_refusal
from oracle.decisions import capture as decisions_capture  # noqa: F401
from oracle.docs import service as docs_service
from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.docs.parser import is_uuid
from oracle.docs.schemas import VersionSource
from oracle.engineering import check as eng_check
from oracle.members.leads import (
    ENGINEERING_KINDS,
    SPEC_FLOW,
    engineering_leads,
    lead_stop,
    may_decide,
)
from oracle.priorities.schemas import PriorityCheck
from oracle.review import inbox as inbox_states  # noqa: F401
from oracle.runs import (
    apply_edits,
    feature_set,
    flows,
    gate,
    review_link,
    review_text,
    stop_answers,
    workflow,
)
from oracle.runs.models import Checkpoint, CheckpointAction, Run, RunSegment
from oracle.runs.schemas import (
    AgentRoleOut,
    CheckpointDelivery,
    CheckpointOut,
    ConsoleAnswer,
    DraftImport,
    FeatureSetCheck,
    FlowCatalog,
    FlowOut,
    FlowSegmentOut,
    FlowStart,
    Gate,
    ItemsCheck,
    KnobsOut,
    NeedsAgents,
    PrdScopeOut,
    PreviousAttempt,
    RunDecision,
    RunDecisionAnswer,
    RunNoteRefs,
    RunOut,
    RunProgress,
    RunSummary,
    SegmentAgent,
    SegmentAttempt,
    SegmentOut,
    TargetFeature,
    TargetGoal,
)
from oracle.sources.models import Snapshot
from oracle.swarm import (
    get_runtime,
    load_learned,
    redact,  # noqa: F401
)
from oracle.v2.models import StakeholderQuestion

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
    # qa-company-17: each document's own title, so a run is named as its document's page
    # names it ("Investor update · October 2026"), not by its slug in words.
    titles: dict[uuid.UUID, str] = field(default_factory=dict)
    # A run whose new document is not imported yet (a brief's Draft with Oracle) is named
    # by the title the person typed on its brief, the one the import gives the document:
    # never by its slug in words. By run id.
    pending: dict[uuid.UUID, str] = field(default_factory=dict)

    def get(self, document_id: uuid.UUID | None) -> str | None:
        return self.slugs.get(document_id) if document_id else None

    def title(self, run: Run) -> str | None:
        """The run's document's title: its own, or the brief's before the import."""
        if run.document_id:
            return self.titles.get(run.document_id)
        return self.pending.get(run.id)


def _source_id(run: Run) -> uuid.UUID | None:
    raw = (run.knobs or {}).get("source_version_id")
    return uuid.UUID(raw) if raw else None


async def _refs(
    db: AsyncSession, runs: list[Run], segments: list[RunSegment] | None = None
) -> _Refs:
    ids = {r.document_id for r in runs if r.document_id}
    slugs: dict[uuid.UUID, str] = {}
    kinds: dict[uuid.UUID, str] = {}
    titles: dict[uuid.UUID, str] = {}
    if ids:
        rows = await db.execute(
            select(Document.id, Document.slug, Document.kind, Document.title).where(
                Document.id.in_(ids)
            )
        )
        for doc_id, slug, kind, title in rows.all():
            slugs[doc_id], kinds[doc_id], titles[doc_id] = slug, kind, title
    sources = await docs_service.version_sources(db, [_source_id(r) for r in runs])
    zone = (
        await company_time.company_time_zone(db)
        if any(r.error for r in runs) or any(s.error for s in segments or [])
        else company_time.DEFAULT_ZONE
    )
    return _Refs(slugs, kinds, sources, zone, titles, await _pending_titles(db, runs))


async def _pending_titles(db: AsyncSession, runs: list[Run]) -> dict[uuid.UUID, str]:
    """By run id: the brief's title of each run started from a brief whose document is
    not imported yet (:func:`_intake_title`, the title the import gives it)."""
    from oracle.v2.models import ProductIntake

    wanted: dict[uuid.UUID, uuid.UUID] = {}
    for r in runs:
        raw = None if r.document_id else (r.knobs or {}).get("intake_id")
        if raw and is_uuid(str(raw)):
            wanted[r.id] = uuid.UUID(str(raw))
    if not wanted:
        return {}
    rows = await db.execute(
        select(ProductIntake.id, ProductIntake.title).where(
            ProductIntake.id.in_(set(wanted.values()))
        )
    )
    titles: dict[uuid.UUID, str] = {i: t for i, t in rows.all()}
    return {run_id: titles[i] for run_id, i in wanted.items() if titles.get(i)}


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
        document_title=refs.title(run),
        document_kind=(refs.kinds.get(run.document_id) if run.document_id else None)
        or flow.target_kind,  # type: ignore[arg-type]
        source=refs.sources.get(source_id) if source_id else None,
        template=run.knobs.get("template"),
        theme=run.knobs.get("theme"),
        roadmap_read=run.knobs.get("roadmap_read"),
        estimate_usd=_usd(run.estimate_usd),
        spent_usd=_usd(run.spent_usd),
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
        # ITEM 11: the agents' text the review shows, read plainly (oracle.runs.review_text).
        payload=review_text.review_payload(cp.kind, payload),
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
        # A priority order's stale-goal problem is read as of now too: gone once its goal
        # is back (kept on the checkpoint, so the gate reads the refreshed check).
        await _recheck_order_goals(db, c, add=False)
        if c.status == "pending" and c.kind in gate.LIVE_KINDS:
            out[c.id] = await from_run.gate_reasons(db, c.run_id)
    return out


async def recheck_briefs(
    db: AsyncSession,
    run: Run,
    checkpoints: list[Checkpoint],
    segments: list[RunSegment] | None = None,
    *,
    persist: bool = False,
) -> None:
    """The pending Engineering checks of ``checkpoints`` (of ``run``) as the rules now are
    (:func:`oracle.engineering.check.refresh`). The one source of a check's problems:
    every reader goes through it (the run, the review and its gate, the Inbox, each
    approve path), so the problems a stop shows are the ones its Approve counts.
    ``persist`` false (a read) keeps the new check in memory."""
    if not any(c.kind == eng_check.KIND and c.status == "pending" for c in checkpoints):
        return
    if segments is None:
        segments = await _segments(db, run.id)
    await eng_check.refresh(db, run, segments, checkpoints, persist=persist)


async def approve_gate_of(db: AsyncSession, cp: Checkpoint) -> Gate | None:
    """The approve gate of ``cp`` now (D3): its blocking reasons and staged actions."""
    if cp.kind == eng_check.KIND:
        # An approval (the decide route, a console's) counts the check as the rules now
        # are, stored with the decision, as the stop's page reads it.
        await recheck_briefs(db, await _get_run(db, cp.run_id), [cp], persist=True)
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
    proposals: tuple[int, datetime | None] = (0, None),
    can_retry: bool = False,
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
        cost_usd=_usd(segment.cost_usd),
        workflow_id=segment.swarm_workflow_id,
        artifacts=sorted((art.get("files") or {}).keys()),
        attempts=[SegmentAttempt(**a) for a in art.get("attempts") or []],
        draft_import=DraftImport(**imp) if imp else None,
        sent_back=_sent_back(run, segment),
        reused=art.get("reused") if segment.status == "skipped" else None,
        note=art.get("note") if segment.status == "skipped" or art.get("reused_items") else None,
        can_retry_draft_import=can_retry_draft_import,
        can_retry=can_retry,
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
        agents=[_agent_out(a, proposals[1]) for a in progress.get("agents") or []],
        checked_at=progress.get("checked_at"),
        proposals_written=proposals[0] if progress else 0,
        queue_wait=_queue_wait_out(run, segment.seq) if segment.status == "running" else None,
    )


def _agent_out(agent: dict[str, Any], proposed_at: datetime | None) -> SegmentAgent:
    """run-progress: a running agent with the latest evidence of its work: its heartbeat,
    the runtime's last event on its task, or the run's last proposal written since it
    started, whichever is latest."""
    out = SegmentAgent(**agent)
    if proposed_at is not None and out.started_at is not None and proposed_at < out.started_at:
        proposed_at = None  # written before this agent started
    signs = [(out.heartbeat_at, "heartbeat"), (out.event_at, "event"), (proposed_at, "proposals")]
    seen = [(at, what) for at, what in signs if at is not None]
    if seen:
        out.last_work_at, out.last_work = max(seen, key=lambda s: s[0])  # type: ignore[assignment]
    return out


# D11: how a decision reads for the run's agents and on the run page.
CHECKPOINT_TITLES = {
    "baseline_confirm": "Ground Truth",
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


def _record_decider(
    cp: Checkpoint, role: str | None, via: str, by: uuid.UUID | str | None = None
) -> None:
    """Who decided ``cp``: their role, the member or token (``by``, named when the list
    is read) and where (:func:`list_decisions`); kept on the checkpoint as it is decided,
    so a later change of the member's role does not alter what the run's agents read."""
    mark = {"role": role, "via": via, "by": str(by) if by else None}
    cp.payload = {**copy.deepcopy(cp.payload or {}), "decided": mark}


def _decider_of(cp: Checkpoint) -> uuid.UUID | None:
    """The member or token :func:`list_decisions` names for ``cp``: the one kept with its
    role; for a decision recorded before that, who decided it, except a confirmed console
    answer (its confirmer is not its author)."""
    payload = cp.payload or {}
    mark = payload.get("decided")
    if isinstance(mark, dict) and "by" in mark:
        try:
            return uuid.UUID(mark["by"]) if mark["by"] else None
        except (TypeError, ValueError):
            return None
    console = ((payload.get("wait") or {}).get("console")) or {}
    if isinstance(console, dict) and console.get("confirmed_by"):
        return None
    return cp.decided_by


def decision_summary(
    kind: str,
    status: str,
    role: str | None,
    via: str,
    note: str | None,
    delivered: bool,
    name: str | None = None,
) -> str:
    """One line: "Feature set · approved by Ana Example, an approver · note: Keep bulk
    import out"; the role alone when nobody is named."""
    what = status.replace("_", " ")
    article = f"{'an' if role and role[0] in 'aeiou' else 'a'} {role}" if role else None
    if name:
        what += f" by {name}, {article}" if article else f" by {name}"
    elif article:
        what += f" by {article}"
    if via == "swarmcloud_console":
        what += " in SwarmCloud's console"
    parts = [CHECKPOINT_TITLES.get(kind, kind), what]
    if note:
        parts.append(f"note: {note}")
    if not delivered:
        parts.append("not delivered to the run yet")
    return " · ".join(parts)


async def _people_named(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """Who decided, as the decisions list names them: a member's name, else their email
    (a personal API token decides as its member); a service token's name."""
    if not ids:
        return {}
    rows = (await db.execute(select(User.id, User.name, User.email).where(User.id.in_(ids)))).all()
    out: dict[uuid.UUID, str] = {i: (name or "").strip() or email for i, name, email in rows}
    if rest := ids - set(out):
        out.update(
            (
                await db.execute(select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(rest)))
            ).all()
        )
    return out


async def list_decisions(
    db: AsyncSession, run_id: uuid.UUID, principal: Principal
) -> list[RunDecision]:
    """Every decided checkpoint of the run, by segment then decided time (pending ones,
    a console answer held for an approver included, are not decisions yet). A run's own
    call reads its own run only."""
    if principal.run_id is not None and principal.run_id != run_id:
        raise NotFound(f"run {run_id} not found")
    run = await _get_run(db, run_id)
    return (await decisions_of_runs(db, [run]))[run.id]


async def decisions_of_runs(
    db: AsyncSession, runs: list[Run]
) -> dict[uuid.UUID, list[RunDecision]]:
    """:func:`list_decisions` of runs the caller has read and may see, in one read of their
    checkpoints, roles and names for all of them (Simple › Decisions' Runs group)."""
    flows_of = {r.id: _flow(r) for r in runs}
    decided = [c for c in await _checkpoints(db, list(flows_of)) if c.status in _LISTED]
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
    by = {cp.id: _decider_of(cp) for cp in decided}
    people = await _people_named(db, {i for i in by.values() if i})
    answered = await stop_answers.of_checkpoints(db, {r.id: r for r in runs}, decided)
    out: dict[uuid.UUID, list[RunDecision]] = {i: [] for i in flows_of}
    for cp in decided:
        flow = flows_of[cp.run_id]
        payload = cp.payload or {}
        who = people.get(by[cp.id]) if by[cp.id] else None
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
        out[cp.run_id].append(
            RunDecision(
                checkpoint_id=cp.id,
                kind=cp.kind,  # type: ignore[arg-type]
                segment_seq=seq,
                segment_title=title,
                attempt=payload.get("attempt"),
                status=cp.status,  # type: ignore[arg-type]
                decided_at=cp.decided_at,
                decided_by_role=role,
                decided_by_name=who,
                via=via,
                note=cp.note,
                edits=extra.get("edits"),
                review=cp.review or extra.get("review"),
                delivered=delivered,
                summary=decision_summary(cp.kind, cp.status, role, via, cp.note, delivered, who),
                answers=[
                    RunDecisionAnswer(
                        question=a.question,
                        answer=a.answer,
                        feature_key=a.feature_key,
                        feature_title=a.feature_title,
                        answered_by_name=a.by_name,
                        answered_at=a.at,
                    )
                    for a in answered.get(cp.id, [])
                ],  # fmt: skip
            )
        )
    far = datetime.max.replace(tzinfo=UTC)
    for lst in out.values():
        lst.sort(key=lambda d: (d.segment_seq or 0, d.decided_at or far))
    return out


async def _proposals_since(
    db: AsyncSession, run: Run, segments: list[RunSegment]
) -> tuple[int, datetime | None]:
    """run-progress: the proposals the run wrote since its running segment started, and
    when the last was written: evidence that its agents work."""
    running = next((s for s in segments if s.status == "running"), None)
    if running is None:
        return 0, None
    q = select(func.count(), func.max(Proposal.created_at)).where(Proposal.run_id == run.id)
    if running.started_at is not None:
        q = q.where(Proposal.created_at >= running.started_at)
    count, last = (await db.execute(q)).one()
    return int(count or 0), last


async def read_run(db: AsyncSession, run_id: uuid.UUID, principal: Principal | None) -> RunOut:
    run = await _get_run(db, run_id)
    segments = await _segments(db, run.id)
    checkpoints = await _checkpoints(db, [run.id])
    # A run already waiting at the Engineering check reads as the rules now are: its
    # briefs checked again (kept in its segment), no rerun. In memory only: a read (a
    # read-only token's too) writes nothing; deciding the stop stores it.
    await recheck_briefs(db, run, checkpoints, segments)
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
    failed_seq = _retryable_seq(run, segments) if principal and _manages(principal, run) else None
    version = _run_version(segments, checkpoints)
    proposed = await _proposals_since(db, run, segments)
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
    summary = _summary(
        run, refs, waiting, segments, next((c for c in checkpoints if _owes(c)), None)
    )
    summary.can_decide = (
        waiting is not None
        and principal is not None
        and may_decide(principal, waiting, run.flow, leads)
    )
    return RunOut(
        **summary.model_dump(),
        knobs=KnobsOut(
            depth=knobs.depth,  # type: ignore[arg-type]
            roles=knobs.roles,
            checkpoints=knobs.checkpoints,
            budget_usd=_usd(knobs.budget_usd),
            reuse_baseline=(run.knobs or {}).get("reuse_baseline") or None,
            goals=[TargetGoal(**g) for g in (run.knobs or {}).get("target_goals") or []],
            features=[TargetFeature(**f) for f in (run.knobs or {}).get("target_features") or []],
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
                proposals=proposed if s.status == "running" else (0, None),
                can_retry=s.seq == failed_seq,
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
    principal = visibility.principal_of(db)
    leads = await engineering_leads(db) if principal is not None and pending else frozenset()
    out = []
    for r in runs:
        row = _summary(r, refs, pending.get(r.id), segments[r.id], owed.get(r.id))
        cp = pending.get(r.id)
        if cp is not None and principal is not None:
            row.can_decide = may_decide(principal, cp, r.flow, leads)
        out.append(row)
    return out


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
