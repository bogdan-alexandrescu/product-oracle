"""O5 lane 4: company branding's logos

``brand_assets``: a company's logos, re-encoded to PNG and addressed by the sha256 of
their bytes (unique per company); members read them at ``/uploads/brand/<sha256>.png``.
The ``branding`` setting needs no schema: its default lives in
``oracle.tenant_settings_api.DEFAULTS``.

Live-safe: one new table.

The downgrade drops the table and any stored ``branding`` setting.

Revision ID: 0055_brand_assets
Revises: 0054_reply_opened
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy import text

revision: str = "0055_brand_assets"
down_revision: str | None = "0054_reply_opened"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        "brand_assets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("content_type", sa.Text(), nullable=False),
        sa.Column("bytes", sa.LargeBinary(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=False),
        sa.Column("height", sa.Integer(), nullable=False),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenants.id"],
            name=op.f("fk_brand_assets_tenant_id_tenants"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_brand_assets")),
    )
    op.create_index(op.f("ix_brand_assets_tenant_id"), "brand_assets", ["tenant_id"])
    op.create_index("uq_brand_assets_sha256", "brand_assets", ["tenant_id", "sha256"], unique=True)


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.get_bind().execute(text("DELETE FROM tenant_settings WHERE key = 'branding'"))
    op.drop_table("brand_assets")
