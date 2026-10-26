"""Intakes: create one from a short brief, edit, repin, and start a run from it.

Service functions flush but never commit; the router commits once per request. Roles
are checked by the router; "the author", "the author or an approver" and the S6 sharing
rules are checked here:

- only the author re-runs the analysis or repins (both re-read the author's sources);
- the author or an approver asks the next batch of questions;
- linking an intake to a PRD takes an approver (it brings the intake's gaps into the
  PRD's review gate), and moving an intake with an unresolved critical blocker off its
  PRD takes an owner (it would clear ``intake.critical_blockers``, B4);
- only the author sets what others see of a finding (``set_sharing``), audited;
- archiving an intake retires its open questions (they leave the Inbox and stay on the
  brief as history); restoring it asks them again, a delegated one of its delegate
  (``retire_questions``, #307).
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
from oracle.baseline.models import Entity
from oracle.docs import service as docs_service
from oracle.intake import autoask, engine, sharing
from oracle.intake import categories as cats
from oracle.intake import evidence as ev
from oracle.intake.schemas import AnswerIn, IntakeCreate, IntakePatch, IntakeRunIn
from oracle.jobs.models import LlmJob
from oracle.runs import service as runs_service
from oracle.runs.schemas import RunCreate, RunPatch
from oracle.sources.models import Snapshot, Source
from oracle.templates.builtins import ensure_builtins
from oracle.templates.models import Template, Theme
from oracle.v2.concurrency import expect_version, flush_or_conflict
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderAnswer, StakeholderQuestion


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


async def confirmed_goals(db: AsyncSession, goal_ids: list[uuid.UUID]) -> list[Entity]:
    """The goals, in the order given; 422 if one is not a confirmed goal (C4)."""
    if not goal_ids:
        return []
    rows = {
        e.id: e
        for e in await db.scalars(
            select(Entity).where(
                Entity.id.in_(goal_ids), Entity.type == "goal", Entity.status == "confirmed"
            )
        )
    }
    missing = [g for g in goal_ids if g not in rows]
    if missing:
        raise IntakeError(422, f"{missing[0]} is not a confirmed goal")
    return [rows[g] for g in goal_ids]


async def check_template(db: AsyncSession, template: str | None, theme: str | None) -> None:
    """422 unless the template and theme are live PRD ones (C4)."""
    if template is None and theme is None:
        return
    await ensure_builtins(db)
    if template is not None:
        row = await db.scalar(select(Template).where(Template.key == template))
        if row is None:
            raise IntakeError(422, f"template '{template}' not found")
        if row.kind != "prd":
            raise IntakeError(422, f"template '{template}' is a {row.kind} template, not a PRD one")
        if row.archived_at is not None:
            raise IntakeError(422, f"template '{template}' is archived")
    if theme is not None:
        trow = await db.scalar(select(Theme).where(Theme.key == theme))
        if trow is None:
            raise IntakeError(422, f"theme '{theme}' not found")
        if trow.kind not in ("prd", "any"):
            raise IntakeError(422, f"theme '{theme}' is for {trow.kind} documents, not PRDs")
        if trow.archived_at is not None:
            raise IntakeError(422, f"theme '{theme}' is archived")


async def create(db: AsyncSession, principal: Principal, body: IntakeCreate) -> ProductIntake:
    if body.document is not None and not has_role(principal.role, "approver"):
        raise IntakeError(403, "Linking an intake to a PRD needs an approver")
    await confirmed_goals(db, body.goal_ids)
    await check_template(db, body.template, body.theme)
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
        goal_ids=list(body.goal_ids),
        out_of_scope=list(body.out_of_scope),
        draft_template=body.template,
        draft_theme=body.theme,
        prd_answers=body.prd_answers.model_dump() if body.prd_answers else {},
    )
    db.add(intake)
    await db.flush()
    await engine.analyze(db, intake)
    # Before the first batch: the brief's goals and out-of-scope lines answer their
    # questions, so neither is asked.
    await apply_brief_fields(db, principal, intake)
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
    # H11 ``questions``: at Observe and Draft a new brief asks no one; a person sends.
    if await autoask.asks_first_batch(db):
        await ask(db, principal, intake, body.batch_size)
    if body.ai_extraction:
        await queue_extraction(db, principal, intake)
    return intake


async def apply_brief_fields(
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    *,
    goals: bool = True,
    scope: bool = True,
) -> None:
    """The brief's goals answer the rule-made goal_alignment gap's question, and its
    out-of-scope lines the non_goals gap's, through ``answers.answer`` as ``principal``
    (kind answer, knowledge state user_decision): B4 applies unchanged, so a critical gap
    answered below the owner role waits for review. Each call adds a new answer (the
    latest wins). A category the baseline already covers (no rule-made gap) is left as
    the baseline says."""
    gaps = await engine.intake_gaps(db, intake.id)
    if goals and intake.goal_ids:
        entities = await confirmed_goals(db, list(intake.goal_ids))
        gap = engine.rules_gap(gaps, "goal_alignment")
        if gap is not None:
            body = "Serves: " + ", ".join(e.title for e in entities)
            await _answer_gap(db, principal, intake, gap, body)
            if gap.status not in engine.FROZEN:
                gap.entity_ids = [e.id for e in entities]
    if scope and intake.out_of_scope:
        gap = engine.rules_gap(gaps, "non_goals")
        if gap is not None:
            body = "Out of scope: " + "; ".join(intake.out_of_scope)
            await _answer_gap(db, principal, intake, gap, body)
    await db.flush()


async def _answer_gap(
    db: AsyncSession, principal: Principal, intake: ProductIntake, gap: KnowledgeGap, body: str
) -> None:
    # Here, not at the top: oracle.intake.answers reads this module.
    from oracle.intake import answers

    live = [
        q
        for q in await engine.intake_questions(db, intake.id)
        if q.gap_id == gap.id and q.status != "withdrawn"
    ]
    question = live[-1] if live else None
    if question is None:
        question = StakeholderQuestion(
            gap_id=gap.id,
            intake_id=intake.id,
            document_id=intake.document_id,
            category=gap.category,
            prompt=engine.question_prompt(gap),
            priority=0,
            module_key=(gap.related_modules or [None])[0],
            status="draft",
        )
        db.add(question)
        await db.flush()
    if question.status == "answered":
        # The brief changed: its line answers the question again, as the brief did the
        # first time (a new answer; the latest wins).
        question.status = "asked"
    await answers.answer(
        db,
        principal,
        question,
        AnswerIn(kind="answer", body=body[:4000], knowledge_state="user_decision"),
    )


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
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    size: int,
    assign: dict[uuid.UUID, uuid.UUID] | None = None,
) -> list[StakeholderQuestion]:
    """Ask the next batch. Questions of gaps the asker may not see (S6) are left as
    drafts, so they are neither asked nor take a place in the batch. ``assign``: the
    person to ask, per draft question (C2); every one is checked before anything is
    asked."""
    v = sharing.viewer(principal, intake)
    skip: set[uuid.UUID] = set()
    gaps = await engine.intake_gaps(db, intake.id)
    if not v.is_author:
        reg = sharing.registry(intake)
        skip = {g.id for g in gaps if sharing.gap_view(g, reg, v) is None}
    if assign:
        await _check_assign(db, intake, gaps, skip, assign)
    # H11 ``questions`` at Draft: the person the preview named, never the sender.
    answers = await autoask.proposes_asker(db)
    asked = await engine.ask_batch(db, intake, principal.id, size, skip, assign, answers)
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


async def _check_assign(
    db: AsyncSession,
    intake: ProductIntake,
    gaps: list[KnowledgeGap],
    skip: set[uuid.UUID],
    assign: dict[uuid.UUID, uuid.UUID],
) -> None:
    # Here, not at the top: oracle.intake.questions reads this module's errors.
    from oracle.intake.questions import check_assignee

    by_gap = {g.id: g for g in gaps}
    drafts = {
        q.id: q
        for q in await engine.intake_questions(db, intake.id)
        if q.status == "draft" and q.gap_id not in skip
    }
    for question_id, user_id in assign.items():
        q = drafts.get(question_id)
        if q is None:
            raise IntakeError(422, f"Question {question_id} is not waiting to be asked here")
        await check_assignee(db, intake, by_gap.get(q.gap_id) if q.gap_id else None, user_id)


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
        await retire_questions(db, intake)
    reanswer = await _patch_brief_fields(db, intake, body, changes)
    await flush_or_conflict(db)
    if reanswer:
        await apply_brief_fields(
            db, principal, intake, goals="goal_ids" in reanswer, scope="out_of_scope" in reanswer
        )
        await flush_or_conflict(db)
    if changes:
        await audit.record(db, principal, "intake.updated", "intake", intake.id, changes)
    return intake


# Asked of someone and waiting (oracle.intake.questions.OPEN).
OPEN_QUESTIONS = ("asked", "delegated")


async def retire_questions(db: AsyncSession, intake: ProductIntake) -> None:
    """An archived intake's open questions are retired; a restored one's retired questions
    are asked again: ``delegated`` if someone delegated it, else ``asked``."""
    archived = intake.status == "archived"
    rows = (
        await db.scalars(
            select(StakeholderQuestion).where(
                StakeholderQuestion.intake_id == intake.id,
                StakeholderQuestion.status.in_(OPEN_QUESTIONS if archived else ("retired",)),
            )
        )
    ).all()
    if archived:
        for q in rows:
            q.status = "retired"
        return
    delegated = set(
        await db.scalars(
            select(StakeholderAnswer.question_id).where(
                StakeholderAnswer.question_id.in_([q.id for q in rows]),
                StakeholderAnswer.kind == "delegate",
            )
        )
    )
    for q in rows:
        q.status = "delegated" if q.id in delegated else "asked"


BRIEF_FIELDS = ("goal_ids", "out_of_scope", "template", "theme", "prd_answers")


async def _patch_brief_fields(
    db: AsyncSession, intake: ProductIntake, body: IntakePatch, changes: dict[str, Any]
) -> set[str]:
    """Set the brief's fields a PATCH gives (C4); returns those whose questions are
    answered again (goal_ids, out_of_scope). 409 once the intake is converted."""
    if not any(getattr(body, k) is not None for k in BRIEF_FIELDS):
        return set()
    if intake.status == "converted":
        raise IntakeError(409, "A converted intake keeps its brief; its draft run reads it")
    reanswer: set[str] = set()
    if body.goal_ids is not None:
        await confirmed_goals(db, body.goal_ids)
        if list(intake.goal_ids or []) != body.goal_ids:
            changes["goal_ids"] = [[str(g) for g in intake.goal_ids or []],
                                   [str(g) for g in body.goal_ids]]  # fmt: skip
            intake.goal_ids = list(body.goal_ids)
            reanswer.add("goal_ids")
    if body.out_of_scope is not None and list(intake.out_of_scope or []) != body.out_of_scope:
        changes["out_of_scope"] = {"count": len(body.out_of_scope)}
        intake.out_of_scope = list(body.out_of_scope)
        reanswer.add("out_of_scope")
    await check_template(db, body.template, body.theme)
    if body.template is not None and body.template != intake.draft_template:
        changes["template"] = [intake.draft_template, body.template]
        intake.draft_template = body.template
    if body.theme is not None and body.theme != intake.draft_theme:
        changes["theme"] = [intake.draft_theme, body.theme]
        intake.draft_theme = body.theme
    if body.prd_answers is not None:
        answers = body.prd_answers.model_dump()
        if answers != (intake.prd_answers or {}):
            changes["prd_answers"] = answers
            intake.prd_answers = answers
    return reanswer


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
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    size: int,
    assign: dict[uuid.UUID, uuid.UUID] | None = None,
) -> list[StakeholderQuestion]:
    """Ask the next batch: the author or an approver."""
    if not sharing.is_author(principal, intake) and not has_role(principal.role, "approver"):  # type: ignore[arg-type]
        raise IntakeError(403, "Only the intake's author or an approver asks the next batch")
    held = await autoask.held(db)
    if held:
        raise IntakeError(409, held)
    return await ask(db, principal, intake, size, assign)


async def withdraw_asked(
    db: AsyncSession, principal: Principal, intake: ProductIntake, question_ids: list[uuid.UUID]
) -> list[StakeholderQuestion]:
    """Withdraw these questions of the intake that are still waiting on an answer (the
    Undo of a batch Oracle asked on its own, H11 ``questions``): the author or an
    approver. Answered or settled ones stay as they are."""
    if not sharing.is_author(principal, intake) and not has_role(principal.role, "approver"):  # type: ignore[arg-type]
        raise IntakeError(403, "Only the intake's author or an approver withdraws these questions")
    wanted = set(question_ids)
    done = [
        q
        for q in await engine.intake_questions(db, intake.id)
        if q.id in wanted and q.status in autoask.WAITING
    ]
    for q in done:
        q.status = "withdrawn"
    await db.flush()
    if done:
        await audit.record(
            db,
            principal,
            "intake.questions_withdrawn",
            "intake",
            intake.id,
            {"question_ids": [str(q.id) for q in done]},
        )
    return done


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


async def _run_knobs_in(
    db: AsyncSession, intake: ProductIntake, body: IntakeRunIn, depth: str | None = None
):
    """The knobs of the intake's draft run, as created or updated."""
    knobs = body.knobs.model_copy(update={"depth": depth}) if depth else body.knobs
    reuse_wanted = body.reuse_baseline
    if reuse_wanted is None:
        reuse_wanted = knobs.reuse_baseline
    if reuse_wanted is None:
        # The door's default: use the current baseline when it is reusable (C4).
        from oracle.runs import reuse

        reuse_wanted = (await reuse.review_status(db)).reusable
    update: dict[str, Any] = {"reuse_baseline": reuse_wanted}
    brief = [str(g) for g in intake.goal_ids or []]
    # #260: the run serves the brief's goals unless the sheet names others.
    goals = brief if knobs.goals is None else knobs.goals
    if brief:
        # A goal of the brief rejected since is left out (the sheet says so), not refused.
        confirmed = await db.scalars(
            select(Entity.id).where(
                Entity.id.in_(intake.goal_ids), Entity.type == "goal", Entity.status == "confirmed"
            )
        )
        stale = set(brief) - {str(g) for g in confirmed}
        goals = [g for g in goals if g not in stale]
    update["goals"] = goals
    return knobs.model_copy(update=update)


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
    knobs = await _run_knobs_in(db, intake, body, depth)
    try:
        run_id = await runs_service.create_run(
            db,
            principal,
            RunCreate(
                flow="baseline_to_prd",
                document=document,
                knobs=knobs,
                template=body.template or intake.draft_template,
                theme=body.theme or intake.draft_theme,
            ),
            oracle_knobs=run_knobs(intake, gap_ids),
            commit=False,
        )
    except runs_service.RunError as e:
        raise IntakeError(e.status, str(e)) from e
    return run_id


