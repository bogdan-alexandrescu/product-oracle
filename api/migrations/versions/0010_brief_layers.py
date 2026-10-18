"""Brief and full layers (O1f), and per-user preferences

``sections.layer`` records whether each section of a version is in the brief layer or
is detail; ``document_versions.brief_source`` records where that came from (the
draft's front matter, its template's markers, a "Full version" heading, or none).
Versions imported before this revision have no brief and open on the full document.
``user_preferences`` keeps per-user choices such as the layer documents open on.

Revision ID: 0010
Revises: 0009
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "sections", sa.Column("layer", sa.Text(), server_default="detail", nullable=False)
    )
    op.create_check_constraint(
        op.f("ck_sections_layer"), "sections", "layer IN ('brief', 'detail')"
    )
    op.add_column(
        "document_versions",
        sa.Column("brief_source", sa.Text(), server_default="none", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_document_versions_brief_source"),
        "document_versions",
        "brief_source IN ('draft', 'template', 'full_heading', 'none')",
    )
    op.create_table(
        "user_preferences",
        sa.Column("principal_id", sa.Uuid(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_user_preferences_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_user_preferences")),
        sa.UniqueConstraint(
            "tenant_id",
            "principal_id",
            "key",
            name=op.f("uq_user_preferences_tenant_id_principal_id_key"),
        ),
    )
    op.create_index(
        op.f("ix_user_preferences_tenant_id"), "user_preferences", ["tenant_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_user_preferences_tenant_id"), table_name="user_preferences")
    op.drop_table("user_preferences")
    op.drop_constraint(
        op.f("ck_document_versions_brief_source"), "document_versions", type_="check"
    )
    op.drop_column("document_versions", "brief_source")
    op.drop_constraint(op.f("ck_sections_layer"), "sections", type_="check")
    op.drop_column("sections", "layer")
