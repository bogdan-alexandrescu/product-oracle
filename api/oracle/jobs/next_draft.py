"""C1e: staged changes and the next draft built from them in one job.

Accepting a section-text suggestion stages it: nothing is applied per item. The staged
changes of a document are every accepted section-text suggestion not applied in any
draft yet, whichever draft it was raised on. **Build next draft** queues one
``refinement_batch`` job over the latest version (the approver may untick items); the
approver sees one combined preview, may drop sections or edit them, and **Apply**
imports exactly one new version. Suggestions of dropped (or skipped) sections stay
staged, and so does everything when the build is discarded.

D12: one Build next draft for two engines. :func:`choose_engine` holds the rule: the
chosen staged items go to the agents (a ``feedback_loop`` run in SwarmCloud, with exactly
those items and the accepted text) when any of them was staged for the agents or a chosen
text change's section is gone; otherwise Oracle's own refinement batch builds them.
:func:`plan` says which and why, for the web, the Inbox and MCP clients alike.

Service functions flush but never commit, except :func:`apply`, which imports a
version through the document importer (it commits) and then records what was applied,
and :func:`start_run`, which creates, estimates and starts a run (each step commits).
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from typing import TYPE_CHECKING, Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.models import ApiToken, User
from oracle.docs import service as docs_service
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.docs.schemas import VersionOut
from oracle.jobs import kinds, prompting
from oracle.jobs.models import LlmJob, LlmSuggestion
from oracle.jobs.schemas import (
    AgentItem,
    NextDraftFeedback,
    NextDraftInstruction,
    NextDraftPlan,
    NextDraftPreview,
    NextDraftReason,
    NextDraftSection,
    SkippedSection,
    StagedChange,
    StagedChanges,
    StagedDiscussionChange,
)
from oracle.jobs.service import (
    JobError,
    _data_point_lines,
    _is_sources,
    compose_markdown,
    enabled,
    enqueue,
    get_document,
    job_out,
    latest_number,
    on_version_imported,
)
from oracle.review.models import FeedbackItem
from oracle.review.service import locked_section_keys
from oracle.runs import flows

if TYPE_CHECKING:
    from oracle.auth.deps import Principal

KIND = "refinement_batch"
#: The run the agents write a next draft in.
AGENT_FLOW = "feedback_loop"
#: Earlier refinements a cost estimate is drawn from.
ESTIMATE_SAMPLE = 20


def _now() -> datetime:
    return datetime.now(UTC)


async def names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    """A label for each user (email) or API token (name) id."""
    ids = {i for i in ids if i}
    if not ids:
        return {}
    out: dict[uuid.UUID, str] = dict(
        (await db.execute(select(User.id, User.email).where(User.id.in_(ids)))).all()
    )
    rest = ids - set(out)
    if rest:
        out.update(
            (
                await db.execute(select(ApiToken.id, ApiToken.name).where(ApiToken.id.in_(rest)))
            ).all()
        )
    return out


async def _latest(db: AsyncSession, document: Document) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document.id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _sections(db: AsyncSession, version: DocumentVersion | None) -> list[Section]:
    if version is None:
        return []
    return list(
        await db.scalars(
            select(Section).where(Section.version_id == version.id).order_by(Section.ordinal)
        )
    )


def _discarded(job: LlmJob) -> bool:
    return bool((job.output or {}).get("discarded_at"))


def _applied(job: LlmJob) -> int | None:
    return (job.output or {}).get("applied_version")


async def current_job(db: AsyncSession, document_id: uuid.UUID) -> LlmJob | None:
    """The document's latest next-draft build while it is still pending (queued,
    running, failed or ready to preview); None once applied, discarded or cancelled."""
    job = await db.scalar(
        select(LlmJob)
        .where(LlmJob.document_id == document_id, LlmJob.kind == KIND)
        .order_by(LlmJob.created_at.desc(), LlmJob.id.desc())
        .limit(1)
    )
    if job is None or job.status == "cancelled" or _applied(job) or _discarded(job):
        return None
    return job


async def _estimate(db: AsyncSession, sections: int) -> float | None:
    """Typical cost per section of recent refinements, times the sections to build."""
    rows = list(
        await db.scalars(
            select(LlmJob)
            .where(
                LlmJob.kind.in_(("refinement", KIND)),
                LlmJob.status == "succeeded",
                LlmJob.cost_usd.is_not(None),
            )
            .order_by(LlmJob.finished_at.desc().nulls_last())
            .limit(ESTIMATE_SAMPLE)
        )
    )
    per: list[Decimal] = []
    for j in rows:
        n = len((j.output or {}).get("sections") or []) if j.kind == KIND else 1
        if n and j.cost_usd is not None:
            per.append(j.cost_usd / n)
    if not per or not sections:
        return None
    return round(float(sum(per) / len(per)) * sections, 4)


# --- staged changes -----------------------------------------------------------------------


async def _discussion_changes(
    db: AsyncSession,
    principal: "Principal | None",
    document: Document,
    headings: dict[str, str],
    locked: set[str],
    include_gone: bool,
) -> list[StagedDiscussionChange]:
    """G4: the discussions' section changes staged for the next draft, each with the
    line saying where it came from, as the reader may see it."""
    from oracle.staging import service as staging

    rows = await staging.staged_rows(db, document.id)
    views = await staging.discussion_views(db, principal, [r.discussion_id for r in rows])
    who = await names(db, {r.staged_by for r in rows})
    out = []
    for r in rows:
        gone = r.section_key not in headings
        if gone and not include_gone:
            continue
        view = views.get(r.discussion_id) if r.discussion_id else None
        out.append(
            StagedDiscussionChange(
                id=r.id,
                section_key=r.section_key,
                section_heading=headings.get(r.section_key, r.section_key),
                instruction=r.instruction,
                text=r.text,
                reason=r.reason,
                origin_line=staging.origin_line(view) or staging.PRIVATE_LINE,
                discussion_id=view.id if view else None,
                discussion_title=view.title if view else None,
                from_private=r.from_private,
                staged_by_name=who.get(r.staged_by),
                staged_at=r.created_at,
                raised_on_version=r.raised_on_version,
                section_gone=gone,
                section_locked=r.section_key in locked,
                lock_version=r.lock_version,
            )
        )
    return out


async def staged_changes(
    db: AsyncSession,
    doc: str,
    include_gone: bool = False,
    principal: "Principal | None" = None,
) -> StagedChanges:
    document = await get_document(db, doc)
    latest = await _latest(db, document)
    sections = await _sections(db, latest)
    headings = {s.section_key: s.heading for s in sections}
    locked = await locked_section_keys(db, latest.id) if latest else set()
    rows = await kinds.staged_suggestions(db, document.id)
    items = {
        f.id: f
        for f in await db.scalars(
            select(FeedbackItem).where(FeedbackItem.id.in_([r.feedback_item_id for r in rows]))
        )
    }
    # The heading of a gone section, from the draft its suggestion was written against.
    old_headings: dict[tuple[int, str], str] = {}
    gone_rows = [r for r in rows if r.section_key not in headings]
    if gone_rows:
        old_headings = {
            (n, k): h
            for n, k, h in (
                await db.execute(
                    select(DocumentVersion.number, Section.section_key, Section.heading)
                    .join(Section, Section.version_id == DocumentVersion.id)
                    .where(
                        DocumentVersion.document_id == document.id,
                        Section.section_key.in_({r.section_key for r in gone_rows}),
                    )
                )
            ).all()
        }
    who = await names(db, {r.decided_by for r in rows if r.decided_by})
    out: list[StagedChange] = []
    gone = 0
    for r in rows:
        key = r.section_key or ""
        is_gone = key not in headings
        gone += is_gone
        if is_gone and not include_gone:
            continue
        item = items.get(r.feedback_item_id)
        heading = headings.get(key) or next(
            (
                h
                for (n, k), h in sorted(old_headings.items(), reverse=True)
                if k == key and n <= r.version_number
            ),
            key,
        )
        out.append(
            StagedChange(
                suggestion_id=r.id,
                feedback_item_id=r.feedback_item_id,
                section_key=key,
                section_heading=heading,
                feedback_summary=item.summary if item else "",
                text=r.edited_text or r.text or "",
                accepted_by=r.decided_by,
                accepted_by_name=who.get(r.decided_by) if r.decided_by else None,
                accepted_at=r.decided_at,
                raised_on_version=item.raised_on_version if item else r.version_number,
                suggested_on_version=r.version_number,
                section_gone=is_gone,
                section_locked=key in locked,
            )
        )
    job = await current_job(db, document.id)
    buildable = {c.section_key for c in out if not c.section_gone}
    agent_rows = list(
        await db.scalars(
            select(FeedbackItem)
            .where(
                FeedbackItem.document_id == document.id,
                FeedbackItem.status == "open",
                FeedbackItem.staged_for_agents_at.is_not(None),
            )
            .order_by(FeedbackItem.staged_for_agents_at, FeedbackItem.id)
        )
    )
    stagers = await names(db, {f.staged_for_agents_by for f in agent_rows})
    return StagedChanges(
        document_id=document.id,
        slug=document.slug,
        latest_version=latest.number if latest else None,
        next_version=(latest.number if latest else 0) + 1,
        items=out,
        gone_count=gone,
        estimate_usd=await _estimate(db, len(buildable)),
        draft_job=await job_out(db, job) if job else None,
        agent_items=[
            AgentItem(
                feedback_id=f.id,
                summary=f.summary,
                section_key=f.section_key,
                staged_by_name=stagers.get(f.staged_for_agents_by),
                staged_at=f.staged_for_agents_at,
            )
            for f in agent_rows
        ],
        next_draft_changes=await _discussion_changes(
            db, principal, document, headings, locked, include_gone
        ),
    )


# --- the engine (D12) ---------------------------------------------------------------------


@dataclass
class Plan:
    engine: Literal["oracle", "agents"]
    why: list[NextDraftReason] = field(default_factory=list)


def _n(count: int, one: str, many: str) -> str:
    return f"{count} {one if count == 1 else many}"


def choose_engine(
    text_changes: Sequence[StagedChange], agent_items: Sequence[AgentItem], document: Any
) -> Plan:
    """The one rule for which engine builds the chosen staged items.

    ``agents`` when any chosen item was staged for the agents (a remark about the whole
    draft, or an item that needs more than a section's text changed) or a chosen text
    change's section is gone from the latest version; otherwise ``oracle`` (Oracle's own
    refinement batch). A locked section is the built-in path's refusal, not a reason for
    the agents. A roadmap's items needing re-deriving joins as ``roadmap_items`` once
    roadmap-per-draft items exist (group E); ``document`` is taken for it."""
    why: list[NextDraftReason] = []
    general = [i.feedback_id for i in agent_items if i.section_key is None]
    sectioned = [i.feedback_id for i in agent_items if i.section_key is not None]
    gone = [c for c in text_changes if c.section_gone]
    if general:
        why.append(
            NextDraftReason(
                code="whole_draft",
                text=_n(len(general), "remark is", "remarks are") + " about the whole draft",
                feedback_ids=general,
            )
        )
    if sectioned:
        why.append(
            NextDraftReason(
                code="structure",
                text=_n(len(sectioned), "item needs", "items need")
                + " more than a section's text changed",
                feedback_ids=sectioned,
            )
        )
    if gone:
        sections = len({c.section_key for c in gone})
        why.append(
            NextDraftReason(
                code="section_gone",
                text=_n(sections, "section", "sections")
                + (" to change is gone" if sections == 1 else " to change are gone"),
                suggestion_ids=[c.suggestion_id for c in gone],
            )
        )
    return Plan(engine="agents" if why else "oracle", why=why)


async def _chosen(
    db: AsyncSession,
    doc: str,
    suggestion_ids: list[uuid.UUID] | None,
    feedback_ids: list[uuid.UUID] | None,
    next_draft_change_ids: list[uuid.UUID] | None = None,
) -> tuple[StagedChanges, list[StagedChange], list[AgentItem]]:
    """The staged items a build takes: the ones named (each must be staged), else every
    staged text change whose section exists and every item staged for the agents. G4:
    a discussion's staged section change counts as a text change; the build reads those
    with :func:`_chosen_rows`."""
    staged = await staged_changes(db, doc, include_gone=True)
    rows = _chosen_rows(staged, next_draft_change_ids)
    if suggestion_ids is None:
        changes = [c for c in staged.items if not c.section_gone]
    else:
        wanted = set(suggestion_ids)
        changes = [c for c in staged.items if c.suggestion_id in wanted]
        if len(changes) != len(wanted):
            raise JobError(422, "every suggestion must be a staged (accepted, not applied) change")
    if feedback_ids is None:
        items = list(staged.agent_items)
    else:
        wanted = set(feedback_ids)
        items = [i for i in staged.agent_items if i.feedback_id in wanted]
        if len(items) != len(wanted):
            raise JobError(422, "every feedback item must be staged for the agents")
    if not changes and not items and not rows:
        raise JobError(422, "nothing is staged for the next draft")
    return staged, changes, items


def _chosen_rows(
    staged: StagedChanges, ids: list[uuid.UUID] | None
) -> list[StagedDiscussionChange]:
    """G4: the discussions' section changes a build takes: the ones named (each must be
    staged), else every staged one whose section exists."""
    if ids is None:
        return [c for c in staged.next_draft_changes if not c.section_gone]
    wanted = set(ids)
    rows = [c for c in staged.next_draft_changes if c.id in wanted]
    if len(rows) != len(wanted):
        raise JobError(422, "every discussion change must be staged for the next draft")
    return rows


def _locked_refusal(changes: Sequence[StagedChange | StagedDiscussionChange]) -> str | None:
    hit = sorted({(c.section_heading, c.section_key) for c in changes if c.section_locked})
    if not hit:
        return None
    named = ", ".join(f"{h} ({k})" for h, k in hit)
    return f"approved and locked, never changed: {named}; untick them"


def _agent_estimate(depth: str) -> Decimal:
    flow = flows.FLOWS[AGENT_FLOW]
    knobs = flows.resolve_knobs(flow, {"depth": depth})
    return sum((flows.segment_estimate(s, knobs) for s in flow.segments), Decimal(0))


async def plan(
    db: AsyncSession,
    doc: str,
    suggestion_ids: list[uuid.UUID] | None,
    feedback_ids: list[uuid.UUID] | None,
    depth: str = "standard",
    next_draft_change_ids: list[uuid.UUID] | None = None,
) -> NextDraftPlan:
    """Which engine builds the chosen staged items (default: every staged one), and why;
    the agents' run estimate, or why the built-in build cannot start."""
    staged, changes, items = await _chosen(
        db, doc, suggestion_ids, feedback_ids, next_draft_change_ids
    )
    rows = _chosen_rows(staged, next_draft_change_ids)
    chosen = choose_engine(changes, items, await get_document(db, doc))
    out = NextDraftPlan(
        engine=chosen.engine,
        why=chosen.why,
        text_changes=len(changes) + len(rows),
        agent_items=len(items),
        sections=len({c.section_key for c in changes} | {r.section_key for r in rows}),
        next_version=staged.next_version,
    )
    if chosen.engine == "agents":
        estimate = _agent_estimate(depth)
        out.estimate_usd = float(estimate)
        out.needs_owner_approval = estimate > flows.APPROVAL_THRESHOLD_USD
    elif not enabled(await get_document(db, doc), KIND):
        out.refused = "Refinement is turned off for this document"
    else:
        out.refused = _locked_refusal([*changes, *rows])
    return out


