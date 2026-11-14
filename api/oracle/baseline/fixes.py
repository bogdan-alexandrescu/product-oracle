"""The Ground Truth check's fixes that are no plain entity or edge write (docs/ground-truth.md;
the owner's follow-up, Nov 5):

- Give it a code (``no_code``): a Ground Truth feature gets the company's next F-number (its
  highest + 1, over every feature's code, every PRD plan's and every roadmap item's PRD code);
  a slice (a feature whose parent is a feature) keeps its parent's number with the next letter
  (F-15a, F-15b). The code is stored as the feature's key, where every reader takes a
  feature's code from (``oracle.simple.priorities.short_codes``, the web's ``named``). Undo
  gives back the key it had (read from the entity's revision). What names a feature by its
  key keeps finding it (the owner's decision, Nov 5): a tech brief's ``feature_key`` is
  rewritten in the same change (and back on Undo); a key a feature had before stays its
  alias (:func:`former_keys`), read by the YAML import (an older export updates the feature,
  never adds a second one), a draft's ``baseline feature <key>`` citation and a launch's
  roadmap item named by the key. A code once given is never given again. Two codes given
  at the same moment: the second write retries with the next number once, else refuses
  ("That code is taken; try again."), never a server error.
- Link to a feature (``prd_feature_missing``, ``slice_parent_missing``): a feature of a PRD's
  approved plan is linked to a confirmed Ground Truth feature, kept in the plan's ``links``
  ({PRD code: feature id}, kept when the plan is read again); the check stops flagging it and
  the PRD reads that feature's code (:func:`linked_codes`).

Approvers and owners act at once; a commenter's fix is a proposal (``payload["fix"]``) that an
approver's accept applies (:func:`apply_proposal`).
"""

import re
import uuid
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from oracle.baseline.models import Entity, EntityRevision, Proposal
from oracle.baseline.service import (
    ConflictError,
    NotFoundError,
    Writer,
    _jsonable,
    _record_change,
    _revision,
    entity_snapshot,
    lock,
)
from oracle.docs import visibility
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimplePrdPlan
from oracle.v2.models import ArtifactRequest

LETTERS = "abcdefghij"
F_NUMBER = re.compile(r"F-(\d+)(?:\.\d+)?[a-j]?")
# A code a slice's parent can lend its number from (F-15, not F-15a).
WHOLE_CODE = re.compile(r"[A-Z]{1,3}-\d+")
GIVE_CODE, LINK_PRD = "give_code", "link_prd_feature"


async def _codes(db: AsyncSession) -> dict[uuid.UUID, str]:
    """Every feature's real code (F-12, F-12a) by its id, as the check reads them."""
    from oracle.baseline.check import F_CODE
    from oracle.simple.priorities import _short_codes

    short = await _short_codes(db, names=False)
    rows = (await db.execute(select(Entity.id, Entity.key).where(Entity.type == "feature"))).all()
    return {i: c for i, k in rows if F_CODE.fullmatch(c := short.get(k, ""))}


def canonical_code(key: str) -> str | None:
    """A code-shaped feature key as the check reads it (F-9 and F-009 read F-09; a slice keeps
    its letter: F-9a reads F-09a), None for a key that is no code."""
    from oracle.baseline.check import _code

    m = re.fullmatch(r"(.+?)([a-j]?)", key.strip())
    code = _code(m[1]) if m and WHOLE_CODE.fullmatch(m[1]) else None
    return f"{code}{m[2]}" if code and m else None


async def code_taken(db: AsyncSession, code: str) -> bool:
    """Whether some feature has ``code`` (read one way, :func:`canonical_code`): as its code
    the check reads (its key, or its published roadmap item's PRD section), or as a code it
    had before, an alias never given again (:func:`next_code`)."""
    had = (await _taken(db)).taken
    return code in {canonical_code(c) or c for c in had}


async def code_of(db: AsyncSession, feature: Entity) -> str | None:
    return (await _codes(db)).get(feature.id)


async def _feature(db: AsyncSession, feature_id: uuid.UUID) -> Entity:
    e = await db.get(Entity, feature_id)
    if e is None or e.type != "feature":
        raise NotFoundError("No such feature")
    return e


