"""The reader's view of the foundation's thin intake routes (S6).

``GET /v1/intakes``, ``/v1/gaps``, ``/v1/questions``, ``/v1/answers`` and
``/v1/assumption-decisions`` and ``/v1/change-events`` (lists and gets,
``oracle.v2.router``) return what
``oracle.intake.sharing`` lets the reader see: an intake's analysis without the
findings it may not see, no gap the author has not shared (nor its questions, answers,
decisions and change events), and a gap shared as a summary in Oracle's words. The
lists leave those rows out in SQL, before paging (:func:`register`), so a reader's
pages never shift because of rows they may not see.
"""

import uuid
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.intake import sharing, summary
from oracle.v2 import router as v2_router
from oracle.v2.models import (
    AssumptionDecision,
    ChangeEvent,
    KnowledgeGap,
    ProductIntake,
    StakeholderAnswer,
    StakeholderQuestion,
)
from oracle.v2.schemas import (
    AssumptionDecisionOut,
    ChangeEventOut,
    KnowledgeGapOut,
    StakeholderAnswerOut,
    StakeholderQuestionOut,
)


class Readers:
    """Per-request cache: intakes, and each gap as the principal may see it."""

    def __init__(self, db: AsyncSession, principal: Principal) -> None:
        self.db = db
        self.principal = principal
        self.intakes: dict[uuid.UUID, ProductIntake | None] = {}

    async def intake(self, intake_id: uuid.UUID | None) -> ProductIntake | None:
        if intake_id is None:
            return None
        if intake_id not in self.intakes:
            self.intakes[intake_id] = await self.db.get(ProductIntake, intake_id)
        return self.intakes[intake_id]

    async def gap(self, gap: KnowledgeGap) -> Any | None:
        intake = await self.intake(gap.intake_id)
        if intake is None:
            return gap
        return sharing.gap_view(
            gap, sharing.registry(intake), sharing.viewer(self.principal, intake)
        )

    async def gap_by_id(self, gap_id: uuid.UUID | None) -> tuple[KnowledgeGap | None, Any]:
        """(the gap, its view: None when hidden)."""
        if gap_id is None:
            return None, None
        gap = await self.db.get(KnowledgeGap, gap_id)
        if gap is None:
            return None, None
        return gap, await self.gap(gap)

    async def question(self, q: StakeholderQuestion) -> Any | None:
        gap, view = await self.gap_by_id(q.gap_id)
        if gap is None:
            return q
        views = {gap.id: view} if view is not None else {}
        return sharing.question_view(q, {gap.id: gap}, views)


async def intakes(db: AsyncSession, principal: Principal, rows: list[Any]) -> list[Any]:
    return [summary.intake_out(i, principal) for i in rows]


async def gaps(db: AsyncSession, principal: Principal, rows: list[Any]) -> list[Any]:
    readers = Readers(db, principal)
    out = []
    for gap in rows:
        view = await readers.gap(gap)
        if view is not None:
            out.append(KnowledgeGapOut.model_validate(view))
    return out


async def questions(db: AsyncSession, principal: Principal, rows: list[Any]) -> list[Any]:
    readers = Readers(db, principal)
    out = []
    for q in rows:
        view = await readers.question(q)
        if view is not None:
            out.append(StakeholderQuestionOut.model_validate(view))
    return out


async def answers(db: AsyncSession, principal: Principal, rows: list[Any]) -> list[Any]:
    readers = Readers(db, principal)
    ids = {a.question_id for a in rows}
    found = {
        q.id: q
        for q in (
            await db.scalars(select(StakeholderQuestion).where(StakeholderQuestion.id.in_(ids)))
        ).all()
    }
    out = []
    for a in rows:
        q = found.get(a.question_id)
        if q is not None and await readers.question(q) is None:
            continue
        out.append(StakeholderAnswerOut.model_validate(a))
    return out


async def decisions(db: AsyncSession, principal: Principal, rows: list[Any]) -> list[Any]:
    readers = Readers(db, principal)
    out = []
    for d in rows:
        gap, view = await readers.gap_by_id(d.gap_id)
        if gap is not None and view is None:
            continue
        row = AssumptionDecisionOut.model_validate(d)
        if gap is not None and view is not gap:
            row.statement = view.statement
        out.append(row)
    return out


async def change_events(db: AsyncSession, principal: Principal, rows: list[Any]) -> list[Any]:
    readers = Readers(db, principal)
    out = []
    for event in rows:
        raw = (event.data or {}).get("gap_id")
        if raw:
            try:
                gap, view = await readers.gap_by_id(uuid.UUID(str(raw)))
            except ValueError:
                gap, view = None, None
            if gap is not None and view is None:
                continue
        out.append(ChangeEventOut.model_validate(event))
    return out


# --- hidden rows, in SQL (applied before limit and offset) -------------------------------


async def hidden_gap_ids(db: AsyncSession, principal: Principal) -> set[uuid.UUID]:
    """Gaps of the company's intakes that ``principal`` may not see (S6)."""
    readers: dict[uuid.UUID, tuple[Any, sharing.Viewer]] = {}
    for intake in (await db.scalars(select(ProductIntake))).all():
        v = sharing.viewer(principal, intake)
        if not v.is_author:
            readers[intake.id] = (sharing.registry(intake), v)
    if not readers:
        return set()
    gaps = (
        await db.scalars(select(KnowledgeGap).where(KnowledgeGap.intake_id.in_(list(readers))))
    ).all()
    return {g.id for g in gaps if sharing.gap_view(g, *readers[g.intake_id]) is None}


def _hidden(clause):
    async def visible(db: AsyncSession, principal: Principal) -> Any:
        hidden = await hidden_gap_ids(db, principal)
        return clause(hidden) if hidden else None

    return visible


def _not_hidden(column, hidden: set[uuid.UUID]) -> Any:
    return or_(column.is_(None), column.not_in(hidden))


def register() -> None:
    v2_router.register_hidden("/gaps", _hidden(lambda h: KnowledgeGap.id.not_in(h)))
    v2_router.register_hidden(
        "/questions", _hidden(lambda h: _not_hidden(StakeholderQuestion.gap_id, h))
    )
    v2_router.register_hidden(
        "/answers",
        _hidden(
            lambda h: StakeholderAnswer.question_id.not_in(
                select(StakeholderQuestion.id).where(StakeholderQuestion.gap_id.in_(h))
            )
        ),
    )
    v2_router.register_hidden(
        "/assumption-decisions", _hidden(lambda h: _not_hidden(AssumptionDecision.gap_id, h))
    )
    v2_router.register_hidden(
        "/change-events",
        _hidden(lambda h: _not_hidden(ChangeEvent.data["gap_id"].astext, {str(i) for i in h})),
    )
    v2_router.register_view("/intakes", intakes)
    v2_router.register_view("/gaps", gaps)
    v2_router.register_view("/questions", questions)
    v2_router.register_view("/answers", answers)
    v2_router.register_view("/assumption-decisions", decisions)
    v2_router.register_view("/change-events", change_events)
