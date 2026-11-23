"""A comment on a feature (#1553, migration 0134_feature_comments).

A comment hangs on the feature, not on one row of it: a roadmap item's rows change from
version to version and draft to draft, but its roadmap and ``item_key`` stay, so the comment
shows wherever that feature's panel opens, and follows it to Trash and back. ``author_id``
holds a user id with no foreign key, as elsewhere.
"""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped

MAX_BODY = 2000


class FeatureComment(TenantScoped, Base):
    __tablename__ = "feature_comments"
    __table_args__ = (Index("ix_feature_comments_feature", "roadmap_document_id", "item_key"),)

    roadmap_document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    item_key: Mapped[str] = mapped_column(Text, nullable=False)
    author_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
