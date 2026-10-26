"""Drafting from an intake (C5 Pre-draft questions): the draft gate and the answers a run
reads.

The draft gate (decided 2026-10-21, C5 "Draft gate": drafting waits until decided): a
draft run is neither created from an intake (``POST /v1/intakes/{id}/runs``) nor started
(``POST /v1/runs/{id}/start``) while the intake's review gate is blocked, that is while a
critical blocker everyone may see is neither answered nor decided (accepted as an
assumption, its risk accepted, validated). A private critical gap its author has not
shared gates nothing (S6). There is no "start anyway". A research run (``intake_gap_ids``)
is how a gap gets looked into, so it is not held.

Converting: the intake becomes ``converted`` when its draft run starts, not when the run
is made or estimated (C4): until then the brief keeps Draft with Oracle, stays in PRDs ›
Ideas and its fields stay editable, and reopening the sheet updates that same draft run.

Answers pinned to a run: when a run started from an intake starts, Oracle stores the ids
of the intake's answers that exist then (``knobs.intake_answer_ids``). The run's own reads
(``/v1/answers``, the question batch and the summary) leave out the others, so every
segment sees the same answers; later answers reach the next draft.
"""

import uuid
from dataclasses import dataclass
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit
from oracle.auth.deps import Principal
from oracle.intake.schemas import DraftGateClosedOut
from oracle.runs.models import Run
from oracle.v2.models import ProductIntake, StakeholderAnswer, StakeholderQuestion

ANSWER_IDS = "intake_answer_ids"


class DraftGateClosed(Exception):
    """409 with the gaps that hold the draft (the app's exception handler answers it)."""

    status = 409

    def __init__(self, blocking_gap_ids: list[uuid.UUID]) -> None:
        self.blocking_gap_ids = blocking_gap_ids
        n = len(blocking_gap_ids)
        super().__init__(f"{n} critical question{' is' if n == 1 else 's are'} open on this brief")

    def body(self) -> DraftGateClosedOut:
        return DraftGateClosedOut(detail=str(self), blocking_gap_ids=self.blocking_gap_ids)


async def draft_gate_closed(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, DraftGateClosed)
    return JSONResponse(exc.body().model_dump(mode="json"), exc.status)


async def check(db: AsyncSession, intake: ProductIntake) -> None:
    """Raise :class:`DraftGateClosed` while the intake's gate, as everyone sees it, is
    blocked."""
    from oracle.intake import summary

    view = await summary.View(intake, None).load(db)
    gate = summary.gate(view)
    if gate.gate == "blocked":
        raise DraftGateClosed(gate.blocking_gap_ids)


def _intake_id(run: Run) -> uuid.UUID | None:
    raw = (run.knobs or {}).get("intake_id")
    try:
        return uuid.UUID(str(raw)) if raw else None
    except ValueError:
        return None


async def answer_ids(db: AsyncSession, intake_id: uuid.UUID) -> list[uuid.UUID]:
    """The intake's answers that exist now, oldest first."""
    return list(
        await db.scalars(
            select(StakeholderAnswer.id)
            .join(StakeholderQuestion, StakeholderQuestion.id == StakeholderAnswer.question_id)
            .where(StakeholderQuestion.intake_id == intake_id)
            .order_by(StakeholderAnswer.created_at, StakeholderAnswer.id)
        )
    )


async def on_start(
    db: AsyncSession, run: Run, principal: Principal | str | None = None
) -> dict[str, Any] | None:
    """A run started from an intake: hold a draft run at the gate and convert its intake
    (C4: making or estimating the draft run converts nothing), then the knob that pins the
    answers it reads (None for any other run)."""
    intake_id = _intake_id(run)
    if intake_id is None:
        return None
    intake = await db.get(ProductIntake, intake_id)
    if intake is not None and not (run.knobs or {}).get("intake_gap_ids"):
        await check(db, intake)
        await _convert(db, intake, run, principal)
    return {ANSWER_IDS: [str(a) for a in await answer_ids(db, intake_id)]}


async def _convert(
    db: AsyncSession, intake: ProductIntake, run: Run, principal: Principal | str | None
) -> None:
    """The intake's draft run starts: the brief is converted and links the run's PRD."""
    if intake.status in ("converted", "archived"):
        return
    changes: dict[str, Any] = {"status": [intake.status, "converted"], "run_id": str(run.id)}
    if run.document_id is not None and intake.document_id is None:
        intake.document_id = run.document_id
        changes["document_id"] = [None, str(run.document_id)]
    intake.status = "converted"
    await db.flush()
    if intake.document_id is not None:
        # C1: the requests behind the brief link its PRD.
        from oracle.requests import service as requests_service

        await requests_service.link_intake_document(db, intake.id, intake.document_id)
    await audit.record(db, principal, "intake.converted", "intake", intake.id, changes)


@dataclass(frozen=True)
class Pin:
    """The answers a run reads of its intake: the rest are left out of its reads."""

    intake_id: uuid.UUID
    answer_ids: frozenset[uuid.UUID]

    def keeps(self, intake_id: uuid.UUID | None, answer_id: uuid.UUID) -> bool:
        return intake_id != self.intake_id or answer_id in self.answer_ids


async def pin_of(db: AsyncSession, principal: Principal | None) -> Pin | None:
    """The pin of the run ``principal`` acts for; None for a person or an unpinned run."""
    if principal is None or not principal.is_run:
        return None
    run = await db.get(Run, principal.run_id)
    if run is None:
        return None
    intake_id = _intake_id(run)
    ids = (run.knobs or {}).get(ANSWER_IDS)
    if intake_id is None or not isinstance(ids, list):
        return None
    return Pin(intake_id, frozenset(uuid.UUID(str(i)) for i in ids))


async def draft_run(db: AsyncSession, intake: ProductIntake) -> Run | None:
    """The intake's latest draft run (not a research run)."""
    rows = (
        await db.scalars(
            select(Run)
            .where(Run.knobs["intake_id"].astext == str(intake.id))
            .order_by(Run.created_at.desc(), Run.id)
        )
    ).all()
    return next((r for r in rows if not (r.knobs or {}).get("intake_gap_ids")), None)
