"""Intakes: create one from a short brief, edit, repin, and start a run from it.

Service functions flush but never commit; the router commits once per request. Roles
are checked by the router; "the author", "the author or an approver" and the S6 sharing
rules are checked here:

- only the author re-runs the analysis or repins (both re-read the author's sources);
- the author or an approver asks the next batch of questions;
- linking an intake to a PRD takes an approver (it brings the intake's gaps into the
  PRD's review gate), and moving an intake with an unresolved critical blocker off its
  PRD takes an owner (it would clear ``intake.critical_blockers``, B4);
- only the author sets what others see of a finding (``set_sharing``), audited.
"""

import re
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.docs import service as docs_service
from oracle.intake import categories as cats
from oracle.intake import engine, sharing
from oracle.intake import evidence as ev
from oracle.intake.schemas import IntakeCreate, IntakePatch, IntakeRunIn
from oracle.jobs.models import LlmJob
from oracle.runs import service as runs_service
from oracle.runs.schemas import RunCreate
from oracle.sources.models import Snapshot, Source
from oracle.v2.concurrency import expect_version, flush_or_conflict
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion


class IntakeError(Exception):
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(message)


def not_found(what: str) -> IntakeError:
    return IntakeError(404, f"{what} not found")


# --- lookups -----------------------------------------------------------------------------


async def get_intake(db: AsyncSession, intake_id: uuid.UUID) -> ProductIntake:
    intake = await db.get(ProductIntake, intake_id)
    if intake is None:
        raise not_found("Intake")
    return intake


async def get_gap(db: AsyncSession, gap_id: uuid.UUID) -> KnowledgeGap:
    gap = await db.get(KnowledgeGap, gap_id)
    if gap is None:
        raise not_found("Gap")
    return gap


async def get_question(db: AsyncSession, question_id: uuid.UUID) -> StakeholderQuestion:
    question = await db.get(StakeholderQuestion, question_id)
    if question is None:
        raise not_found("Question")
    return question


async def resolve_document(db: AsyncSession, doc: str | None) -> uuid.UUID | None:
    if doc is None:
        return None
    document = await docs_service.find_document(db, doc)
    if document is None:
        raise not_found(f"Document '{doc}'")
    return document.id


async def member(db: AsyncSession, user_id: uuid.UUID) -> User | None:
    return await db.get(User, user_id)


def author_or(principal: Principal, intake: ProductIntake, role: str = "approver") -> None:
    if intake.author_id == principal.id or has_role(principal.role, role):  # type: ignore[arg-type]
        return
    raise IntakeError(403, f"Only the intake's author or an {role} can do this")


def author_only(principal: Principal, intake: ProductIntake, what: str) -> None:
    if not sharing.is_author(principal, intake):
        raise IntakeError(403, f"Only the intake's author can {what}")


def actor_user(principal: Principal) -> uuid.UUID | None:
    return principal.user_id if principal.kind == "user" else None


# --- create ------------------------------------------------------------------------------


async def pin_snapshot(db: AsyncSession, label: str, created_by: uuid.UUID | None) -> Snapshot:
    snapshot = Snapshot(label=label, as_of=func.clock_timestamp(), created_by=created_by)
    db.add(snapshot)
    await db.flush()
    await db.refresh(snapshot)
    return snapshot


