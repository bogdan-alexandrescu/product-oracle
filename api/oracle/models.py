"""Cross-cutting models (tenants, audit events) and the full model registry.

Importing this module imports every model, so ``Base.metadata`` is complete
(Alembic and the tests rely on that).
"""

import uuid
from typing import Any

from sqlalchemy import Text, Uuid
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, IdMixin, TenantScoped


class Tenant(IdMixin, Base):
    __tablename__ = "tenants"

    name: Mapped[str] = mapped_column(Text, nullable=False)


class AuditEvent(TenantScoped, Base):
    __tablename__ = "audit_events"

    # "user:<uuid>", "token:<uuid>" or "system".
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    entity: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")


from oracle.auth.models import ApiToken, User  # noqa: E402
from oracle.baseline.models import (  # noqa: E402
    Conflict,
    Edge,
    Entity,
    EntityRevision,
    Evidence,
    Proposal,
)
from oracle.connections.models import Connection  # noqa: E402
from oracle.docs.models import Citation, Document, DocumentVersion, Section  # noqa: E402
from oracle.mcp.oauth.models import OAuthClient, OAuthCode, OAuthToken  # noqa: E402
from oracle.members.models import Invite  # noqa: E402
from oracle.priorities.models import PrioritySnapshot  # noqa: E402
from oracle.review.models import Comment, FeedbackItem, SectionReview  # noqa: E402
from oracle.runs.models import Checkpoint, Run, RunSegment  # noqa: E402
from oracle.runtokens import RunToken  # noqa: E402
from oracle.sources.models import (  # noqa: E402
    Snapshot,
    Source,
    SourceItem,
    SourceItemVersion,
)
from oracle.templates.models import Template, TemplateVersion, Theme  # noqa: E402
from oracle.tenant_settings import TenantSetting  # noqa: E402

__all__ = [
    "ApiToken",
    "AuditEvent",
    "Checkpoint",
    "Citation",
    "Comment",
    "Connection",
    "Conflict",
    "Document",
    "DocumentVersion",
    "Edge",
    "Entity",
    "EntityRevision",
    "Evidence",
    "FeedbackItem",
    "Invite",
    "OAuthClient",
    "OAuthCode",
    "OAuthToken",
    "PrioritySnapshot",
    "Proposal",
    "Run",
    "RunSegment",
    "RunToken",
    "Section",
    "SectionReview",
    "Snapshot",
    "Source",
    "SourceItem",
    "SourceItemVersion",
    "Template",
    "TemplateVersion",
    "Tenant",
    "TenantSetting",
    "Theme",
    "User",
]
