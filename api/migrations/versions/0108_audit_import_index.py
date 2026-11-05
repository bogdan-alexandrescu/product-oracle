"""An index for oracle.docs.service.run_imported_into (train AN review)

``ix_audit_events_version_imported``: the document import events by run and document, so
the lookup of whether a run imported a version of a document reads that index instead of
scanning every audit event (EXPLAIN on a seeded table showed a sequential scan). Partial:
only ``document.version_imported`` rows.

Live-safe: built concurrently, outside the migration's transaction, so audited writes go on
while it builds (a plain CREATE INDEX there holds a ShareLock on audit_events until commit).
The downgrade drops it, in its own transaction.

Revision ID: 0108_audit_import_index
Revises: 0107_simple_change_seq
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0108_audit_import_index"
down_revision: str | None = "0107_simple_change_seq"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


INDEX = "ix_audit_events_version_imported"


def upgrade() -> None:
    with op.get_context().autocommit_block():
        # A build an earlier attempt left unfinished is invalid: start again.
        op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {INDEX}")
        op.create_index(
            INDEX,
            "audit_events",
            [sa.text("(data ->> 'run_id')"), sa.text("(data ->> 'document_id')")],
            postgresql_where=sa.text("action = 'document.version_imported'"),
            postgresql_concurrently=True,
        )


def downgrade() -> None:
    # In the downgrade's own transaction: a later step that refuses rolls it back.
    op.drop_index(INDEX, table_name="audit_events")
