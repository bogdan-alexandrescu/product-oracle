"""Team interviews (C3 lane 2): a member answering the intake's questions with "Oracle
follows up" on.

Each member has one team interview per intake (:func:`open_for`); its messages are the
transcript. A turn (:func:`take_turn`) is one answer to one of the intake's questions:

1. Oracle reads the answer against the gap's statement and stop condition (one inline
   ``interview_turn`` call, 25-second deadline, oracle.interviews.turns). The answer is
   committed before the call, which holds no row lock and no connection; one turn per
   interview runs at a time (a second is 429).
2. When the answer does not meet it and Oracle has not followed up on this question yet,
   Oracle posts one follow-up and waits for the reply (or "Skip, record my answer").
3. Otherwise, or after the reply, the answer is recorded through the answer path
   (oracle.intake.answers: kind ``answer``, the member's messages joined with a blank
   line, "your decision"). A call that fails or runs out of time records the answer as
   written, with the note :data:`COULD_NOT`.

A round is the member's messages on a question since Oracle last recorded an answer to
it (Oracle's ``closing`` message on that question).
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.intake import answers, service
from oracle.intake.schemas import AnswerIn
from oracle.interviews import turns
from oracle.interviews.models import Interview, InterviewMessage
from oracle.interviews.schemas import ANSWER_MAX
from oracle.interviews.service import InterviewError
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, StakeholderQuestion

PROMPT = "interview_team_turn"
RECORDED = "Answer recorded."
COULD_NOT = "Oracle could not follow up; your answer is saved."
SKIPPED = "Skip, record my answer"


async def open_for(db: AsyncSession, principal: Principal, intake_id: uuid.UUID) -> Interview:
    """The caller's team interview for the intake, created on first call."""
    try:
        intake = await service.get_intake(db, intake_id)
    except service.IntakeError as e:
        raise InterviewError(e.status, str(e)) from e
    row = await db.scalar(
        select(Interview).where(
            Interview.kind == "team",
            Interview.intake_id == intake.id,
            Interview.interviewee_user_id == principal.id,
        )
    )
    if row is not None:
        return row
    row = Interview(
        kind="team",
        intake_id=intake.id,
        title=intake.title[:200],
        interviewee_user_id=principal.id,
        status="in_progress",
        created_by=principal.id,
    )
    db.add(row)
    await db.flush()
    await audit.record(db, principal, "interview.created", "interview", row.id, {"kind": "team"})
    return row


async def visible(
    db: AsyncSession, principal: Principal, messages: list[InterviewMessage]
) -> list[InterviewMessage]:
    """The messages of questions whose gap the reader may see (S6: a private finding's
    question is its author's alone)."""
    from oracle.intake.views import Readers

    readers = Readers(db, principal)
    shown: dict[uuid.UUID, bool] = {}
    out = []
    for m in messages:
        if m.question_id is not None and m.question_id not in shown:
            q = await db.get(StakeholderQuestion, m.question_id)
            _, view = await readers.gap_by_id(q.gap_id if q else None)
            shown[m.question_id] = q is None or q.gap_id is None or view is not None
        if m.question_id is None or shown[m.question_id]:
            out.append(m)
    return out


async def _round(
    db: AsyncSession, row: Interview, question_id: uuid.UUID
) -> list[InterviewMessage]:
    """This question's messages since Oracle last recorded an answer to it."""
    messages = list(
        await db.scalars(
            select(InterviewMessage)
            .where(
                InterviewMessage.interview_id == row.id,
                InterviewMessage.question_id == question_id,
            )
            .order_by(InterviewMessage.created_at, InterviewMessage.id)
        )
    )
    closed = [m.created_at for m in messages if m.kind == "closing"]
    return [m for m in messages if not closed or m.created_at > max(closed)]


def _message(row: Interview, question_id: uuid.UUID, role: str, kind: str, body: str, **call):
    # Stamped one by one, so a turn's messages keep their order (as oracle.interviews.public).
    return InterviewMessage(
        interview_id=row.id,
        question_id=question_id,
        role=role,
        kind=kind,
        body=body,
        created_at=datetime.now(UTC),
        **call,
    )


async def next_question(
    db: AsyncSession, principal: Principal, row: Interview, after: uuid.UUID
) -> uuid.UUID | None:
    """The next open question of this intake asked of the member (oldest first)."""
    return await db.scalar(
        select(StakeholderQuestion.id)
        .where(
            StakeholderQuestion.intake_id == row.intake_id,
            StakeholderQuestion.asked_to == principal.id,
            StakeholderQuestion.status.in_(("asked", "delegated")),
            StakeholderQuestion.id != after,
        )
        .order_by(
            StakeholderQuestion.batch,
            StakeholderQuestion.created_at,
            StakeholderQuestion.priority,
            StakeholderQuestion.id,
        )
        .limit(1)
    )


