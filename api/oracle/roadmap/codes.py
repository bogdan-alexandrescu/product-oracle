"""every-field: one code, one item. The code an item shows (:func:`shown_code`) is its
feature's, else its PRD section's, else the one its title leads with ("F-31 Launch flow").
The one check every write of a roadmap item passes through: before each flush, a roadmap item
added, renamed, given another feature or brought back from Trash that would newly show, as its
own (its title's), a code another live item of the same plan shows (its version, its draft, the
working draft opened on its version) is refused with 409, in set_code's words ("F-31 is already
the code of F-31 Alert routing by team"); one that takes it from its feature or PRD section
gets the next free number at once instead (codes-at-write, Nov 23: the first item of a feature
on a plan keeps its code). A copy of an item that showed the code already on the version or
draft it is copied from (its source, :func:`copied_from`) is no new claim and keeps it, and a
row with no source claims every code. The paths that can say more check a typed code first in
their own words (oracle.simple.changes._not_taken, oracle.roadmap.changeset, Apply approved
roadmap in oracle.simple.approved_roadmap, Restore in oracle.simple.trash_items)."""

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
    """The code a person sees on an item: its own, the one its title leads with, else
    ``code`` (its feature's, else its PRD section's: :func:`inherited`)."""
    return title_code(title) or code


def inherited(row: Any, by_feature: dict[uuid.UUID, str]) -> str | None:
    """The code an item takes from its feature (``by_feature``: :func:`feature_codes`), else
    from its PRD section; None for an item with neither."""
    from oracle.simple.priorities import prd_code

    got = by_feature.get(row.feature_id) if getattr(row, "feature_id", None) is not None else None
    return got or prd_code(getattr(row, "prd_section_key", None))


def code_of(row: Any, by_feature: dict[uuid.UUID, str]) -> str | None:
    """unique-codes (Nov 23): an item's own code, the one its title leads with, else the one
    it takes from its feature or PRD section (:func:`inherited`); None for an item with none.
    Every item has its own: two items of one feature never read the same code."""
    return title_code(getattr(row, "title", None)) or inherited(row, by_feature)


def next_number(used: Any) -> str:
    """unique-codes: the next free feature code, the highest F-number in ``used`` (codes,
    "F-12", "F-37a", "F-12.2"; None skipped) plus one. The one numbering rule: a new item
    (oracle.simple.additions._next_code) and the duplicate-code migration both use it."""
    nums = [int(m.group(1)) for u in used if u and (m := _F_NUMBER.fullmatch(u.split(".")[0]))]
    return f"F-{max(nums, default=0) + 1}"


_F_NUMBER = re.compile(r"F-(\d+)[a-j]?")


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
    title: str | None = None,
) -> Any:
    """The first of ``others`` (items: ``item_key``, ``title``, ``feature_id``,
    ``prd_section_key``) that shows ``code``, other than the item ``key``, when ``code`` is the
    item's own (its title's): a typed code that is taken. An item that takes ``code`` from its
    feature or PRD section (``feature_id``, ``section``) is never refused: codes-at-write
    (Nov 23) gives it the next free number at write when another item shows it
    (:func:`check_flush`)."""
    del feature_id, section
    if not title_code(title):
        return None
    for o in others:
        if o.item_key != key and (shown(o, by_feature) or "").upper() == code.upper():
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
    """Raises :class:`CodeTaken` when a roadmap item about to be written newly shows, as its
    own (its title's), a code another live item of its plan shows (what this flush writes
    counts as written). codes-at-write (the owner, Nov 23: "Number them at write"): an item
    that would newly show a code it takes from its feature or PRD section, which another item
    of its plan shows already, gets the next free number at once (:func:`_number`), so no
    write makes a pair and none is refused. The first item of a feature on a plan keeps the
    feature's code; a copy (:func:`copied_from`) keeps its code; a row in Trash or on an older
    version is never written here."""
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
    claims = [
        (row, code)
        for row in rows
        if (code := shown(row, by_feature)) is not None
        and _claims(session, row, code, by_feature, stored_rows)
    ]
    if not claims:
        return
    # A typed code first, checked against every item of the plan, this write's too (it is
    # refused when taken); then the codes taken from a feature, in the order written: the
    # first item of a feature keeps its code, a later one is numbered.
    claims.sort(key=lambda rc: title_code(rc[0].title) is None)
    waiting = {id(r) for r, _ in claims}
    if any(title_code(r.title) is None for r, _ in claims):
        # Before reading the plan: a write that may number an item waits for any other
        # (oracle.simple.additions._next_code's lock), so two writes never both keep one code.
        lock(session)
    by_owner: dict[tuple[str, Any], list[Any]] = {}
    numbering = _Numbering(session, by_feature)
    for row, code in claims:
        owner = _owner(row)
        if owner not in by_owner:
            by_owner[owner] = _plan(session, owner, pending, gone)  # type: ignore[arg-type]
        waiting.discard(id(row))
        typed = title_code(row.title) is not None
        others = [o for o in by_owner[owner] if o is not row and (typed or id(o) not in waiting)]
        if typed:
            hit = clash(code, row.item_key, row.feature_id, others, by_feature,
                        row.prd_section_key, row.title)  # fmt: skip
            if hit is not None:
                raise CodeTaken(code, named(hit, by_feature))
            continue
        # Its draft's plan: the rows of the version it was opened on count too.
        others += _base_rows(session, row, owner, by_owner)  # type: ignore[arg-type]
        # A version's plan: the rows of the working draft opened on it count too.
        others += _draft_rows(session, row, owner, by_owner, pending, gone)  # type: ignore[arg-type]
        if any(
            o.item_key != row.item_key and (shown(o, by_feature) or "").upper() == code.upper()
            for o in others
        ):
            numbering.give(row, code)