async def convert(
    db: AsyncSession, principal: Principal, intake: ProductIntake, body: IntakeRunIn
) -> uuid.UUID:
    """The intake's draft run, once the draft gate is clear (C5, ``drafting.check``)."""
    from oracle.intake import drafting

    await drafting.check(db, intake)
    existing = await drafting.draft_run(db, intake)
    if existing is not None and existing.status == "draft":
        # Reopening the sheet after an estimate (C4): the intake's one draft run takes
        # the new choices; no second run is made.
        return await _update_draft_run(db, principal, intake, existing.id, body)
    # The brief stays open (Draft with Oracle, PRDs > Ideas, its fields editable) until
    # the run starts: ``drafting.on_start`` converts it then (C4).
    run_id = await create_run(db, principal, intake, body)
    await audit.record(
        db, principal, "intake.run_created", "intake", intake.id, {"run_id": str(run_id)}
    )
    return run_id


async def _update_draft_run(
    db: AsyncSession,
    principal: Principal,
    intake: ProductIntake,
    run_id: uuid.UUID,
    body: IntakeRunIn,
) -> uuid.UUID:
    """The intake's draft run, not started yet, takes the sheet's new choices."""
    patch_body = RunPatch(
        document=body.document,
        template=body.template or intake.draft_template,
        theme=body.theme or intake.draft_theme,
        knobs=await _run_knobs_in(db, intake, body),
    )
    try:
        await runs_service.update_run(db, principal, run_id, patch_body)
    except runs_service.RunError as e:
        raise IntakeError(e.status, str(e)) from e
    return run_id
