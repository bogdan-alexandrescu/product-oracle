"""C5 late answers: an answer given after drafting started becomes feedback on the draft.

The intake's draft run reads the answers pinned when it started (``drafting``). Each
later answer with a body (not "I don't know", defer, delegate or research) becomes one
whole-draft (D13 ``general``) feedback item on the intake's PRD, raised by the person
who answered and linked back to its question (``intake_question_id``) and answer
(``intake_answer_id``, unique: one item per answer). The next draft takes it like any
other open feedback; Oracle's review job looks at it as at any new feedback.

Raised when the answer is given if the PRD has a version, else when the run imports
its draft (:func:`sync`). An answer to a gap others may not read in full (S6: private,
or shared at counts only) is never quoted in feedback, which every approver reads: the
intake page still counts it. The item follows the finding's level (:func:`on_sharing`):
withdrawn when the finding goes back to private or to counts (deleted when nobody acted on
it; kept with its quote withheld when someone did: triaged it, or decided a suggestion on
it), raised or read in full again when it is shared from summary up, also for an answer
given while it was private. Nothing here commits.
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.docs.models import DocumentVersion
from oracle.intake import drafting
from oracle.jobs.models import LlmSuggestion
from oracle.review.models import FeedbackItem
from oracle.runs.models import Run
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderAnswer, StakeholderQuestion

#: How a late answer reads as a feedback item (owner's wording; questions.json).
LEAD = "Answered after drafting started"
#: The summary of an item kept while its finding is not shared in full (#595 re-review).
WITHHELD = f"{LEAD} (withheld while its finding is not shared in full)"


def summary_of(question: StakeholderQuestion, answer: StakeholderAnswer) -> str:
    return f"{LEAD}: {question.prompt} {answer.body}"[:4000]


async def _target(db: AsyncSession, intake: ProductIntake) -> tuple[Run, set[str]] | None:
    """The draft run whose pin makes an answer late, and the pinned answer ids."""
    if intake.status != "converted":
        return None
    run = await drafting.draft_run(db, intake)
    pinned = (run.knobs or {}).get(drafting.ANSWER_IDS) if run is not None else None
    if run is None or not isinstance(pinned, list):
        return None
    return run, {str(i) for i in pinned}


async def latest(db: AsyncSession, document_id: uuid.UUID) -> int | None:
    return await db.scalar(
        select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == document_id)
    )


async def _quotable(db: AsyncSession, intake: ProductIntake, question: StakeholderQuestion) -> bool:
    from oracle.intake.answers import proposal_mode

    gap = await db.get(KnowledgeGap, question.gap_id) if question.gap_id else None
    return gap is None or proposal_mode(intake, gap) == "full"


async def _raise(
    db: AsyncSession,
    intake: ProductIntake,
    document_id: uuid.UUID,
    version: int,
    question: StakeholderQuestion,
    answer: StakeholderAnswer,
) -> FeedbackItem | None:
    if answer.kind != "answer" or not answer.body:
        return None
    if not await _quotable(db, intake, question):
        return None
    kept = await db.scalar(select(FeedbackItem).where(FeedbackItem.intake_answer_id == answer.id))
    if kept is not None:
        if kept.summary == WITHHELD:
            kept.summary = summary_of(question, answer)
            await audit.record(
                db, audit.ORACLE, "feedback.unwithhold", "feedback_item", kept.id,
                {"intake_id": str(intake.id), "reason": "finding_shared"},
            )  # fmt: skip
        return None
    item = FeedbackItem(
        document_id=document_id,
        raised_on_version=version,
        kind="general",
        section_key=None,
        summary=summary_of(question, answer),
        author_id=answer.answered_by,
        status="open",
        intake_question_id=question.id,
        intake_answer_id=answer.id,
        created_at=datetime.now(UTC),
    )
    db.add(item)
    await db.flush()
    await audit.record(
        db, audit.ORACLE, "feedback.create", "feedback_item", item.id,
        {"kind": "general", "raised_on_version": version, "intake_id": str(intake.id),
         "question_id": str(question.id), "answer_id": str(answer.id)},
    )  # fmt: skip
    return item


async def on_answer(
    db: AsyncSession,
    intake: ProductIntake | None,
    question: StakeholderQuestion,
    answer: StakeholderAnswer,
) -> FeedbackItem | None:
    """An answer just given: feedback on the draft when it came after drafting started
    and the draft exists."""
    if intake is None or (target := await _target(db, intake)) is None:
        return None
    run, pinned = target
    if str(answer.id) in pinned:
        return None
    document_id = intake.document_id or run.document_id
    version = await latest(db, document_id) if document_id else None
    if document_id is None or version is None:
        return None
    item = await _raise(db, intake, document_id, version, question, answer)
    if item is not None:
        from oracle.jobs import service as jobs_service

        await jobs_service.on_feedback(db, document_id, version)
    return item


async def sync(db: AsyncSession, run: Run, document_id: uuid.UUID) -> int:
    """The draft run imported a version of ``document_id``: raise the late answers given
    while there was nothing to raise them on. Returns how many items it made."""
    intake_id = (run.knobs or {}).get("intake_id")
    if not intake_id or (run.knobs or {}).get("intake_gap_ids"):
        return 0
    intake = await db.get(ProductIntake, uuid.UUID(str(intake_id)))
    if intake is None or (target := await _target(db, intake)) is None:
        return 0
    draft, pinned = target
    if draft.id != run.id:
        return 0
    if intake.document_id is None:
        intake.document_id = document_id
    version = await latest(db, document_id)
    if version is None:
        return 0
    rows = await db.execute(
        select(StakeholderQuestion, StakeholderAnswer)
        .join(StakeholderAnswer, StakeholderAnswer.question_id == StakeholderQuestion.id)
        .where(StakeholderQuestion.intake_id == intake.id)
        .order_by(StakeholderAnswer.created_at, StakeholderAnswer.id)
    )
    made = 0
    for question, answer in rows.all():
        if str(answer.id) not in pinned:
            made += await _raise(db, intake, document_id, version, question, answer) is not None
    if made:
        from oracle.jobs import service as jobs_service

        await jobs_service.on_feedback(db, document_id, version)
    return made


async def on_sharing(db: AsyncSession, intake: ProductIntake, gaps: list[KnowledgeGap]) -> None:
    """These gaps' findings changed level (S6): the items quoting their late answers are
    withdrawn when others may no longer read the answers in full, and raised when they may
    (#587 review). An item someone acted on (triaged, staged, or with a suggestion decided)
    is kept with its quote withheld, so nothing others did on it goes (#595 re-review)."""
    from oracle.intake.answers import proposal_mode

    hidden = [g.id for g in gaps if proposal_mode(intake, g) != "full"]
    if hidden:
        questions = select(StakeholderQuestion.id).where(
            StakeholderQuestion.intake_id == intake.id, StakeholderQuestion.gap_id.in_(hidden)
        )
        items = list(
            await db.scalars(
                select(FeedbackItem).where(FeedbackItem.intake_question_id.in_(questions))
            )
        )
        decided = set(
            await db.scalars(
                select(LlmSuggestion.feedback_item_id).where(
                    LlmSuggestion.feedback_item_id.in_([i.id for i in items]),
                    LlmSuggestion.status.not_in(("open", "superseded")),
                )
            )
        )
        for item in items:
            acted = (
                item.status != "open"
                or item.resolution_note
                or item.staged_for_agents_at
                or item.id in decided
            )
            if acted and item.summary == WITHHELD:
                continue
            if acted:
                item.summary = WITHHELD
                action = "feedback.withhold"
            else:
                await db.delete(item)
                action = "feedback.withdraw"
            await audit.record(
                db, audit.ORACLE, action, "feedback_item", item.id,
                {"intake_id": str(intake.id), "reason": "finding_not_shared"},
            )  # fmt: skip
        await db.flush()
    shown = [g.id for g in gaps if g.id not in hidden]
    if not shown or (target := await _target(db, intake)) is None:
        return
    run, pinned = target
    document_id = intake.document_id or run.document_id
    version = await latest(db, document_id) if document_id else None
    if document_id is None or version is None:
        return
    rows = await db.execute(
        select(StakeholderQuestion, StakeholderAnswer)
        .join(StakeholderAnswer, StakeholderAnswer.question_id == StakeholderQuestion.id)
        .where(StakeholderQuestion.intake_id == intake.id, StakeholderQuestion.gap_id.in_(shown))
        .order_by(StakeholderAnswer.created_at, StakeholderAnswer.id)
    )
    made = 0
    for question, answer in rows.all():
        if str(answer.id) not in pinned:
            made += await _raise(db, intake, document_id, version, question, answer) is not None
    if made:
        from oracle.jobs import service as jobs_service

        await jobs_service.on_feedback(db, document_id, version)


async def counted(db: AsyncSession, intake: ProductIntake) -> int:
    """How many of the intake's answers became feedback items (not counting ones whose
    quote is withheld)."""
    return (
        await db.scalar(
            select(func.count(FeedbackItem.id))
            .join(StakeholderQuestion, StakeholderQuestion.id == FeedbackItem.intake_question_id)
            .where(StakeholderQuestion.intake_id == intake.id, FeedbackItem.summary != WITHHELD)
        )
        or 0
    )
