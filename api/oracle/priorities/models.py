import uuid
from typing import Any

from sqlalchemy import CheckConstraint, Text, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

PRIORITY_METHODS = ("goal_weighted", "rice", "moscow", "wsjf")


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