async def former_keys(db: AsyncSession, *, live: bool = False) -> dict[str, uuid.UUID]:
    """{a key a feature had before (its revisions): that feature's id}, the latest holder of
    each, but not a key some feature has now. ``live``: not of a rejected feature."""
    query = (
        select(EntityRevision.entity_id, EntityRevision.before["key"].astext)
        .join(Entity, Entity.id == EntityRevision.entity_id)
        .where(
            Entity.type == "feature",
            EntityRevision.before["key"].astext != EntityRevision.after["key"].astext,
        )
        .order_by(EntityRevision.created_at)
    )
    if live:
        query = query.where(Entity.status != "rejected")
    out = {k: i for i, k in (await db.execute(query)).all() if k}
    if not out:
        return {}
    now = set(
        await db.scalars(select(Entity.key).where(Entity.type == "feature", Entity.key.in_(out)))
    )
    return {k: i for k, i in out.items() if k not in now}


async def features_by_keys(
    db: AsyncSession, keys: Iterable[str], *, live: bool = False
) -> dict[str, Entity]:
    """{key: the feature that has it, else the one that had it before (:func:`former_keys`)}
    for every key that names one, in two reads however many keys: what names a feature by
    its key keeps finding it once it is given its code. ``live``: not a rejected feature."""
    wanted = {k for k in keys if k}
    if not wanted:
        return {}
    holders = list(
        await db.scalars(select(Entity).where(Entity.type == "feature", Entity.key.in_(wanted)))
    )
    out = {e.key: e for e in holders if not (live and e.status == "rejected")}
    held = {e.key for e in holders}
    left = wanted - held
    if not left:
        return out
    old = EntityRevision.before["key"].astext
    query = (
        select(old, Entity)
        .join(Entity, Entity.id == EntityRevision.entity_id)
        .where(Entity.type == "feature", old.in_(left), old != EntityRevision.after["key"].astext)
        .order_by(EntityRevision.created_at)
    )
    if live:
        query = query.where(Entity.status != "rejected")
    # The latest holder of each key last, so it wins.
    for key, e in (await db.execute(query)).all():
        out[key] = e
    return out


async def by_former_key(db: AsyncSession, key: str) -> Entity | None:
    """The feature that had ``key`` before (:func:`former_keys`), if no feature has it now:
    read by that key alone, never every alias."""
    found = (await features_by_keys(db, [key])).get(key)
    return found if found is not None and found.key != key else None


async def _prd_codes(db: AsyncSession) -> list[str]:
    """Every feature code of every PRD: its stored plan's and its latest approved version's
    tables (a plan not read yet)."""
    from oracle.simple import plan

    out = []
    for data in await db.scalars(select(SimplePrdPlan.data)):
        out += [str(f.get("code") or "") for f in (data or {}).get("features") or []
                if isinstance(f, dict)]  # fmt: skip
    latest = (
        select(DocumentVersion.document_id, func.max(DocumentVersion.number).label("n"))
        .join(Document, Document.id == DocumentVersion.document_id)
        .where(Document.kind == "prd", DocumentVersion.approved_at.is_not(None))
        .group_by(DocumentVersion.document_id)
        .subquery()
    )
    for v in await db.scalars(
        select(DocumentVersion).join(
            latest,
            (DocumentVersion.document_id == latest.c.document_id)
            & (DocumentVersion.number == latest.c.n),
        )
    ):
        out += [str(f.get("code") or "") for f in (plan._parsed(v) or {}).get("features") or []]
    return out


_TAKEN = "fixes.taken_codes"


@dataclass
class _Taken:
    codes: dict[uuid.UUID, str]  # every feature's code by its id (:func:`_codes`)
    taken: set[str]  # those and every former key: never given again
    top: int  # the highest F-number anywhere (features, aliases, PRDs, roadmap items)


@asynccontextmanager
async def codes_once(db: AsyncSession) -> AsyncIterator[None]:
    """A batch (a YAML import) reads the codes taken once, not once per feature it adds: each
    code given in it is added to what was read (:func:`took`)."""
    if _TAKEN in db.info:
        yield
        return
    db.info[_TAKEN] = None
    try:
        yield
    finally:
        db.info.pop(_TAKEN, None)


