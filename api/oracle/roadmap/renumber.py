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
            ).where(t.c.roadmap_document_id.is_not(None))  # fmt: skip
        )
    )
    features = list(
        session.execute(select(Entity.tenant_id, Entity.key).where(Entity.type == "feature"))
    )
    made: list[dict[str, Any]] = []
    for tenant in sorted({r.tenant_id for r in rows}, key=str):
        mine = [r for r in rows if r.tenant_id == tenant]
        used = [codes.shown(r, by_feature) for r in mine]
        used += [k for tid, k in features if tid == tenant]
        used += [by_feature.get(r.feature_id) for r in mine if r.feature_id is not None]
        # One item, every row of it (its versions and drafts), read as its latest live row.
        items: dict[tuple[uuid.UUID, str], list[Any]] = {}
        for r in mine:
            if r.deleted_at is None:
                items.setdefault((r.roadmap_document_id, r.item_key), []).append(r)
        latest = {
            k: max(v, key=lambda r: (r.created_at or datetime.min, str(r.id)))
            for k, v in items.items()
        }
        first = {k: min(r.created_at or datetime.max for r in v) for k, v in items.items()}

        def order(k: tuple[uuid.UUID, str]) -> tuple[date, datetime, str]:
            return (latest[k].start_date or date.max, first[k], k[1])  # noqa: B023

        groups: dict[tuple[uuid.UUID, str], list[tuple[uuid.UUID, str]]] = {}
        to_number: list[tuple[uuid.UUID, str]] = []
        for k, row in latest.items():
            code = codes.shown(row, by_feature)
            if code is None:
                to_number.append(k)
            else:
                groups.setdefault((k[0], code.upper()), []).append(k)
        for group in groups.values():
            if len(group) > 1:
                to_number += sorted(group, key=order)[1:]
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
