"""Stale marks that only confirmations raised clear (the owner, Nov 23).

A change that only raises the standing of the same content (a proposed feature, goal or link
confirmed, a feature given its code) marks no roadmap item any more
(oracle.baseline.standing). This applies the same rule to the marks stored before: each
reason of a potentially stale or under-review item is judged by the change events that
raised it, and those by their own record and the revisions written with them.

- Every reason exempt, or settled before by a person or an approval: the mark clears, to
  what the item was before it (reconciled, else fresh), and its open stale alerts close.
- Some exempt: the item stays as it is, its exempt reasons dropped, in its alerts too.
- A reason no event explains stays, unless it says in words that something was confirmed.

Freshness columns and stale alerts only: an item's content and an approved version are never
rewritten. Safe to run twice: a kept reason is kept again. The downgrade does nothing.

Revision ID: 0137_stale_by_meaning
Revises: 0136_unique_item_codes
"""

import json
import re
from collections import defaultdict
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ARRAY

revision: str = "0137_stale_by_meaning"
down_revision: str | None = "0136_unique_item_codes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JOIN_FIELDS = {"status", "key"}
CONFIRMED = re.compile(
    r"(?:[a-z][a-z_]*:\S+|\d+ (?:Ground Truth|baseline) items?) (?:was|were) confirmed"
)

MARKED = sa.text(
    "SELECT id, tenant_id, roadmap_document_id, item_key, freshness, stale_reasons,"
    " reconciled_at, caused_by_change_id FROM roadmap_items"
    " WHERE freshness IN ('potentially_stale', 'under_review') AND cardinality(stale_reasons) > 0"
)
# The same item in other versions of its roadmap: a reason moves to a new version's row.
SAME_ITEM = sa.text(
    "SELECT roadmap_document_id, item_key, id FROM roadmap_items"
    " WHERE roadmap_document_id IN :documents"
).bindparams(sa.bindparam("documents", expanding=True))
RAISED = sa.text(
    "SELECT r.key AS item_id, r.value AS reason, e.id, e.created_at, e.cause, e.subject_kind,"
    " e.subject_id, e.data->'fields' AS fields, e.data->'entity' AS entity,"
    " e.data->'edge' AS edge, e.data->'roots' AS roots,"
    " e.data->'standing_only' AS standing_only"
    " FROM change_events AS e"
    " CROSS JOIN LATERAL jsonb_each_text(e.data->'roadmap'->'reasons') AS r"
    " WHERE jsonb_exists(e.data, 'roadmap') AND r.key IN :items"
).bindparams(sa.bindparam("items", expanding=True))
# What was written in the same transaction as the event (both stamped now()).
REVISIONS = sa.text(
    "SELECT created_at, entity_id, before, after FROM entity_revisions WHERE created_at IN :times"
).bindparams(sa.bindparam("times", expanding=True))
CLEAR = sa.text(
    "UPDATE roadmap_items SET freshness = :freshness, stale_reasons = '{}', stale_since = NULL,"
    " caused_by_change_id = NULL WHERE id = :id"
)
SHORTEN = sa.text("UPDATE roadmap_items SET stale_reasons = :reasons WHERE id = :id").bindparams(
    sa.bindparam("reasons", type_=ARRAY(sa.Text()))
)
ALERTS = sa.text(
    "SELECT a.id, a.detail FROM track_alerts AS a JOIN product_tracks AS t ON t.id = a.track_id"
    " WHERE a.kind = 'stale' AND a.state <> 'resolved' AND t.roadmap_document_id = :document"
    " AND a.item_key = :key AND a.fingerprint = :fingerprint"
)
STILL_MARKED = sa.text(
    "SELECT 1 FROM roadmap_items WHERE roadmap_document_id = :document AND item_key = :key"
    " AND freshness IN ('potentially_stale', 'under_review')"
    " AND caused_by_change_id = :caused LIMIT 1"
)
RESOLVE = sa.text("UPDATE track_alerts SET state = 'resolved', resolved_at = now() WHERE id = :id")
DETAIL = sa.text("UPDATE track_alerts SET detail = :detail WHERE id = :id")
AUDIT = sa.text(
    "INSERT INTO audit_events (id, tenant_id, actor, action, entity, entity_id, data)"
    " VALUES (gen_random_uuid(), :tenant, 'system', 'roadmap.items.confirmations_cleared',"
    " 'document', :document, CAST(:data AS jsonb))"
)


def _json(value: Any) -> Any:
    return json.loads(value) if isinstance(value, str) else value


def _raised(before: Any, after: Any, fields: set[str]) -> bool:
    """Only the standing rose: proposed to confirmed, and nothing else but ``fields``."""
    if not isinstance(before, dict) or not isinstance(after, dict):
        return False
    changed = {k for k in {*before, *after} if before.get(k) != after.get(k)}
    if not changed or not changed <= fields:
        return False
    was = (before.get("status"), after.get("status"))
    return "status" not in changed or was == ("proposed", "confirmed")