async def _taken(db: AsyncSession) -> _Taken:
    if (cached := db.info.get(_TAKEN)) is not None:
        return cached
    codes = await _codes(db)
    taken = set(codes.values()) | set(await former_keys(db))
    seen = list(taken) + await _prd_codes(db)
    seen += [s or "" for s in await db.scalars(select(RoadmapItem.prd_section_key).distinct())]
    numbers = [int(m[1]) for c in seen if (m := F_NUMBER.fullmatch(c.strip().upper()))]
    out = _Taken(codes, taken, max(numbers, default=0))
    if _TAKEN in db.info:
        db.info[_TAKEN] = out
    return out


def took(db: AsyncSession, feature: Entity, old: str | None = None) -> None:
    """In a batch (:func:`codes_once`): ``feature``'s code key, given or typed, is taken now
    (and ``old``, its key before, stays its alias)."""
    cached: _Taken | None = db.info.get(_TAKEN)
    code = canonical_code(feature.key)
    if cached is None or code is None:
        return
    cached.codes[feature.id] = code
    cached.taken |= {code} | ({old} if old else set())
    if m := F_NUMBER.fullmatch(code):
        cached.top = max(cached.top, int(m[1]))


async def next_code(db: AsyncSession, feature: Entity) -> str:
    """The code ``feature`` would be given (refused when it has one or is not in the Ground
    Truth, or is a slice whose feature has no code)."""
    if feature.status != "confirmed":
        raise ConflictError("This feature is not in the Ground Truth yet.")
    t = await _taken(db)
    if feature.id in t.codes:
        raise ConflictError("This feature already has a code.")
    # A code given once and taken back stays an alias of its feature: never given again.
    if feature.parent_id is not None:
        parent = await db.get(Entity, feature.parent_id)
        if parent is not None and parent.type == "feature":
            base = t.codes.get(parent.id)
            if base is None or not WHOLE_CODE.fullmatch(base):
                raise ConflictError("Give its feature a code first.")
            for letter in LETTERS:
                if f"{base}{letter}" not in t.taken:
                    return f"{base}{letter}"
            raise ConflictError("This feature has no slice letter left.")
    return f"F-{t.top + 1:02d}"


async def _set_key(db: AsyncSession, feature: Entity, key: str) -> bool:
    """Write ``key`` in a savepoint: False (and the feature as it was) when another feature
    holds it, written at the same moment."""
    try:
        async with db.begin_nested():
            feature.key = key
            await db.flush()
    except IntegrityError:
        await db.refresh(feature)
        if _TAKEN in db.info:
            db.info[_TAKEN] = None  # another writer took a code: read them again
        return False
    return True


async def _rename_refs(db: AsyncSession, old: str, new: str) -> None:
    """What names the feature by its key and keeps it: a tech brief's ``feature_key``."""
    await db.execute(
        update(ArtifactRequest)
        .where(
            ArtifactRequest.kind == "tech_brief",
            ArtifactRequest.params["feature_key"].astext == old,
        )
        .values(params=ArtifactRequest.params.op("||")(func.jsonb_build_object("feature_key", new)))
        .execution_options(synchronize_session=False)
    )


async def code_on_join(db: AsyncSession, feature: Entity, *, new: bool = False) -> None:
    """Every feature has a code, given when it joins the Ground Truth (the owner, Nov 4: "Code
    + name, all"): a confirmed feature with none gets :func:`next_code` as its key, and what
    names it by its key follows (:func:`_rename_refs`; its old key stays an alias). A code it
    has is kept, never renumbered; a slice whose feature has no code waits for Give it a code.
    The caller writes the revision, so the code is part of the write that confirmed it.
    ``new``: a feature just made, which no roadmap item or PRD feature is tied to yet."""
    if feature.type != "feature" or feature.status != "confirmed":
        return
    old = feature.key
    # Its own code first (its Code attribute, else its roadmap item's or PRD feature's), when
    # no other feature has it; else the next number, flagged code_differs by the check.
    if feature.id not in (await _taken(db)).codes and not await _is_slice(db, feature):
        want = await wanted_code(db, feature, tied=not new)
        if want and await _free(db, feature, want) and await _set_key(db, feature, want):
            await _rename_refs(db, old, want)
            took(db, feature, old)
            return
    for _ in range(2):
        try:
            code = await next_code(db, feature)
        except ConflictError:
            return
        if await _set_key(db, feature, code):
            await _rename_refs(db, old, code)
            took(db, feature, old)
            return
    # Lost the race twice: refused, never a join without its code.
    raise ConflictError("That code is taken; try again.")