def claim(session: Session, ids: list[Any]) -> None:
    """codes-at-write for rows written past the flush (Restore's UPDATE in
    oracle.trash.service.restore_entry): each live row of ``ids`` that shows a code it takes
    from its feature or PRD section, which another item of its plan shows, gets the next free
    number now, as :func:`check_flush` gives it."""
    from oracle.roadmap.models import RoadmapItem

    if not ids:
        return
    with session.no_autoflush:
        rows = list(
            session.scalars(
                select(RoadmapItem)
                .where(RoadmapItem.id.in_(ids), RoadmapItem.deleted_at.is_(None))
                .execution_options(populate_existing=True)
            )
        )
    rows = [o for o in rows if _owner(o) is not None and not title_code(o.title)]
    if not rows:
        return
    by_feature = _feature_codes_sync(session)
    claims = [(o, c) for o in rows if (c := inherited(o, by_feature)) is not None]
    if not claims:
        return
    lock(session)
    by_owner: dict[tuple[str, Any], list[Any]] = {}
    numbering = _Numbering(session, by_feature)
    for row, code in claims:
        owner = _owner(row)
        if owner is None:
            continue
        if owner not in by_owner:
            by_owner[owner] = _plan(session, owner, [], set())
        others = [o for o in by_owner[owner] if o is not row]
        others += _base_rows(session, row, owner, by_owner)
        others += _draft_rows(session, row, owner, by_owner, [], set())
        if any(
            o.item_key != row.item_key and (shown(o, by_feature) or "").upper() == code.upper()
            for o in others
        ):
            numbering.give(row, code)


def lock(session: Session) -> None:
    """The one lock every numbering takes (oracle.simple.additions._next_code's): held to the
    end of the write's transaction."""
    from sqlalchemy import text

    with session.no_autoflush:
        session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended('roadmap.next_code', 0))")
        )


def _plan(session: Session, owner: tuple[str, Any], pending: list[Any], gone: set) -> list[Any]:
    """The live rows of one version or draft, stored and about to be written."""
    from oracle.roadmap.models import RoadmapItem

    col, value = owner
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
    return [o for o in live if o not in gone and o.deleted_at is None]


def _base_rows(
    session: Session, row: Any, owner: tuple[str, Any], by_owner: dict[tuple[str, Any], list]
) -> list[Any]:
    """A Simple draft's row: the live rows of the version its draft was opened on whose items
    the draft does not hold itself; [] for a row of a version or a draft roadmap."""
    from oracle.roadmap.models import RoadmapItem
    from oracle.simple.models import SimpleDraft

    if owner[0] != "simple_draft_id":
        return []
    with session.no_autoflush:
        draft = session.get(SimpleDraft, owner[1])
        if draft is None or draft.base_version_id is None:
            return []
        base = ("roadmap_version_id", draft.base_version_id)
        if base not in by_owner:
            by_owner[base] = list(
                session.scalars(
                    select(RoadmapItem).where(
                        RoadmapItem.roadmap_version_id == draft.base_version_id,
                        RoadmapItem.deleted_at.is_(None),
                    )
                )
            )
    mine = {o.item_key for o in by_owner[owner]}
    return [o for o in by_owner[base] if o.item_key not in mine and o is not row]


