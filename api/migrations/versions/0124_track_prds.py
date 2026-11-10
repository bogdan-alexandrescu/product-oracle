"""A track holds many PRDs; a PRD belongs to at most one track (tracks-goal, owner Nov 9)

- ``track_prds``: one row per PRD that Oracle knows the track of (a PRD has one row:
  ``uq_track_prds_tenant_id_prd_document_id``). ``state`` says which:
  - ``linked``: the PRD is on ``track_id``;
  - ``off``: a person took it off a track: Oracle never starts or suggests one for it again;
  - ``suggested``: a newly accepted PRD with no track: Oracle suggests ``suggested_track_id``
    (null when no track fits) in its owner's Inbox, and a person confirms, picks or starts one.
- Every track's ``prd_document_id`` is backfilled as its first linked PRD, then the column
  (and its unique constraint) is dropped.

The downgrade puts ``product_tracks.prd_document_id`` back from each track's first linked PRD
(the oldest link). A track holding several PRDs keeps only that first one: its other PRDs go
to no track (their features keep the track until a roadmap is rebuilt). ``off`` and
``suggested`` rows are dropped.

Revision ID: 0124_track_prds
Revises: 0123_track_goal
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0124_track_prds"
down_revision: str | None = "0123_track_goal"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
T = "product_tracks"
L = "track_prds"


def upgrade() -> None:
    op.execute(LOCK_TIMEOUT)
    op.create_table(
        L,
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("tenant_id", sa.Uuid(), nullable=False),
        sa.Column("prd_document_id", sa.Uuid(), nullable=False),
        sa.Column("track_id", sa.Uuid(), nullable=True),
        sa.Column("suggested_track_id", sa.Uuid(), nullable=True),
        sa.Column("state", sa.Text(), nullable=False, server_default="linked"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_track_prds")),
        sa.ForeignKeyConstraint(["tenant_id"], ["tenants.id"], ondelete="CASCADE",
                                name=op.f("fk_track_prds_tenant_id_tenants")),
        sa.ForeignKeyConstraint(["prd_document_id"], ["documents.id"], ondelete="CASCADE",
                                name=op.f("fk_track_prds_prd_document_id_documents")),
        sa.ForeignKeyConstraint(["track_id"], [f"{T}.id"], ondelete="CASCADE",
                                name=op.f("fk_track_prds_track_id_product_tracks")),
        sa.ForeignKeyConstraint(["suggested_track_id"], [f"{T}.id"], ondelete="SET NULL",
                                name=op.f("fk_track_prds_suggested_track_id_product_tracks")),
        sa.UniqueConstraint("tenant_id", "prd_document_id",
                            name=op.f("uq_track_prds_tenant_id_prd_document_id")),
        sa.CheckConstraint("state IN ('linked', 'off', 'suggested')",
                           name=op.f("ck_track_prds_state")),
        sa.CheckConstraint("(state = 'linked') = (track_id IS NOT NULL)",
                           name=op.f("ck_track_prds_linked")),
    )  # fmt: skip
    for col in ("tenant_id", "prd_document_id", "track_id", "suggested_track_id"):
        op.create_index(op.f(f"ix_{L}_{col}"), L, [col])
    op.execute(
        f"INSERT INTO {L} (id, tenant_id, prd_document_id, track_id, state, created_at) "
        f"SELECT gen_random_uuid(), tenant_id, prd_document_id, id, 'linked', created_at FROM {T} "
        "WHERE prd_document_id IS NOT NULL"
    )
    op.drop_column(T, "prd_document_id")  # drops its index, foreign key and unique constraint


def downgrade() -> None:
    """Each track takes back its first linked PRD; a track's other PRDs go to no track, and
    ``off`` and ``suggested`` rows are dropped."""
    op.execute(LOCK_TIMEOUT)
    op.add_column(
        T,
        sa.Column("prd_document_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        op.f("fk_product_tracks_prd_document_id_documents"), T, "documents",
        ["prd_document_id"], ["id"], ondelete="CASCADE",
    )  # fmt: skip
    op.create_index(op.f("ix_product_tracks_prd_document_id"), T, ["prd_document_id"])
    op.execute(
        f"UPDATE {T} t SET prd_document_id = f.prd_document_id FROM ("
        f"SELECT DISTINCT ON (track_id) track_id, prd_document_id FROM {L} "
        "WHERE state = 'linked' ORDER BY track_id, created_at, id) f WHERE f.track_id = t.id"
    )
    op.create_unique_constraint(
        op.f("uq_product_tracks_tenant_id_prd_document_id"), T, ["tenant_id", "prd_document_id"]
    )
    op.drop_table(L)