async def _is_slice(db: AsyncSession, feature: Entity) -> bool:
    if feature.parent_id is None:
        return False
    parent = await db.get(Entity, feature.parent_id)
    return parent is not None and parent.type == "feature"


async def wanted_code(db: AsyncSession, feature: Entity, *, tied: bool = True) -> str | None:
    """The code ``feature`` is keyed by (``oracle.baseline.check.own_code``): its Code
    attribute, else the one code of the roadmap items and PRD features tied to it."""
    from oracle.baseline import check

    if (own := check.whole_code((feature.attrs or {}).get("code"))) or not tied:
        return own
    return check.own_code(feature, (await check.tied_codes(db, {feature.id})).get(feature.id))


async def held_codes(
    db: AsyncSession, codes: dict[uuid.UUID, str] | None = None
) -> dict[str, set[uuid.UUID]]:
    """{a code read one way: every feature that has it now (``codes``, else the codes the check
    reads) or as a code it gave back (:func:`former_keys`)}. One reading for the check's
    Code differs and Use its code (:func:`_free`), so they never disagree."""
    from oracle.baseline.check import _code

    if codes is None:
        codes = (await _taken(db)).codes
    out: dict[str, set[uuid.UUID]] = {}
    for k, i in (await former_keys(db)).items():
        out.setdefault(canonical_code(k) or k, set()).add(i)
    for i, c in codes.items():
        out.setdefault(_code(c) or c, set()).add(i)
    return out


async def _free(db: AsyncSession, feature: Entity, code: str) -> bool:
    """Whether no other feature has ``code``, now or as a code it gave back."""
    return not (await held_codes(db)).get(code, set()) - {feature.id}


async def confirm_goal_links(db: AsyncSession, writer: Writer, feature: Entity) -> None:
    """A confirmed feature's goal links a run proposed with it are confirmed with it, so it
    is not flagged Serves no goal for a link it has: links to a confirmed goal only (a goal
    a run only proposed waits for its own yes)."""
    from oracle.baseline.models import Edge
    from oracle.baseline.service import update_edge

    if feature.type != "feature" or feature.status != "confirmed":
        return
    edges = await db.scalars(
        select(Edge)
        .join(Entity, Entity.id == Edge.dst_id)
        .where(
            Edge.src_id == feature.id,
            Edge.type == "supports",
            Edge.status == "proposed",
            Entity.type == "goal",
            Entity.status == "confirmed",
        )
    )
    for edge in list(edges):
        await update_edge(db, writer, edge, {"status": "confirmed"})


async def use_own_code(db: AsyncSession, writer: Writer, feature: Entity) -> str:
    """Use its code (the check's ``code_differs``): a feature keyed by the next number as it
    was confirmed gets its own code as its key; the number it had is given back, an alias
    never given again (:func:`former_keys`). Its proposed goal links are confirmed too. A slice
    keeps its letter (F-35a): it has no code of its own to take."""
    if feature.status != "confirmed":
        raise ConflictError("This feature is not in the Ground Truth yet.")
    if await _is_slice(db, feature):
        # A slice reads its feature's code with its letter (F-35a), never a code of its own.
        raise ConflictError("This feature already has its own code.")
    want = await wanted_code(db, feature)
    if not want or want == canonical_code(feature.key):
        raise ConflictError("This feature already has its own code.")
    if not await _free(db, feature, want):
        raise ConflictError(f"Another feature already has the code {want}.")
    before = entity_snapshot(feature)
    old = feature.key
    if not await _set_key(db, feature, want):
        raise ConflictError("That code is taken; try again.")
    await _rename_refs(db, old, want)
    took(db, feature, old)
    lock(feature, writer)
    await db.flush()
    _revision(db, writer, before, entity_snapshot(feature), entity=feature)
    await db.flush()
    await _record_change(db, writer.actor, feature, before, "entity_updated")
    await confirm_goal_links(db, writer, feature)
    return want