async def create(db: AsyncSession, principal: Principal, body: IntakeCreate) -> ProductIntake:
    if body.document is not None and not has_role(principal.role, "approver"):
        raise IntakeError(403, "Linking an intake to a PRD needs an approver")
    document_id = await resolve_document(db, body.document)
    if body.snapshot_id is not None:
        snapshot = await db.scalar(
            select(Snapshot).where(
                Snapshot.id == body.snapshot_id, Snapshot.created_by == principal.id
            )
        )
        if snapshot is None:
            raise not_found("Snapshot")
    else:
        snapshot = await pin_snapshot(db, f"Intake: {body.title}"[:200], principal.id)
    me = actor_user(principal)
    source_ids = list(dict.fromkeys(body.source_ids))
    if source_ids:
        owned = set(
            await db.scalars(
                select(Source.id).where(Source.id.in_(source_ids), Source.owner_user_id == me)
            )
        )
        if me is None or owned != set(source_ids):
            raise not_found("Source")
    intake = ProductIntake(
        title=body.title,
        brief=body.brief,
        author_id=principal.id,
        source_snapshot_ids=[snapshot.id],
        status="analyzing",
        analysis={
            "source_ids": [str(i) for i in source_ids],
            "extraction": {"ai": body.ai_extraction},
        },
        document_id=document_id,
    )
    db.add(intake)
    await db.flush()
    await engine.analyze(db, intake)
    await audit.record(
        db,
        principal,
        "intake.created",
        "intake",
        intake.id,
        {
            "snapshot_id": str(snapshot.id),
            "source_ids": [str(i) for i in source_ids],
            "document_id": str(document_id) if document_id else None,
        },
    )
    await ask(db, principal, intake, body.batch_size)
    if body.ai_extraction:
        await queue_extraction(db, principal, intake)
    return intake


async def queue_extraction(db: AsyncSession, principal: Principal | None, intake: ProductIntake):
    """Light extraction on Oracle's built-in model jobs (one queued job per intake)."""
    queued = await db.scalar(
        select(LlmJob).where(
            LlmJob.intake_id == intake.id,
            LlmJob.kind == "intake_analysis",
            LlmJob.status == "queued",
        )
    )
    if queued is not None:
        return queued
    job = LlmJob(
        kind="intake_analysis",
        intake_id=intake.id,
        status="queued",
        input={"snapshot_id": str(intake.source_snapshot_ids[-1])},
        requested_by=principal.id if principal else None,
        attempts=0,
    )
    db.add(job)
    await db.flush()
    await audit.record(
        db, principal, "llm_job.queue", "llm_job", job.id,
        {"kind": "intake_analysis", "intake_id": str(intake.id)},
    )  # fmt: skip
    return job


async def ask(
    db: AsyncSession, principal: Principal, intake: ProductIntake, size: int
) -> list[StakeholderQuestion]:
    """Ask the next batch. Questions of gaps the asker may not see (S6) are left as
    drafts, so they are neither asked nor take a place in the batch."""
    v = sharing.viewer(principal, intake)
    skip: set[uuid.UUID] = set()
    if not v.is_author:
        reg = sharing.registry(intake)
        skip = {
            g.id
            for g in await engine.intake_gaps(db, intake.id)
            if sharing.gap_view(g, reg, v) is None
        }
    asked = await engine.ask_batch(db, intake, principal.id, size, skip)
    if asked:
        await audit.record(
            db,
            principal,
            "intake.questions_asked",
            "intake",
            intake.id,
            {"batch": asked[0].batch, "question_ids": [str(q.id) for q in asked]},
        )
    return asked


# --- edit, analyze, repin ------------------------------------------------------------------


async def patch(
    db: AsyncSession, principal: Principal, intake: ProductIntake, body: IntakePatch
) -> ProductIntake:
    author_or(principal, intake)
    expect_version(intake, body.lock_version)
    changes: dict[str, Any] = {}
    if body.title is not None and body.title != intake.title:
        changes["title"] = [intake.title, body.title]
        intake.title = body.title
    if "document" in body.model_fields_set:
        document_id = await resolve_document(db, body.document)
        if document_id != intake.document_id:
            if not has_role(principal.role, "approver"):  # type: ignore[arg-type]
                raise IntakeError(403, "Linking an intake to a PRD needs an approver")
            if intake.document_id is not None and not has_role(principal.role, "owner"):  # type: ignore[arg-type]
                if await open_hard_blockers(db, intake):
                    raise IntakeError(
                        403,
                        "The intake has an unresolved critical blocker on its PRD; only an "
                        "owner can move it",
                    )
            changes["document_id"] = [str(intake.document_id), str(document_id)]
            intake.document_id = document_id
    if body.status is not None and body.status != intake.status:
        if intake.status == "converted":
            raise IntakeError(409, "A converted intake keeps its status")
        changes["status"] = [intake.status, body.status]
        intake.status = body.status
    await flush_or_conflict(db)
    if changes:
        await audit.record(db, principal, "intake.updated", "intake", intake.id, changes)
    return intake


