"""unique-codes (the owner, Nov 23): every roadmap item has its own code; nothing shares one.

Items of one Ground Truth feature (its slices) read the feature's code, so several items read
the same one. :func:`renumber` gives each item that shares a code with another of its roadmap
its own: in each group sharing a code, the item with the earliest start date (ties: the
earliest created) keeps it, and each other item, in date order, takes the next free feature
number (oracle.roadmap.codes.next_number, the rule a new item's code comes from), written as
its title's lead ("F-64 Alert routing"), the item's own code. An item with no code at all gets
the next free number too. An item whose code is already unique is never renumbered. Each
change is audited (old code -> new code). Safe to run twice: a second run finds nothing to
change. Sync on purpose: migration 0136 runs it.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import insert, select, update
from sqlalchemy.orm import Session

from oracle.roadmap import codes

ACTION = "roadmap.item.code_renumbered"
TITLE_MAX = 200  # oracle.simple.changes.TITLE_MAX


def _name(title: str) -> str:
    """A title less the code it leads with ("F-51 Alert routing": Alert routing)."""
    m = codes.LEADING_CODE.match(title or "")
    return title[m.end() :].strip() if m and title[m.end() :].strip() else title


def renumber(session: Session) -> list[dict[str, Any]]:
    """Gives every roadmap item sharing a code (or with none) its own; the changes made, each
    ``{"tenant_id", "roadmap_document_id", "item_key", "title", "old", "new"}``."""
    from oracle.baseline.models import Entity
    from oracle.docs.models import DocumentVersion
    from oracle.models import AuditEvent
    from oracle.roadmap.models import RoadmapItem

    by_feature = codes._feature_codes_sync(session)
    # The columns it reads, by name: a later column added to the table is never selected.
    t = RoadmapItem.__table__
    rows = list(
        session.execute(
            select(
                t.c.id,
                t.c.tenant_id,
                t.c.roadmap_document_id,
                t.c.item_key,
                t.c.title,
                t.c.feature_id,
                t.c.prd_section_key,
                t.c.deleted_at,
                t.c.created_at,
                t.c.start_date,
                t.c.roadmap_version_id,
                t.c.draft_roadmap_id,
                t.c.simple_draft_id,
            ).where(t.c.roadmap_document_id.is_not(None))  # fmt: skip
        )
    )
    features = list(
        session.execute(select(Entity.tenant_id, Entity.key).where(Entity.type == "feature"))
    )
    # Each roadmap's latest version: with the drafts, the plans an item is read on now.
    v = DocumentVersion.__table__
    numbers = list(session.execute(select(v.c.id, v.c.document_id, v.c.number)))
    top: dict[uuid.UUID, int] = {}
    for _, doc, n in numbers:
        top[doc] = max(top.get(doc, n), n)
    current_versions = {vid for vid, doc, n in numbers if top[doc] == n}

    def plan(r: Any) -> tuple[str, Any] | None:
        """The plan ``r`` is on, as the write check (codes.check_flush) groups items: a draft,
        or its roadmap's latest version; None for an older version."""
        if r.roadmap_version_id is not None:
            return ("v", r.roadmap_version_id) if r.roadmap_version_id in current_versions else None
        return (
            ("d", r.draft_roadmap_id)
            if r.draft_roadmap_id is not None
            else ("s", r.simple_draft_id)
        )

    made: list[dict[str, Any]] = []
    for tenant in sorted({r.tenant_id for r in rows}, key=str):
        mine = [r for r in rows if r.tenant_id == tenant]
        used = [codes.shown(r, by_feature) for r in mine]
        used += [k for tid, k in features if tid == tenant]
        used += [by_feature.get(r.feature_id) for r in mine if r.feature_id is not None]
        # One item, every live row of it (its versions and drafts), read as its latest row;
        # only an item on a plan read now (a draft, a roadmap's latest version) is renumbered.
        items: dict[tuple[uuid.UUID, str], list[Any]] = {}
        for r in mine:
            if r.deleted_at is None:
                items.setdefault((r.roadmap_document_id, r.item_key), []).append(r)
        plans = {k: {p for r in v if (p := plan(r)) is not None} for k, v in items.items()}
        items = {k: v for k, v in items.items() if plans[k]}
        latest = {
            k: max(v, key=lambda r: (r.created_at or datetime.min, str(r.id)))
            for k, v in items.items()
        }
        first = {k: min(r.created_at or datetime.max for r in v) for k, v in items.items()}

        def order(k: tuple[uuid.UUID, str]) -> tuple[date, datetime, str]:
            return (latest[k].start_date or date.max, first[k], k[1])  # noqa: B023

        # In date order, an item keeps its code unless an earlier item on one of its plans
        # kept it; one with none, or one whose code an earlier item kept, is numbered.
        to_number: list[tuple[uuid.UUID, str]] = []
        kept: set[tuple[tuple[str, Any], str]] = set()
        for k in sorted(latest, key=order):
            code = codes.shown(latest[k], by_feature)
            if code is None or any((p, code.upper()) in kept for p in plans[k]):
                to_number.append(k)
            else:
                kept |= {(p, code.upper()) for p in plans[k]}
        for k in sorted(to_number, key=order):
            row = latest[k]
            old = codes.shown(row, by_feature)
            new = codes.next_number(used)
            used.append(new)
            name = _name(row.title)[: TITLE_MAX - len(new) - 1]
            title = f"{new} {name}"
            ids = [r.id for r in items[k]]
            session.execute(update(t).where(t.c.id.in_(ids)).values(title=title))
            session.execute(
                insert(AuditEvent.__table__).values(
                    id=uuid.uuid4(),
                    tenant_id=tenant,
                    actor="system",
                    action=ACTION,
                    entity="roadmap_item",
                    entity_id=row.id,
                    data={
                        "roadmap_document_id": str(k[0]),
                        "item_key": k[1],
                        "title": name,
                        "old": old,
                        "new": new,
                    },  # fmt: skip
                )
            )
            made.append({"tenant_id": tenant, "roadmap_document_id": k[0], "item_key": k[1],
                         "title": name, "old": old, "new": new})  # fmt: skip
    return made
