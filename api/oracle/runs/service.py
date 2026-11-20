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
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any

from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy, company_time, confidence, safe_yaml, webhooks, wording
from oracle.auth.deps import Principal
from oracle.auth.models import ApiToken, User
from oracle.authz import has_role
from oracle.baseline import fixes, yaml_io
from oracle.baseline.goals import target_words
from oracle.baseline.models import Edge, Entity, Proposal
from oracle.claude_accounts.pool import readable_refusal
from oracle.decisions import capture as decisions_capture  # noqa: F401
from oracle.docs import draft_checks, visibility, written
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.parser import DraftError, is_uuid
from oracle.docs.schemas import ImportProblem, VersionSource
from oracle.engineering import check as eng_check
from oracle.engineering import dates as eng_dates
from oracle.errors import exception_text
from oracle.jobs.models import LlmSuggestion
from oracle.members.leads import (
    ENGINEERING_KINDS,
    SPEC_FLOW,
    engineering_leads,
    lead_stop,
    may_decide,
)
from oracle.priorities import run_order
from oracle.priorities import service as priorities_service
from oracle.priorities.models import PrioritySnapshot
from oracle.priorities.schemas import PriorityCheck
from oracle.review import inbox as inbox_states  # noqa: F401
from oracle.review.models import FeedbackItem
from oracle.review.schemas import Resolution
from oracle.review.service import locked_section_keys
from oracle.roadmap import company as roadmap_company
from oracle.roadmap import schedule
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
    review_text,
    roadmap,
    stop_answers,
    workflow,
)
from oracle.runs import resolutions as answers
from oracle.runs.batch import once
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
    ItemsCheck,
    KnobsIn,
    KnobsOut,
    NeedsAgents,
    PrdScopeOut,
    PreviousAttempt,
    RunCreate,
    RunDecision,
    RunDecisionAnswer,
    RunNoteRefs,
    RunOut,
    RunPatch,
    RunProgress,
    RunSummary,
    SegmentAgent,
    SegmentAttempt,
    SegmentEstimate,
    SegmentOut,
    TargetFeature,
    TargetGoal,
)
from oracle.runs.scope_models import PrdScope
from oracle.runtokens import revoke_run_tokens
from oracle.sources.models import Snapshot
from oracle.swarm import (
    AgentRuntime,
    RuntimeUnavailable,
    get_runtime,
    load_learned,
    redact,  # noqa: F401
)
from oracle.swarm.runtime import NOT_YET, not_reached
from oracle.swarm.settings import (
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


def _about(estimate: Decimal | float | None) -> str:
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
    if source is not None and source[0].id in await roadmap_company.replaced_prd_ids(db):
        # one-roadmap-many-prds: a replaced PRD is read-only and feeds no roadmap.
        raise Invalid(f"{source[0].title} is replaced: run its replacing PRDs instead")
    company_roadmap = await roadmap_company.active(db) if flow.target_kind == "roadmap" else None
    if source is not None and inputs.document is None and company_roadmap is not None:
        # one-roadmap-many-prds: every PRD's run writes the company roadmap's next version.
        default_slug = company_roadmap.slug
    elif source is not None and inputs.document is None:
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
        raise Invalid(exception_text(exc)) from exc


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
        raise RunError(f"A Ground Truth build is already under way (run {under_way})")


class NotReusable(RunError):
    """409 ``baseline_not_reusable``: the current baseline may not be reused (C4)."""

    def __init__(self, reason: str | None) -> None:
        super().__init__(f"the current Ground Truth is not reusable ({reason})")
        self.detail = {"code": "baseline_not_reusable", "reason": reason}


async def _reuse_knob(db: AsyncSession, flow: flows.FlowDef) -> dict[str, Any]:
    """The ``reuse_baseline`` knob for a run asking to reuse the current baseline: the
    review it reuses. 422 off Baseline to PRD; 409 when not reusable."""
    if flow.key != "baseline_to_prd":
        raise Invalid(f"the {flow.title} flow does not reuse the Ground Truth")
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
    extra.pop("target_features", None)
    if features := await _target_features(db, flow, body.knobs.features):
        extra["target_features"] = features
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
            raise Invalid(exception_text(exc)) from exc
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
        raise Invalid("only a Ground Truth to PRD run names the goals it serves")
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


async def _target_features(
    db: AsyncSession, flow: flows.FlowDef, refs: list[str] | None
) -> list[dict[str, str]]:
    """The ``target_features`` knob ("Add it to a PRD"): each named Ground Truth feature
    (key or id, not rejected), once, in the order named. Only a Baseline to PRD run adds
    features to its PRD."""
    if not refs:
        return []
    if flow.key != "baseline_to_prd":
        raise Invalid("only a Ground Truth to PRD run adds features to its PRD")
    refs = list(dict.fromkeys(r.strip() for r in refs))
    ids = [uuid.UUID(r) for r in refs if is_uuid(r)]
    rows = (
        await db.scalars(
            select(Entity).where(
                Entity.type == "feature",
                Entity.status != "rejected",
                or_(Entity.key.in_(refs), Entity.id.in_(ids)),
            )
        )
    ).all()
    found = {e.key: e for e in rows} | {str(e.id): e for e in rows}
    if any(r not in found for r in refs):
        # A key a feature had before it joined (its code is its key now) still names it.
        aliases = {k: v for k, v in (await fixes.former_keys(db, live=True)).items()
                   if k in refs and k not in found}  # fmt: skip
        for key, fid in aliases.items():
            feature = await db.get(Entity, fid)
            if feature is not None and feature.type == "feature" and feature.status != "rejected":
                found[key] = feature
    missing = [r for r in refs if r not in found]
    if missing:
        raise Invalid(f"not a Ground Truth feature: {', '.join(missing)}")
    features = list({found[r].id: found[r] for r in refs}.values())
    return [{"id": str(f.id), "key": f.key, "title": f.title} for f in features]


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
            or k in ("reuse_baseline", "target_goals", "target_features", "reuse_draft_items")
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
    if body.knobs is not None and body.knobs.features is not None:
        oracle.pop("target_features", None)
        if features := await _target_features(db, flow, body.knobs.features):
            oracle["target_features"] = features
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
            note = f"Current Ground Truth, approved {reuse.short_date(reused['approved_at'], zone)}"
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
    note = f"Reused the Ground Truth approved {reuse.short_date(reused['approved_at'], zone)}"
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
    run_items = None
    if (
        run.flow == "prd_to_roadmap"
        and segment.name == "roadmap_draft"
        and (items_text := prior.get(ITEMS_FILE))
    ):
        # roadmap-plan-tables: the checkpoint's check of the file (kept by
        # oracle.runs.roadmap), not a second parse in the prompt.
        run_items = (await items_check(db, run, items_text)).items
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
    # A PRD writer reads each stop's note in its decided block, with the stop's name, who
    # decided and the decision record (stop_answers.prompt_lines).
    notes = [
        f"{c.kind}: {c.note}"
        for c in await _checkpoints(db, [run.id])
        if c.status == "approved" and c.note and not (hidden and hidden.names(c.note))
        and segment.name not in stop_answers.WRITERS
    ]  # fmt: skip
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
    # SwarmCloud reaches Oracle only through the credential it attaches; the local
    # runtime's agents are Oracle's own.
    mcp_reachable = attached or (runtime.can_reach_oracle and runtime.name != "swarmcloud")
    return flows.PromptContext(
        run_id=str(run.id),
        document=document,
        snapshot_as_of=snapshot.as_of.isoformat() if snapshot else None,
        low_confidence=await _low_threshold(db),
        depth=knobs.depth,
        prior_outputs=prior,
        run_items=run_items,
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
        mcp_reachable=mcp_reachable,
        mcp_attached=attached,
        prior_files=prior_files,
        kind=kind,
        source=source,
        loop_plan=await _loop_plan_inputs(db, run)
        if kind == "roadmap"
        and run.flow != "prd_to_roadmap"
        and _flow(run).segment(segment.name).imports_draft
        else None,
        draft=draft_ctx,
        extra_lines=[
            *await extensions.prompt_lines(db, run),
            *await eng_check.prompt_lines(db, run.id, segment.name),
            *await stop_answers.prompt_lines(db, run, segment.name, segment.seq, hidden),
            *(
                await eng_check.run_architect_lines(db, run, mcp_reachable=mcp_reachable)
                if flows.BRIEFS_FILE in _flow(run).segment(segment.name).outputs
                else []
            ),
            *await eng_dates.prompt_lines(db, run, segment.name),
            *await _roadmap_lines(db, run, segment.name, kind, hidden),
            *_regenerate_note(run, hidden),
            *await _carried_lines(db, run, segment.name),
        ],
        intake_id=run.knobs.get("intake_id"),
        intake_gap_ids=list(run.knobs.get("intake_gap_ids") or []),
        scope_yaml=scope_yaml,
        launch_id=run.knobs.get("launch_id"),
        target_goals=[(g["key"], g["title"]) for g in run.knobs.get("target_goals") or []],
        target_features=[(f["key"], f["title"]) for f in run.knobs.get("target_features") or []],
        discussions=discussions,
        baseline_reused=reuse.short_date(
            reused["approved_at"], await company_time.company_time_zone(db)
        )
        if (reused := run.knobs.get("reuse_baseline")) and segment.name != "baseline"
        else None,
    )


async def _roadmap_lines(
    db: AsyncSession, run: Run, segment: str, kind: str | None, hidden: Any
) -> list[str]:
    """prd-reads-working-draft: a PRD's run follows the company roadmap of record (its
    working draft when newer than the published version; oracle.simple.roadmap_of_record)
    and keeps the words saying which one it read (``roadmap_read``, the run page's)."""
    from oracle.simple import roadmap_of_record

    if run.flow not in roadmap_of_record.FLOWS or segment not in roadmap_of_record.SEGMENTS:
        return []
    if kind != "prd":
        return []
    # The draft is read by its own rule (oracle.simple.drafts.sees): the run reads it when
    # the person who started the run may see it (the owner always may), else the published
    # version; a run nobody started (Oracle's own) has nobody who may see it, so it reads
    # the published version.
    record = await roadmap_of_record.read(db, reader=run.created_by)
    if record is None:
        return []
    # Each step keeps the roadmap it read (``roadmap_read_by``); ``roadmap_read`` is the
    # last step's, the one the run page shows.
    knobs = dict(run.knobs or {})
    by_step = {**(knobs.get("roadmap_read_by") or {}), segment: record.label}
    if knobs.get("roadmap_read") != record.label or knobs.get("roadmap_read_by") != by_step:
        run.knobs = {**knobs, "roadmap_read": record.label, "roadmap_read_by": by_step}
    return roadmap_of_record.prompt_lines(record, run.document_id, hidden)


async def _carried_lines(db: AsyncSession, run: Run, segment: str) -> list[str]:
    """The PRD writer's carried inputs, when the run's brief replaces a PRD."""
    if segment != "prd_draft":
        return []
    from oracle.intake import carried

    got = await carried.of_run(db, run)
    return carried.prompt_lines(got) if got is not None else []


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
    frozen = (
        await _frozen_queue(db, run, version)
        if run.flow == "prd_to_roadmap"
        else {"rows": [], "per_week": None, "today": None}
    )
    return flows.SourceContext(
        approved=version.approved_at is not None or not _flow(run).stores_draft_items,
        known_items=known,
        known_from=known_from,
        horizons=await _run_horizons(db, run),
        schedule_bases=[b.as_json() for b in bases],
        company_queue=frozen["rows"],
        company_plan={k: v for k, v in frozen.items() if k != "rows"},
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


async def _frozen_queue(
    db: AsyncSession, run: Run, source: DocumentVersion | None
) -> dict[str, Any]:
    """one-roadmap-many-prds: the shared queue this run reads (oracle.roadmap.company
    .frozen_queue), stored on the run when its first prompt (the roadmap_items segment's)
    is built, before the run writes its items file; that prompt, the roadmap draft's, every
    rewrite after a refusal and the check read that copy, though other PRDs' runs land or
    the team's capacity changes meanwhile. ``source``: the run's PRD version."""
    frozen = (run.knobs or {}).get(COMPANY_QUEUE)
    if isinstance(frozen, dict) and isinstance(frozen.get("rows"), list):
        return frozen
    frozen = await roadmap_company.frozen_queue(
        db, source.document_id if source else None, run.created_at, source
    )
    _set_knob(run, COMPANY_QUEUE, frozen)
    await db.flush()
    return frozen


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
        "read_artifacts",
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
    run.spent_usd = _known_sum(s.cost_usd for s in segments)


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
                "cost_usd": None,
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


async def _loop_plan_inputs(
    db: AsyncSession, run: Run
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """What a roadmap draft without an items file of its own (the feedback loop's next
    draft, the owner Nov 4) builds its plan tables from, as the roadmap was when the run
    started (so the brief and the check read the same): (its latest items of the PRD its
    latest version came from, as an items file's entries; that PRD's verified bases; on the
    company roadmap, the shared queue with the other PRDs' items, as it stands: a loop draft
    neither adds nor moves items, and its import carries them forward in their places; the
    items an approved version took off the plan, shipped or moved to the next PRD, whose
    plan_state carry_forward keeps: {key, title, state}, so the tables show them with their
    status and a draft that keeps their rows is not refused). A roadmap with no items (or
    no document) gives an empty plan: its loop draft still needs both tables, empty."""
    from oracle.roadmap import draft_items
    from oracle.roadmap.models import RoadmapItem

    doc = await db.get(Document, run.document_id) if run.document_id else None
    if doc is None:
        return [], [], [], []
    latest = await db.scalar(
        select(DocumentVersion)
        .where(
            DocumentVersion.document_id == doc.id,
            DocumentVersion.created_at <= run.created_at,
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    source = (
        await db.get(DocumentVersion, latest.source_version_id)
        if latest is not None and latest.source_version_id
        else None
    )
    prd_id = source.document_id if source is not None else None
    version = await roadmap_company._items_version(db, doc.id, run.created_at)
    rows: list[RoadmapItem] = []
    kept: list[dict[str, Any]] = []
    if version is not None:
        replaced = await roadmap_company.replaced_prd_ids(db)
        for r in await db.scalars(
            select(RoadmapItem)
            .where(RoadmapItem.roadmap_version_id == version.id)
            .order_by(RoadmapItem.position)
        ):
            if r.prd_document_id in replaced:
                continue
            if r.plan_state is None:
                rows.append(r)
            else:
                kept.append({"key": r.item_key, "title": r.title, "state": r.plan_state})
    queued: list[dict[str, Any]] = []
    if doc.company_roadmap:
        # The other PRDs' items are in the tables as the queue has them.
        rows = [r for r in rows if r.prd_document_id == prd_id]
        queued = await roadmap_company.run_queue(db, prd_id, run.created_at)
    bases = [b.as_json() for b in await schedule.verified_bases(db, prd_id)]
    return draft_items.entries(rows), bases, queued, kept


async def _plan_table_problems(
    db: AsyncSession, run: Run, markdown: str, source_id: uuid.UUID | None
) -> list[ImportProblem]:
    """The draft's plan tables against the run's engineering dates (oracle.runs.plan_tables):
    the items file the roadmap_items segment wrote and the source PRD's verified bases;
    any other run's roadmap draft (the feedback loop): the roadmap's own items."""
    from oracle.runs import plan_tables

    if run.flow != "prd_to_roadmap":
        items, loop_bases, queued, kept = await _loop_plan_inputs(db, run)
        loop_plan = plan_tables.engineering_plan(items, loop_bases, others=queued, kept=kept)
        return plan_tables.check(
            markdown, loop_plan, await company_time.company_today(db), loop=True
        )
    text = None
    for seg in await db.scalars(
        select(RunSegment).where(RunSegment.run_id == run.id).order_by(RunSegment.seq)
    ):
        files = (seg.artifacts or {}).get("files") or {}
        text = files.get(plan_tables.ITEMS_FILE, text)
    # The checkpoint's check of the file (kept by oracle.runs.roadmap): never parsed again.
    items = (await items_check(db, run, text)).items if text else None
    source = await db.get(DocumentVersion, source_id) if source_id else None
    bases = await schedule.verified_bases(db, source.document_id if source else None)
    # one-roadmap-many-prds: the other PRDs' items on the company roadmap are in the tables
    # too, from the queue the run froze when its first prompt (roadmap_items) was built.
    frozen = await _frozen_queue(db, run, source)
    others = roadmap_company.with_run_items(
        frozen["rows"], items, **{k: v for k, v in frozen.items() if k != "rows"}
    )
    plan = plan_tables.engineering_plan(items, [b.as_json() for b in bases], others=others)
    today = frozen["today"]
    day = date.fromisoformat(today) if today else await roadmap_company.run_day(db, run.created_at)
    return plan_tables.check(markdown, plan, day)


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


async def _work_problems(db: AsyncSession, run: Run, markdown: str) -> list[ImportProblem]:
    """A PRD draft's problems with the work its brief's answers made (an answer saying
    finding out is part of this work: a requirement cited to it, never a blocker)."""
    from oracle.intake import discovery, drafting

    intake_id = drafting._intake_id(run)
    pinned = (run.knobs or {}).get(drafting.ANSWER_IDS)
    if intake_id is None or not isinstance(pinned, list) or (run.knobs or {}).get("intake_gap_ids"):
        return []
    keep = set()
    for i in pinned:
        try:
            keep.add(uuid.UUID(str(i)))
        except ValueError:
            continue  # a malformed knob pins nothing
    return discovery.draft_problems(markdown, await discovery.run_work(db, intake_id, keep))


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
        return {"error": exception_text(exc)}
    source_id = await _draft_source(db, run)
    knobs = run.knobs or {}
    template = (
        (knobs["template"], str(knobs["template_version"]))
        if knobs.get("template") and knobs.get("template_version")
        else None
    )
    if kind == "roadmap":
        # roadmap-plan-tables: a draft without the plan tables approving it applies to
        # Simple, or with other items or dates than the run's, goes back to the writer;
        # every roadmap draft, the feedback loop's too (the owner, Nov 4).
        problems = await _plan_table_problems(db, run, markdown, source_id)
        if problems:
            return rejection.refused(name, problems)
    if kind == "prd" and (problems := await _work_problems(db, run, markdown)):
        # Walk 2 problem 19: what the brief's answers made work is never a blocker.
        return rejection.refused(name, problems)
    if kind == "prd":
        # A question a person answered at a stop is decided: a draft that still lists it
        # under Decisions needed or Open questions goes back to the writer.
        problems = await stop_answers.open_problems(db, run, markdown)
        if problems:
            return rejection.refused(name, problems)
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
            return {"error": f"{name} was not imported: {exception_text(exc)}"}
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
        # #306: codes the draft uses without their names (and a roadmap's date words), in
        # the warning's plain words; a run sends such a draft back to the writer before a
        # person reviews it.
        sent_back = draft_checks.SENT_BACK
        code_names = [w.message for w in result.version.warnings if w.code in sent_back]
        if code_names:
            out["code_names"] = code_names
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
        return {"error": exception_text(exc)}
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
        return {"error": exception_text(exc)}
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
                reason="The run's Ground Truth file (baseline.yaml)",
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
        note = "Ground Truth merge skipped: Oracle is set to observe the Ground Truth"
    else:
        note = (
            f"Ground Truth changes became proposals: Oracle is set to {level} for the Ground Truth"
        )
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
            baseline_import = {"error": "the segment left no Ground Truth file (baseline.yaml)"}
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
        and (imported.get("problems") or imported.get("code_names"))
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
            await _accept_new(db, run, snapshot, None)
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
    named = ", ".join(wording.named(targets[k], k) for k in missing)
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
    did not take the answer.

    A draft imported with codes it does not name (#306, ``code_names``) goes back the same
    way, with those codes as findings (:func:`workflow.code_name_findings`)."""
    found = _send_back_entry(run, segment, wait)
    if found is None:
        return False
    wf, entry = found
    round_ = int(wait.get("round") or 1)
    step = wait["step_id"]
    name = flows.draft_file(kind)
    refused = bool(imported.get("problems"))
    trouble = workflow.code_name_trouble(list(imported.get("warnings") or []))
    why = "was refused at import" if refused else trouble
    left = _left(wf)
    steps = workflow.agent_steps_after(wf.get("segments") or [], segment.seq, False, round_)
    tail = workflow.tail_seconds(steps, get_runtime_settings())
    if left < tail:
        _note(
            segment,
            f"{name} {why}. With {_duration(left)} of the run's credential "
            f"left, under the {_duration(tail)} the revision needs, Oracle did not send it "
            f"back to the writer: {checkpoint} waits for a person.",
        )
        return False
    findings = (
        workflow.import_findings(
            name, imported.get("problems") or [], imported.get("problems_total")
        )
        if refused
        else workflow.code_name_findings(
            name, list(imported.get("code_names") or []), list(imported.get("warnings") or [])
        )
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
                f"{name} {why}, and Oracle could not send it back to the "
                f"writer (SwarmCloud: {_shown(exc)}): {checkpoint} waits for a person.",
            )
            return False
    subject = workflow.warning_subject(list(imported.get("warnings") or []))
    still = (
        "is still refused," if refused else f"still {trouble}, the import says which {subject} and"
    )
    problems = "import's problems" if refused else f"import's warnings on its {subject}"
    _note(
        segment,
        f"{name} {why}, so Oracle sent the draft back to the writer before "
        f"asking a person: it answered {step} (round {round_}) with NOT_YET and the "
        f"{problems} as findings. This is "
        "Oracle's answer, not a person's decision: nothing is "
        "approved, and the run's agents may not write to Oracle until a person's answer "
        f"counts. The revision is imported when the next review opens; if it {still} "
        f"{checkpoint} waits in the Inbox.",
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
    found = await _prd_source(db, source_id)
    return found[0] if found is not None else None


async def _prd_source(db: AsyncSession, source_id: uuid.UUID) -> tuple[VersionSource, str] | None:
    """A PRD version's source and its markdown, in one read (once per Inbox call)."""
    return await once(("version_source", source_id), lambda: _source_of(db, source_id))


async def _source_of(db: AsyncSession, source_id: uuid.UUID) -> tuple[VersionSource, str] | None:
    row = (
        await db.execute(
            select(DocumentVersion, Document)
            .join(Document, Document.id == DocumentVersion.document_id)
            .where(DocumentVersion.id == source_id)
        )
    ).first()
    return (docs_service.version_source(*row), row[0].markdown) if row is not None else None


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
) -> tuple[roadmap.ItemsCheck, str | None, int | None, set[str] | None, tuple[Any, ...]]:
    slug = version = prd_id = markdown = title = None
    keys: set[str] | None = None
    source_id = _source_id(run)
    if source_id is not None:
        found = await _prd_source(db, source_id)
        if found is not None:
            source, markdown = found
            slug, version, prd_id = source.slug, source.version, source.document_id
            title = source.title
            keys = set(
                await once(("section_keys", source_id), lambda: _section_keys(db, source_id))
            )
    # CR-11: a date only with a verified estimate, capacity or commitment behind it.
    bases = await once(("date_bases", prd_id), lambda: schedule.verified_bases(db, prd_id))
    # In a worker thread with a time cap: agent output never holds the event loop.
    # The owner, Nov 4: an item may depend on another PRD's feature on the company roadmap.
    # Checked for the horizon and for a cycle through them.
    on_roadmap = await once(("on_roadmap",), lambda: roadmap_company.features_on_roadmap(db))
    elsewhere = roadmap_company.others_of(on_roadmap, prd_id, run.id)
    check = await roadmap.check_items_async(
        text,
        prd_slug=slug,
        prd_version=version,
        prd_sections=keys,
        date_bases=bases,
        elsewhere=elsewhere,
        prd_name=roadmap_company.OnRoadmap("", title).prd_name if title else None,
    )
    if source_id is not None and markdown is not None and check.items:
        check = await _with_work_problems(db, source_id, markdown, check)
    return check, slug, version, keys, elsewhere


async def _with_work_problems(
    db: AsyncSession, source_id: uuid.UUID, markdown: str, check: roadmap.ItemsCheck
) -> roadmap.ItemsCheck:
    """``check`` with the items' problems with the work the PRD version (``markdown``)
    planned from its brief's answers (walk 2 problem 19: a finding-out is never a blocker).
    A new check: ``check`` may be the parse cache's."""
    from oracle.intake import discovery

    work = await once(("version_work", source_id), lambda: discovery.version_work(db, markdown))
    found = discovery.items_problems(check.items, work)
    if not found:
        return check
    out = roadmap.ItemsCheck(list(check.items), list(check.problems), list(check.resolutions))
    for code, message, item in found:
        out.add(code, message, item)
    return out


async def checked_items(
    db: AsyncSession, run: Run, text: str, prior: PriorReview | None = None
) -> CheckedItems:
    check, slug, version, keys, elsewhere = await once(
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
    # The check's own list of other PRDs' items: each dependency problem finds its item.
    found = reasons.reasons_for(check.items, check.problems, context, elsewhere)
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