async def give_code(db: AsyncSession, writer: Writer, feature: Entity) -> str:
    """Give ``feature`` its next code, as the writer's own edit (it locks the feature); a
    code another writer took at the same moment is tried once more with the next."""
    before = entity_snapshot(feature)
    old = feature.key
    for _ in range(2):
        code = await next_code(db, feature)
        if await _set_key(db, feature, code):
            break
    else:
        raise ConflictError("That code is taken; try again.")
    await _rename_refs(db, old, code)
    took(db, feature, old)
    lock(feature, writer)
    await db.flush()
    _revision(db, writer, before, entity_snapshot(feature), entity=feature)
    await db.flush()
    await _record_change(db, writer.actor, feature, before, "entity_updated")
    return code


async def take_code_back(db: AsyncSession, writer: Writer, feature_id: uuid.UUID) -> Entity:
    """Undo Give it a code: the key the feature had before its code was given, and what was
    renamed with it; refused when another feature has that key now."""
    feature = await _feature(db, feature_id)
    revisions = await db.scalars(
        select(EntityRevision)
        .where(EntityRevision.entity_id == feature.id)
        .order_by(EntityRevision.created_at.desc())
    )
    key = feature.key
    given = next(
        (r for r in revisions
         if (r.after or {}).get("key") == key and (r.before or {}).get("key") != key),
        None,
    )  # fmt: skip
    if given is None or not await code_of(db, feature):
        raise ConflictError("This feature's code was not given here.")
    old = str(given.before["key"])
    taken = ConflictError("Its old key is taken by another feature.")
    if await db.scalar(select(Entity.id).where(Entity.type == "feature", Entity.key == old)):
        raise taken
    before = entity_snapshot(feature)
    if not await _set_key(db, feature, old):
        raise taken
    await _rename_refs(db, key, old)
    if _TAKEN in db.info:
        db.info[_TAKEN] = None
    lock(feature, writer)
    await db.flush()
    _revision(db, writer, before, entity_snapshot(feature), entity=feature)
    await db.flush()
    await _record_change(db, writer.actor, feature, before, "entity_updated")
    return feature


# --------------------------------------------------------------------------- PRD links


async def _plan(db: AsyncSession, prd_id: uuid.UUID) -> tuple[Document, SimplePrdPlan]:
    doc = await db.get(Document, prd_id)
    if doc is None or doc.kind != "prd" or doc.visibility != visibility.COMPANY:
        raise NotFoundError("No such PRD")
    row = await db.scalar(select(SimplePrdPlan).where(SimplePrdPlan.document_id == prd_id))
    if row is None or row.status != "ready" or row.version_id is None:
        raise ConflictError("This PRD has no approved plan yet.")
    return doc, row


def _plan_feature(row: SimplePrdPlan, code: str) -> dict[str, Any]:
    """The plan's feature by its code as written or read one way ("f-15" and 15 are F-15)."""
    from oracle.baseline.check import _plan_code

    for f in (row.data or {}).get("features") or []:
        if isinstance(f, dict) and (
            str(f.get("code") or "").strip() == code
            or (_plan_code(f.get("code")) or None) == _plan_code(code)
        ):
            return f
    raise NotFoundError("This PRD has no such feature")


async def check_link(
    db: AsyncSession, prd_id: uuid.UUID, code: str, feature_id: uuid.UUID
) -> tuple[SimplePrdPlan, dict[str, Any], Entity]:
    _, row = await _plan(db, prd_id)
    f = _plan_feature(row, code)
    feature = await _feature(db, feature_id)
    if feature.status != "confirmed":
        raise ConflictError("Link it to a feature in the Ground Truth.")
    if code in ((row.data or {}).get("links") or {}):
        raise ConflictError("This PRD's feature is already linked; undo that first.")
    return row, f, feature


