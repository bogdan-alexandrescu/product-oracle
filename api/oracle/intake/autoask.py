"""C2 Questions to people under H11 Autonomy (issue #151): the ``questions``
responsibility at each level.

- **observe**: Oracle keeps drafting a question per open gap but asks no one. No next
  batch is proposed (:data:`OBSERVE`, shown instead), asking a batch is refused, and a
  new brief asks no first batch. A person asking a teammate directly is never stopped.
- **draft**: the next batch lists the drafted questions, each with its own named person
  (the gap's owner, else the brief's author), not the reader; a person sends it. A new
  brief asks no first batch.
- **recommend** (the default): today's behaviour.
- **act**: :func:`tick_due` (the ticker) asks the next batch of each live brief on
  Oracle's own account once nothing asked earlier is still waiting on an answer, never
  past ``max_per_person_per_week`` questions Oracle asked one person in the last seven
  days (counted from its ``intake.questions_asked`` audit events), then tells the
  brief's author ("Oracle did"; Undo withdraws what it asked that is still waiting).
"""

import logging
import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, autonomy
from oracle.intake import engine, sharing
from oracle.models import AuditEvent
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion

log = logging.getLogger(__name__)

KEY = "questions"
OBSERVE = (
    "Oracle is set to observe questions: it asks no one. "
    "An owner can change this in Settings › Autonomy."
)
# The batch Oracle asks on its own (the size a brief asks first by default).
SIZE = 5
# Briefs Oracle asks for: analysed, neither drafting nor archived.
LIVE = ("awaiting_answers", "ready")
# A question still waiting on a person's answer.
WAITING = ("asked", "delegated")
ASKED = "intake.questions_asked"
WEEK = timedelta(days=7)


async def held(db: AsyncSession) -> str | None:
    """Why no batch is proposed or asked now, in plain words; None when a person may ask."""
    return None if await autonomy.allows(db, KEY, "draft") else OBSERVE


async def asks_first_batch(db: AsyncSession) -> bool:
    """Whether a new brief asks its first batch (Recommend and up, today's behaviour)."""
    return await autonomy.allows(db, KEY, "recommend")


async def proposes_asker(db: AsyncSession) -> bool:
    """Whether the preview may fall back to the reader as the person asked (Recommend
    and up); at Draft each question keeps its own named person."""
    return await autonomy.allows(db, KEY, "recommend")


async def _asked_this_week(db: AsyncSession) -> Counter[uuid.UUID]:
    """How many questions Oracle asked each person in the last seven days."""
    since = datetime.now(UTC) - WEEK
    rows = await db.scalars(
        select(AuditEvent.data).where(
            AuditEvent.actor == audit.ORACLE,
            AuditEvent.action == ASKED,
            AuditEvent.created_at >= since,
        )
    )
    used: Counter[uuid.UUID] = Counter()
    for data in rows:
        for person in (data or {}).get("asked_to") or []:
            try:
                used[uuid.UUID(person)] += 1
            except (TypeError, ValueError):
                continue
    return used


async def _within_cap(
    db: AsyncSession,
    intake: ProductIntake,
    questions: list[StakeholderQuestion],
    gaps: dict[uuid.UUID, KnowledgeGap],
    skip: set[uuid.UUID],
    used: Counter[uuid.UUID],
    cap: int,
) -> set[uuid.UUID]:
    """``skip`` grown by the gaps whose question would take its person past ``cap``, so
    :func:`engine.ask_batch` with it asks only within the cap (it chooses and names the
    person exactly as here)."""
    reg = sharing.registry(intake)
    able: dict[uuid.UUID, bool] = {}
    for _ in range(len(questions) + 1):
        batch = engine.choose_batch(questions, gaps, reg, SIZE, skip)
        taken: Counter[uuid.UUID] = Counter()
        over = None
        for q in batch.questions:
            gap = gaps.get(q.gap_id) if q.gap_id else None
            person = await engine.default_person(db, intake, q, gap, None, False, able)
            if used[person] + taken[person] >= cap:
                over = q
                break
            taken[person] += 1
        if over is None:
            return skip
        if over.gap_id is None:
            # Cannot be left out on its own: ask nothing for this brief.
            return skip | {q.gap_id for q in questions if q.gap_id}
        skip = skip | {over.gap_id}
    return skip


async def _ask_one(
    db: AsyncSession, intake: ProductIntake, used: Counter[uuid.UUID], cap: int
) -> list[StakeholderQuestion]:
    questions = await engine.intake_questions(db, intake.id)
    if any(q.status in WAITING for q in questions) or not any(
        q.status == "draft" for q in questions
    ):
        return []
    gaps = {g.id: g for g in await engine.intake_gaps(db, intake.id)}
    reg = sharing.registry(intake)
    # Only what everyone may see (S6): the author's private findings stay theirs to ask.
    skip = {g.id for g in gaps.values() if sharing.gap_changes(g, reg, sharing.EVERYONE) is None}
    skip = await _within_cap(db, intake, questions, gaps, skip, used, cap)
    asked = await engine.ask_batch(db, intake, None, SIZE, skip)
    if not asked:
        return []
    people = [q.asked_to for q in asked if q.asked_to is not None]
    used.update(people)
    await audit.record(
        db,
        audit.ORACLE,
        ASKED,
        "intake",
        intake.id,
        {
            "batch": asked[0].batch,
            "question_ids": [str(q.id) for q in asked],
            "asked_to": [str(p) for p in people],
        },
    )
    return asked


async def _names(db: AsyncSession, people: list[uuid.UUID]) -> str:
    from oracle.auth.models import User
    from oracle.members.names import display_name

    names = []
    for person in dict.fromkeys(people):
        user = await db.get(User, person)
        if user is not None:
            names.append(display_name(user.email, user.name))
    if len(names) <= 2:
        return " and ".join(names)
    return f"{', '.join(names[:-1])} and {names[-1]}"


async def tick_due(db: AsyncSession) -> int:
    """At "Act within limits": ask the next batch of each live brief whose earlier
    questions are all settled, within the weekly cap a person, and tell its author.
    Returns how many batches were asked. Flushes; the caller commits."""
    if not await autonomy.allows(db, KEY, "act"):
        return 0
    limits = await autonomy.limits(db, KEY)
    cap = int(getattr(limits, "max_per_person_per_week", 5))
    used = await _asked_this_week(db)
    intakes = await db.scalars(
        select(ProductIntake)
        .where(
            ProductIntake.status.in_(LIVE),
            ProductIntake.id.in_(
                select(StakeholderQuestion.intake_id).where(StakeholderQuestion.status == "draft")
            ),
        )
        .order_by(ProductIntake.created_at, ProductIntake.id)
    )
    batches = 0
    for intake in list(intakes):
        asked = await _ask_one(db, intake, used, cap)
        if not asked:
            continue
        batches += 1
        n = len(asked)
        who = await _names(db, [q.asked_to for q in asked if q.asked_to is not None])
        what = f"{n} question{'' if n == 1 else 's'} about '{intake.title}'"
        await autonomy.acted(
            db,
            KEY,
            summary=f"Asked {who} {what}" if who else f"Asked {what}",
            subject={"kind": "intake", "key": str(intake.id), "href": f"/intakes/{intake.id}"},
            undo={
                "method": "POST",
                "path": f"/v1/intakes/{intake.id}/questions/withdraw",
                "body": {"question_ids": [str(q.id) for q in asked]},
            },
            notify=[intake.author_id] if intake.author_id else [],
        )
    await db.flush()
    return batches
