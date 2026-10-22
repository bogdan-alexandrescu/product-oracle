"""Code capability maps (F5-2, migration 0022_code_maps).

One row per map a ``code_map`` run builds of one repo of a GitHub source: ``building``
while the run works, ``ready`` with the checked ``content`` (``code_map.json``),
``failed`` with the problems in ``error``, ``stale`` once a merge on the repo came after
it (``stale_at``; a merge during the build marks the new map stale as it lands, so merges
during a refresh coalesce into one follow-up).

A map is drawn from one person's source (S6): ``private`` (only the source's owner sees
it; no run or brief uses it) until the owner shares it in ``full``. Sharing is the same
for every map of the source's repo (a refresh keeps it). Deleting the source deletes its
maps; narrowing it deletes the maps of the repos it no longer lists
(:func:`oracle.engineering.codemaps.drop_outside`).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

CODE_MAP_STATUSES = ("building", "ready", "stale", "failed")
CODE_MAP_SHARING = ("private", "full")


class CodeMap(TenantScoped, Base):
    __tablename__ = "code_maps"
    __table_args__ = (
        UniqueConstraint("source_id", "repo", "commit_sha"),
        CheckConstraint(_in("status", CODE_MAP_STATUSES), name="status"),
        CheckConstraint(_in("sharing", CODE_MAP_SHARING), name="sharing"),
        Index("ix_code_maps_source_id_repo", "source_id", "repo"),
    )

    source_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("sources.id", ondelete="CASCADE"), nullable=False
    )
    repo: Mapped[str] = mapped_column(Text, nullable=False)
    commit_sha: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    sharing: Mapped[str] = mapped_column(Text, nullable=False, default="private",
                                         server_default="private")  # fmt: skip
    shared_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    shared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    content: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="SET NULL")
    )
    error: Mapped[str | None] = mapped_column(Text)
    as_of: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The first merge on the repo after this map's run started (a refresh is due).
    stale_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