def _draft_rows(
    session: Session,
    row: Any,
    owner: tuple[str, Any],
    by_owner: dict[tuple[str, Any], list],
    pending: list[Any],
    gone: set,
) -> list[Any]:
    """A version's row: the live rows of the working Simple drafts opened on that version (a
    PRD import's slices, as the Roadmap read shows them beside it); [] for any other row."""
    from oracle.simple.models import SimpleDraft

    if owner[0] != "roadmap_version_id":
        return []
    with session.no_autoflush:
        drafts = list(
            session.scalars(
                select(SimpleDraft.id).where(
                    SimpleDraft.base_version_id == owner[1], SimpleDraft.status == "working"
                )
            )
        )
    out: list[Any] = []
    for d in drafts:
        key = ("simple_draft_id", d)
        if key not in by_owner:
            by_owner[key] = _plan(session, key, pending, gone)
        out += [o for o in by_owner[key] if o is not row]
    return out


# The audit action of a numbering, the migration's (0136_unique_item_codes).
RENUMBERED = "roadmap.item.code_renumbered"
# The longest title (oracle.simple.changes.TITLE_MAX).
_TITLE_MAX = 200


class _Numbering:
    """The next free numbers of one write (:func:`next_number` over every code in use: any
    item's title on any roadmap, version, draft or Trash, every feature's code and key),
    read once, after :func:`lock`."""

    def __init__(self, session: Session, by_feature: dict[uuid.UUID, str]) -> None:
        self.session, self.by_feature = session, by_feature
        self.used: list[str | None] | None = None

    def _read(self) -> list[str | None]:
        from oracle.baseline.models import Entity
        from oracle.roadmap.models import RoadmapItem
        from oracle.simple.priorities import prd_code
        from oracle.trash.filter import INCLUDE_TRASHED

        s = self.session
        with s.no_autoflush:
            titles = s.scalars(
                select(RoadmapItem.title)
                .where(RoadmapItem.title.op("~")(r"^F-[0-9]+[a-j]?\s"))
                .execution_options(**{INCLUDE_TRASHED: True})
            ).all()
            keys = s.scalars(select(Entity.key).where(Entity.type == "feature")).all()
            sections = s.scalars(
                select(RoadmapItem.prd_section_key)
                .where(RoadmapItem.prd_section_key.is_not(None))
                .distinct()
                .execution_options(**{INCLUDE_TRASHED: True})
            ).all()
        used: list[str | None] = [title_code(t) for t in titles]
        used += [title_code(o.title) for o in (*s.new, *s.dirty) if isinstance(o, RoadmapItem)]
        used += [*keys, *self.by_feature.values(), *(prd_code(k) for k in sections)]
        return used

    def give(self, row: Any, code: str) -> None:
        """Gives ``row`` the next free number as its title's lead ("F-63 Night digest", the
        name cut to fit, as the migration does) and audits it."""

        if self.used is None:
            self.used = self._read()
        new = next_number(self.used)
        self.used.append(new)
        name = " ".join((row.title or "").split())[: _TITLE_MAX - len(new) - 1]
        row.title = f"{new} {name}"
        if row.id is None:
            row.id = uuid.uuid4()
        numbered(self.session, row, code, new, name)


def numbered(session: Session, row: Any, old: str | None, new: str, name: str) -> None:
    """Audits that ``row`` was given ``new`` as it was written (its title now leads with it)
    and keeps it for the write's response (:data:`NUMBERED`)."""
    from oracle.models import AuditEvent

    session.add(
        AuditEvent(
            tenant_id=row.tenant_id,
            actor="system",
            action=RENUMBERED,
            entity="roadmap_item",
            entity_id=row.id,
            data={
                "roadmap_document_id": str(row.roadmap_document_id),
                "item_key": row.item_key,
                "title": name,
                "old": old,
                "new": new,
                # Numbered when written, not by the migration: another item of its plan
                # showed the code it takes from its feature or PRD section.
                "at": "write",
                "why": "shared",
            },
        )
    )
    session.info.setdefault(NUMBERED, {})[str(row.id)] = new


# session.info's key: the items this session's writes numbered (item id -> code), for the
# write's response (oracle.simple.changes_router).
NUMBERED = "codes_numbered"


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
