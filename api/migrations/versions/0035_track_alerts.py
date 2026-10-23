"""F2 Track health: track alerts and tracker history

Additive. ``track_alerts`` holds one situation on one track (a slip, drift, a blocker, a
stale item, a moved PRD) with its state (open, kept, resolved); a track-level alert
stores ``''`` as its item key, so the unique key needs no NULLS NOT DISTINCT.
``tracker_record_events`` keeps a tracker record's changed fields per import (before and
after).

Live-safe: two new tables, nothing else is read or locked.

The downgrade drops both tables; bases and milestones moved by accepted dates stay.

Revision ID: 0035_track_alerts
Revises: 0034_draft_roadmaps
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0035_track_alerts"
down_revision: str | None = "0034_draft_roadmaps"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

ALERTS = "track_alerts"
EVENTS = "tracker_record_events"
# Frozen here as of this revision (oracle.roadmap.models).
KINDS = ("date_slip", "overdue", "cancelled", "ahead", "unplanned", "blocked", "stale",
         "prd_moved")  # fmt: skip
STATES = ("open", "kept", "resolved")
FIELDS = ("state", "target_date", "estimate", "raw_status")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(repr(v) for v in values)})"


def _common(table: str) -> list:
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f(f"fk_{table}_tenant_id_tenants"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]


def upgrade() -> None:
    op.create_table(
        ALERTS,
        sa.Column("track_id", sa.Uuid(), nullable=False),
        sa.Column("item_key", sa.Text(), server_default="", nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("fingerprint", sa.Text(), nullable=False),
        sa.Column("detail", sa.Text(), nullable=False),
        sa.Column("data", JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.Column("state", sa.Text(), server_default="open", nullable=False),
        sa.Column(
            "opened_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),  # fmt: skip
        sa.Column("opened_change_id", sa.Uuid(), nullable=True),
        sa.Column("kept_by", sa.Uuid(), nullable=True),
        sa.Column("kept_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        *_common(ALERTS),
        sa.CheckConstraint(_in("kind", KINDS), name=op.f(f"ck_{ALERTS}_kind")),
        sa.CheckConstraint(_in("state", STATES), name=op.f(f"ck_{ALERTS}_state")),
        sa.CheckConstraint(
            "note IS NULL OR char_length(note) <= 500", name=op.f(f"ck_{ALERTS}_note")
        ),
        sa.ForeignKeyConstraint(
            ["track_id"],
            ["product_tracks.id"],
            name=op.f(f"fk_{ALERTS}_track_id_product_tracks"),
            ondelete="CASCADE",
        ),  # fmt: skip
        sa.ForeignKeyConstraint(
            ["opened_change_id"],
            ["change_events.id"],
            name=op.f(f"fk_{ALERTS}_opened_change_id_change_events"),
            ondelete="SET NULL",
        ),  # fmt: skip
        sa.UniqueConstraint(
            "track_id",
            "item_key",
            "kind",
            "fingerprint",
            name=op.f(f"uq_{ALERTS}_track_id_item_key_kind_fingerprint"),
        ),  # fmt: skip
    )
    op.create_index(op.f(f"ix_{ALERTS}_tenant_id"), ALERTS, ["tenant_id"], unique=False)
    op.create_index(
        "ix_track_alerts_open",
        ALERTS,
        ["tenant_id", "state"],
        postgresql_where=sa.text("state <> 'resolved'"),
    )
    op.create_table(
        EVENTS,
        sa.Column("record_id", sa.Uuid(), nullable=False),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("field", sa.Text(), nullable=False),
        sa.Column("before", sa.Text(), nullable=True),
        sa.Column("after", sa.Text(), nullable=True),
        *_common(EVENTS),
        sa.CheckConstraint(_in("field", FIELDS), name=op.f(f"ck_{EVENTS}_field")),
        sa.ForeignKeyConstraint(
            ["record_id"],
            ["tracker_records.id"],
            name=op.f(f"fk_{EVENTS}_record_id_tracker_records"),
            ondelete="CASCADE",
        ),  # fmt: skip
    )
    op.create_index(op.f(f"ix_{EVENTS}_tenant_id"), EVENTS, ["tenant_id"], unique=False)
    op.create_index(
        "ix_tracker_record_events_record", EVENTS, ["record_id", "observed_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_tracker_record_events_record", table_name=EVENTS)
    op.drop_index(op.f(f"ix_{EVENTS}_tenant_id"), table_name=EVENTS)
    op.drop_table(EVENTS)
    op.drop_index("ix_track_alerts_open", table_name=ALERTS)
    op.drop_index(op.f(f"ix_{ALERTS}_tenant_id"), table_name=ALERTS)
    op.drop_table(ALERTS)