def _set_links(row: SimplePrdPlan, links: dict[str, str]) -> None:
    data = dict(row.data or {})
    if links:
        data["links"] = links
    else:
        data.pop("links", None)
    row.data = data
    flag_modified(row, "data")


async def link(db: AsyncSession, prd_id: uuid.UUID, code: str, feature_id: uuid.UUID) -> Entity:
    row, _, feature = await check_link(db, prd_id, code, feature_id)
    _set_links(row, {**((row.data or {}).get("links") or {}), code: str(feature.id)})
    await db.flush()
    return feature


async def unlink(db: AsyncSession, prd_id: uuid.UUID, code: str) -> None:
    _, row = await _plan(db, prd_id)
    links = dict((row.data or {}).get("links") or {})
    if links.pop(code, None) is None:
        raise ConflictError("This PRD's feature is not linked.")
    _set_links(row, links)
    await db.flush()


async def linked_codes(db: AsyncSession, links: dict[str, str] | None) -> dict[str, str]:
    """{PRD code: the linked Ground Truth feature's code}, for links to a confirmed feature
    with a code."""
    if not links:
        return {}
    ids = {uuid.UUID(v) for v in links.values()}
    live = set(
        await db.scalars(select(Entity.id).where(Entity.id.in_(ids), Entity.status == "confirmed"))
    )
    codes = await _codes(db) if live else {}
    out = {}
    for code, fid in links.items():
        if uuid.UUID(fid) in live and uuid.UUID(fid) in codes:
            out[code] = codes[uuid.UUID(fid)]
    return out


# --------------------------------------------------------------------------- its own feature

# A feature's marks of the roadmap items whose match to it a person declined (Its own feature)
# or that still wait for their own Confirm it (a proposal shared by several items, confirmed from
# one item's flag): ``"<roadmap id>/<item key>"``, so a mark holds across the roadmap's versions.
DECLINED, UNCONFIRMED = "_declined_items", "_unconfirmed_items"


def item_mark(row: Any) -> str:
    return f"{row.roadmap_document_id}/{row.item_key}"


def marked(feature: Entity, kind: str, row: Any) -> bool:
    return item_mark(row) in ((feature.attrs or {}).get(kind) or [])


def _mark(feature: Entity, kind: str, mark: str, on: bool) -> None:
    attrs = dict(feature.attrs or {})
    marks = [m for m in attrs.pop(kind, None) or [] if m != mark] + ([mark] if on else [])
    feature.attrs = {**attrs, kind: marks} if marks else attrs


async def confirmed_for(
    db: AsyncSession, feature: Entity, item_id: uuid.UUID, joined: bool
) -> None:
    """Confirm it from one roadmap item's flag (the owner, Nov 13): that item is in the Ground
    Truth. When the feature ``joined`` now, the other items on it (a proposal several items
    shared) each wait for their own Confirm it; else the item no longer waits."""
    from oracle.baseline import check
    from oracle.simple import drafts

    row = await db.get(RoadmapItem, item_id)
    if row is None or feature.type != "feature":
        raise NotFoundError("No such roadmap item")
    _mark(feature, UNCONFIRMED, item_mark(row), False)
    _mark(feature, DECLINED, item_mark(row), False)
    if joined:
        items, _ = await check._roadmap_items(db)
        effective = await drafts.effective(db, items)
        for i in items:
            if effective[str(i.id)].feature_id == feature.id and item_mark(i) != item_mark(row):
                _mark(feature, UNCONFIRMED, item_mark(i), True)
    await db.flush()


