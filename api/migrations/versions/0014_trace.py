"""Trace: staleness survives a deleted upstream entity (v2 wave 1, lane v2-trace)

Additive. ``artifact_dependencies.upstream_entity_id`` was ON DELETE CASCADE, so deleting
a baseline entity deleted the stale marks on what was built on it. Now it is ON DELETE
SET NULL, and two nullable columns keep what the dependency pointed at:
``upstream_snapshot`` (the entity's id, type, key, title and status) and
``upstream_deleted_at``. The upstream check also accepts a snapshot. Existing rows are
untouched.

``document_section_links.source_item_id`` was ON DELETE SET NULL while the link's check
needs a target: deleting the source of a link that cites only a source item failed the
check. It now cascades, like ``entity_id`` and ``evidence_id`` (the trace handler records
what the link was before its source is deleted).

The downgrade deletes the rows whose upstream entity is gone (the old schema would have
cascaded them) and restores the cascade; a section link's source item goes back to SET NULL.

The integrator re-chains this onto the head of the merged wave.

Revision ID: 0014_trace
Revises: 0013
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0014_trace"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "artifact_dependencies"
FK = "fk_artifact_dependencies_upstream_entity_id_entities"
CHECK = "ck_artifact_dependencies_upstream"
LINKS = "document_section_links"
LINK_ITEM_FK = "fk_document_section_links_source_item_id_source_items"


def _link_item_fk(ondelete: str) -> None:
    op.drop_constraint(op.f(LINK_ITEM_FK), LINKS, type_="foreignkey")
    op.create_foreign_key(
        op.f(LINK_ITEM_FK), LINKS, "source_items", ["source_item_id"], ["id"], ondelete=ondelete
    )


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
    _link_item_fk("CASCADE")


def downgrade() -> None:
    _link_item_fk("SET NULL")
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