class NeedsAgents(JobError):
    """The built-in build was asked for items only the agents can build (409)."""

    def __init__(self, why: list[NextDraftReason]):
        self.why = why
        super().__init__(409, "these changes need the agents: " + "; ".join(w.text for w in why))


async def start_run(
    db: AsyncSession,
    principal: "Principal",
    doc: str,
    suggestion_ids: list[uuid.UUID] | None,
    feedback_ids: list[uuid.UUID] | None,
    depth: str = "standard",
    next_draft_change_ids: list[uuid.UUID] | None = None,
) -> uuid.UUID:
    """Start the agents' feedback-loop run with exactly the chosen items: created,
    estimated and started (or left awaiting an owner's approval over the threshold).
    G4: the discussions' chosen section changes go with them, for the agents to make."""
    from oracle.runs import service as runs
    from oracle.runs.schemas import KnobsIn, RunCreate

    staged, changes, items = await _chosen(
        db, doc, suggestion_ids, feedback_ids, next_draft_change_ids
    )
    rows = _chosen_rows(staged, next_draft_change_ids)
    document = await get_document(db, doc)
    if choose_engine(changes, items, document).engine == "oracle":
        raise JobError(409, "these changes need no agents; build them with Oracle")
    run_id = await runs.create_run(
        db,
        principal,
        RunCreate(flow=AGENT_FLOW, document=document.slug, knobs=KnobsIn(depth=depth)),
        oracle_knobs={
            "feedback_ids": [str(i.feedback_id) for i in items],
            "suggestion_ids": [str(c.suggestion_id) for c in changes],
            "next_draft_change_ids": [str(r.id) for r in rows],
        },
    )
    await runs.estimate(db, principal, run_id)
    await runs.start(db, principal, run_id)
    return run_id