async def _slug_key(db: AsyncSession, name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "feature"
    keys = set(await db.scalars(select(Entity.key).where(Entity.key.startswith(slug))))
    key, n = slug, 2
    while key in keys:
        key, n = f"{slug}-{n}", n + 1
    return key


async def own_feature(db: AsyncSession, principal: Any, item_id: uuid.UUID) -> Entity:
    """Its own feature (the owner, Nov 13): a roadmap item joins the Ground Truth as a feature of
    its own, named as the item, keyed by the code the item or its PRD gives it when no feature
    has it, else the next free code, and becomes the item's feature (a set_feature change, as
    Add to Ground Truth). The feature it was matched to (a proposal, maybe shared with other
    items) is declined for this item: never offered to it again. An entry of the item's name
    is reused, confirmed if it was only proposed, never a second entry of that name."""
    from oracle import audit
    from oracle.baseline import check
    from oracle.baseline.service import create_entity, link_new_feature, set_entity_status
    from oracle.roadmap.codes import title_code
    from oracle.simple import drafts
    from oracle.simple.service import coded_title

    row = await db.get(RoadmapItem, item_id)
    if row is None:
        raise NotFoundError("No such roadmap item")
    writer = Writer(principal, "user", reason="Ground Truth fix: own_feature")
    mark = item_mark(row)
    was_id = (await drafts.effective_row(db, row)).feature_id
    was = await db.get(Entity, was_id) if was_id is not None else None
    code = check.whole_code(row.prd_section_key) or check.whole_code(title_code(row.title))
    name = coded_title(row.title, None)[1].strip() or row.title
    same = (
        await db.scalars(
            select(Entity)
            .where(
                Entity.type == "feature",
                Entity.status != "rejected",
                func.lower(func.btrim(Entity.title)) == name.lower(),
            )
            .order_by((Entity.status == "confirmed").desc(), Entity.created_at)
            .limit(1)
        )
    ).first()
    declined = was is not None and was.type == "feature" and was is not same
    if declined:
        _mark(was, DECLINED, mark, True)  # type: ignore[arg-type]
        _mark(was, UNCONFIRMED, mark, False)  # type: ignore[arg-type]
        await db.flush()
    free = code is not None and not await code_taken(db, code)
    if same is not None:
        feature = same
        _mark(feature, DECLINED, mark, False)
        _mark(feature, UNCONFIRMED, mark, False)
        if feature.status != "confirmed":
            if free and not check.whole_code((feature.attrs or {}).get("code")):
                feature.attrs = {**(feature.attrs or {}), "code": code}
            await set_entity_status(db, principal, feature, "confirmed", None)
    else:
        key = code if free else await _slug_key(db, name)
        made = await create_entity(db, writer, type_="feature", key=key, title=name,  # type: ignore[arg-type]
                                   status="confirmed")  # fmt: skip
        feature = made.entity  # type: ignore[assignment]
    if was_id != feature.id:
        await link_new_feature(db, writer, feature, None, row.id)
    await audit.record(db, principal, "baseline.item.own_feature", "roadmap_item", row.id, {
        "feature_id": str(feature.id), "reused": same is not None,
        "declined": str(was_id) if declined else None,
    })  # fmt: skip
    await db.flush()
    return feature


# --------------------------------------------------------------------------- proposals


async def propose(
    db: AsyncSession, writer: Writer, feature: Entity, fix: dict[str, Any]
) -> Proposal:
    """A commenter's fix, for an approver to accept; the same open one when asked again."""
    for p in await db.scalars(
        select(Proposal).where(Proposal.status == "open", Proposal.entity_id == feature.id)
    ):
        if (p.payload or {}).get("fix") == fix:
            return p
    payload = _jsonable({"op": "update", "kind": "entity", "fields": {}, "fix": fix,
                         "reason": writer.reason, "origin": writer.origin})  # fmt: skip
    p = Proposal(entity_id=feature.id, payload=payload, actor=writer.actor, status="open")
    db.add(p)
    await db.flush()
    return p


async def apply_proposal(db: AsyncSession, writer: Writer, proposal: Proposal) -> None:
    fix = proposal.payload["fix"]
    if fix.get("action") == GIVE_CODE:
        await give_code(db, writer, await _feature(db, proposal.entity_id))  # type: ignore[arg-type]
    elif fix.get("action") == LINK_PRD:
        await link(db, uuid.UUID(fix["prd_document_id"]), fix["code"], proposal.entity_id)  # type: ignore[arg-type]


def sentence(fix: dict[str, Any], target: Entity | None) -> str:
    title = target.title if target is not None else "a removed feature"
    if fix.get("action") == LINK_PRD:
        return (
            f"Link the PRD’s {fix.get('code')} {fix.get('name') or ''}".rstrip() + f" to “{title}”"
        )
    return f"Give “{title}” a feature code"
