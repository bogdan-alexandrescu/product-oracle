"""every-field: one code, one item. The code an item shows (:func:`shown_code`) is its
feature's, else its PRD section's, else the one its title leads with ("F-31 Launch flow").
The one check every write of a roadmap item passes through: before each flush, a roadmap item
added, renamed, given another feature or brought back from Trash that would newly show a code
another live item of the same plan (its version, its draft) shows is refused with 409, in
set_code's words ("F-31 is already the code of F-31 Alert routing by team"); a copy of an
item that showed the code already on the version or draft it is copied from (its source,
:func:`copied_from`) is no new claim, and a row with no source claims every code. Items of
one feature (its slices) share its code. The paths that can say more check first in their
own words (oracle.simple.changes._not_taken, oracle.roadmap.changeset, Apply approved roadmap
in oracle.simple.approved_roadmap, Restore in oracle.simple.trash_items)."""

import re
import uuid
from types import SimpleNamespace
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import inspect, or_, select
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
    from sqlalchemy import Text, cast, func

    from oracle.baseline.fixes import DECLINED
    from oracle.baseline.models import Entity
    from oracle.roadmap.models import RoadmapItem

    # An item that declined its feature (Its own feature, oracle.baseline.fixes.own_feature)
    # gives that feature no code, though its published row still names it.
    mark = func.concat(cast(RoadmapItem.roadmap_document_id, Text), "/", RoadmapItem.item_key)
    declined = (
        select(Entity.id)
        .where(
            Entity.id == RoadmapItem.feature_id,
            Entity.attrs.op("->")(DECLINED).op("@>", is_comparison=True)(
                func.jsonb_build_array(mark)
            ),
        )
        .exists()
    )
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
            ~declined,
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


async def item_links(db: Any) -> list[Any]:
    """Every live roadmap item's PRD, goals, feature, PRD section, ``published`` (on a version)
    and ``cut``, oldest first, read once per read (oracle.simple.drafts.one_read): the feature
    codes' sections and the PRD order's main goals (oracle.docs.prd_order) both come from it
    (read-speed)."""
    from oracle.roadmap.models import RoadmapItem
    from oracle.simple import drafts

    async def load() -> list[Any]:
        return list(
            (
                await db.execute(
                    select(
                        RoadmapItem.prd_document_id,
                        RoadmapItem.goal_ids,
                        RoadmapItem.feature_id,
                        RoadmapItem.prd_section_key,
                        RoadmapItem.roadmap_version_id.is_not(None).label("published"),
                        RoadmapItem.cut,
                    ).order_by(RoadmapItem.created_at)
                )
            ).all()
        )

    return await drafts.once("item_links", load)


async def feature_codes(db: Any) -> dict[uuid.UUID, str]:
    """Every feature's code (:func:`_by_feature`), read with an async session."""
    from oracle.simple import drafts

    features, sections = feature_reads()
    if drafts.reading():
        found = [
            (r.feature_id, r.prd_section_key)
            for r in await item_links(db)
            if r.feature_id is not None and r.prd_section_key is not None and r.published
        ]
    else:
        found = list((await db.execute(sections)).all())
    return _by_feature(list((await db.execute(features)).all()), found)


def _feature_codes_sync(session: Session) -> dict[uuid.UUID, str]:
    features, sections = feature_reads()
    with session.no_autoflush:
        return _by_feature(list(session.execute(features).all()),
                           list(session.execute(sections).all()))  # fmt: skip


def clash(
    code: str,
    key: str,
    feature_id: Any,
    others: list[Any],
    by_feature: dict[uuid.UUID, str],
    section: str | None = None,
) -> Any:
    """The first of ``others`` (items: ``item_key``, ``title``, ``feature_id``,
    ``prd_section_key``) that shows ``code``, other than the item ``key`` and the slices of
    its feature: an item of the same feature, or, when the item's feature or PRD section
    (``feature_id``, ``section``) gives it ``code``, an item whose own feature or PRD section
    gives it ``code`` too, unless the two are linked to different features."""
    own = code_of(SimpleNamespace(feature_id=feature_id, prd_section_key=section), by_feature)
    part = (own or "").upper() == code.upper()
    for o in others:
        if o.item_key == key or (feature_id is not None and o.feature_id == feature_id):
            continue
        if (shown(o, by_feature) or "").upper() != code.upper():
            continue
        if (
            part
            and (code_of(o, by_feature) or "").upper() == code.upper()
            and (feature_id is None or o.feature_id is None)
        ):
            continue  # a slice of the same feature, by its code
        return o
    return None


# The version or draft a row is copied from, set by :func:`copied_from`.
_SOURCE = "_code_source"


def copied_from(row: Any, **owner: Any) -> Any:
    """Marks ``row`` (not yet written) a copy of its item on one version or draft
    (``roadmap_version_id=``, ``draft_roadmap_id=`` or ``simple_draft_id=``): a code its item
    shows there is no new claim. Returns ``row``."""
    [(col, value)] = owner.items()
    setattr(row, _SOURCE, (col, value))
    return row


def _source(row: Any) -> tuple[str, Any] | None:
    got = getattr(row, _SOURCE, None)
    return got if got is not None and got[1] is not None else None


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
        hit = clash(code, row.item_key, row.feature_id, others, by_feature,
                    row.prd_section_key)  # fmt: skip
        if hit is not None:
            raise CodeTaken(code, named(hit, by_feature))


def _changed(row: Any) -> bool:
    state = inspect(row)
    return any(
        state.attrs[c].history.has_changes()
        for c in ("title", "deleted_at", "feature_id", "prd_section_key")
    )


def _stored(session: Session, rows: list[Any]) -> dict[tuple[Any, Any, str], list[Any]]:
    """The stored live rows ``rows`` (added rows) are copied from, by source
    (:func:`copied_from`), roadmap and item key: one read for the whole write, of the source
    versions and drafts alone, whatever its size."""
    from oracle.roadmap.models import RoadmapItem

    copies = [o for o in rows if _source(o) is not None]
    if not copies:
        return {}
    sources = {_source(o) for o in copies}
    docs = {o.roadmap_document_id for o in copies}
    keys = {o.item_key for o in copies}
    with session.no_autoflush:
        found = session.execute(
            select(
                RoadmapItem.roadmap_document_id,
                RoadmapItem.item_key,
                RoadmapItem.title,
                RoadmapItem.feature_id,
                RoadmapItem.prd_section_key,
                RoadmapItem.roadmap_version_id,
                RoadmapItem.draft_roadmap_id,
                RoadmapItem.simple_draft_id,
            ).where(
                or_(*(getattr(RoadmapItem, col) == value for col, value in sources)),
                RoadmapItem.roadmap_document_id.in_(docs),
                RoadmapItem.item_key.in_(keys),
                RoadmapItem.deleted_at.is_(None),
            )
        ).all()
    out: dict[tuple[Any, Any, str], list[Any]] = {}
    for o in found:
        out.setdefault((_owner(o), o.roadmap_document_id, o.item_key), []).append(o)
    return out


def _held(
    row: Any,
    code: str,
    by_feature: dict[uuid.UUID, str],
    stored: dict[tuple[Any, Any, str], list[Any]],
) -> bool:
    """``row``'s item shows ``code`` on the version or draft ``row`` is copied from
    (:func:`copied_from`): ``row`` is a copy (a new version's, a carried row) and no new claim.
    A row with no source holds no code."""
    source = stored.get((_source(row), row.roadmap_document_id, row.item_key), [])
    return any((shown(o, by_feature) or "").upper() == code.upper() for o in source)
