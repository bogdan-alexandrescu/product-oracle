"""Per-user preferences: one JSON value per (user or API token, key).

Known keys: ``document_view`` (O1f): ``brief`` or ``full``, the layer a document opens
on for this user; ``experience`` (#723): ``simple`` or ``studio``, the mode they last
switched to.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Text, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped


class UserPreference(TenantScoped, Base):
    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("tenant_id", "principal_id", "key"),)

    # User id, or the API token id for a token that acts for no user.
    principal_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    key: Mapped[str] = mapped_column(Text, nullable=False)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
