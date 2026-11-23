"""Every roadmap item has its own code; nothing shares one (the owner, Nov 23).

Items of one Ground Truth feature read the feature's code, so several items read the same
one. Within each group of a roadmap's items sharing a code, the item with the earliest start
date (ties: the earliest created) keeps it; each other one, in date order, takes the next free
feature number as its own code (its title's lead), as does an item with no code at all. An
item whose code is unique is never renumbered. Each change is audited (old code -> new code):
the logic below is a frozen copy of what the app did when this was written (a migration
imports no live app code). Safe to run twice: a second run changes nothing.

The downgrade does nothing (the codes given stay, as a person's set_code would).

Revision ID: 0136_unique_item_codes
Revises: 0135_feature_comments
"""

import re
import uuid
from collections.abc import Sequence
from datetime import date, datetime
from typing import Any

from alembic import op
from sqlalchemy import Connection, cast, column, func, insert, select, table, update
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.types import Date, DateTime, Integer, Text, Uuid

revision: str = "0136_unique_item_codes"
down_revision: str | None = "0135_feature_comments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ACTION = "roadmap.item.code_renumbered"
TITLE_MAX = 200
DECLINED = "_declined_items"

# The codes' shapes, as the app read them then.
LEADING_CODE = re.compile(r"^[A-Z][A-Z0-9]*-\d+[a-z]?\s+")
FEATURE_CODE = re.compile(r"[A-Z]{1,3}-\d+[a-j]?")
PRD_SECTION_CODE = re.compile(r"([a-z]{1,3})-(\d+)", re.IGNORECASE)
F_NUMBER = re.compile(r"F-(\d+)[a-j]?")

# The columns this reads and writes, by name: a column a later migration adds is neither
# selected nor required here.
ITEMS = table(
    "roadmap_items",
    column("id", Uuid),
    column("tenant_id", Uuid),
    column("roadmap_document_id", Uuid),
    column("item_key", Text),
    column("title", Text),
    column("feature_id", Uuid),
    column("prd_section_key", Text),
    column("deleted_at", DateTime(timezone=True)),
    column("created_at", DateTime(timezone=True)),
    column("start_date", Date),
    column("roadmap_version_id", Uuid),
    column("draft_roadmap_id", Uuid),
    column("simple_draft_id", Uuid),
)
ENTITIES = table(
    "entities",
    column("id", Uuid),
    column("tenant_id", Uuid),
    column("type", Text),
    column("key", Text),
    column("title", Text),
    column("attrs", JSONB),
    column("created_at", DateTime(timezone=True)),
)
VERSIONS = table(
    "document_versions", column("id", Uuid), column("document_id", Uuid), column("number", Integer)
)
AUDIT = table(
    "audit_events",
    column("id", Uuid),
    column("tenant_id", Uuid),
    column("actor", Text),
    column("action", Text),
    column("entity", Text),
    column("entity_id", Uuid),
    column("data", JSONB),
)


def title_code(title: str | None) -> str | None:
    """The code a title gives its item ("F-31 Alerts": F-31); None when it leads with none or
    is a code alone."""
    m = LEADING_CODE.match(title or "")
    return m.group(0).strip() if m and (title or "")[m.end() :].strip() else None


def _name(title: str) -> str:
    """A title less the code it leads with ("F-51 Alert routing": Alert routing)."""
    m = LEADING_CODE.match(title or "")
    return title[m.end() :].strip() if m and title[m.end() :].strip() else title


def prd_code(section_key: str | None) -> str | None:
    m = PRD_SECTION_CODE.fullmatch((section_key or "").strip())
    return f"{m.group(1).upper()}-{m.group(2)}" if m else None


def next_number(used: Any) -> str:
    """The next free feature code: the highest F-number in ``used`` plus one."""
    nums = [int(m.group(1)) for u in used if u and (m := F_NUMBER.fullmatch(u.split(".")[0]))]
    return f"F-{max(nums, default=0) + 1}"


def _initials(name: str) -> str:
    words = re.findall(r"[^\W\d_]+", name)
    number = next(iter(re.findall(r"\d+", name)), "")
    if len(words) >= 2:
        return "".join(w[0] for w in words[:3]).upper() + number
    return ((words[0] if words else "") + "xx")[:2].upper() + number


def short_codes(keys: list[str], prd: dict[str, str], names: dict[str, str]) -> list[str]:
    """Each feature's short code, for feature keys in creation order: the key when it is a
    code, else its PRD section's code, else initials; a digit added on a clash."""
    out: list[str | None] = [None] * len(keys)
    taken: set[str] = set()
    for i, k in enumerate(keys):
        own = k if FEATURE_CODE.fullmatch(k) else prd.get(k)
        if own is None:
            continue
        if own in taken and not FEATURE_CODE.fullmatch(k):
            continue
        code, n = own, 1
        while code in taken:
            n += 1
            code = f"{own}.{n}"
        out[i] = code
        taken.add(code)
    for i, k in enumerate(keys):
        if out[i] is not None:
            continue
        base = _initials(names.get(k) or k)
        sep = "." if base[-1:].isdigit() else ""
        code, n = base, 1
        while code in taken:
            n += 1
            code = f"{base}{sep}{n}"
        taken.add(code)
        out[i] = code
    return out  # type: ignore[return-value]


