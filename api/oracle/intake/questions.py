"""Questions to people (C2): every open question reaches a named person, who answers it
from the Inbox.

- **Who can be asked**: an active member whose role is commenter or above (viewers
  cannot answer); anyone else is 422 "Ask someone who can answer".
- **Private findings stay private** (S6): a question whose gap is hidden from everyone
  but the intake's author is asked of, reassigned or delegated to the author only;
  anyone else is 409 "Share this finding first to ask someone else".
- **Ask a teammate** (:func:`create`): a commenter or above asks a named person about an
  intake, a document section, a run checkpoint item or a baseline entity. These are
  ``general`` questions with no gap ("<name> asks"); the engine's are "Oracle asks".
- **Reassign or withdraw** (:func:`patch`): the asker, the intake's author (an intake's
  question) or an approver; an answered or withdrawn question stays as it is (409).
- **The Inbox** (:func:`inbox`): what is asked of me (``asked`` or ``delegated``), oldest
  first, each as the reader may see it (``oracle.intake.views``), with its asker, its
  subject and the answer paths it offers.

Run tokens never reach these: their routes map to no run scope (``oracle.mcp.scopes``).
Nothing here commits.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.auth.models import User
from oracle.authz import has_role
from oracle.baseline.models import Entity
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.intake import engine, sharing, views
from oracle.intake.schemas import (
    ANSWER_PATHS,
    CheckpointItemSubject,
    DocumentSectionSubject,
    EntitySubject,
    InboxQuestion,
    InboxSubject,
    IntakeSubject,
    OracleAsker,
    PersonAsker,
    QuestionCreate,
    QuestionPatch,
)
from oracle.intake.service import IntakeError
from oracle.members.names import display_name
from oracle.runs.models import Checkpoint
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from oracle.v2.schemas import KnowledgeGapOut, StakeholderQuestionOut

CANNOT_ANSWER = "Ask someone who can answer"
PRIVATE = "Share this finding first to ask someone else"
# Asked of someone, waiting for them: the Inbox's questions (a delegated one is asked of
# the delegate).
OPEN = ("asked", "delegated")
# Final: never moved again.
SETTLED = ("answered", "withdrawn")
# The checkpoint kinds, as the Inbox names them.
CHECKPOINT_LABEL = {
    "baseline_confirm": "Confirm the baseline",
    "feature_set": "Feature set and dependencies",
    "priority_order": "Priority order",
    "prd_review": "PRD review",
    "eng_review": "Engineering review",
    "roadmap_items": "Roadmap items",
    "roadmap_review": "Roadmap review",
}


async def answerer(db: AsyncSession, user_id: uuid.UUID) -> User:
    """The person to ask: an active member who can answer (commenter or above)."""
    user = await db.get(User, user_id)
    if not engine.can_answer(user):
        raise IntakeError(422, CANNOT_ANSWER)
    return user  # type: ignore[return-value]


def private_gap(intake: ProductIntake | None, gap: KnowledgeGap | None) -> bool:
    """A gap hidden from everyone but the intake's author (S6)."""
    if intake is None or gap is None:
        return False
    return sharing.gap_changes(gap, sharing.registry(intake), sharing.EVERYONE) is None


async def check_assignee(
    db: AsyncSession,
    intake: ProductIntake | None,
    gap: KnowledgeGap | None,
    user_id: uuid.UUID,
) -> None:
    """``user_id`` may be asked this question: 422 when they cannot answer, 409 when its
    gap is a private finding and they are not the intake's author."""
    await answerer(db, user_id)
    if private_gap(intake, gap) and intake is not None and user_id != intake.author_id:
        raise IntakeError(409, PRIVATE)


# --- ask a teammate --------------------------------------------------------------------


async def _subject_columns(db: AsyncSession, subject) -> dict:
    """The question's subject columns; 422 when the subject does not exist."""
    if isinstance(subject, IntakeSubject):
        intake = await db.get(ProductIntake, subject.intake_id)
        if intake is None:
            raise IntakeError(422, "No such intake")
        return {"intake_id": intake.id, "document_id": intake.document_id}
    if isinstance(subject, DocumentSectionSubject):
        latest = await _latest(db, subject.document_id)
        if latest is None or await _section(db, latest, subject.section_key) is None:
            raise IntakeError(422, "No such section in the document's latest version")
        return {"document_id": subject.document_id, "section_key": subject.section_key}
    if isinstance(subject, CheckpointItemSubject):
        if await db.get(Checkpoint, subject.checkpoint_id) is None:
            raise IntakeError(422, "No such checkpoint")
        return {"checkpoint_id": subject.checkpoint_id, "item_ref": subject.item_ref}
    assert isinstance(subject, EntitySubject)
    if await db.get(Entity, subject.entity_id) is None:
        raise IntakeError(422, "No such baseline entity")
    return {"entity_id": subject.entity_id}


async def create(
    db: AsyncSession, principal: Principal, body: QuestionCreate
) -> StakeholderQuestion:
    """Ask a named person a question about a subject: asked at once, in no batch."""
    columns = await _subject_columns(db, body.subject)
    await answerer(db, body.asked_to)
    question = StakeholderQuestion(
        category="general",
        prompt=body.prompt,
        rationale=body.rationale,
        priority=100,
        batch=None,
        asked_to=body.asked_to,
        asked_by=principal.id,
        status="asked",
        **columns,
    )
    db.add(question)
    await db.flush()
    await audit.record(
        db, principal, "question.asked", "stakeholder_question", question.id,
        {"subject": body.subject.kind, "asked_to": str(body.asked_to)},
    )  # fmt: skip
    return question


