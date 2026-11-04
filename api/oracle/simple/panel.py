"""build-feature-panel: what Simple's one feature panel reads besides the item itself, both
from the item's own changes (oracle.simple.changes), so no new columns are needed.

- ``override``: the dates a person set over Oracle's (an engineering estimate, a tracker's
  dates, an accepted suggestion...): Oracle's dates and their source, kept from the first
  change that replaced them, and who set the dates the item has now. None when the item's
  dates are Oracle's, or a ``restore_dates`` put them back.
- ``links``: each link the item depends on, who added it (None: Oracle found it, from the PRD
  or the roadmap), and Oracle's links a person removed (``removed``, ``removed_by``), which
  the panel shows struck through with Restore.
- ``goal_set`` (build-feature-panel review 2): the goal and measure a person set on the item
  (``set_goal``), which win over the goal its feature supports: Oracle's goal as the item
  showed it, kept from the first ``set_goal``, the goal_ids to put back, and who set it. None
  when no one did, or a ``restore_goal`` put Oracle's back.

Only written changes count: applied or accepted, and not undone.
"""

import uuid
from collections import defaultdict
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.auth.models import User
from oracle.members.names import display_name
from oracle.simple.models import SimpleChange

DATE_OPS = ("move_dates", "restore_dates", "accept_date_suggestion", "shift_dependents",
            "move_dependency")  # fmt: skip
RESTORED = ("start_date", "end_date", "date_source")
LINK_OPS = ("add_link", "remove_link", "restore_link")
GOAL_OPS = ("set_goal", "restore_goal")


async def _written(db: AsyncSession, docs: set[uuid.UUID], ops: tuple[str, ...]) -> list:
    if not docs:
        return []
    # One statement: the ops' rows and every undo row (an undo keeps its change's op).
    rows = list(
        await db.scalars(
            select(SimpleChange)
            .where(SimpleChange.document_id.in_(docs), SimpleChange.op.in_(ops))
            .order_by(SimpleChange.at, SimpleChange.id)
        )
    )
    undone = {r.undoes_id for r in rows if r.undoes_id is not None}
    return [r for r in rows if r.status in ("applied", "accepted") and r.id not in undone]


async def _names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    return {
        u.id: display_name(u.email, u.name)
        for u in await db.scalars(select(User).where(User.id.in_(ids)))
    }


def _dates_of(c: SimpleChange, item: str) -> tuple[dict, dict] | None:
    """The change's (before, after) dates of the item, or None when it did not date it."""
    if c.op in ("shift_dependents", "move_dependency"):
        b, a = (c.before or {}).get(item), (c.after or {}).get(item)
        return (b, a) if isinstance(b, dict) and isinstance(a, dict) else None
    if (c.target or {}).get("item_id") != item:
        return None
    return c.before or {}, c.after or {}


def overrides(rows: list, rows_by: dict[uuid.UUID, str], item: str) -> dict[str, Any] | None:
    """The item's override (Oracle's dates kept, who set the new ones), from its date
    changes in order."""
    kept: dict[str, Any] | None = None
    for c in rows:
        if c.op not in DATE_OPS:
            continue
        both = _dates_of(c, item)
        if both is None:
            continue
        before, after = both
        if c.op == "restore_dates" or after.get("date_source") != "typed":
            kept = None
            continue
        if kept is None:
            # Oracle's dates as the item showed them (a move_dates keeps them), else the
            # row's own when they were not a person's.
            oracle = (c.target or {}).get("oracle") if c.op == "move_dates" else None
            if oracle is None:
                if before.get("date_source") in (None, "typed") or not before.get("end_date"):
                    continue
                oracle = {"start_date": before.get("start_date"),
                          "end_date": before.get("end_date"),
                          "source": before.get("date_source")}  # fmt: skip
            kept = {**oracle, "restore": {f: before.get(f) for f in RESTORED}}
        kept |= {"by": rows_by.get(c.by), "at": c.at}
    return kept


async def goal_sets(db: AsyncSession, docs: set[uuid.UUID]) -> dict[str, dict[str, Any]]:
    """Item id -> its goal set by a person now (``oracle``: Oracle's goal, ``restore``: the
    goal_ids before, ``by``: a user id, ``at``, ``measure``)."""
    out: dict[str, dict[str, Any]] = {}
    for c in await _written(db, docs, GOAL_OPS):
        item = str((c.target or {}).get("item_id"))
        if c.op == "restore_goal":
            out.pop(item, None)
            continue
        kept = out.setdefault(
            item,
            {"oracle": (c.target or {}).get("oracle"),
             "restore": list((c.before or {}).get("goal_ids") or [])},
        )  # fmt: skip
        kept |= {"by": c.by, "at": c.at, "measure": (c.target or {}).get("measure")}
    return out


async def item_panel(db: AsyncSession, read_: Any, shown: list) -> dict[uuid.UUID, dict]:
    """``override`` and ``links`` of the shown items, keyed by item id."""
    docs = {e.row.roadmap_document_id for e in shown}
    rows = await _written(db, docs, DATE_OPS + LINK_OPS)
    names = await _names(db, {c.by for c in rows} | {e.goal_set["by"] for e in shown if e.goal_set})
    by_version = {(e.row.roadmap_version_id, e.row.item_key): e for e in read_.entries}
    per_item: dict[str, list] = defaultdict(list)
    for c in rows:
        if c.op in LINK_OPS:
            per_item[str((c.target or {}).get("item_id"))].append(c)
    out: dict[uuid.UUID, dict] = {}
    for e in shown:
        item = str(e.row.id)
        override = overrides(rows, names, item) if e.row.date_source == "typed" else None
        added: dict[str, str | None] = {}
        removed: dict[str, str | None] = {}
        for c in per_item.get(item, []):
            key = (c.target or {}).get("subject_key")
            if not key:
                continue
            who = names.get(c.by)
            if c.op == "add_link":
                added[key] = who
                removed.pop(key, None)
            elif c.op == "remove_link":
                if key in added:
                    added.pop(key)
                else:
                    removed[key] = who
            else:
                removed.pop(key, None)
        links: list[dict[str, Any]] = []
        for key in e.row.depends_on or []:
            dep = by_version.get((e.row.roadmap_version_id, key))
            if dep is not None and dep is not e:
                links.append({"item_id": dep.row.id, "by": added.get(key), "removed": False,
                              "removed_by": None})  # fmt: skip
        for key, who in removed.items():
            dep = by_version.get((e.row.roadmap_version_id, key))
            if dep is not None and key not in (e.row.depends_on or []):
                links.append({"item_id": dep.row.id, "by": None, "removed": True,
                              "removed_by": who})  # fmt: skip
        gs = e.goal_set
        goal_set = (
            {
                "oracle": gs["oracle"],
                "by": names.get(gs["by"]),
                "at": gs["at"],
                "measure": gs["measure"],
            }  # fmt: skip
            if gs is not None
            else None
        )
        out[e.row.id] = {"override": override, "links": links, "goal_set": goal_set}
    return out


async def override_of(db: AsyncSession, row: Any) -> dict[str, Any] | None:
    """The one item's override now (``restore_dates`` puts its Oracle dates back)."""
    if row.date_source != "typed":
        return None
    rows = await _written(db, {row.roadmap_document_id}, DATE_OPS)
    return overrides(rows, {}, str(row.id))
