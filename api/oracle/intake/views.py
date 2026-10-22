"""The reader's view of the foundation's thin intake routes (S6).

``GET /v1/intakes``, ``/v1/gaps``, ``/v1/questions``, ``/v1/answers`` and
``/v1/assumption-decisions`` and ``/v1/change-events`` (lists and gets,
``oracle.v2.router``) return what
``oracle.intake.sharing`` lets the reader see: an intake's analysis without the
findings it may not see, no gap the author has not shared (nor its questions, answers,
decisions and change events), and a gap shared as a summary in Oracle's words. The
lists leave those rows out in SQL, before paging (:func:`register`), so a reader's
pages never shift because of rows they may not see. Only rows the call itself may
list are read to find them, and the hidden ids travel as one array parameter. A
question's priority shows to anyone but the author as everyone may see it. Filters
match what readers see: ``/v1/gaps?importance=`` reads an old rule-made row's
importance from the brief as its view does (:func:`gaps_by_importance`); every other
filter (and every question filter: intake, document, gap, status) is on a column that
holds a public value.
"""

import uuid
from typing import Any

from sqlalchemy import Text, Uuid, and_, any_, bindparam, cast, not_, or_, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.deps import Principal
from oracle.intake import drafting, engine, sharing, summary
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
        self.priorities: dict[uuid.UUID, dict[uuid.UUID, int] | None] = {}

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

    async def public_priorities(self, intake: ProductIntake) -> dict[uuid.UUID, int] | None:
        """Question priorities as everyone may see them; None for the author."""
        if intake.id not in self.priorities:
            v = sharing.viewer(self.principal, intake)
            self.priorities[intake.id] = (
                None
                if v.is_author
                else engine.priorities(intake, await engine.intake_gaps(self.db, intake.id))
            )
        return self.priorities[intake.id]

    async def question(self, q: StakeholderQuestion) -> Any | None:
        gap, view = await self.gap_by_id(q.gap_id)
        if gap is None:
            return q
        views = {gap.id: view} if view is not None else {}
        intake = await self.intake(gap.intake_id)
        priorities = await self.public_priorities(intake) if intake is not None else None
        return sharing.question_view(q, {gap.id: gap}, views, priorities)


async def intakes(db: AsyncSession, principal: Principal, rows: list[Any]) -> list[Any]:
    return [await summary.intake_out(db, i, principal) for i in rows]


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
    # A run reads the answers given before it started (C5).
    pin = await drafting.pin_of(db, principal)
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
        if pin is not None and not pin.keeps(q.intake_id if q else None, a.id):
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


def _where(model: Any, filters: dict[str, Any]) -> list[Any]:
    return [getattr(model, name) == value for name, value in filters.items()]


async def hidden_gap_ids(
    db: AsyncSession, principal: Principal, scope: Any = None
) -> set[uuid.UUID]:
    """Gaps of the company's intakes that ``principal`` may not see (S6).

    Only a gap no person created and the engine did not make by rule (one the model
    wrote) can be hidden, so only those are read; ``scope``: a condition on
    ``KnowledgeGap`` narrowing them to what the list call may return."""
    stmt = select(KnowledgeGap).where(
        KnowledgeGap.intake_id.is_not(None),
        KnowledgeGap.created_by.is_(None),
        KnowledgeGap.rule_key.is_(None),
    )
    if scope is not None:
        stmt = stmt.where(scope)
    gaps = (await db.scalars(stmt)).all()
    if not gaps:
        return set()
    ids = list({g.intake_id for g in gaps})
    readers: dict[uuid.UUID, tuple[Any, sharing.Viewer]] = {}
    for intake in (
        await db.scalars(select(ProductIntake).where(ProductIntake.id == any_(_uuids(ids))))
    ).all():
        v = sharing.viewer(principal, intake)
        if not v.is_author:
            readers[intake.id] = (sharing.registry(intake), v)
    return {
        g.id
        for g in gaps
        if g.intake_id in readers and sharing.gap_view(g, *readers[g.intake_id]) is None
    }


def _uuids(ids: Any) -> Any:
    """Ids as one array parameter (a list of binds hits the driver's 32767 limit)."""
    return bindparam(None, list(ids), type_=ARRAY(Uuid()))


def _not_hidden(column: Any, hidden: set[uuid.UUID], nullable: bool = True) -> Any:
    kept = not_(column == any_(_uuids(hidden)))
    return or_(column.is_(None), kept) if nullable else kept


def _hidden(scope, clause):
    """The list's WHERE clause: ``scope(filters)`` narrows the gaps read (None: all
    the list may reach), ``clause(hidden)`` leaves their rows out."""

    async def visible(db: AsyncSession, principal: Principal, filters: dict[str, Any]) -> Any:
        hidden = await hidden_gap_ids(db, principal, scope(filters))
        return clause(hidden) if hidden else None

    return visible


def _gap_scope(filters: dict[str, Any]) -> Any:
    return (KnowledgeGap.id.in_(select(KnowledgeGap.id).where(*_where(KnowledgeGap, filters)))
            if filters else None)  # fmt: skip