class _Written:
    """The revisions written with each event, by transaction."""

    def __init__(self, rows: Any) -> None:
        self.entities: dict[tuple, list[tuple]] = defaultdict(list)
        self.edges: dict[tuple, list[tuple]] = defaultdict(list)
        for at, entity_id, before, after in rows:
            before, after = _json(before), _json(after)
            if entity_id is not None:
                self.entities[at, str(entity_id)].append((before, after))
                continue
            ends = after or before or {}
            for end in {ends.get("src_id"), ends.get("dst_id")}:
                self.edges[at, end].append((before, after))

    def standing_only(self, at: Any, cause: Any, change: dict[str, Any]) -> bool:
        """The change of one entity, by what was recorded of it."""
        if isinstance(said := change.get("standing_only"), bool):
            return said
        fields, edge, entity_id = change.get("fields"), change.get("edge"), str(change["id"])
        if cause not in ("entity_confirmed", "entity_updated", "edge_updated"):
            return False
        if not isinstance(fields, list) or not set(fields) <= JOIN_FIELDS or not (fields or edge):
            return False
        if fields and not all(_raised(b, a, JOIN_FIELDS) for b, a in self.entities[at, entity_id]):
            return False
        if "status" in fields and cause != "entity_confirmed" and not self.entities[at, entity_id]:
            return False
        links = self.edges[at, entity_id]
        if edge and not links:
            return False  # the link is gone, and what it was with it
        return all(_raised(b, a, {"status"}) for b, a in links)


def _exempt(event: Any, written: _Written) -> bool:
    if event.subject_kind not in ("entity", "requirement", "decision"):
        return False
    roots = [r for r in _json(event.roots) or [] if isinstance(r, dict) and r.get("id")]
    if roots:
        return all(written.standing_only(event.created_at, r.get("cause"), r) for r in roots)
    if event.subject_id is None:
        return False
    change = {
        "id": event.subject_id,
        "fields": _json(event.fields),
        "edge": _json(event.edge),
        "standing_only": _json(event.standing_only),
    }
    return written.standing_only(event.created_at, event.cause, change)


def _kept(item: Any, events: dict[tuple, list], same: dict, written: _Written) -> list[str]:
    out = []
    for reason in item.stale_reasons:
        if CONFIRMED.fullmatch(reason):
            continue
        rows = [
            e
            for row_id in same[item.roadmap_document_id, item.item_key]
            for e in events[row_id, reason]
        ]
        live = [e for e in rows if not item.reconciled_at or e.created_at > item.reconciled_at]
        if rows and all(_exempt(e, written) for e in live):
            continue  # exempt, or settled before (none of its events is later)
        out.append(reason)
    return out


def _alerts(conn: Any, item: Any, dropped: set[str], cleared: bool) -> None:
    if item.caused_by_change_id is None:
        return
    where = {"document": item.roadmap_document_id, "key": item.item_key}
    if (
        cleared
        and conn.execute(STILL_MARKED, {**where, "caused": item.caused_by_change_id}).first()
    ):
        return
    found = conn.execute(ALERTS, {**where, "fingerprint": str(item.caused_by_change_id)}).all()
    for alert_id, detail in found:
        if cleared:
            conn.execute(RESOLVE, {"id": alert_id})
            continue
        try:
            reasons = json.loads(detail)
        except ValueError:
            continue
        if isinstance(reasons, list) and (left := [r for r in reasons if r not in dropped]):
            conn.execute(DETAIL, {"id": alert_id, "detail": json.dumps(left, ensure_ascii=False)})


def settle(conn: Any) -> None:
    marked = conn.execute(MARKED).all()
    if not marked:
        return
    same: dict[tuple, list[str]] = defaultdict(list)
    documents = sorted({m.roadmap_document_id for m in marked}, key=str)
    for document, key, row_id in conn.execute(SAME_ITEM, {"documents": documents}):
        same[document, key].append(str(row_id))
    ids = sorted({i for m in marked for i in same[m.roadmap_document_id, m.item_key]})
    raised = conn.execute(RAISED, {"items": ids}).all()
    events: dict[tuple, list] = defaultdict(list)
    for e in raised:
        events[e.item_id, e.reason].append(e)
    times = sorted({e.created_at for e in raised})
    written = _Written(conn.execute(REVISIONS, {"times": times}).all() if times else [])
    for item in marked:
        kept = _kept(item, events, same, written)
        if kept == list(item.stale_reasons):
            continue
        cleared = not kept
        if cleared:
            to = "fresh" if item.reconciled_at is None else "reconciled"
            conn.execute(CLEAR, {"id": item.id, "freshness": to})
        else:
            to = item.freshness
            conn.execute(SHORTEN, {"id": item.id, "reasons": kept})
        _alerts(conn, item, set(item.stale_reasons) - set(kept), cleared)
        data = {
            "items": [
                {"item": item.item_key, "id": str(item.id), "from": item.freshness, "to": to}
            ],
            "reasons": len(item.stale_reasons) - len(kept),
            "via": "migration 0137",
        }
        conn.execute(
            AUDIT,
            {
                "tenant": item.tenant_id,
                "document": item.roadmap_document_id,
                "data": json.dumps(data),
            },
        )


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    settle(op.get_bind())


def downgrade() -> None:
    pass
