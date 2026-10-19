"""Trace: staleness survives a deleted upstream entity (v2 wave 1, lane v2-trace)

Additive. ``artifact_dependencies.upstream_entity_id`` was ON DELETE CASCADE, so deleting
a baseline entity deleted the stale marks on what was built on it. Now it is ON DELETE
SET NULL, and two nullable columns keep what the dependency pointed at:
``upstream_snapshot`` (the entity's id, type, key, title and status) and
``upstream_deleted_at``. The upstream check also accepts a snapshot. Existing rows are
untouched.

``document_section_links.source_item_id`` stays ON DELETE SET NULL: a link that also
names an entity or evidence keeps it when its source item goes. A link that would be left
with no target is deleted by the delete paths first (``oracle.v2.links``), so its target
check holds.

The downgrade deletes the rows whose upstream entity is gone (the old schema would have
cascaded them) and restores the cascade.

Re-chained on 0014_usage_retry_at at the wave 1 integration, part 2 (waves.md: 0014_* in
merge order).

Revision ID: 0014_trace
Revises: 0014_usage_retry_at
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_trace"
down_revision: str | None = "0014_usage_retry_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "artifact_dependencies"
FK = "fk_artifact_dependencies_upstream_entity_id_entities"
CHECK = "ck_artifact_dependencies_upstream"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("upstream_snapshot", postgresql.JSONB(astext_type=sa.Text())))
    op.add_column(TABLE, sa.Column("upstream_deleted_at", sa.DateTime(timezone=True)))
    op.drop_constraint(op.f(FK), TABLE, type_="foreignkey")
    op.create_foreign_key(
        op.f(FK), TABLE, "entities", ["upstream_entity_id"], ["id"], ondelete="SET NULL"
    )
    op.drop_constraint(op.f(CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(CHECK),
        TABLE,
        "upstream_version_id IS NOT NULL OR upstream_entity_id IS NOT NULL"
        " OR upstream_snapshot IS NOT NULL",
    )


def downgrade() -> None:
    op.execute(
        "DELETE FROM artifact_dependencies "
        "WHERE upstream_version_id IS NULL AND upstream_entity_id IS NULL"
    )
    op.drop_constraint(op.f(CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(CHECK), TABLE, "upstream_version_id IS NOT NULL OR upstream_entity_id IS NOT NULL"
    )
    op.drop_constraint(op.f(FK), TABLE, type_="foreignkey")
    op.create_foreign_key(
        op.f(FK), TABLE, "entities", ["upstream_entity_id"], ["id"], ondelete="CASCADE"
    )
    op.drop_column(TABLE, "upstream_deleted_at")
    op.drop_column(TABLE, "upstream_snapshot")