# --- reassign or withdraw -------------------------------------------------------------


async def patch(
    db: AsyncSession, principal: Principal, question: StakeholderQuestion, body: QuestionPatch
) -> StakeholderQuestion:
    intake = await db.get(ProductIntake, question.intake_id) if question.intake_id else None
    gap = await db.get(KnowledgeGap, question.gap_id) if question.gap_id else None
    if gap is not None and intake is not None:
        view = sharing.gap_view(gap, sharing.registry(intake), sharing.viewer(principal, intake))
        if view is None:
            raise IntakeError(404, "Question not found")
    allowed = (
        (question.asked_by is not None and question.asked_by == principal.id)
        or (intake is not None and sharing.is_author(principal, intake))
        or has_role(principal.role, "approver")
    )
    if not allowed:
        raise IntakeError(
            403, "Only the person who asked, the intake's author or an approver can do this"
        )
    if question.status in SETTLED:
        raise IntakeError(409, f"This question is {question.status}; it stays as it is")
    if body.status == "withdrawn":
        question.status = "withdrawn"
        await db.flush()
        await audit.record(
            db, principal, "question.withdrawn", "stakeholder_question", question.id, {}
        )
        return question
    assert body.asked_to is not None
    await check_assignee(db, intake, gap, body.asked_to)
    before = question.asked_to
    question.asked_to = body.asked_to
    await db.flush()
    await audit.record(
        db, principal, "question.reassigned", "stakeholder_question", question.id,
        {"from": str(before) if before else None, "to": str(body.asked_to)},
    )  # fmt: skip
    return question


# --- the Inbox -------------------------------------------------------------------------


async def _latest(db: AsyncSession, document_id: uuid.UUID) -> DocumentVersion | None:
    return await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document_id)
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )


async def _section(db: AsyncSession, version: DocumentVersion, key: str) -> Section | None:
    return await db.scalar(
        select(Section).where(Section.version_id == version.id, Section.section_key == key)
    )


async def subject_of(
    db: AsyncSession, q: StakeholderQuestion, readers: views.Readers
) -> InboxSubject:
    """What the question is about, in the Inbox's words, and where Open goes."""
    if q.checkpoint_id is not None:
        cp = await db.get(Checkpoint, q.checkpoint_id)
        label = CHECKPOINT_LABEL.get(cp.kind, "Checkpoint") if cp else "Checkpoint"
        # The review routes of C7 and D1 come later: the run's decision until then.
        return InboxSubject(
            kind="checkpoint_item", title=f"{label} · {q.item_ref}",
            href=f"/runs/{cp.run_id}#decide" if cp else None,
        )  # fmt: skip
    if q.entity_id is not None:
        ent = await db.get(Entity, q.entity_id)
        return InboxSubject(
            kind="entity", title=f"Baseline · {ent.title if ent else 'an entity'}",
            href=f"/baseline?entity={q.entity_id}",
        )  # fmt: skip
    doc = await db.get(Document, q.document_id) if q.document_id else None
    intake = await readers.intake(q.intake_id)
    if intake is not None:
        # The intake page (C5) comes later: its PRD until then, else nothing to open.
        return InboxSubject(
            kind="intake", title=f"Before drafting · {intake.title}",
            href=f"/documents/{doc.slug}" if doc else None,
        )  # fmt: skip
    if doc is None:
        return InboxSubject(kind="document_section", title="A document", href=None)
    latest = await _latest(db, doc.id)
    if latest is None:
        return InboxSubject(kind="document_section", title=doc.title, href=f"/documents/{doc.slug}")
    section = await _section(db, latest, q.section_key) if q.section_key else None
    title = f"{doc.title} · {section.heading}" if section else doc.title
    anchor = f"#{q.section_key}" if q.section_key else ""
    return InboxSubject(
        kind="document_section", title=title,
        href=f"/documents/{doc.slug}/v/{latest.number}{anchor}",
    )  # fmt: skip


async def inbox(db: AsyncSession, principal: Principal) -> list[InboxQuestion]:
    """The questions asked of the caller and still open, oldest first, as they may see
    them (a hidden one never appears)."""
    me = principal.user_id if principal.kind == "user" else None
    if me is None:
        return []
    rows = (
        await db.scalars(
            select(StakeholderQuestion)
            .where(StakeholderQuestion.asked_to == me, StakeholderQuestion.status.in_(OPEN))
            .order_by(StakeholderQuestion.created_at, StakeholderQuestion.id)
        )
    ).all()
    readers = views.Readers(db, principal)
    names: dict[uuid.UUID, str] = {}
    out = []
    for q in rows:
        shown = await readers.question(q)
        if shown is None:
            continue
        _, gap = await readers.gap_by_id(q.gap_id)
        if q.gap_id is not None and gap is None:
            continue
        if q.gap_id is not None or q.asked_by is None:
            asked_by: OracleAsker | PersonAsker = OracleAsker()
        else:
            if q.asked_by not in names:
                email = await db.scalar(select(User.email).where(User.id == q.asked_by))
                names[q.asked_by] = display_name(email) if email else "Someone"
            asked_by = PersonAsker(id=q.asked_by, name=names[q.asked_by])
        paths = [p for p in ANSWER_PATHS if p != "research" or (q.intake_id and q.gap_id)]
        out.append(
            InboxQuestion(
                question=StakeholderQuestionOut.model_validate(shown),
                asked_by=asked_by,
                subject=await subject_of(db, q, readers),
                gap=KnowledgeGapOut.model_validate(gap) if gap is not None else None,
                answer_paths=paths,
            )
        )
    return out