async def open_hard_blockers(db: AsyncSession, intake: ProductIntake) -> list[KnowledgeGap]:
    return [
        g
        for g in await engine.intake_gaps(db, intake.id)
        if g.importance == "critical"
        and g.category in cats.HARD_BLOCKER_CATEGORIES
        and g.status not in engine.DECIDED
    ]


async def reanalyze(db: AsyncSession, principal: Principal, intake: ProductIntake) -> None:
    author_only(principal, intake, "re-run its analysis")
    await engine.analyze(db, intake)
    await audit.record(db, principal, "intake.analyzed", "intake", intake.id, {})


async def repin(db: AsyncSession, principal: Principal, intake: ProductIntake) -> Snapshot:
    """Pin a new snapshot explicitly; decided gaps stay as they are (S4)."""
    author_only(principal, intake, "repin it")
    version = len(intake.source_snapshot_ids) + 1
    snapshot = await pin_snapshot(
        db, f"Intake: {intake.title} (v{version})"[:200], intake.author_id
    )
    intake.source_snapshot_ids = [*intake.source_snapshot_ids, snapshot.id]
    await db.flush()
    await engine.analyze(db, intake)
    await audit.record(
        db, principal, "intake.repinned", "intake", intake.id,
        {"version": version, "snapshot_id": str(snapshot.id)},
    )  # fmt: skip
    if (intake.analysis or {}).get("extraction", {}).get("ai"):
        await queue_extraction(db, principal, intake)
    return snapshot


async def ask_next(
    db: AsyncSession, principal: Principal, intake: ProductIntake, size: int
) -> list[StakeholderQuestion]:
    """Ask the next batch: the author or an approver."""
    if not sharing.is_author(principal, intake) and not has_role(principal.role, "approver"):  # type: ignore[arg-type]
        raise IntakeError(403, "Only the intake's author or an approver asks the next batch")
    return await ask(db, principal, intake, size)


# --- sharing (S6) ------------------------------------------------------------------------


async def set_sharing(
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    changes: list[tuple[str, str]],
) -> list[str]:
    """Set what others see of the author's findings; every change is audited. Returns
    the ids of the findings set.

    Sharing in full releases exactly what the finding cites now, at the version the
    intake read (S6, owner 2026-10-19, freeze at sharing): what a later analysis adds,
    and newer versions, stay withheld until the author shares it in full again, which
    releases what it cites then."""
    author_only(principal, intake, "share its findings")
    reg = sharing.registry(intake)
    missing = [fid for fid, _ in changes if fid not in reg]
    if missing:
        raise not_found(f"Finding {missing[0]}")
    _restricted(reg, [fid for fid, _ in changes])
    done: list[str] = []
    moved: list[str] = []
    for fid, level in changes:
        entry = dict(reg[fid])
        before = entry.get("sharing", sharing.DEFAULT)
        done.append(fid)
        released = entry.get("frozen")
        if level == "full":
            entry["frozen"] = await ev.pinned_versions(
                db, intake, entry.get("source_item_ids") or []
            )
        else:
            entry.pop("frozen", None)
        entry["sharing"] = level
        reg[fid] = entry
        if before == level and (level != "full" or entry["frozen"] == released):
            continue
        if before != level:
            moved.append(fid)
        data: dict[str, Any] = {"finding_id": fid, "from": before, "to": level}
        if level != "private":
            # A private finding's kind and category stay unsaid (as its summary audit).
            data |= {"kind": entry["kind"], "category": entry.get("category")}
        if level == "full":
            data["released"] = len(entry["frozen"])
        await audit.record(db, principal, "intake.finding_shared", "intake", intake.id, data)
    intake.analysis = {**(intake.analysis or {}), "findings": reg}
    # What runs may read changed with the levels (S6, owner 2026-10-19).
    await ev.record_reads(db, intake)
    # What others see changed: so may the order of their questions and the status.
    gaps = await engine.intake_gaps(db, intake.id)
    await engine.sync_questions(db, intake, gaps)
    engine.refresh_status(intake, gaps)
    if moved:
        # Answers to these gaps are proposed to the baseline as the new level allows:
        # the question alone at counts, the answer and severity from summary up (S6).
        from oracle.intake import answers

        await answers.propose_shared(db, principal, intake, [g for g in gaps if str(g.id) in moved])
    await flush_or_conflict(db)
    return done


