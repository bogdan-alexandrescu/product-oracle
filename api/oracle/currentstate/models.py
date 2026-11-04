"""Current state (migration 0101_feature_states): a feature's place (Desired, marked as
already shipped, or moved to Current state by the owner) and its proof.

``feature_states``: one row per feature. ``status`` is ``desired`` (the default),
``shipped`` (the item chat's "Mark as already shipped" card: it exists, no proof read
yet) or ``current`` (the owner moved it). ``move_note`` keeps how it was moved
(``owner_confirmed``); the web words it ("Moved Nov 3 · you confirmed"). ``not_yet_at``:
the owner's Not yet, which keeps it off the ready band until its proof is read again.
``answer``: the owner's answer to "does it still run?".

``feature_proofs``: one row per feature and kind (code map hits, merged pull requests,
tracker tasks done of all, a measured value for a period), each with when it was read.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    false,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

STATUSES = ("desired", "shipped", "current")
ANSWERS = ("still_runs", "changed", "no_longer_runs")
PROOF_KINDS = ("code_map", "pull_requests", "tasks", "measured")


class FeatureState(TenantScoped, Base):
    __tablename__ = "feature_states"
    __table_args__ = (
        UniqueConstraint("tenant_id", "feature_id"),
        CheckConstraint(_in("status", STATUSES), name="status"),
        CheckConstraint(f"answer IS NULL OR {_in('answer', ANSWERS)}", name="answer"),
    )

    feature_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="desired", server_default="desired"
    )
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    moved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    moved_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    move_note: Mapped[str | None] = mapped_column(Text)
    not_yet_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    answer: Mapped[str | None] = mapped_column(Text)
    answered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    answered_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # When the proof was last confirmed: a live source read it again, the owner moved the
    # feature or answered "still runs". The mark ages on this.
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # When Oracle last re-read it (Check again or the nightly job), found something or not.
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    checking: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=false()
    )


class FeatureProof(TenantScoped, Base):
    __tablename__ = "feature_proofs"
    __table_args__ = (
        UniqueConstraint("tenant_id", "feature_id", "kind"),
        CheckConstraint(_in("kind", PROOF_KINDS), name="kind"),
    )

    feature_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False, index=True
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    count: Mapped[int | None] = mapped_column(Integer)
    total: Mapped[int | None] = mapped_column(Integer)
    # A measured value as a person reads it ("3,410 sent last month") and its month ("Sep").
    value: Mapped[str | None] = mapped_column(Text)
    period: Mapped[str | None] = mapped_column(Text)
    ok: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=false())
    still_true: Mapped[bool | None] = mapped_column(Boolean)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
