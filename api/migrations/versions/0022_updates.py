"""H8 Board and investor drafts: the update document kind, its draft flow and review,
and who sees a document.

- ``update`` joins the document, template and theme kind checks;
- the ``update_draft`` flow and its ``update_review`` checkpoint;
- ``documents.visibility``: ``company`` (every member; the default of every existing and
  other document) or ``approvers`` (owners and approvers only; an update's default), with
  a partial index over the few documents that are not ``company``.

Every check is widened through ``oracle.migration_checks``, which reads the live values,
so no other lane's value is dropped.

The downgrade refuses while update documents exist, unless
``ORACLE_DOWNGRADE_DROP_UPDATES=1``: then it deletes them, their templates and themes,
and update_draft runs; then it drops ``visibility`` and narrows the checks.

Revision ID: 0022_updates
Revises: 0022_checkpoint_actions
"""

import os
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from oracle.migration_checks import add_check_values, remove_check_values

revision: str = "0022_updates"
down_revision: str | None = "0022_checkpoint_actions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CHECKS = (
    ("documents", "ck_documents_kind", "kind", ("update",)),
    ("templates", "ck_templates_kind", "kind", ("update",)),
    ("themes", "ck_themes_kind", "kind", ("update",)),
    ("runs", "ck_runs_flow", "flow", ("update_draft",)),
    ("checkpoints", "ck_checkpoints_kind", "kind", ("update_review",)),
)


def upgrade() -> None:
    for table, name, column, values in CHECKS:
        add_check_values(table, name, column, values)
    op.add_column(
        "documents",
        sa.Column("visibility", sa.Text(), server_default="company", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_documents_visibility"), "documents", "visibility IN ('company', 'approvers')"
    )
    op.create_index(
        "ix_documents_visibility",
        "documents",
        ["tenant_id", "visibility"],
        unique=False,
        postgresql_where=sa.text("visibility <> 'company'"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    documents = bind.scalar(sa.text("SELECT count(*) FROM documents WHERE kind = 'update'"))
    if documents and os.environ.get("ORACLE_DOWNGRADE_DROP_UPDATES") != "1":
        raise RuntimeError(
            f"{documents} update document(s) exist; the downgrade would delete them. Back "
            "up the database, then set ORACLE_DOWNGRADE_DROP_UPDATES=1 to delete them and "
            "downgrade."
        )
    op.execute("DELETE FROM checkpoints WHERE kind = 'update_review'")
    op.execute("DELETE FROM runs WHERE flow = 'update_draft'")
    op.execute("DELETE FROM documents WHERE kind = 'update'")
    op.execute("DELETE FROM templates WHERE kind = 'update'")
    op.execute("DELETE FROM themes WHERE kind = 'update'")
    op.drop_index("ix_documents_visibility", table_name="documents")
    op.drop_constraint(op.f("ck_documents_visibility"), "documents", type_="check")
    op.drop_column("documents", "visibility")
    for table, name, column, values in reversed(CHECKS):
        remove_check_values(table, name, column, values)
