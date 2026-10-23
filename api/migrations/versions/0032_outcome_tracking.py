"""Outcome tracking against predictions (H3 Predicted versus actual)

``outcome_records`` gains the roadmap item and track it was predicted for, whether it
still needs a numeric prediction, the confidence at prediction, when and how it shipped,
when it is due for its check, Oracle's proposed assessment and the decision it came from.
``ck_outcome_records_status`` gains ``predicted`` (oracle.migration_checks, keeping other
lanes' values). Existing rows keep ``tracking`` and get ``assess_due_on`` from their
prediction's ``by``, so they surface once.

The downgrade deletes ``predicted`` rows (they never shipped), drops the columns and the
three settings (``outcome_measure_days``, ``calibration_min_outcomes``,
``outcome_calibration``).

Revision ID: 0032_outcome_tracking
Revises: 0031_rituals
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0032_outcome_tracking"
down_revision: str | None = "0031_rituals"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

T = "outcome_records"
CHECK = "ck_outcome_records_status"
FK_COLUMNS = ("roadmap_item_id", "track_id", "decision_id")
SETTINGS = ("outcome_measure_days", "calibration_min_outcomes", "outcome_calibration")


def upgrade() -> None:
    add_check_values(T, CHECK, "status", ("predicted",))
    op.add_column(
        T,
        sa.Column(
            "roadmap_item_id",
            sa.Uuid(),
            sa.ForeignKey("roadmap_items.id", ondelete="SET NULL"),
        ),
    )
    op.add_column(
        T,
        sa.Column("track_id", sa.Uuid(), sa.ForeignKey("product_tracks.id", ondelete="SET NULL")),
    )
    op.add_column(
        T,
        sa.Column("needs_prediction", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(T, sa.Column("confidence_at_prediction", sa.Numeric(4, 3)))
    op.create_check_constraint(
        op.f("ck_outcome_records_confidence_at_prediction"),
        T,
        "confidence_at_prediction IS NULL OR confidence_at_prediction BETWEEN 0 AND 1",
    )
    op.add_column(T, sa.Column("shipped_at", sa.DateTime(timezone=True)))
    op.add_column(T, sa.Column("ship_signal", postgresql.JSONB()))
    op.add_column(T, sa.Column("assess_due_on", sa.Date()))
    op.add_column(T, sa.Column("proposed_assessment", postgresql.JSONB()))
    op.add_column(
        T,
        sa.Column("decision_id", sa.Uuid(), sa.ForeignKey("decisions.id", ondelete="SET NULL")),
    )
    for column in FK_COLUMNS:
        op.create_index(op.f(f"ix_{T}_{column}"), T, [column], unique=False)
    op.create_index(
        "ux_outcome_records_item",
        T,
        ["tenant_id", "roadmap_item_id"],
        unique=True,
        postgresql_where=sa.text("roadmap_item_id IS NOT NULL"),
    )
    op.create_index(
        "ix_outcome_records_due",
        T,
        ["tenant_id", "assess_due_on"],
        postgresql_where=sa.text("status = 'tracking'"),
    )
    op.execute(
        "UPDATE outcome_records SET assess_due_on = (prediction->>'by')::date "
        "WHERE status = 'tracking' AND prediction->>'by' IS NOT NULL "
        "AND prediction->>'by' <> ''"
    )


def downgrade() -> None:
    op.execute("DELETE FROM outcome_records WHERE status = 'predicted'")
    op.drop_index("ix_outcome_records_due", table_name=T)
    op.drop_index("ux_outcome_records_item", table_name=T)
    for column in FK_COLUMNS:
        op.drop_index(op.f(f"ix_{T}_{column}"), table_name=T)
    op.drop_constraint(op.f("ck_outcome_records_confidence_at_prediction"), T, type_="check")
    for column in (
        "decision_id", "proposed_assessment", "assess_due_on", "ship_signal", "shipped_at",
        "confidence_at_prediction", "needs_prediction", "track_id", "roadmap_item_id",
    ):  # fmt: skip
        op.drop_column(T, column)
    remove_check_values(T, CHECK, "status", ("predicted",))
    keys = ", ".join(f"'{k}'" for k in SETTINGS)
    op.execute(f"DELETE FROM tenant_settings WHERE key IN ({keys})")