def _question_scope(filters: dict[str, Any]) -> Any:
    if not filters:
        return None
    return KnowledgeGap.id.in_(
        select(StakeholderQuestion.gap_id).where(*_where(StakeholderQuestion, filters))
    )


def _answer_scope(filters: dict[str, Any]) -> Any:
    if not filters:
        return None
    return KnowledgeGap.id.in_(
        select(StakeholderQuestion.gap_id).where(
            StakeholderQuestion.id.in_(
                select(StakeholderAnswer.question_id).where(*_where(StakeholderAnswer, filters))
            )
        )
    )


def _decision_scope(filters: dict[str, Any]) -> Any:
    if not filters:
        return None
    return KnowledgeGap.id.in_(
        select(AssumptionDecision.gap_id).where(*_where(AssumptionDecision, filters))
    )


def _event_scope(filters: dict[str, Any]) -> Any:
    if not filters:
        return None
    return cast(KnowledgeGap.id, Text).in_(
        select(ChangeEvent.data["gap_id"].astext).where(*_where(ChangeEvent, filters))
    )


def _answers_kept(hidden: set[uuid.UUID]) -> Any:
    hidden_questions = select(StakeholderQuestion.id).where(
        StakeholderQuestion.gap_id == any_(_uuids(hidden))
    )
    return StakeholderAnswer.question_id.not_in(hidden_questions)


_answers_shared = _hidden(_answer_scope, _answers_kept)


async def _answers_hidden(db: AsyncSession, principal: Principal, filters: dict[str, Any]) -> Any:
    """Answers left out of ``/v1/answers``: those of gaps hidden from the reader (S6) and,
    for a run started from an intake, that intake's answers given after it started (C5),
    so a page of a run's reads never shifts with later answers."""
    clauses = [c for c in [await _answers_shared(db, principal, filters)] if c is not None]
    pin = await drafting.pin_of(db, principal)
    if pin is not None:
        later = select(StakeholderQuestion.id).where(StakeholderQuestion.intake_id == pin.intake_id)
        clauses.append(
            or_(
                StakeholderAnswer.question_id.not_in(later),
                StakeholderAnswer.id == any_(_uuids(pin.answer_ids or {uuid.UUID(int=0)})),
            )
        )
    return and_(*clauses) if clauses else None


def _events_kept(hidden: set[uuid.UUID]) -> Any:
    text = ChangeEvent.data["gap_id"].astext
    ids = bindparam(None, [str(i) for i in hidden], type_=ARRAY(Text()))
    return or_(text.is_(None), not_(text == any_(ids)))


async def gaps_by_importance(db: AsyncSession, principal: Principal, value: Any) -> Any:
    """``/v1/gaps?importance=``: what readers see (S6). A rule-made row from before its
    importance basis was recorded reads its importance from the brief, so it matches on
    that; every other row on its column (its stored value is the public one). Such rows
    are found through a partial index (``ix_knowledge_gaps_legacy_importance``) and the
    next analysis of their intake records their basis, so they do not stay."""
    legacy = (
        await db.scalars(
            select(KnowledgeGap).where(
                KnowledgeGap.intake_id.is_not(None),
                KnowledgeGap.rule_key.is_not(None),
                KnowledgeGap.importance_basis.is_(None),
            )
        )
    ).all()
    regs: dict[uuid.UUID, Any] = {}
    matching = []
    for gap in legacy:
        if gap.intake_id not in regs:
            intake = await db.get(ProductIntake, gap.intake_id)
            regs[gap.intake_id] = sharing.registry(intake) if intake else {}
        if sharing.public_importance(gap, regs[gap.intake_id]) == value:
            matching.append(gap.id)
    stored = KnowledgeGap.importance == value
    if not legacy:
        return stored
    old_ids = [g.id for g in legacy]
    return or_(
        and_(stored, not_(KnowledgeGap.id == any_(_uuids(old_ids)))),
        KnowledgeGap.id == any_(_uuids(matching or [uuid.UUID(int=0)])),
    )


def register() -> None:
    v2_router.register_filter("/gaps", "importance", gaps_by_importance)
    v2_router.register_hidden(
        "/gaps", _hidden(_gap_scope, lambda h: _not_hidden(KnowledgeGap.id, h, nullable=False))
    )
    v2_router.register_hidden(
        "/questions",
        _hidden(_question_scope, lambda h: _not_hidden(StakeholderQuestion.gap_id, h)),
    )
    v2_router.register_hidden("/answers", _answers_hidden)
    v2_router.register_hidden(
        "/assumption-decisions",
        _hidden(_decision_scope, lambda h: _not_hidden(AssumptionDecision.gap_id, h)),
    )
    v2_router.register_hidden("/change-events", _hidden(_event_scope, _events_kept))
    v2_router.register_view("/intakes", intakes)
    v2_router.register_view("/gaps", gaps)
    v2_router.register_view("/questions", questions)
    v2_router.register_view("/answers", answers)
    v2_router.register_view("/assumption-decisions", decisions)
    v2_router.register_view("/change-events", change_events)
