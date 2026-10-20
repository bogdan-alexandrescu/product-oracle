"""Verified schedule bases: the only thing a roadmap date may rest on (O4, §11.4).

Now/Next/Later on the B2 horizons is the default and needs no date. A date (a dated
milestone, an item's milestone date) is accepted only when a verified estimate, capacity
figure or commitment supports exactly that date:

- a person with the approver role records the basis (``POST /v1/schedule-bases``), with
  the reference a roadmap names (``ENG-412``), its kind, and the date it supports; it may
  come from a tracker record read back (E1), whose own target date must agree;
- a roadmap item's milestone ``date_source`` must name the reference of such a basis,
  and the basis must support the item's date; a track milestone lists its bases;
- a withdrawn basis supports nothing: milestones lose the date it alone supported, and
  roadmap items whose date rested on it are marked potentially stale.

Oracle never proposes a date of its own.
"""

import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.roadmap.models import ScheduleBasis

UNVERIFIED = (
    "a date needs a verified estimate, capacity or commitment that supports it "
    "(record one with POST /v1/schedule-bases); Oracle never invents dates"
)


@dataclass(frozen=True)
class Basis:
    """What the date checks need from a verified basis."""

    id: uuid.UUID
    kind: str
    reference: str
    supports_date: date
    prd_document_id: uuid.UUID | None = None

    @classmethod
    def of(cls, row: ScheduleBasis) -> "Basis":
        return cls(row.id, row.kind, row.reference, row.supports_date, row.prd_document_id)

    def as_json(self) -> dict[str, Any]:
        return {
            "id": str(self.id),
            "kind": self.kind,
            "reference": self.reference,
            "supports_date": self.supports_date.isoformat(),
        }


def now() -> datetime:
    return datetime.now(UTC)


async def verified_bases(db: AsyncSession, prd_document_id: uuid.UUID | None = None) -> list[Basis]:
    """Verified bases usable for this PRD's roadmaps (company-wide ones too)."""
    query = select(ScheduleBasis).where(ScheduleBasis.status == "verified")
    if prd_document_id is not None:
        query = query.where(
            or_(
                ScheduleBasis.prd_document_id.is_(None),
                ScheduleBasis.prd_document_id == prd_document_id,
            )
        )
    else:
        query = query.where(ScheduleBasis.prd_document_id.is_(None))
    rows = await db.scalars(query.order_by(ScheduleBasis.supports_date, ScheduleBasis.reference))
    return [Basis.of(r) for r in rows]


def _names(reference: str, text: str) -> bool:
    """Whether ``text`` names ``reference`` as a whole token, case-insensitively."""
    pattern = r"(?<![A-Za-z0-9])" + re.escape(reference.strip()) + r"(?![A-Za-z0-9])"
    return bool(reference.strip()) and re.search(pattern, text, re.IGNORECASE) is not None


def as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def supporting(when: Any, date_source: str | None, bases: Iterable[Basis]) -> list[Basis]:
    """The verified bases a milestone date rests on: named in ``date_source`` and
    supporting exactly that date. Empty: the date is refused."""
    day = as_date(when)
    if day is None or not date_source:
        return []
    return [b for b in bases if b.supports_date == day and _names(b.reference, date_source)]


async def withdraw(
    db: AsyncSession, principal: Any, basis: ScheduleBasis, reason: str
) -> tuple[list[uuid.UUID], list[uuid.UUID]]:
    """Withdraw a basis. Milestones keep their date only if another verified basis
    supports it; roadmap items whose date rested on it go potentially stale (their
    content stays: an approved version is never rewritten). The caller commits."""
    from oracle import audit
    from oracle.roadmap.models import RoadmapItem, TrackMilestone

    basis.status = "withdrawn"
    basis.withdrawn_by = principal.id
    basis.withdrawn_at = now()
    await db.flush()
    undated: list[uuid.UUID] = []
    for m in await db.scalars(
        select(TrackMilestone).where(TrackMilestone.basis_ids.contains([basis.id]))
    ):
        rest = [b for b in m.basis_ids if b != basis.id]
        still = (
            list(
                await db.scalars(
                    select(ScheduleBasis.id).where(
                        ScheduleBasis.id.in_(rest),
                        ScheduleBasis.status == "verified",
                        ScheduleBasis.supports_date == m.target_date,
                    )
                )
            )
            if rest
            else []
        )
        m.basis_ids = still
        if not still and m.target_date is not None:
            m.target_date = None
            undated.append(m.id)
    stale: list[uuid.UUID] = []
    when = now()
    reason_text = f"the schedule basis {basis.reference} was withdrawn"
    for item in await db.scalars(
        select(RoadmapItem).where(RoadmapItem.milestone["basis_ids"].astext.contains(str(basis.id)))
    ):
        if item.freshness != "potentially_stale" or item.stale_since is None:
            item.stale_since = when
        item.freshness = "potentially_stale"
        item.stale_reasons = [*(item.stale_reasons or []), reason_text][-20:]
        stale.append(item.id)
    await db.flush()
    await audit.record(
        db,
        principal,
        "schedule_basis.withdrawn",
        "schedule_basis",
        basis.id,
        {
            "reference": basis.reference,
            "reason": reason,
            "undated_milestones": [str(i) for i in undated],
            "stale_items": [str(i) for i in stale],
        },
    )
    return undated, stale
