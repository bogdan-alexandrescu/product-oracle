"""Schedule bases wait for verification (F3 Date bases)

Additive. ``ck_schedule_bases_status`` also allows ``proposed`` (an approver's basis while
an engineering lead is named, waiting for the lead) and ``rejected``, extended with the
additive helpers (oracle.migration_checks). ``verified_at`` may be null for those two
only (``ck_schedule_bases_verified_at``). New nullable columns: ``proposed_by``,
``proposed_at``, ``note``, ``withdrawn_reason``, ``rejected_by``, ``rejected_at``,
``rejected_reason``. ``withdrawn_reason`` is backfilled from each withdrawn basis's
``schedule_basis.withdrawn`` audit event.

The downgrade deletes the proposed and rejected rows (they never supported a date), drops
the columns (the reasons stay in the audit log) and restores the two-value check and NOT
NULL.

Revision ID: 0025_basis_verification
Revises: 0024_segment_skipped
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0025_basis_verification"
down_revision: str | None = "0024_segment_skipped"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_CHECK = ("schedule_bases", "ck_schedule_bases_status", "status")
STATUSES = ("proposed", "rejected")
VERIFIED_AT = "ck_schedule_bases_verified_at"
COLUMNS = (
    ("proposed_by", sa.Uuid()),
    ("proposed_at", sa.DateTime(timezone=True)),
    ("note", sa.Text()),
    ("withdrawn_reason", sa.Text()),
    ("rejected_by", sa.Uuid()),
    ("rejected_at", sa.DateTime(timezone=True)),
    ("rejected_reason", sa.Text()),
)


def upgrade() -> None:
    add_check_values(*STATUS_CHECK, STATUSES)
    op.alter_column("schedule_bases", "verified_at", nullable=True)
    op.create_check_constraint(
        op.f(VERIFIED_AT),
        "schedule_bases",
        "status = 'proposed' OR status = 'rejected' OR verified_at IS NOT NULL",
    )
    for name, type_ in COLUMNS:
        op.add_column("schedule_bases", sa.Column(name, type_, nullable=True))
    op.execute(
        """
        UPDATE schedule_bases b SET withdrawn_reason = e.reason
        FROM (
            SELECT DISTINCT ON (entity_id) entity_id, data->>'reason' AS reason
            FROM audit_events
            WHERE action = 'schedule_basis.withdrawn' AND entity = 'schedule_basis'
            ORDER BY entity_id, created_at DESC
        ) e
        WHERE b.id = e.entity_id AND b.status = 'withdrawn' AND e.reason IS NOT NULL
        """
    )


def downgrade() -> None:
    op.execute("DELETE FROM schedule_bases WHERE status IN ('proposed', 'rejected')")
    for name, _ in reversed(COLUMNS):
        op.drop_column("schedule_bases", name)
    op.drop_constraint(op.f(VERIFIED_AT), "schedule_bases", type_="check")
    op.alter_column("schedule_bases", "verified_at", nullable=False)
    remove_check_values(*STATUS_CHECK, STATUSES)
