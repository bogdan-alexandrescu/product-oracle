"""The Ground Truth check's fixes that are no plain entity or edge write (docs/ground-truth.md;
the owner's follow-up, Nov 5):

- Give it a code (``no_code``): a Ground Truth feature gets the company's next F-number (its
  highest + 1, over every feature's code, every PRD plan's and every roadmap item's PRD code);
  a slice (a feature whose parent is a feature) keeps its parent's number with the next letter
  (F-15a, F-15b). The code is stored as the feature's key, where every reader takes a
  feature's code from (``oracle.simple.priorities.short_codes``, the web's ``named``). Undo
  gives back the key it had (read from the entity's revision).
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

from sqlalchemy import select
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
from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimplePrdPlan

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


async def code_of(db: AsyncSession, feature: Entity) -> str | None:
    return (await _codes(db)).get(feature.id)


async def _feature(db: AsyncSession, feature_id: uuid.UUID) -> Entity:
    e = await db.get(Entity, feature_id)
    if e is None or e.type != "feature":
        raise NotFoundError("No such feature")
    return e


async def next_code(db: AsyncSession, feature: Entity) -> str:
    """The code ``feature`` would be given (refused when it has one or is not in the Ground
    Truth, or is a slice whose feature has no code)."""
    if feature.status != "confirmed":
        raise ConflictError("This feature is not in the Ground Truth yet.")
    codes = await _codes(db)
    if feature.id in codes:
        raise ConflictError("This feature already has a code.")
    taken = set(codes.values())
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
    seen = list(taken)
    for data in await db.scalars(select(SimplePrdPlan.data)):
        seen += [str(f.get("code") or "") for f in (data or {}).get("features") or []
                 if isinstance(f, dict)]  # fmt: skip
    seen += [s or "" for s in await db.scalars(select(RoadmapItem.prd_section_key).distinct())]
    numbers = [int(m[1]) for c in seen if (m := F_NUMBER.fullmatch(c.strip().upper()))]
    return f"F-{max(numbers, default=0) + 1:02d}"


async def give_code(db: AsyncSession, writer: Writer, feature: Entity) -> str:
    """Give ``feature`` its next code, as the writer's own edit (it locks the feature)."""
    code = await next_code(db, feature)
    if await db.scalar(select(Entity.id).where(Entity.type == "feature", Entity.key == code)):
        raise ConflictError("That code is taken; try again.")
    before = entity_snapshot(feature)
    feature.key = code
    lock(feature, writer)
    await db.flush()
    _revision(db, writer, before, entity_snapshot(feature), entity=feature)
    await db.flush()
    await _record_change(db, writer.actor, feature, before, "entity_updated")
    return code


async def take_code_back(db: AsyncSession, writer: Writer, feature_id: uuid.UUID) -> Entity:
    """Undo Give it a code: the key the feature had before its code was given."""
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
    if await db.scalar(select(Entity.id).where(Entity.type == "feature", Entity.key == old)):
        raise ConflictError("Its old key is taken by another feature.")
    before = entity_snapshot(feature)
    feature.key = old
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
    for f in (row.data or {}).get("features") or []:
        if isinstance(f, dict) and str(f.get("code") or "").strip() == code:
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
