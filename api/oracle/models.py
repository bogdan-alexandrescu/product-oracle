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

    # "user:<uuid>", "token:<uuid>", "oracle" (oracle.audit.ORACLE) or "system".
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    # The API token the actor acted through (also a token acting for a user), C2.
    actor_token_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The MCP OAuth grant (oauth_tokens.family_id) the actor acted through, C2.
    actor_grant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
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
    EvidenceLinkSnapshot,
    Proposal,
)
from oracle.claude_accounts.models import (  # noqa: E402
    ClaudeAccount,
    ClaudeAccountHold,
    ClaudeAccountSignin,
    ClaudeFallbackCredential,
    ClaudeSweepLease,
)
from oracle.connections.models import Connection  # noqa: E402
from oracle.decisions.models import Decision, DecisionReview  # noqa: E402
from oracle.docs.models import Citation, Document, DocumentVersion, Section  # noqa: E402
from oracle.intake.models import IntakeProposal, IntakeWithheldItem  # noqa: E402
from oracle.integrations.models import CompanyIntegration  # noqa: E402
from oracle.jobs.models import LlmJob, LlmSuggestion  # noqa: E402
from oracle.mcp.oauth.models import OAuthClient, OAuthCode, OAuthToken  # noqa: E402
from oracle.members.models import Invite, MemberFollowUp  # noqa: E402
from oracle.preferences.models import UserPreference  # noqa: E402
from oracle.priorities.models import PrioritySnapshot  # noqa: E402
from oracle.quality.models import OutcomeRecord, QualityLearning  # noqa: E402
from oracle.reports.models import AlignmentReport, AlignmentReportRead  # noqa: E402
from oracle.requests.models import (  # noqa: E402
    ProductRequest,
    RequestCandidate,
    RequestTheme,
)
from oracle.review.models import (  # noqa: E402
    Comment,
    DocumentPublication,
    DocumentReviewPolicy,
    FeedbackItem,
    Notification,
    ReviewCampaign,
    SectionPatch,
    SectionReview,
    SectionReviewState,
)
from oracle.roadmap.models import (  # noqa: E402
    ProductTrack,
    RoadmapItem,
    ScheduleBasis,
    TrackerRecord,
    TrackMilestone,
)
from oracle.runs.models import Checkpoint, Run, RunSegment  # noqa: E402
from oracle.runs.scope_models import PrdScope, PrdScopeItem  # noqa: E402
from oracle.runtokens import RunToken  # noqa: E402
from oracle.sources.models import (  # noqa: E402
    Snapshot,
    Source,
    SourceItem,
    SourceItemVersion,
)
from oracle.swarm.learned import LearnedFeature  # noqa: E402
from oracle.templates.models import Template, TemplateVersion, Theme  # noqa: E402
from oracle.tenant_settings import TenantSetting  # noqa: E402
from oracle.v2.models import (  # noqa: E402
    ArtifactDependency,
    ArtifactOutput,
    ArtifactRequest,
    ArtifactReviewEvent,
    ArtifactVersion,
    AssumptionDecision,
    BlockerOption,
    BlockerResolutionEvent,
    ChangeEvent,
    CompositionRevision,
    DocumentComposition,
    DocumentSectionLink,
    EvaluationFinding,
    EvaluationReport,
    FeasibilityExperiment,
    KnowledgeGap,
    ModuleDefinition,
    ModuleVersion,
    ProductIntake,
    StakeholderAnswer,
    StakeholderQuestion,
    TemplateModuleAssignment,
)

__all__ = [
    "AlignmentReport",
    "AlignmentReportRead",
    "ApiToken",
    "ArtifactDependency",
    "ArtifactOutput",
    "ArtifactRequest",
    "ArtifactReviewEvent",
    "ArtifactVersion",
    "AssumptionDecision",
    "AuditEvent",
    "BlockerOption",
    "BlockerResolutionEvent",
    "ChangeEvent",
    "Checkpoint",
    "Decision",
    "DecisionReview",
    "Citation",
    "ClaudeAccount",
    "ClaudeAccountHold",
    "ClaudeAccountSignin",
    "ClaudeFallbackCredential",
    "ClaudeSweepLease",
    "Comment",
    "CompanyIntegration",
    "CompositionRevision",
    "Conflict",
    "Connection",
    "Document",
    "DocumentComposition",
    "DocumentPublication",
    "DocumentReviewPolicy",
    "DocumentSectionLink",
    "DocumentVersion",
    "Edge",
    "Entity",
    "EntityRevision",
    "EvaluationFinding",
    "EvaluationReport",
    "Evidence",
    "EvidenceLinkSnapshot",
    "FeasibilityExperiment",
    "FeedbackItem",
    "IntakeProposal",
    "IntakeWithheldItem",
    "Invite",
    "MemberFollowUp",
    "KnowledgeGap",
    "LearnedFeature",
    "LlmJob",
    "LlmSuggestion",
    "ModuleDefinition",
    "ModuleVersion",
    "Notification",
    "OAuthClient",
    "OAuthCode",
    "OAuthToken",
    "OutcomeRecord",
    "PrioritySnapshot",
    "ProductRequest",
    "ProductIntake",
    "ProductTrack",
    "Proposal",
    "ReviewCampaign",
    "QualityLearning",
    "RequestCandidate",
    "RequestTheme",
    "RoadmapItem",
    "Run",
    "RunSegment",
    "PrdScope",
    "PrdScopeItem",
    "RunToken",
    "ScheduleBasis",
    "Section",
    "SectionPatch",
    "SectionReview",
    "SectionReviewState",
    "Snapshot",
    "Source",
    "SourceItem",
    "SourceItemVersion",
    "StakeholderAnswer",
    "StakeholderQuestion",
    "Template",
    "TemplateModuleAssignment",
    "TemplateVersion",
    "Tenant",
    "TenantSetting",
    "Theme",
    "TrackMilestone",
    "TrackerRecord",
    "User",
    "UserPreference",
]
