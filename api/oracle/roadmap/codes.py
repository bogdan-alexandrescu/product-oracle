"""every-field: one code, one item. The one check every write of a roadmap item's title or
code passes through: before each flush, a roadmap item added, renamed, given another feature
or brought back from Trash whose title leads with a code ("F-31 Launch flow") another live
item of the same plan (its version, its draft) already reads in its title is refused with
409, in set_code's words ("F-31 is already the code of F-31 Alert routing by team"). Items of
one feature (its slices) share its code. The paths that can say more check first in their
own words (oracle.simple.changes._not_taken, oracle.roadmap.changeset, Apply approved roadmap
in oracle.simple.approved_roadmap, Restore in oracle.simple.trash_items)."""

import re
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

# The read's leading code (oracle.simple.service.coded_title): a code, then the name.
LEADING_CODE = re.compile(r"^[A-Z][A-Z0-9]*-\d+[a-z]?\s+")


class CodeTaken(HTTPException):
    """A code another item of the plan reads already: 409, in set_code's words."""

    def __init__(self, code: str, holder: str) -> None:
        super().__init__(status.HTTP_409_CONFLICT, taken(code, holder))


def taken(code: str, holder: str) -> str:
    return f"{code} is already the code of {holder}"


def title_code(title: str | None) -> str | None:
    """The code a title gives its item ("F-31 Alerts": F-31); None when it leads with none or
    is a code alone."""
    m = LEADING_CODE.match(title or "")
    return m.group(0).strip() if m and title[m.end() :].strip() else None  # type: ignore[index]


def clash(code: str, key: str, feature_id: Any, others: list[Any]) -> Any:
    """The first of ``others`` (items: ``item_key``, ``title``, ``feature_id``) that reads
    ``code`` in its title, other than the item ``key`` and the slices of its feature."""
    for o in others:
        if o.item_key == key or (feature_id is not None and o.feature_id == feature_id):
            continue
        if (title_code(o.title) or "").upper() == code.upper():
            return o
    return None


def _owner(row: Any) -> tuple[str, Any] | None:
    for col in ("roadmap_version_id", "draft_roadmap_id", "simple_draft_id"):
        if getattr(row, col) is not None:
            return col, getattr(row, col)
    return None


def _touched(row: Any, session: Session) -> bool:
    if row in session.new:
        return True
    state = inspect(row)
    return any(state.attrs[c].history.has_changes() for c in ("title", "deleted_at", "feature_id"))


def check_flush(session: Session) -> None:
    """Raises :class:`CodeTaken` when a roadmap item about to be written takes a code another
    live item of its plan reads (what this flush writes counts as written)."""
    from oracle.roadmap.models import RoadmapItem

    rows = [
        o
        for o in (*session.new, *session.dirty)
        if isinstance(o, RoadmapItem)
        and o.roadmap_document_id is not None
        and o.deleted_at is None
        and title_code(o.title)
        and _owner(o) is not None
        and _touched(o, session)
    ]
    if not rows:
        return
    pending = [o for o in session.new if isinstance(o, RoadmapItem)]
    gone = set(session.deleted)
    by_owner: dict[tuple[str, Any], list[Any]] = {}
    for row in rows:
        owner = _owner(row)
        if owner not in by_owner:
            col, value = owner  # type: ignore[misc]
            with session.no_autoflush:
                stored = list(
                    session.scalars(
                        select(RoadmapItem).where(
                            getattr(RoadmapItem, col) == value, RoadmapItem.deleted_at.is_(None)
                        )
                    )
                )
            seen = {id(o) for o in stored}
            live = [*stored, *(o for o in pending if _owner(o) == owner and id(o) not in seen)]
            by_owner[owner] = [o for o in live if o not in gone and o.deleted_at is None]
        others = [o for o in by_owner[owner] if o is not row]
        code = title_code(row.title)
        hit = clash(code, row.item_key, row.feature_id, others)  # type: ignore[arg-type]
        if hit is not None:
            # Two rows written together (a new version's copies): the one that read the code
            # before, on another version of the roadmap, holds it; the other takes it.
            if _held(session, row, code) and not _held(session, hit, code):  # type: ignore[arg-type]
                row, hit = hit, row
            raise CodeTaken(code, hit.title)  # type: ignore[arg-type]


def _held(session: Session, row: Any, code: str) -> bool:
    """``row``'s item read ``code`` already on another row of its roadmap (as it is stored)."""
    from oracle.roadmap.models import RoadmapItem

    with session.no_autoflush:
        titles = session.execute(
            select(RoadmapItem.title).where(
                RoadmapItem.roadmap_document_id == row.roadmap_document_id,
                RoadmapItem.item_key == row.item_key,
                RoadmapItem.id != row.id if row.id is not None else RoadmapItem.id.is_not(None),
            )
        ).scalars()
        return any((title_code(t) or "").upper() == code.upper() for t in titles)
