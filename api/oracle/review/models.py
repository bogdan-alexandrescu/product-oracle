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
    UniqueConstraint,
    Uuid,
    func,
    true,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

VERDICTS = ("approved", "changes_requested", "rejected")
FEEDBACK_KINDS = ("comment", "section_review", "general")
FEEDBACK_STATUSES = ("open", "addressed", "declined", "superseded")
# A change request's severity (v2, §9); null: not classified (legacy items).
SEVERITIES = ("critical", "major", "minor")


class Comment(TenantScoped, Base):
    __tablename__ = "comments"

    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    # W3C TextQuoteSelector: {"exact": ..., "prefix": ..., "suffix": ...}. Null on replies.
    anchor: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    # User id (or API token id); no FK because it can be either.
    author_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    parent_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("comments.id", ondelete="CASCADE"), index=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SectionReview(TenantScoped, Base):
    """Verdict history; the latest row per (version_id, section_key) wins."""

    __tablename__ = "section_reviews"
    __table_args__ = (
        CheckConstraint(_in("verdict", VERDICTS), name="verdict"),
        Index("ix_section_reviews_version_section", "version_id", "section_key", "created_at"),
    )

    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False
    )
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    verdict: Mapped[str] = mapped_column(Text, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    reviewer_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The section's content hash the verdict was given on (sections.content_hash), so an
    # approval is tied to an exact section revision. Null on verdicts before 0013.
    section_hash: Mapped[str | None] = mapped_column(Text)
    # The API token that gave the verdict when a token acted (for a user, or a user-less
    # one); revoking the token voids the approvals it gave (C2).
    token_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)
    # The MCP OAuth grant (oauth_tokens.family_id) the verdict came through; revoking the
    # grant voids the approvals made through it, as for API tokens (C2).
    grant_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, index=True)
    # Set when the approval lapsed for good: its approver was demoted below approver or
    # disabled, or its token or grant revoked. A re-promotion or a restore never revives it.
    lapsed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lapse_reason: Mapped[str | None] = mapped_column(Text)


