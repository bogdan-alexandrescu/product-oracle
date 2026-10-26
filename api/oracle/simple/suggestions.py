"""Simple S2 (#723): Oracle's date suggestions for undated roadmap items. Deterministic: no
model call (oracle.simple.dates.suggest has the rule).

- :func:`regenerate`: every undated item of the company-wide roadmap (read as Oracle)
  gets one open suggestion, replaced when the rule now gives other dates; an item no
  longer undated loses its open one; after a person dismisses one, the item is offered
  nothing for 30 days, and never the dismissed dates again.
- :func:`daily`: :func:`regenerate` once a company day, from the minute tick
  (oracle.ticker.body); the last day it ran is the internal company setting
  :data:`DAY_SETTING`.
- :func:`decide`: accept (the item takes the suggestion's dates, ``date_source``
  ``accepted``), edit (the item takes the person's dates, also ``accepted``) or dismiss.
  Who may: oracle.simple.service.can_decide.
"""

import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import audit, company_time
from oracle.docs import visibility
from oracle.roadmap.models import RoadmapItem
from oracle.simple import dates, service
from oracle.simple.models import RoadmapDateSuggestion
from oracle.tenant_settings import TenantSetting

# ``{"day": "YYYY-MM-DD"}``: the company day the suggestions were last regenerated on.
DAY_SETTING = "simple_date_suggestions"
# A dismissed suggestion's item is offered nothing new for this long (and never the same
# dates again).
DISMISSED_QUIET = timedelta(days=30)


class SuggestionError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


async def regenerate(db: AsyncSession) -> int:
    """Regenerate the open suggestions (the caller commits); how many are open after."""
    principal = visibility.principal_of(db)
    visibility.bind(db, None)
    try:
        read = await service.load(db)
    finally:
        visibility.bind(db, principal)
    entries = read.entries
    durations: dict[str | None, list[int]] = defaultdict(list)
    for e in entries:
        if not e.resolved.start.estimated and not e.resolved.end.estimated:
            durations[e.row.confidence].append(e.resolved.days)
    by_id = read.by_id()
    ids = [e.row.id for e in entries]
    existing: dict[uuid.UUID, list[RoadmapDateSuggestion]] = defaultdict(list)
    if ids:
        for s in await db.scalars(
            select(RoadmapDateSuggestion).where(
                RoadmapDateSuggestion.item_id.in_(ids),
                RoadmapDateSuggestion.status.in_(("open", "dismissed")),
            )
        ):
            existing[s.item_id].append(s)
    now = company_time.now()
    count = 0
    for e in entries:
        rows = existing.get(e.row.id, [])
        current = next((s for s in rows if s.status == "open"), None)
        if not e.resolved.undated or e.status in ("cut", "done"):
            if current is not None:
                await db.delete(current)
            continue
        deps = [(by_id[d].row.title, by_id[d].resolved.end.date) for d in e.depends_on]
        s = dates.suggest(e.window, deps, durations.get(e.row.confidence, []),
                          e.row.confidence, e.row.horizon)  # fmt: skip
        if any(
            r.status == "dismissed"
            and ((r.start_date, r.end_date) == (s.start, s.end) or _recent(r, now))
            for r in rows
        ):
            if current is not None:
                await db.delete(current)
            continue
        count += 1
        if current is not None:
            if (current.start_date, current.end_date, current.basis) != (s.start, s.end, s.basis):
                current.start_date, current.end_date, current.basis = s.start, s.end, s.basis
                current.created_at = now
            continue
        db.add(RoadmapDateSuggestion(item_id=e.row.id, start_date=s.start, end_date=s.end,
                                     basis=s.basis, status="open", created_at=now))  # fmt: skip
    await db.flush()
    return count


async def daily(db: AsyncSession) -> bool:
    """Regenerate once a company day (the caller commits); whether it ran."""
    today = (await company_time.company_today(db)).isoformat()
    row = await db.scalar(select(TenantSetting).where(TenantSetting.key == DAY_SETTING))
    if row is not None and isinstance(row.value, dict) and row.value.get("day") == today:
        return False
    await regenerate(db)
    if row is None:
        db.add(TenantSetting(key=DAY_SETTING, value={"day": today}))
    else:
        row.value = {"day": today}
    await db.flush()
    return True


async def visible(
    db: AsyncSession, principal: Any
) -> list[tuple[RoadmapDateSuggestion, service.Entry, bool]]:
    """The suggestions of the items the reader may see, with their item's entry."""
    read = await service.load(db)
    out = []
    by_id = read.by_id()
    rows = await db.scalars(
        select(RoadmapDateSuggestion).order_by(RoadmapDateSuggestion.created_at.desc())
    )
    for s in rows:
        e = by_id.get(s.item_id)
        if e is not None:
            out.append((s, e, service.can_decide(principal, e, read.deciders)))
    return out


async def decide(
    db: AsyncSession,
    principal: Any,
    suggestion_id: uuid.UUID,
    action: str,
    start: Any = None,
    end: Any = None,
) -> tuple[RoadmapDateSuggestion, RoadmapItem, bool]:
    """Accept, edit or dismiss one suggestion (commits)."""
    read = await service.load(db)
    s = await db.get(RoadmapDateSuggestion, suggestion_id, with_for_update=True)
    entry = read.by_id().get(s.item_id) if s is not None else None
    if s is None or entry is None:
        raise SuggestionError(404, "No such date suggestion")
    if not service.can_decide(principal, entry, read.deciders):
        raise SuggestionError(
            403,
            "Only an owner or the roadmap's decider (with no decider, its owner) decides "
            "date suggestions",
        )
    if s.status != "open":
        raise SuggestionError(409, f"This suggestion is {s.status} already")
    item = entry.row
    before = {"start_date": _iso(item.start_date), "end_date": _iso(item.end_date),
              "date_source": item.date_source}  # fmt: skip
    if action in ("accept", "edit"):
        item.start_date = start if action == "edit" else s.start_date
        item.end_date = end if action == "edit" else s.end_date
        item.date_source = "accepted"
    s.status = {"accept": "accepted", "edit": "edited", "dismiss": "dismissed"}[action]
    s.decided_by = getattr(principal, "user_id", None) or getattr(principal, "id", None)
    s.decided_at = company_time.now()
    await audit.record(
        db, principal, f"roadmap_date_suggestion.{action}", "roadmap_date_suggestion", s.id,
        data={"item_id": str(item.id), "before": before,
              "after": {"start_date": _iso(item.start_date), "end_date": _iso(item.end_date),
                        "date_source": item.date_source}},
    )  # fmt: skip
    await db.commit()
    await db.refresh(s)
    return s, item, True


def _recent(s: RoadmapDateSuggestion, now: datetime) -> bool:
    return s.decided_at is not None and now - s.decided_at < DISMISSED_QUIET


def _iso(d: Any) -> str | None:
    return d.isoformat() if d is not None else None