# --- build --------------------------------------------------------------------------------


async def build(
    db: AsyncSession,
    principal: "Principal",
    doc: str,
    suggestion_ids: list[uuid.UUID] | None,
    feedback_ids: list[uuid.UUID] | None = None,
    next_draft_change_ids: list[uuid.UUID] | None = None,
) -> LlmJob:
    document = await get_document(db, doc)
    # Serialise builds per document: the row lock is held until the request commits, so a
    # double click or two approvers cannot both pass the pending check below.
    await db.execute(select(Document.id).where(Document.id == document.id).with_for_update())
    latest = await _latest(db, document)
    if latest is None:
        raise JobError(409, f"'{document.slug}' has no version yet")
    pending = await current_job(db, document.id)
    if pending is not None and pending.status in ("queued", "running"):
        raise JobError(
            409,
            f"a build is already running (job {pending.id}); wait for it or discard it",
        )
    # D12: the built-in engine builds only what needs no agents.
    staged, changes, items = await _chosen(
        db, doc, suggestion_ids, feedback_ids, next_draft_change_ids
    )
    chosen = choose_engine(changes, items, document)
    if chosen.engine == "agents":
        raise NeedsAgents(chosen.why)
    nd_rows = _chosen_rows(staged, next_draft_change_ids)
    sections = await _sections(db, latest)
    headings = {s.section_key: s.heading for s in sections}
    ids = [str(i) for i in suggestion_ids] if suggestion_ids is not None else None
    rows = await kinds.staged_suggestions(db, document.id, ids)
    if ids is not None and len(rows) != len(set(ids)):
        raise JobError(422, "every suggestion must be a staged (accepted, not applied) change")
    gone = [r for r in rows if r.section_key not in headings]
    # Named items whose section is gone are refused; by default they are left out.
    gone_keys = {r.section_key or "?" for r in gone} if ids is not None else set()
    if next_draft_change_ids is not None:
        gone_keys |= {c.section_key for c in nd_rows if c.section_key not in headings}
    if ids is None:
        rows = [r for r in rows if r.section_key in headings]
    if gone_keys:
        keys = ", ".join(sorted(gone_keys))
        raise JobError(
            422, f"section(s) {keys} are no longer in version {latest.number}; untick them"
        )
    nd_rows = [c for c in nd_rows if c.section_key in headings]
    if not rows and not nd_rows:
        raise JobError(422, "nothing is staged for the next draft")
    locked = await locked_section_keys(db, latest.id)
    touched = {r.section_key for r in rows} | {c.section_key for c in nd_rows}
    hit = [s for s in sections if s.section_key in locked and s.section_key in touched]
    if hit:
        named = ", ".join(f"{s.heading} ({s.section_key})" for s in hit)
        raise JobError(409, f"approved and locked, never changed: {named}; untick them")
    return await enqueue(
        db,
        document,
        KIND,
        version=latest,
        input={
            "suggestion_ids": [str(r.id) for r in rows],
            "next_draft_change_ids": [str(c.id) for c in nd_rows],
        },
        principal=principal,
    )


