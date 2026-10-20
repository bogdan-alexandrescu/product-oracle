"""Blocker gate snapshots for blockers recorded before snapshots existed (data only)

The readiness gate compares a blocker's strategy (``entities.attrs["blocker"]``) with the
snapshot its last resolution event recorded (``data["gate"]``). Blockers written before
snapshots existed have none, and the reads that used to record one on first assessment
never committed it. This writes one ``legacy_snapshot`` event for every such blocker
whose strategy can be read, from its current strategy, so reads never write. A strategy
that cannot be read gets none: the gate keeps treating it as critical. Blockers that
already have a snapshot, and plain constraints, are left alone.

Self-contained on purpose (no application imports): the gate fields are checked against
the values the strategy schema accepted when this was written. A strategy that passes
here but fails the application's full schema stays critical anyway (the gate reads no
snapshot for a strategy it cannot read).

Downgrade deletes exactly the events this upgrade wrote (``data.migration``).

Revision ID: 0014_blockers_snapshot
Revises: 0014_trace
"""

import json
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

import sqlalchemy as sa
from alembic import op

revision: str = "0014_blockers_snapshot"
down_revision: str | None = "0014_trace"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TYPES = ("hard", "soft", "unknown", "temporary")
SEVERITIES = ("critical", "high", "medium", "low")
STATUSES = ("open", "mitigating", "resolved", "accepted_risk", "feasibility_only")
ACTOR = "system:migration"
REASON = "Gate snapshot taken from a blocker recorded before snapshots existed"


def _snapshot(raw: object) -> dict | None:
    """The gate snapshot of a stored strategy (oracle.blockers.service.gate_snapshot), or
    None when the gate fields cannot be read."""
    if not isinstance(raw, dict):
        return None
    type_ = raw.get("type")
    severity = raw.get("severity", "medium")
    status = raw.get("status", "open")
    docs = raw.get("document_ids", [])
    if type_ not in TYPES or severity not in SEVERITIES or status not in STATUSES:
        return None
    if not isinstance(docs, list):
        return None
    try:
        doc_ids = sorted(str(uuid.UUID(str(d))) for d in docs)
    except ValueError:
        return None
    return {"type": type_, "severity": severity, "status": status, "document_ids": doc_ids}


def upgrade() -> None:
    conn = op.get_bind()
    rows = conn.execute(
        sa.text(
            "SELECT e.id, e.tenant_id, e.attrs -> 'blocker' AS blocker, "
            "(SELECT max(r.created_at) FROM blocker_resolution_events r "
            " WHERE r.blocker_id = e.id) AS latest "
            "FROM entities e "
            "WHERE e.type = 'constraint' AND e.attrs ? 'blocker' "
            "AND NOT EXISTS (SELECT 1 FROM blocker_resolution_events g "
            "  WHERE g.blocker_id = e.id AND g.data ? 'gate') "
            "ORDER BY e.id FOR UPDATE OF e"
        )
    ).all()
    now = datetime.now(UTC)
    insert = sa.text(
        "INSERT INTO blocker_resolution_events "
        "(id, tenant_id, blocker_id, kind, reason, actor, data, created_at) "
        "VALUES (:id, :t, :b, 'status_changed', :reason, :actor, CAST(:data AS jsonb), :at)"
    )
    for entity_id, tenant_id, blocker, latest in rows:
        gate = _snapshot(blocker)
        if gate is None:
            continue  # unreadable: stays critical
        # After every recorded event of the blocker, so it reads as the latest snapshot.
        at = now
        if latest is not None:
            latest = latest if latest.tzinfo else latest.replace(tzinfo=UTC)
            if latest >= now:
                at = latest + timedelta(microseconds=1)
        data = {"change": "legacy_snapshot", "gate": gate, "migration": revision}
        conn.execute(
            insert,
            {
                "id": uuid.uuid4(),
                "t": tenant_id,
                "b": entity_id,
                "reason": REASON,
                "actor": ACTOR,
                "data": json.dumps(data),
                "at": at,
            },
        )


def downgrade() -> None:
    op.execute(
        sa.text(
            "DELETE FROM blocker_resolution_events WHERE actor = :actor "
            "AND data ->> 'migration' = :rev"
        ).bindparams(actor=ACTOR, rev=revision)
    )
