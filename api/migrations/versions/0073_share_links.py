"""O5 lane 3: share links with a passcode and their view log (spec-O5 §3)

- ``share_links``: one publication of one roadmap, in one audience, behind a private
  address and a passcode (owner answer O5-Q5, changed). Only the token's sha256 and the
  passcode's argon2 hash are kept; ``passcode_version`` ends every cookie signed before a
  rotation; ``passcode_failures``/``locked_until`` lock out guessing per link;
  ``refused_*`` caps refusal audits; ``inbox_dismissed_at`` closes an owner's Inbox row;
- ``share_link_views``: counts only (O5-Q4), never an address or an identity.

Live-safe: new tables only. The downgrade drops them.

Revision ID: 0073_share_links
Revises: 0072_public_texts
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0073_share_links"
down_revision: str | None = "0072_public_texts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
LINKS = "share_links"
VIEWS = "share_link_views"


def _fk(table: str, column: str, target: str, ondelete: str | None) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=op.f(f"fk_{table}_{column}_{target}"), ondelete=ondelete
    )


def _base(table: str) -> list:
    return [
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        _fk(table, "tenant_id", "tenants", "CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
    ]  # fmt: skip


def _at(name: str, nullable: bool = True) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=nullable)


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        LINKS,
        *_base(LINKS),
        sa.Column("document_id", sa.Uuid(), nullable=False),
        sa.Column("publication_id", sa.Uuid(), nullable=False),
        sa.Column("audience", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column("passcode_hash", sa.Text(), nullable=False),
        sa.Column("passcode_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("passcode_failures", sa.Integer(), server_default="0", nullable=False),
        _at("passcode_window_start"),
        _at("locked_until"),
        sa.Column("created_by", sa.Uuid(), nullable=False),
        _at("expires_at", nullable=False),
        sa.Column("revoked_by", sa.Uuid(), nullable=True),
        _at("revoked_at"),
        sa.Column("revoked_reason", sa.Text(), nullable=True),
        _at("inbox_dismissed_at"),
        sa.Column("allow_download", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("follow_latest", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("views", sa.Integer(), server_default="0", nullable=False),
        _at("last_viewed_at"),
        _at("refused_window_start"),
        sa.Column("refused_in_window", sa.Integer(), server_default="0", nullable=False),
        sa.CheckConstraint("audience IN ('board', 'team', 'engineering', 'public')",
                           name=op.f(f"ck_{LINKS}_audience")),
        sa.CheckConstraint("char_length(label) BETWEEN 1 AND 120", name=op.f(f"ck_{LINKS}_label")),
        _fk(LINKS, "document_id", "documents", "CASCADE"),
        _fk(LINKS, "publication_id", "document_publications", None),
        sa.UniqueConstraint("token_hash", name=op.f(f"uq_{LINKS}_token_hash")),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{LINKS}_tenant_id"), LINKS, ["tenant_id"])
    op.create_index("ix_share_links_doc", LINKS, ["tenant_id", "document_id", "created_at"])
    op.create_table(
        VIEWS,
        *_base(VIEWS),
        sa.Column("share_link_id", sa.Uuid(), nullable=False),
        sa.Column(
            "viewed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("browser_key", sa.Text(), nullable=False),
        sa.Column("browser_family", sa.Text(), nullable=True),
        sa.Column("country", sa.Text(), nullable=True),
        sa.CheckConstraint("kind IN ('page', 'download')", name=op.f(f"ck_{VIEWS}_kind")),
        _fk(VIEWS, "share_link_id", "share_links", "CASCADE"),
    )  # fmt: skip
    op.create_index(op.f(f"ix_{VIEWS}_tenant_id"), VIEWS, ["tenant_id"])
    op.create_index("ix_share_link_views", VIEWS, ["share_link_id", "viewed_at"])


def downgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.drop_table(VIEWS)
    op.drop_table(LINKS)