# --- preview ------------------------------------------------------------------------------


async def _job(db: AsyncSession, document: Document, job_id: uuid.UUID, lock: bool = False):
    stmt = select(LlmJob).where(LlmJob.id == job_id)
    if lock:
        stmt = stmt.with_for_update()
    job = await db.scalar(stmt)
    if job is None or job.document_id != document.id or job.kind != KIND:
        raise JobError(404, f"next-draft build {job_id} not found on '{document.slug}'")
    return job


async def preview(db: AsyncSession, doc: str, job_id: uuid.UUID) -> NextDraftPreview:
    document = await get_document(db, doc)
    job = await _job(db, document, job_id)
    latest = await latest_number(db, document.id)
    base = (job.input or {}).get("version")
    out = NextDraftPreview(
        job=await job_out(db, job),
        base_version=base,
        next_version=base + 1 if base else None,
        latest_version=latest,
        stale=bool(base and latest and latest != base and not _applied(job)),
        applied_version=_applied(job),
        discarded=_discarded(job),
    )
    if job.status != "succeeded" or not job.output:
        return out
    data = job.output
    fids = {
        uuid.UUID(r["feedback_id"]) for s in data.get("sections") or [] for r in s["resolutions"]
    }
    summaries = dict(
        (
            await db.execute(
                select(FeedbackItem.id, FeedbackItem.summary).where(FeedbackItem.id.in_(fids))
            )
        ).all()
    )
    instructions = await _instructions(db, data)
    out.notes = data.get("notes") or ""
    out.skipped = [SkippedSection.model_validate(x) for x in data.get("skipped") or []]
    out.sections = [
        NextDraftSection(
            section_key=s["section_key"],
            heading=s["heading"],
            before_heading=s["before"]["heading"],
            before_body_md=s["before"]["body_md"],
            body_md=s["body_md"],
            words=s.get("preview") or [],
            notes=s.get("notes") or "",
            o1c_fixes=s.get("o1c_fixes") or [],
            data_points=s.get("data_points") or [],
            resolutions=s.get("resolutions") or [],
            suggestion_ids=s.get("suggestion_ids") or [],
            feedback=[
                NextDraftFeedback(
                    id=r["feedback_id"], summary=summaries.get(uuid.UUID(r["feedback_id"]), "")
                )
                for r in s.get("resolutions") or []
            ],
            next_draft_change_ids=s.get("next_draft_change_ids") or [],
            instructions=[
                instructions[i] for i in s.get("next_draft_change_ids") or [] if i in instructions
            ],
        )
        for s in data.get("sections") or []
    ]
    return out


