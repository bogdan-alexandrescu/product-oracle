"""Audit events by action and entity (version-read-speed)

``ix_audit_events_tenant_id_action_entity_id``: a lookup of a company's events by what
happened and, often, to what (who imported a document version and whether a run's draft
was imported again, read on every version read) reads its own rows. Without it each such
read scanned every audit event the company ever wrote: a big PRD's version page waited
about 30 s on a long log.

Live-safe: built concurrently, so writing audit events goes on while it builds. The
downgrade drops it, in its own transaction.

Revision ID: 0107_audit_action_entity
Revises: 0106_company_roadmap
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0107_audit_action_entity"
down_revision: str | None = "0106_company_roadmap"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

INDEX = "ix_audit_events_tenant_id_action_entity_id"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        # A build an earlier attempt left unfinished is invalid: start again.
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX}")
        op.create_index(
            INDEX,
            "audit_events",
            ["tenant_id", "action", "entity_id"],
            postgresql_concurrently=True,
        )


def downgrade() -> None:
    # In the downgrade's own transaction: a later step that refuses rolls it back.
    op.drop_index(INDEX, table_name="audit_events")
