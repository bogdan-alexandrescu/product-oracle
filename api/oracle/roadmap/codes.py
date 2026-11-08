"""every-field: one code, one item. The code an item shows (:func:`shown_code`) is its
feature's, else its PRD section's, else the one its title leads with ("F-31 Launch flow").
The one check every write of a roadmap item passes through: before each flush, a roadmap item
added, renamed, given another feature or brought back from Trash that would newly show a code
another live item of the same plan (its version, its draft) shows is refused with 409, in
set_code's words ("F-31 is already the code of F-31 Alert routing by team"); a copy of an
item that showed the code already (a new version's, a carried row) is no new claim. Items of
one feature (its slices) share its code. The paths that can say more check first in their
own words (oracle.simple.changes._not_taken, oracle.roadmap.changeset, Apply approved roadmap
in oracle.simple.approved_roadmap, Restore in oracle.simple.trash_items)."""

import re
import uuid
from types import SimpleNamespace
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


def shown_code(title: str | None, code: str | None) -> str | None:
    """The code a person sees on an item: ``code`` (its feature's, else its PRD section's:
    :func:`code_of`), else the one its title leads with."""
    return code or title_code(title)


def code_of(row: Any, by_feature: dict[uuid.UUID, str]) -> str | None:
    """An item's code from its feature (``by_feature``: :func:`feature_codes`), else its PRD
    section's; None for an item with neither."""
    from oracle.simple.priorities import prd_code

    got = by_feature.get(row.feature_id) if row.feature_id is not None else None
    return got or prd_code(getattr(row, "prd_section_key", None))


def shown(row: Any, by_feature: dict[uuid.UUID, str]) -> str | None:
    """The code ``row`` (``title``, ``feature_id``, ``prd_section_key``) shows."""
    return shown_code(row.title, code_of(row, by_feature))


def named(row: Any, by_feature: dict[uuid.UUID, str]) -> str:
    """An item as a person reads it: the code it shows, then its name ("F-31 Shipping step")."""
    from oracle.simple.service import coded_title

    code, name = coded_title(row.title, code_of(row, by_feature))
    return f"{code} {name}" if code else name


def feature_reads() -> tuple[Any, Any]:
    """The two reads every feature's code comes from: the features, oldest first, and the PRD
    sections their published items came from (Priorities' _short_codes reads them too)."""
    from oracle.baseline.models import Entity
    from oracle.roadmap.models import RoadmapItem

    features = (
        select(Entity.id, Entity.key, Entity.title)
        .where(Entity.type == "feature")
        .order_by(Entity.created_at, Entity.key)
    )
    sections = (
        select(RoadmapItem.feature_id, RoadmapItem.prd_section_key)
        .where(
            RoadmapItem.feature_id.is_not(None),
            RoadmapItem.prd_section_key.is_not(None),
            # Published roadmaps only: a draft's code is not every reader's.
            RoadmapItem.roadmap_version_id.is_not(None),
        )
        .order_by(RoadmapItem.created_at)
    )
    return features, sections


def prd_by_key(key_of: dict[uuid.UUID, str], sections: Any) -> dict[str, str]:
    """Each feature's PRD code (F-06) by its key, from the first section that gives one."""
    from oracle.simple.priorities import prd_code

    prd: dict[str, str] = {}
    for fid, section in sections:
        code = prd_code(section)
        if code and fid in key_of:
            prd.setdefault(key_of[fid], code)
    return prd


def _by_feature(features: list[Any], sections: list[Any]) -> dict[uuid.UUID, str]:
    """Each feature's code when it is a code (its key, F-12, or its PRD section's, F-06: as
    Priorities reads it, oracle.simple.priorities._short_codes), by the feature's id."""
    from oracle.simple.priorities import FEATURE_CODE, short_codes

    key_of = {i: k for i, k, _ in features}
    prd = prd_by_key(key_of, sections)
    names = {k: t for _, k, t in features if (t or "").strip()}
    made = short_codes([k for _, k, _ in features], prd, names)
    return {
        fid: code
        for (fid, _, _), code in zip(features, made, strict=True)
        if code and FEATURE_CODE.fullmatch(code.split(".")[0])
    }


async def feature_codes(db: Any) -> dict[uuid.UUID, str]:
    """Every feature's code (:func:`_by_feature`), read with an async session."""
    features, sections = feature_reads()
    return _by_feature(list((await db.execute(features)).all()),
                       list((await db.execute(sections)).all()))  # fmt: skip


def _feature_codes_sync(session: Session) -> dict[uuid.UUID, str]:
    features, sections = feature_reads()
    with session.no_autoflush:
        return _by_feature(list(session.execute(features).all()),
                           list(session.execute(sections).all()))  # fmt: skip