async def _instructions(db: AsyncSession, data: dict[str, Any]) -> dict[str, NextDraftInstruction]:
    """G4: the discussions' changes a build used, with where each came from. The preview
    names no private discussion (it has no reader to check)."""
    from oracle.staging import service as staging
    from oracle.staging.models import NextDraftChange

    ids = [
        uuid.UUID(i)
        for s in data.get("sections") or []
        for i in s.get("next_draft_change_ids") or []
    ]
    if not ids:
        return {}
    rows = list(await db.scalars(select(NextDraftChange).where(NextDraftChange.id.in_(ids))))
    views = await staging.discussion_views(db, None, [r.discussion_id for r in rows])
    return {
        str(r.id): NextDraftInstruction(
            next_draft_change_id=r.id,
            instruction=r.instruction,
            text=r.text,
            origin=staging.origin_line(views.get(r.discussion_id) if r.discussion_id else None)
            or staging.PRIVATE_LINE,
        )
        for r in rows
    }


# --- apply and discard --------------------------------------------------------------------


async def apply(
    db: AsyncSession,
    principal: "Principal",
    doc: str,
    job_id: uuid.UUID,
    drop_sections: list[str],
    edits: dict[str, str],
) -> VersionOut:
    """Import exactly one new version: the latest with every kept section replaced."""
    document = await get_document(db, doc)
    job = await _job(db, document, job_id, lock=True)
    if _discarded(job):
        raise JobError(409, "this next draft was discarded; build it again")
    if _applied(job):
        raise JobError(409, f"already applied as version {_applied(job)}")
    if job.status != "succeeded" or not job.output:
        raise JobError(409, "only a finished next-draft build can be applied")
    out = job.output
    base = await db.scalar(
        select(DocumentVersion).where(
            DocumentVersion.document_id == document.id,
            DocumentVersion.number == int(out["base_version"]),
        )
    )
    if base is None or base.number != await latest_number(db, document.id):
        raise JobError(409, "a newer version exists since this draft was built; build it again")
    built = {s["section_key"]: s for s in out.get("sections") or []}
    unknown = sorted((set(drop_sections) | set(edits)) - set(built))
    if unknown:
        raise JobError(422, f"not in this draft: {', '.join(unknown)}")
    kept = [k for k in built if k not in set(drop_sections)]
    if not kept:
        raise JobError(422, "keep at least one section, or discard the draft")
    bad_edits = sorted(k for k in edits if k not in kept)
    if bad_edits:
        raise JobError(422, f"edits for dropped section(s): {', '.join(bad_edits)}")
    sections = await _sections(db, base)
    by_key = {s.section_key: s for s in sections}
    missing = [k for k in kept if k not in by_key]
    if missing:
        raise JobError(409, f"section(s) {', '.join(missing)} are no longer in the latest version")
    locked = await locked_section_keys(db, base.id)
    hit = [by_key[k] for k in kept if k in locked]
    if hit:
        named = ", ".join(f"{s.heading} ({s.section_key})" for s in hit)
        raise JobError(409, f"approved and locked since the build, never changed: {named}")

    # A suggestion dismissed (or no longer staged) since the build is not applied, and a
    # section whose every suggestion left staging is dropped from the new version.
    wanted = [uuid.UUID(i) for k in kept for i in built[k].get("suggestion_ids") or []]
    used = list(
        await db.scalars(
            select(LlmSuggestion).where(
                LlmSuggestion.id.in_(wanted), LlmSuggestion.status == "accepted"
            )
        )
    )
    still = {str(u.id) for u in used}
    from oracle.staging.models import NextDraftChange

    wanted_rows = [uuid.UUID(i) for k in kept for i in built[k].get("next_draft_change_ids") or []]
    live_rows = list(
        await db.scalars(
            select(NextDraftChange).where(
                NextDraftChange.id.in_(wanted_rows), NextDraftChange.status == "staged"
            )
        )
    )
    still |= {str(r.id) for r in live_rows}
    kept = [
        k
        for k in kept
        if not (built[k].get("suggestion_ids") or built[k].get("next_draft_change_ids"))
        or set(built[k].get("suggestion_ids") or []) & still
        or set(built[k].get("next_draft_change_ids") or []) & still
    ]
    if not kept:
        raise JobError(409, "every suggestion in this draft was dismissed since the build")
    used = [u for u in used if any(str(u.id) in built[k].get("suggestion_ids", []) for k in kept)]

    replace: dict[str, tuple[str, str]] = {}
    for k in kept:
        s = built[k]
        body = (
            (await prompting.clean_body_in_thread(edits[k], s["heading"])).text
            if k in edits
            else s["body_md"]
        )
        replace[k] = (s["heading"], body)
    placed = False
    sources = next((s for s in sections if _is_sources(s)), None)
    additions = [
        f"#### Data points for {replace[k][0]}\n\n{_data_point_lines(built[k]['data_points'])}"
        for k in kept
        if built[k].get("data_points")
    ]
    if additions and sources is not None and sources.section_key not in locked:
        heading, body = replace.get(sources.section_key, (sources.heading, sources.body_md))
        joined = "\n\n".join(additions)
        replace[sources.section_key] = (heading, f"{body.rstrip()}\n\n{joined}".strip())
        placed = True

    live = {str(u.feedback_item_id) for u in used}
    resolutions = [
        r for k in kept for r in built[k].get("resolutions") or [] if r["feedback_id"] in live
    ]
    dupes = list(
        await db.scalars(
            select(LlmSuggestion).where(
                LlmSuggestion.document_id == document.id,
                LlmSuggestion.kind == "duplicate",
                LlmSuggestion.status.in_(("open", "accepted")),
                LlmSuggestion.duplicate_of.in_([u.feedback_item_id for u in used]),
            )
        )
    )
    known = {r["feedback_id"] for r in resolutions}
    for d in dupes:
        if str(d.feedback_item_id) not in known:
            resolutions.append(
                {
                    "feedback_id": str(d.feedback_item_id),
                    "status": "addressed",
                    "note": "Addressed with the item it duplicates",
                }
            )
    open_items = set(
        await db.scalars(
            select(FeedbackItem.id).where(
                FeedbackItem.document_id == document.id, FeedbackItem.status == "open"
            )
        )
    )
    resolutions = [r for r in resolutions if uuid.UUID(r["feedback_id"]) in open_items]
    markdown = compose_markdown(base.front_matter, sections, replace, resolutions)
    try:
        result = await docs_service.import_draft(db, document.slug, markdown, principal)
    except docs_service.DraftError as e:
        await db.rollback()
        raise JobError(422, f"the next draft does not import: {e}") from e
    except docs_service.ImportConflictError as e:
        raise JobError(409, str(e)) from e
    if not result.created:
        raise JobError(409, "the next draft is identical to an existing version")
    number = result.version.number
    job = await db.get(LlmJob, job_id)
    job.output = {
        **job.output,
        "applied_version": number,
        "applied_by": str(principal.id),
        "applied_sections": kept,
        "dropped_sections": [k for k in built if k not in kept],
        "edited_sections": sorted(edits),
        "data_points_placed": placed,
    }
    for s in [*used, *dupes]:
        s.status = "applied"
        s.applied_in_version = number
    # G4: the discussions' changes built into the kept sections are applied, and done.
    from oracle.discussions.models import DiscussionChange

    for r in live_rows:
        if any(str(r.id) in (built[k].get("next_draft_change_ids") or []) for k in kept):
            r.status = "applied"
            r.applied_in_version = number
            change = (
                await db.get(DiscussionChange, r.discussion_change_id)
                if r.discussion_change_id
                else None
            )
            if change is not None and change.status == "staged":
                change.status = "done"
                change.decision_note = f"Applied in draft {number}"
    await audit.record(
        db,
        principal,
        "next_draft.apply",
        "llm_job",
        job.id,
        {
            "version": number,
            "sections": kept,
            "dropped": [k for k in built if k not in kept],
            "resolutions": len(resolutions),
        },
    )
    await on_version_imported(db, document.id, number, principal)
    await db.commit()
    return result.version


async def discard(db: AsyncSession, principal: "Principal", doc: str, job_id: uuid.UUID) -> LlmJob:
    """Drop a build: a queued or running one is cancelled; a finished one is set aside.
    Every staged suggestion stays staged."""
    document = await get_document(db, doc)
    job = await _job(db, document, job_id, lock=True)
    if _applied(job):
        raise JobError(409, f"already applied as version {_applied(job)}")
    if job.status == "cancelled" or _discarded(job):
        raise JobError(409, "this next draft was already discarded")
    before = job.status
    if job.status in ("queued", "running"):
        job.status = "cancelled"
        job.finished_at = _now()
    else:
        job.output = {
            **(job.output or {}),
            "discarded_at": _now().isoformat(),
            "discarded_by": str(principal.id),
        }
    await db.flush()
    await audit.record(db, principal, "next_draft.discard", "llm_job", job.id, {"from": before})
    return job