class FeedbackItem(TenantScoped, Base):
    __tablename__ = "feedback_items"
    __table_args__ = (
        CheckConstraint(_in("kind", FEEDBACK_KINDS), name="kind"),
        CheckConstraint(_in("status", FEEDBACK_STATUSES), name="status"),
        CheckConstraint(f"severity IS NULL OR {_in('severity', SEVERITIES)}", name="severity"),
        Index("ix_feedback_items_document_status", "document_id", "status"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    # Version NUMBERS (DocumentVersion.number) within the document, not ids.
    raised_on_version: Mapped[int] = mapped_column(Integer, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    comment_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("comments.id", ondelete="SET NULL")
    )
    section_review_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("section_reviews.id", ondelete="SET NULL")
    )
    section_key: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    # Who raised it: a user id or an API token id (no FK, as Comment.author_id). Null on
    # items raised before 0020 without a comment or verdict, and on ones Oracle raised.
    author_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    addressed_in_version: Mapped[int | None] = mapped_column(Integer)
    resolution_note: Mapped[str | None] = mapped_column(Text)
    # A change request's severity (v2, §9); null when not classified.
    severity: Mapped[str | None] = mapped_column(Text)
    # D12: an approver staged this item for the agents (no section text to accept): the
    # next draft goes to the agents with it. Cleared when a draft's resolutions close it.
    staged_for_agents_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Who staged it: a user id or an API token id (no FK, as author_id).
    staged_for_agents_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


# --- v2 review correctness and publish (CR-06, migration 0014_review) -------------------

SECTION_APPROVAL_POLICIES = ("required_sections", "all_sections", "none")
CAMPAIGN_STATUSES = ("open", "closed")
NOTIFICATION_KINDS = (
    "comment",
    "reply",
    "assignment",
    "rereview_requested",
    "campaign",
    "patch_proposed",
    "published",
)
PATCH_ORIGINS = ("run", "llm_job", "agent", "person")
PATCH_STATUSES = ("open", "accepted", "rejected", "superseded")
PATCH_ACTIONS = ("replace", "remove")


def _lock_version() -> Mapped[int]:
    return mapped_column(Integer, nullable=False, default=1, server_default="1")


def _updated_at() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class SectionReviewState(TenantScoped, Base):
    """Review state of one stable section id of a document, across its versions.

    Who owns and reviews the section and by when, and which approvals a change
    invalidated (``oracle.review.state``). The verdicts themselves stay in
    ``section_reviews``; an approval holds for the revision (content hash) it was given
    on, in any later version that still has that revision.
    """

    __tablename__ = "section_review_states"
    __table_args__ = (UniqueConstraint("document_id", "section_key"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    # A user id (users.id); no FK, like the other *_id actor columns.
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    reviewer_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set when a change invalidated an approval and the policy asks for re-review;
    # cleared by the next verdict on the section.
    rereview_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Approvals (section_reviews ids) a change invalidated: never valid again, even if
    # the text later returns to the revision they were given on.
    invalidated_review_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    invalidated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    invalidated_change_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("change_events.id", ondelete="SET NULL")
    )
    # The revision the invalidated approval was given on.
    invalidated_hash: Mapped[str | None] = mapped_column(Text)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class DocumentReviewPolicy(TenantScoped, Base):
    """A document's review policy; without a row the company's ``review_policy`` setting
    applies (``oracle.review.state.effective_policy``)."""

    __tablename__ = "document_review_policies"
    __table_args__ = (
        UniqueConstraint("document_id"),
        CheckConstraint(
            _in("section_approval", SECTION_APPROVAL_POLICIES), name="section_approval"
        ),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    # The designated decider (F2): the only one who approves the version. Null: any
    # approver (today's behaviour).
    decider_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Extra reviewers whose approval of the current revisions is mandatory (no
    # unanimity unless configured here).
    mandatory_reviewer_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    # Required beyond the template's required sections and the composition's modules.
    required_section_keys: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default="{}"
    )
    # Which sections need an approval of their current revision before a publish.
    section_approval: Mapped[str] = mapped_column(
        Text, nullable=False, server_default="required_sections"
    )
    rereview_on_change: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=true()
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class ReviewCampaign(TenantScoped, Base):
    """An organization-wide call for feedback on one version (comments, not approvals)."""

    __tablename__ = "review_campaigns"
    __table_args__ = (CheckConstraint(_in("status", CAMPAIGN_STATUSES), name="status"),)

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    message: Mapped[str | None] = mapped_column(Text)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Roles invited (users with one of these roles are notified).
    audience_roles: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default="{}"
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    closed_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class Notification(TenantScoped, Base):
    """An in-app notification for one user (Slack notifications are wave 2)."""

    __tablename__ = "notifications"
    __table_args__ = (
        CheckConstraint(_in("kind", NOTIFICATION_KINDS), name="kind"),
        Index("ix_notifications_user_read", "user_id", "read_at"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    version_number: Mapped[int | None] = mapped_column(Integer)
    section_key: Mapped[str | None] = mapped_column(Text)
    comment_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("comments.id", ondelete="CASCADE")
    )
    campaign_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("review_campaigns.id", ondelete="CASCADE")
    )
    # Audit actor string of who caused it ("user:<uuid>", "system").
    actor: Mapped[str] = mapped_column(Text, nullable=False)
    data: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SectionPatch(TenantScoped, Base):
    """A proposed replacement of one section's text, reviewed as a diff before it
    replaces accepted human text (§9). An agent draft that rewrote an approved section
    leaves one of these instead of the rewrite."""

    __tablename__ = "section_patches"
    __table_args__ = (
        CheckConstraint(_in("origin", PATCH_ORIGINS), name="origin"),
        CheckConstraint(_in("status", PATCH_STATUSES), name="status"),
        CheckConstraint(_in("action", PATCH_ACTIONS), name="action"),
        Index("ix_section_patches_document_status", "document_id", "status"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    section_key: Mapped[str] = mapped_column(Text, nullable=False)
    # The version and section revision the patch was proposed against.
    base_version: Mapped[int] = mapped_column(Integer, nullable=False)
    base_hash: Mapped[str] = mapped_column(Text, nullable=False)
    heading: Mapped[str] = mapped_column(Text, nullable=False)
    body_md: Mapped[str] = mapped_column(Text, nullable=False)
    origin: Mapped[str] = mapped_column(Text, nullable=False)
    # "replace": the section's next text; "remove": the agent's draft dropped (or
    # renamed) the section.
    action: Mapped[str] = mapped_column(Text, nullable=False, server_default="replace")
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("runs.id", ondelete="SET NULL"), index=True
    )
    rationale: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="open")
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_note: Mapped[str | None] = mapped_column(Text)
    applied_version: Mapped[int | None] = mapped_column(Integer)
    lock_version: Mapped[int] = _lock_version()
    __mapper_args__ = {"version_id_col": lock_version}
    updated_at: Mapped[datetime] = _updated_at()


class DocumentPublication(TenantScoped, Base):
    """An immutable publication of an approved version (§9, §16.17).

    Everything it pins is copied in at publish time: the version, template and
    composition, the last approval and the decider, each section's approval, the
    evidence snapshot, the appendix and the rendered exports. A database trigger refuses
    any UPDATE, so later edits and source updates never change it.
    """

    __tablename__ = "document_publications"
    __table_args__ = (
        UniqueConstraint("document_id", "number"),
        UniqueConstraint("document_id", "version_id"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    version_id: Mapped[uuid.UUID] = mapped_column(
        # NO ACTION: a published version is never deleted on its own; deleting the
        # document (or the company) removes both in one statement.
        Uuid,
        ForeignKey("document_versions.id"),
        nullable=False,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    content_hash: Mapped[str] = mapped_column(Text, nullable=False)
    # PublicationManifest (oracle.review.schemas): template, composition, approvals,
    # decider, evidence snapshot, appendix, override log, readiness.
    manifest: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    # sha256 of the canonical manifest JSON plus the pinned markdown.
    manifest_hash: Mapped[str] = mapped_column(Text, nullable=False)
    markdown: Mapped[str] = mapped_column(Text, nullable=False)
    html_full: Mapped[str] = mapped_column(Text, nullable=False)
    html_brief: Mapped[str | None] = mapped_column(Text)
    html_deck: Mapped[str | None] = mapped_column(Text)
    published_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
