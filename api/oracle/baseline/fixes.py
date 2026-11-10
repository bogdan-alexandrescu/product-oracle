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
    had = set((await _codes(db)).values()) | set(await former_keys(db))
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


async def by_former_key(db: AsyncSession, key: str) -> Entity | None:
    """The feature that had ``key`` before (:func:`former_keys`), if no feature has it now."""
    fid = (await former_keys(db)).get(key)
    return await db.get(Entity, fid) if fid is not None else None


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


async def next_code(db: AsyncSession, feature: Entity) -> str:
    """The code ``feature`` would be given (refused when it has one or is not in the Ground
    Truth, or is a slice whose feature has no code)."""
    if feature.status != "confirmed":
        raise ConflictError("This feature is not in the Ground Truth yet.")
    codes = await _codes(db)
    if feature.id in codes:
        raise ConflictError("This feature already has a code.")
    # A code given once and taken back stays an alias of its feature: never given again.
    taken = set(codes.values()) | set(await former_keys(db))
    if feature.parent_id is not None:
        parent = await db.get(Entity, feature.parent_id)
        if parent is not None and parent.type == "feature":
            base = codes.get(parent.id)
            if base is None or not WHOLE_CODE.fullmatch(base):
                raise ConflictError("Give its feature a code first.")
            for letter in LETTERS:
                if f"{base}{letter}" not in taken:
                    return f"{base}{letter}"
            raise ConflictError("This feature has no slice letter left.")
    seen = list(taken) + await _prd_codes(db)
    seen += [s or "" for s in await db.scalars(select(RoadmapItem.prd_section_key).distinct())]
    numbers = [int(m[1]) for c in seen if (m := F_NUMBER.fullmatch(c.strip().upper()))]
    return f"F-{max(numbers, default=0) + 1:02d}"


async def _set_key(db: AsyncSession, feature: Entity, key: str) -> bool:
    """Write ``key`` in a savepoint: False (and the feature as it was) when another feature
    holds it, written at the same moment."""
    try:
        async with db.begin_nested():
            feature.key = key
            await db.flush()
    except IntegrityError:
        await db.refresh(feature)
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


async def code_on_join(db: AsyncSession, feature: Entity) -> None:
    """Every feature has a code, given when it joins the Ground Truth (the owner, Nov 4: "Code
    + name, all"): a confirmed feature with none gets :func:`next_code` as its key, and what
    names it by its key follows (:func:`_rename_refs`; its old key stays an alias). A code it
    has is kept, never renumbered; a slice whose feature has no code waits for Give it a code.
    The caller writes the revision, so the code is part of the write that confirmed it."""
    if feature.type != "feature" or feature.status != "confirmed":
        return
    old = feature.key
    for _ in range(2):
        try:
            code = await next_code(db, feature)
        except ConflictError:
            return
        if await _set_key(db, feature, code):
            await _rename_refs(db, old, code)
            return


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
