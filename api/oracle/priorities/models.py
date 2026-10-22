import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    Uuid,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

PRIORITY_METHODS = ("goal_weighted", "rice", "moscow", "wsjf")
OVERRIDE_KINDS = ("move", "pin")
REASON_CHECK_STATUSES = ("contradiction", "no_contradiction", "skipped", "failed", "timed_out")
# The live ranking's slot in the one-active-override index (snapshot_id is null there).
LIVE = "00000000-0000-0000-0000-000000000000"


class PrioritySnapshot(TenantScoped, Base):
    """A scored, dependency-ordered ranking of features, with every number explained."""

    __tablename__ = "priority_snapshots"
    __table_args__ = (CheckConstraint(_in("method", PRIORITY_METHODS), name="method"),)

    method: Mapped[str] = mapped_column(Text, nullable=False)
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    ranking: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    # User id or API token id; no FK because it can be either.
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class PriorityOverride(TenantScoped, Base):
    """A person's move or pin on the ranking (C9), with their reason and Oracle's pushback.

    Never deleted: removing or replacing one sets ``removed_at`` (and ``replaced_by``), so
    the log keeps every call. One active override per feature per ranking.
    """

    __tablename__ = "priority_overrides"
    __table_args__ = (
        CheckConstraint(_in("kind", OVERRIDE_KINDS), name="kind"),
        CheckConstraint("length(reason) BETWEEN 1 AND 500", name="reason"),
        CheckConstraint(
            "(kind = 'move' AND above_feature_id IS NOT NULL AND position IS NULL) OR "
            "(kind = 'pin' AND position IS NOT NULL AND position >= 1 "
            "AND above_feature_id IS NULL)",
            name="target",
        ),
        CheckConstraint(
            "above_feature_id IS NULL OR above_feature_id <> feature_id", name="not_self"
        ),
        Index(
            "ux_priority_overrides_active",
            "tenant_id",
            "feature_id",
            text(f"coalesce(snapshot_id, '{LIVE}'::uuid)"),
            unique=True,
            postgresql_where=text("removed_at IS NULL"),
        ),
    )

    feature_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    # Null: the live ranking; else a proposed run snapshot (pick C8 Priority order snapshot).
    snapshot_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("priority_snapshots.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    above_feature_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="CASCADE")
    )
    position: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    # Evidence of the feature the person cited, at most 5.
    evidence_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    pushback: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    # {status, ms} of Oracle's reading of the reason: no usage, no text.
    reason_check: Mapped[dict[str, Any]] = mapped_column(
        JSONB, nullable=False, server_default=text("""'{"status": "skipped"}'::jsonb""")
    )
    kept_after_pushback: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    # User id or API token id; no FK because it can be either.
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    removed_reason: Mapped[str | None] = mapped_column(Text)
    replaced_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("priority_overrides.id", ondelete="SET NULL")
    )
