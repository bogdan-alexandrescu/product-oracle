"""v1 amend: per-user connections, source ownership, evidence confidence, themes

Bogdan, 2026-10-17: integrations are per user, what a user's connections pull in is
visible only to that user, evidence carries a confidence score that sets how much it
counts, and PRD/roadmap templates plus visual themes are chosen when a draft starts.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-17 15:26:13.619537
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ITEM_KINDS = (
    "'file', 'page', 'message', 'thread', 'issue', 'pull_request', 'release', 'milestone', "
    "'readme', 'doc'"
)


def upgrade() -> None:
    op.create_table(
        "tenant_settings",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_tenant_settings_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_tenant_settings")),
        sa.UniqueConstraint("tenant_id", "key", name=op.f("uq_tenant_settings_tenant_id_key")),
    )
    op.create_index(
        op.f("ix_tenant_settings_tenant_id"), "tenant_settings", ["tenant_id"], unique=False
    )
    op.create_table(
        "themes",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), server_default="any", nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "tokens", postgresql.JSONB(astext_type=sa.Text()), server_default="{}", nullable=False
        ),
        sa.Column("css", sa.Text(), server_default="", nullable=False),
        sa.Column("builtin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("kind IN ('prd', 'roadmap', 'any')", name=op.f("ck_themes_kind")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_themes_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_themes")),
        sa.UniqueConstraint("tenant_id", "key", name=op.f("uq_themes_tenant_id_key")),
    )
    op.create_index(op.f("ix_themes_tenant_id"), "themes", ["tenant_id"], unique=False)
    op.create_table(
        "connections",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.Text(), nullable=False),
        sa.Column("auth_mode", sa.Text(), nullable=False),
        sa.Column("account_id", sa.Text(), nullable=False),
        sa.Column("account_label", sa.Text(), nullable=True),
        sa.Column("ciphertext", sa.LargeBinary(), nullable=False),
        sa.Column("key_version", sa.Integer(), nullable=False),
        sa.Column("scopes", postgresql.ARRAY(sa.Text()), server_default="{}", nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "auth_mode IN ('oauth', 'token')", name=op.f("ck_connections_auth_mode")
        ),
        sa.CheckConstraint(
            "provider IN ('github', 'slack', 'notion', 'fireflies', 'google', 'claude')",
            name=op.f("ck_connections_provider"),
        ),
        sa.CheckConstraint(
            "status IN ('active', 'expired', 'revoked', 'error')",
            name=op.f("ck_connections_status"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_connections_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_connections_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_connections")),
        sa.UniqueConstraint(
            "user_id",
            "provider",
            "account_id",
            name=op.f("uq_connections_user_id_provider_account_id"),
        ),
    )
    op.create_index(op.f("ix_connections_tenant_id"), "connections", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_connections_user_id"), "connections", ["user_id"], unique=False)
    op.drop_index(op.f("ix_source_credentials_tenant_id"), table_name="source_credentials")
    op.drop_table("source_credentials")
    op.add_column("documents", sa.Column("kind", sa.Text(), server_default="prd", nullable=False))
    op.add_column("documents", sa.Column("theme", sa.Text(), nullable=True))
    op.add_column("edges", sa.Column("confidence", sa.Numeric(precision=4, scale=3), nullable=True))
    op.add_column(
        "entities", sa.Column("confidence", sa.Numeric(precision=4, scale=3), nullable=True)
    )
    op.add_column(
        "evidence", sa.Column("confidence", sa.Numeric(precision=4, scale=3), nullable=True)
    )
    op.add_column(
        "evidence",
        sa.Column(
            "confidence_factors",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )
    op.add_column("evidence", sa.Column("scored_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("sources", sa.Column("owner_user_id", sa.Uuid(), nullable=False))
    op.add_column("sources", sa.Column("connection_id", sa.Uuid(), nullable=True))
    op.drop_constraint(op.f("uq_sources_tenant_id_name"), "sources", type_="unique")
    op.create_index(op.f("ix_sources_connection_id"), "sources", ["connection_id"], unique=False)
    op.create_index(op.f("ix_sources_owner_user_id"), "sources", ["owner_user_id"], unique=False)
    op.create_unique_constraint(
        op.f("uq_sources_owner_user_id_name"), "sources", ["owner_user_id", "name"]
    )
    op.create_foreign_key(
        op.f("fk_sources_owner_user_id_users"),
        "sources",
        "users",
        ["owner_user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        op.f("fk_sources_connection_id_connections"),
        "sources",
        "connections",
        ["connection_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column("templates", sa.Column("kind", sa.Text(), server_default="prd", nullable=False))
    op.add_column("templates", sa.Column("description", sa.Text(), nullable=True))
    op.add_column(
        "templates",
        sa.Column("builtin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column("templates", sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True))

    # Check constraints autogenerate does not detect.
    op.drop_constraint(op.f("ck_sources_kind"), "sources", type_="check")
    op.create_check_constraint(
        op.f("ck_sources_kind"),
        "sources",
        "kind IN ('upload', 'github', 'slack', 'notion', 'fireflies', 'google_docs')",
    )
    op.drop_constraint(op.f("ck_source_items_kind"), "source_items", type_="check")
    op.create_check_constraint(
        op.f("ck_source_items_kind"),
        "source_items",
        f"kind IN ({_ITEM_KINDS}, 'transcript')",
    )
    op.create_check_constraint(op.f("ck_documents_kind"), "documents", "kind IN ('prd', 'roadmap')")
    op.create_check_constraint(op.f("ck_templates_kind"), "templates", "kind IN ('prd', 'roadmap')")
    for table in ("evidence", "entities", "edges"):
        op.create_check_constraint(
            op.f(f"ck_{table}_confidence"),
            table,
            "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
        )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_source_items_kind"), "source_items", type_="check")
    op.execute("DELETE FROM source_items WHERE kind = 'transcript'")
    op.create_check_constraint(
        op.f("ck_source_items_kind"),
        "source_items",
        f"kind IN ({_ITEM_KINDS})",
    )
    op.drop_constraint(op.f("ck_sources_kind"), "sources", type_="check")
    op.execute("DELETE FROM sources WHERE kind IN ('fireflies', 'google_docs')")
    op.create_check_constraint(
        op.f("ck_sources_kind"), "sources", "kind IN ('upload', 'github', 'slack', 'notion')"
    )
    op.drop_column("templates", "archived_at")
    op.drop_column("templates", "builtin")
    op.drop_column("templates", "description")
    op.drop_column("templates", "kind")
    op.drop_constraint(op.f("fk_sources_connection_id_connections"), "sources", type_="foreignkey")
    op.drop_constraint(op.f("fk_sources_owner_user_id_users"), "sources", type_="foreignkey")
    op.drop_constraint(op.f("uq_sources_owner_user_id_name"), "sources", type_="unique")
    op.drop_index(op.f("ix_sources_owner_user_id"), table_name="sources")
    op.drop_index(op.f("ix_sources_connection_id"), table_name="sources")
    op.create_unique_constraint(
        op.f("uq_sources_tenant_id_name"),
        "sources",
        ["tenant_id", "name"],
        postgresql_nulls_not_distinct=False,
    )
    op.drop_column("sources", "connection_id")
    op.drop_column("sources", "owner_user_id")
    op.drop_column("evidence", "scored_at")
    op.drop_column("evidence", "confidence_factors")
    op.drop_column("evidence", "confidence")
    op.drop_column("entities", "confidence")
    op.drop_column("edges", "confidence")
    op.drop_column("documents", "theme")
    op.drop_column("documents", "kind")
    op.create_table(
        "source_credentials",
        sa.Column("source_id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("ciphertext", postgresql.BYTEA(), autoincrement=False, nullable=False),
        sa.Column("key_version", sa.INTEGER(), autoincrement=False, nullable=False),
        sa.Column("tenant_id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column("id", sa.UUID(), autoincrement=False, nullable=False),
        sa.Column(
            "created_at",
            postgresql.TIMESTAMP(timezone=True),
            server_default=sa.text("now()"),
            autoincrement=False,
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["source_id"],
            ["sources.id"],
            name=op.f("fk_source_credentials_source_id_sources"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_source_credentials_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_source_credentials")),
        sa.UniqueConstraint(
            "source_id",
            name=op.f("uq_source_credentials_source_id"),
            postgresql_include=[],
            postgresql_nulls_not_distinct=False,
        ),
    )
    op.create_index(
        op.f("ix_source_credentials_tenant_id"), "source_credentials", ["tenant_id"], unique=False
    )
    op.drop_index(op.f("ix_connections_user_id"), table_name="connections")
    op.drop_index(op.f("ix_connections_tenant_id"), table_name="connections")
    op.drop_table("connections")
    op.drop_index(op.f("ix_themes_tenant_id"), table_name="themes")
    op.drop_table("themes")
    op.drop_index(op.f("ix_tenant_settings_tenant_id"), table_name="tenant_settings")
    op.drop_table("tenant_settings")
