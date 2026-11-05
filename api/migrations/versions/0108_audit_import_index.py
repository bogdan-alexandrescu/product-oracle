"""An index for oracle.docs.service.run_imported_into (train AN review)

``ix_audit_events_version_imported``: the document import events by run and document, so
the lookup of whether a run imported a version of a document reads that index instead of
scanning every audit event (EXPLAIN on a seeded table showed a sequential scan). Partial:
only ``document.version_imported`` rows. The downgrade drops it.

Revision ID: 0108_audit_import_index
Revises: 0107_simple_change_seq
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0108_audit_import_index"
down_revision: str | None = "0107_simple_change_seq"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(
        "CREATE INDEX ix_audit_events_version_imported ON audit_events "
        "((data ->> 'run_id'), (data ->> 'document_id')) "
        "WHERE action = 'document.version_imported'"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_audit_events_version_imported")