def feature_codes(conn: Connection) -> dict[uuid.UUID, str]:
    """Each feature's code (its key when a code, else its PRD section's, else initials)."""
    # An item that declined its feature gives that feature no code.
    mark = func.concat(cast(ITEMS.c.roadmap_document_id, Text), "/", ITEMS.c.item_key)
    declined = (
        select(ENTITIES.c.id)
        .where(
            ENTITIES.c.id == ITEMS.c.feature_id,
            ENTITIES.c.attrs.op("->")(DECLINED).op("@>", is_comparison=True)(
                func.jsonb_build_array(mark)
            ),
        )
        .exists()
    )
    features = list(
        conn.execute(
            select(ENTITIES.c.id, ENTITIES.c.key, ENTITIES.c.title)
            .where(ENTITIES.c.type == "feature")
            .order_by(ENTITIES.c.created_at, ENTITIES.c.key)
        ).all()
    )
    sections = conn.execute(
        select(ITEMS.c.feature_id, ITEMS.c.prd_section_key)
        .where(
            ITEMS.c.feature_id.is_not(None),
            ITEMS.c.prd_section_key.is_not(None),
            ITEMS.c.roadmap_version_id.is_not(None),
            ~declined,
        )
        .order_by(ITEMS.c.created_at)
    ).all()
    key_of = {i: k for i, k, _ in features}
    prd: dict[str, str] = {}
    for fid, section in sections:
        code = prd_code(section)
        if code and fid in key_of:
            prd.setdefault(key_of[fid], code)
    names = {k: t for _, k, t in features if (t or "").strip()}
    made = short_codes([k for _, k, _ in features], prd, names)
    return {
        fid: code
        for (fid, _, _), code in zip(features, made, strict=True)
        if code and FEATURE_CODE.fullmatch(code.split(".")[0])
    }


def renumber(conn: Connection) -> list[dict[str, Any]]:
    """Gives every roadmap item sharing a code (or with none) its own; the changes made, each
    ``{"tenant_id", "roadmap_document_id", "item_key", "title", "old", "new"}``."""
    by_feature = feature_codes(conn)
    a = AUDIT
    # Items an earlier run numbered: their title's lead is their own code.
    numbered = {
        (tid, d["roadmap_document_id"], d["item_key"]): d["new"]
        for tid, d in conn.execute(select(a.c.tenant_id, a.c.data).where(a.c.action == ACTION))
    }

    def before(r: Any) -> str | None:
        """The code ``r`` showed before every item had its own: its feature's, else its PRD
        section's, else its title's lead; its own once a run numbered it."""
        lead = title_code(r.title)
        if lead is not None and numbered.get((r.tenant_id, str(r.roadmap_document_id),
                                              r.item_key)) == lead:  # fmt: skip
            return lead
        got = by_feature.get(r.feature_id) if r.feature_id is not None else None
        return got or prd_code(r.prd_section_key) or lead

    t = ITEMS
    rows = list(
        conn.execute(
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
    features = list(conn.execute(select(ENTITIES.c.tenant_id, ENTITIES.c.key).where(
        ENTITIES.c.type == "feature")))  # fmt: skip
    # Each roadmap's latest version: with the drafts, the plans an item is read on now.
    v = VERSIONS
    numbers = list(conn.execute(select(v.c.id, v.c.document_id, v.c.number)))
    top: dict[uuid.UUID, int] = {}
    for _, doc, n in numbers:
        top[doc] = max(top.get(doc, n), n)
    current_versions = {vid for vid, doc, n in numbers if top[doc] == n}

    def plan(r: Any) -> tuple[str, Any] | None:
        """The plan ``r`` is on: a draft, or its roadmap's latest version; None for an older
        version."""
        if r.roadmap_version_id is not None:
            return ("v", r.roadmap_version_id) if r.roadmap_version_id in current_versions else None
        return (
            ("d", r.draft_roadmap_id)
            if r.draft_roadmap_id is not None
            else ("s", r.simple_draft_id)
        )

    # A title leading with another code than the one its item shows takes that code as its
    # lead: the item shows the code and name it showed, under the own-code-first read.
    titles = {r.id: r.title for r in rows}
    for r in rows:
        code, lead = before(r), title_code(r.title)
        if code and lead and lead.upper() != code.upper():
            titles[r.id] = f"{code} {r.title[: TITLE_MAX - len(code) - 1]}"
            conn.execute(update(t).where(t.c.id == r.id).values(title=titles[r.id]))

    made: list[dict[str, Any]] = []
    for tenant in sorted({r.tenant_id for r in rows}, key=str):
        mine = [r for r in rows if r.tenant_id == tenant]
        used = [before(r) for r in mine]
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
            code = before(latest[k])
            if code is None or any((p, code.upper()) in kept for p in plans[k]):
                to_number.append(k)
            else:
                kept |= {(p, code.upper()) for p in plans[k]}
        for k in sorted(to_number, key=order):
            row = latest[k]
            old = before(row)
            new = next_number(used)
            used.append(new)
            name = _name(titles[row.id])[: TITLE_MAX - len(new) - 1]
            title = f"{new} {name}"
            ids = [r.id for r in items[k]]
            conn.execute(update(t).where(t.c.id.in_(ids)).values(title=title))
            conn.execute(
                insert(a).values(
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


def upgrade() -> None:
    renumber(op.get_bind())


def downgrade() -> None:
    pass