async def _checked(
    db: AsyncSession, principal: Principal, interview_id: uuid.UUID, question_id: uuid.UUID
) -> tuple[Interview, StakeholderQuestion, KnowledgeGap | None]:
    """The interview, the question and its gap when the member may answer it now, read
    fresh (a question may be answered elsewhere while Oracle's call runs)."""
    row = await db.get(Interview, interview_id, populate_existing=True)
    if row is None:
        raise InterviewError(404, "Interview not found")
    if row.kind != "team":
        raise InterviewError(409, "Only a team interview takes team turns")
    if row.interviewee_user_id != principal.id or principal.read_only:
        raise InterviewError(403, "Only its interviewee answers in this interview")
    question = await db.get(StakeholderQuestion, question_id, populate_existing=True)
    if question is None or question.intake_id != row.intake_id:
        raise InterviewError(404, "Question not found")
    intake = await service.get_intake(db, row.intake_id) if row.intake_id else None
    gap = await db.get(KnowledgeGap, question.gap_id) if question.gap_id else None
    if gap is not None:
        try:
            answers.check_visible(principal, intake, gap)
        except service.IntakeError:
            raise InterviewError(404, "Question not found") from None
    if question.status not in answers.ANSWERABLE:
        raise InterviewError(409, "This question is answered; it is not asked again")
    if question.asked_to is not None and question.asked_to != principal.id:
        raise InterviewError(403, "This question was asked of someone else")
    return row, question, gap


async def take_turn(
    db: AsyncSession,
    principal: Principal,
    interview_id: uuid.UUID,
    question_id: uuid.UUID,
    body: str | None,
    skip_follow_up: bool,
) -> tuple[list[InterviewMessage], dict[str, Any] | None]:
    """One turn: (the messages it added, what :func:`answers.answer` did, or None while
    Oracle waits for the reply). The turn's writes are committed here.

    One turn per interview runs at a time (:func:`turns.claim_turn`; another is 429).
    Oracle's call holds no row lock and no connection: the member's answer is written
    and committed first, the model is called, then its result is written. The claim is
    released only once the turn's writes are committed (or rolled back), so the next
    turn reads them and never races them."""
    row, question, gap = await _checked(db, principal, interview_id, question_id)
    await db.commit()  # the reads' connection goes back before the claim takes one
    tenant_id = row.tenant_id  # read now: a rollback below expires the row
    at = await turns.claim_turn(tenant_id, row.id)
    if at is None:
        raise InterviewError(429, "Please wait a moment")
    try:
        out = await _turn(db, principal, row, question, gap, body, skip_follow_up)
        await db.commit()
        return out
    except BaseException:
        await db.rollback()
        raise
    finally:
        await turns.release_turn(tenant_id, interview_id, at)


async def _turn(
    db: AsyncSession,
    principal: Principal,
    row: Interview,
    question: StakeholderQuestion,
    gap: KnowledgeGap | None,
    body: str | None,
    skip_follow_up: bool,
) -> tuple[list[InterviewMessage], dict[str, Any] | None]:
    question_id = question.id
    text = (body or "").strip()
    earlier = await _round(db, row, question_id)
    said = [m.body for m in earlier if m.role == "interviewee" and m.kind == "answer"]
    if not text and not (skip_follow_up and said):
        raise InterviewError(422, "An answer needs a body")
    added: list[InterviewMessage] = []
    if text:
        said.append(text)
        added.append(_message(row, question_id, "interviewee", "answer", text))
    elif skip_follow_up:
        added.append(_message(row, question_id, "interviewee", "skip", SKIPPED))
    joined = "\n\n".join(said)
    if len(joined) > ANSWER_MAX:
        raise InterviewError(422, f"An answer is at most {ANSWER_MAX} characters")

    followed_up = any(m.kind == "follow_up" for m in earlier)
    closing = RECORDED
    call: dict[str, Any] = {}
    db.add_all(added)
    await db.flush()
    if not followed_up and not skip_follow_up:
        payload = {
            "question": question.prompt,
            "gap": (
                {"statement": gap.statement, "stop_condition": gap.stop_condition}
                if gap is not None
                else None
            ),
            "conversation": [{"role": "interviewee", "body": s} for s in said],
            "may_follow_up": True,
        }
        # The answer is saved; the session's connection goes back to the pool and the
        # call runs on a session of its own.
        await db.commit()
        async with tenant_session(row.tenant_id) as own:
            reply, spent = await turns.customer_turn(own, payload, prompt=PROMPT)
        row, question, gap = await _checked(db, principal, row.id, question_id)
        if reply is not None and reply.follow_up:
            note = _message(
                row,
                question_id,
                "oracle",
                "follow_up",
                reply.follow_up,
                model=reply.model,
                usage=reply.usage,
                cost_usd=reply.cost_usd,
            )
            db.add(note)
            await db.flush()
            added.append(note)
            await audit.record(
                db,
                principal,
                "interview.follow_up",
                "interview",
                row.id,
                {"question": str(question_id)},
            )
            return added, None
        if reply is None:
            closing = COULD_NOT
            used = spent
        else:
            used = reply
        if used is not None:
            call = {"model": used.model, "usage": used.usage, "cost_usd": used.cost_usd}

    try:
        result = await answers.answer(
            db,
            principal,
            question,
            AnswerIn(kind="answer", body=joined, knowledge_state="user_decision"),
        )
    except service.IntakeError as e:
        raise InterviewError(e.status, str(e)) from e
    note = _message(row, question_id, "oracle", "closing", closing, **call)
    db.add(note)
    await db.flush()
    added.append(note)
    return added, result