def clash(
    code: str, key: str, feature_id: Any, others: list[Any], by_feature: dict[uuid.UUID, str]
) -> Any:
    """The first of ``others`` (items: ``item_key``, ``title``, ``feature_id``,
    ``prd_section_key``) that shows ``code``, other than the item ``key`` and the slices of
    its feature."""
    for o in others:
        if o.item_key == key or (feature_id is not None and o.feature_id == feature_id):
            continue
        if (shown(o, by_feature) or "").upper() == code.upper():
            return o
    return None


def _owner(row: Any) -> tuple[str, Any] | None:
    for col in ("roadmap_version_id", "draft_roadmap_id", "simple_draft_id"):
        if getattr(row, col) is not None:
            return col, getattr(row, col)
    return None


def _before(row: Any, name: str) -> Any:
    history = inspect(row).attrs[name].history
    return history.deleted[0] if history.deleted else getattr(row, name)


def _claims(
    session: Session, row: Any, code: str, by_feature: dict[uuid.UUID, str], stored: Any
) -> bool:
    """Whether this write newly gives ``row`` the ``code`` it shows: an added row that is no
    copy of its item showing it already (:func:`_held`, over ``stored``: :func:`_stored`), a
    row brought back from Trash, or one whose title, feature or PRD section now shows another
    code."""
    if row in session.new:
        return not _held(row, code, by_feature, stored)
    if _before(row, "deleted_at") is not None:
        return True
    before = SimpleNamespace(**{c: _before(row, c) for c in ("title", "feature_id",
                                                             "prd_section_key")})  # fmt: skip
    return (shown(before, by_feature) or "").upper() != code.upper()


def check_flush(session: Session) -> None:
    """Raises :class:`CodeTaken` when a roadmap item about to be written newly shows a code
    another live item of its plan shows (what this flush writes counts as written)."""
    from oracle.roadmap.models import RoadmapItem
    from oracle.simple.priorities import prd_code

    rows = [
        o
        for o in (*session.new, *session.dirty)
        if isinstance(o, RoadmapItem)
        and o.roadmap_document_id is not None
        and o.deleted_at is None
        and (title_code(o.title) or o.feature_id is not None or prd_code(o.prd_section_key))
        and _owner(o) is not None
        and (o in session.new or _changed(o))
    ]
    if not rows:
        return
    by_feature = _feature_codes_sync(session)
    stored_rows = _stored(session, [o for o in rows if o in session.new])
    pending = [o for o in session.new if isinstance(o, RoadmapItem)]
    gone = set(session.deleted)
    by_owner: dict[tuple[str, Any], list[Any]] = {}
    for row in rows:
        code = shown(row, by_feature)
        if code is None or not _claims(session, row, code, by_feature, stored_rows):
            continue
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
        hit = clash(code, row.item_key, row.feature_id, others, by_feature)
        if hit is not None:
            raise CodeTaken(code, named(hit, by_feature))


def _changed(row: Any) -> bool:
    state = inspect(row)
    return any(
        state.attrs[c].history.has_changes()
        for c in ("title", "deleted_at", "feature_id", "prd_section_key")
    )


def _stored(session: Session, rows: list[Any]) -> dict[tuple[Any, str], list[Any]]:
    """The stored live rows of the items ``rows`` add, by roadmap and item key: one read for
    the whole write, whatever its size."""
    from oracle.roadmap.models import RoadmapItem

    if not rows:
        return {}
    docs = {o.roadmap_document_id for o in rows}
    keys = {o.item_key for o in rows}
    with session.no_autoflush:
        found = session.execute(
            select(
                RoadmapItem.roadmap_document_id,
                RoadmapItem.item_key,
                RoadmapItem.title,
                RoadmapItem.feature_id,
                RoadmapItem.prd_section_key,
                RoadmapItem.created_at,
                RoadmapItem.roadmap_version_id,
                RoadmapItem.draft_roadmap_id,
                RoadmapItem.simple_draft_id,
            ).where(
                RoadmapItem.roadmap_document_id.in_(docs),
                RoadmapItem.item_key.in_(keys),
                RoadmapItem.deleted_at.is_(None),
            )
        ).all()
    out: dict[tuple[Any, str], list[Any]] = {}
    for o in found:
        out.setdefault((o.roadmap_document_id, o.item_key), []).append(o)
    return out


def _held(
    row: Any, code: str, by_feature: dict[uuid.UUID, str], stored: dict[tuple[Any, str], list[Any]]
) -> bool:
    """``row``'s item shows ``code`` on the row it is copied from (its latest stored live row
    of another version or draft of its roadmap): ``row`` is a copy (a new version's, a
    draft's, a carried row). An older row that showed it does not count: the item gave the
    code up since."""
    mine = _owner(row)
    source = [o for o in stored.get((row.roadmap_document_id, row.item_key), [])
              if _owner(o) != mine]  # fmt: skip
    if not source:
        return False
    latest = max(o.created_at for o in source)
    return any(
        (shown(o, by_feature) or "").upper() == code.upper()
        for o in source
        if o.created_at == latest
    )