def _restricted(reg: dict[str, dict[str, Any]], fids: list[str]) -> None:
    """A finding drawn from shared text only has no level and no summary to set."""
    for fid in fids:
        if sharing.is_open(reg.get(fid)):
            raise IntakeError(409, f"Finding {fid} is drawn from shared text only: not restricted")


async def set_summary(
    db: AsyncSession, principal: Principal, intake: ProductIntake, fid: str, text: str | None
) -> None:
    """The author confirms Oracle's draft line for the summary level, or writes their
    own (S6); audited, without the text."""
    author_only(principal, intake, "set what its findings say")
    reg = sharing.registry(intake)
    entry = reg.get(fid)
    if entry is None:
        raise not_found(f"Finding {fid}")
    _restricted(reg, [fid])
    edited = text is not None and bool(text.strip())
    reg[fid] = sharing.set_summary(entry, text)
    intake.analysis = {**(intake.analysis or {}), "findings": dict(reg)}
    data: dict[str, Any] = {"finding_id": fid}
    if entry.get("sharing", sharing.DEFAULT) != "private":
        # Others already read its kind and category; a private finding's stay unsaid.
        data |= {"kind": entry["kind"], "category": entry.get("category"), "edited": edited}
    await audit.record(db, principal, "intake.finding_summary_set", "intake", intake.id, data)
    await flush_or_conflict(db)


# --- runs ----------------------------------------------------------------------------------


def slug_for(title: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
    return (slug or "product-idea")[:80]


def run_knobs(intake: ProductIntake, gap_ids: list[uuid.UUID] | None = None) -> dict[str, Any]:
    """What a run started from an intake carries: the intake and its pinned snapshot."""
    knobs: dict[str, Any] = {
        "intake_id": str(intake.id),
        "intake_snapshot_id": str(intake.source_snapshot_ids[-1]),
    }
    if gap_ids:
        knobs["intake_gap_ids"] = [str(g) for g in gap_ids]
    return knobs


async def create_run(
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    body: IntakeRunIn,
    *,
    gap_ids: list[uuid.UUID] | None = None,
    depth: str | None = None,
) -> uuid.UUID:
    """A draft baseline-to-PRD run pinned to the intake's snapshot. Nothing starts: an
    approver estimates and starts it, under the usual cost gates (P3)."""
    if not intake.source_snapshot_ids:
        raise IntakeError(409, "The intake has no pinned snapshot")
    document = body.document
    if document is None and intake.document_id is not None:
        document = str(intake.document_id)
    if document is None:
        document = slug_for(intake.title)
    knobs = body.knobs.model_copy(update={"depth": depth}) if depth else body.knobs
    try:
        run_id = await runs_service.create_run(
            db,
            principal,
            RunCreate(flow="baseline_to_prd", document=document, knobs=knobs),
            oracle_knobs=run_knobs(intake, gap_ids),
            commit=False,
        )
    except runs_service.RunError as e:
        raise IntakeError(e.status, str(e)) from e
    return run_id


async def convert(
    db: AsyncSession, principal: Principal, intake: ProductIntake, body: IntakeRunIn
) -> uuid.UUID:
    run_id = await create_run(db, principal, intake, body)
    from oracle.runs.models import Run

    run = await db.get(Run, run_id)
    if run is not None and run.document_id is not None and intake.document_id is None:
        intake.document_id = run.document_id
    intake.status = "converted"
    await db.flush()
    await audit.record(
        db, principal, "intake.run_created", "intake", intake.id, {"run_id": str(run_id)}
    )
    return run_id
