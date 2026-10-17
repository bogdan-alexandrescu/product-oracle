"""MCP OAuth: clients, authorization codes and tokens for external MCP clients

OAuth 2.1 for MCP clients (I2): dynamic client registration, authorization codes bound
to a PKCE challenge, opaque access tokens with rotating refresh tokens. Only sha256
hashes of codes and tokens are stored.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-17 22:41:47.857287
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "oauth_clients",
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("redirect_uris", postgresql.ARRAY(sa.Text()), nullable=False),
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
            name=op.f("fk_oauth_clients_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_clients")),
        sa.UniqueConstraint("client_id", name=op.f("uq_oauth_clients_client_id")),
    )
    op.create_index(
        op.f("ix_oauth_clients_tenant_id"), "oauth_clients", ["tenant_id"], unique=False
    )
    op.create_table(
        "oauth_codes",
        sa.Column("code_hash", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("redirect_uri", sa.Text(), nullable=False),
        sa.Column("code_challenge", sa.Text(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["client_id"],
            ["oauth_clients.id"],
            name=op.f("fk_oauth_codes_client_id_oauth_clients"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_oauth_codes_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_oauth_codes_user_id_users"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_codes")),
        sa.UniqueConstraint("code_hash", name=op.f("uq_oauth_codes_code_hash")),
    )
    op.create_index(op.f("ix_oauth_codes_client_id"), "oauth_codes", ["client_id"], unique=False)
    op.create_index(op.f("ix_oauth_codes_tenant_id"), "oauth_codes", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_oauth_codes_user_id"), "oauth_codes", ["user_id"], unique=False)
    op.create_table(
        "oauth_tokens",
        sa.Column("access_hash", sa.Text(), nullable=False),
        sa.Column("refresh_hash", sa.Text(), nullable=False),
        sa.Column("client_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("refresh_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rotated_from", sa.Uuid(), nullable=True),
        sa.Column("family_id", sa.Uuid(), nullable=False),
        sa.Column("code_id", sa.Uuid(), nullable=True),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["client_id"],
            ["oauth_clients.id"],
            name=op.f("fk_oauth_tokens_client_id_oauth_clients"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["code_id"],
            ["oauth_codes.id"],
            name=op.f("fk_oauth_tokens_code_id_oauth_codes"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["rotated_from"],
            ["oauth_tokens.id"],
            name=op.f("fk_oauth_tokens_rotated_from_oauth_tokens"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_oauth_tokens_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_oauth_tokens_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_tokens")),
        sa.UniqueConstraint("access_hash", name=op.f("uq_oauth_tokens_access_hash")),
        sa.UniqueConstraint("refresh_hash", name=op.f("uq_oauth_tokens_refresh_hash")),
    )
    op.create_index(op.f("ix_oauth_tokens_client_id"), "oauth_tokens", ["client_id"], unique=False)
    op.create_index(op.f("ix_oauth_tokens_code_id"), "oauth_tokens", ["code_id"], unique=False)
    op.create_index(op.f("ix_oauth_tokens_family_id"), "oauth_tokens", ["family_id"], unique=False)
    op.create_index(
        op.f("ix_oauth_tokens_rotated_from"), "oauth_tokens", ["rotated_from"], unique=False
    )
    op.create_index(op.f("ix_oauth_tokens_tenant_id"), "oauth_tokens", ["tenant_id"], unique=False)
    op.create_index(op.f("ix_oauth_tokens_user_id"), "oauth_tokens", ["user_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_oauth_tokens_user_id"), table_name="oauth_tokens")
    op.drop_index(op.f("ix_oauth_tokens_tenant_id"), table_name="oauth_tokens")
    op.drop_index(op.f("ix_oauth_tokens_rotated_from"), table_name="oauth_tokens")
    op.drop_index(op.f("ix_oauth_tokens_family_id"), table_name="oauth_tokens")
    op.drop_index(op.f("ix_oauth_tokens_code_id"), table_name="oauth_tokens")
    op.drop_index(op.f("ix_oauth_tokens_client_id"), table_name="oauth_tokens")
    op.drop_table("oauth_tokens")
    op.drop_index(op.f("ix_oauth_codes_user_id"), table_name="oauth_codes")
    op.drop_index(op.f("ix_oauth_codes_tenant_id"), table_name="oauth_codes")
    op.drop_index(op.f("ix_oauth_codes_client_id"), table_name="oauth_codes")
    op.drop_table("oauth_codes")
    op.drop_index(op.f("ix_oauth_clients_tenant_id"), table_name="oauth_clients")
    op.drop_table("oauth_clients")
