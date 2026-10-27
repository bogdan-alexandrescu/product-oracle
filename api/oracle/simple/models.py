"""Simple S2 (#723) tables: Oracle's date suggestions for undated roadmap items
(oracle.simple.suggestions). Simple S3a: the change engine's sessions and changes
(oracle.simple.changes).

One row per suggestion: ``open`` until a person with the right accepts it (the item takes
its dates, ``date_source = 'accepted'``), edits it (the item takes the person's dates) or
dismisses it. An item has at most one open suggestion; the daily regeneration replaces it.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in

SUGGESTION_STATUSES = ("open", "accepted", "edited", "dismissed")
SESSION_KINDS = ("editing", "meeting")
CHANGE_STATUSES = ("applied", "proposed", "accepted", "declined", "undone")


class RoadmapDateSuggestion(TenantScoped, Base):
    __tablename__ = "roadmap_date_suggestions"
    __table_args__ = (
        CheckConstraint(_in("status", SUGGESTION_STATUSES), name="status"),
        CheckConstraint("end_date >= start_date", name="span"),
        Index(
            "uq_roadmap_date_suggestions_open",
            "item_id",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
    )

    item_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("roadmap_items.id", ondelete="CASCADE"), nullable=False, index=True
    )
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date] = mapped_column(Date, nullable=False)
    # One sentence: why these dates.
    basis: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SimpleSession(TenantScoped, Base):
    """One person's editing session, or a meeting's: the changes made in it undo step by
    step while it is open. Closed by its starter, or by the minute tick after 30 minutes
    without a change (oracle.simple.changes.close_idle). A person has at most one open
    editing session."""

    __tablename__ = "simple_sessions"
    __table_args__ = (
        CheckConstraint(_in("kind", SESSION_KINDS), name="kind"),
        Index(
            "uq_simple_sessions_open_editing",
            "started_by",
            unique=True,
            postgresql_where=text("kind = 'editing' AND closed_at IS NULL"),
        ),
    )

    kind: Mapped[str] = mapped_column(Text, nullable=False)
    started_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_change_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SimpleChange(TenantScoped, Base):
    """One change made in Simple (oracle.simple.changes): ``applied`` (an owner's or the
    decider's), ``proposed`` to ``routed_to`` then ``accepted`` or ``declined``, or an
    ``undone`` row that reverses the change ``undoes_id`` (history is never deleted).
    ``before``/``after``: the fields the change writes, as they were and as they became;
    an op that moves several items keys them by item id."""

    __tablename__ = "simple_changes"
    __table_args__ = (
        CheckConstraint(_in("status", CHANGE_STATUSES), name="status"),
        Index(
            "uq_simple_changes_undoes",
            "undoes_id",
            unique=True,
            postgresql_where=text("undoes_id IS NOT NULL"),
        ),
        Index("ix_simple_changes_document_at", "document_id", "at"),
    )

    session_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("simple_sessions.id", ondelete="SET NULL"), index=True
    )
    # The roadmap document of the target item.
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE")
    )
    op: Mapped[str] = mapped_column(Text, nullable=False)
    target: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    before: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    after: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False, index=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reason: Mapped[str | None] = mapped_column(Text)
    decision_reason: Mapped[str | None] = mapped_column(Text)
    # Who decides a proposal: the roadmap's decider, else its owner, else the company's
    # owners (#723 owner answer); empty for every other status.
    routed_to: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    undoes_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("simple_changes.id", ondelete="CASCADE")
    )
    # S3b: the working drafts an applied change of a versioned document wrote (one per
    # roadmap it touched); empty for a proposal and for non-versioned targets.
    draft_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )


DRAFT_STATUSES = ("working", "submitted", "approved", "discarded")
TASK_STATUSES = ("todo", "doing", "done", "dropped")
ACTION_STATUSES = ("open", "done", "dropped")


class SimpleDraft(TenantScoped, Base):
    """Simple S3b: the working draft of one versioned document (a roadmap's items): the
    applied changes of owners and the decider land here, never in the published version
    (oracle.simple.drafts). ``overlay`` holds each changed item's fields as the draft has
    them, keyed by the published item's id; ``base_version_id`` is the version it was
    opened on. Submitting imports the next version (``version_id``) through the
    roadmap's change-set path and the document's review policy; the decider's approval
    waits in ``decider_approval`` while required reviewers in ``waiting_on`` have not
    approved. At most one working draft per document; sessions join it
    (``simple_session_drafts``)."""

    __tablename__ = "simple_drafts"
    __table_args__ = (
        CheckConstraint(_in("status", DRAFT_STATUSES), name="status"),
        Index(
            "uq_simple_drafts_working",
            "document_id",
            unique=True,
            postgresql_where=text("status = 'working'"),
        ),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    base_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="SET NULL")
    )
    version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="working")
    overlay: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    # Who took part: every session's starter that joined it, and meeting attendees.
    participant_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # {"by", "at", "session_id"}: the decider's approval, held until every required
    # reviewer has approved.
    decider_approval: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    waiting_on: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(Uuid), nullable=False, server_default="{}"
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Remind (owner, 2026-10-26): when each waiting reviewer was last nudged,
    # ``{user_id: iso time}``; at most once a day each. Cleared on submit.
    reminders: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, server_default="{}")


class SimpleSessionDraft(TenantScoped, Base):
    """Simple S3b: a session's working draft of one document (one per session and
    document); ``draft_version_id`` is the version the draft became once submitted."""

    __tablename__ = "simple_session_drafts"
    __table_args__ = (UniqueConstraint("session_id", "document_id"),)

    session_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("simple_sessions.id", ondelete="CASCADE"), nullable=False
    )
    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    draft_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("simple_drafts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    draft_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="SET NULL")
    )


class RoadmapItemTask(TenantScoped, Base):
    """Simple S3b: work under a roadmap item (#723 data model). Not versioned: owners and
    the decider change it directly, others propose (oracle.simple.targets). Anchored by
    the item's roadmap and key as well as its id, so a later version's item keeps it."""

    __tablename__ = "roadmap_item_tasks"
    __table_args__ = (
        CheckConstraint(_in("status", TASK_STATUSES), name="status"),
        Index("ix_roadmap_item_tasks_item", "roadmap_document_id", "item_key"),
    )

    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("roadmap_items.id", ondelete="SET NULL")
    )
    roadmap_document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False
    )
    item_key: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="todo")
    due_date: Mapped[date | None] = mapped_column(Date)
    tracker_record_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("tracker_records.id", ondelete="SET NULL")
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)


class SimpleActionItem(TenantScoped, Base):
    """Simple S3b: a meeting's (or an editing session's) action item (#723 data model),
    optionally under a roadmap item. ``meeting_id`` names S8's meeting (no key yet)."""

    __tablename__ = "simple_action_items"
    __table_args__ = (CheckConstraint(_in("status", ACTION_STATUSES), name="status"),)

    meeting_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    item_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("roadmap_items.id", ondelete="SET NULL")
    )
    roadmap_document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE")
    )
    item_key: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    owner_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    due_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open")
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)


class SimpleOnePager(TenantScoped, Base):
    """Simple S5: a PRD version's one-pager as built (oracle.simple.one_pager): its blocks,
    each line with the section keys it came from. One row per version and hash of the
    mapped sections (``sections_hash``): a changed mapped section is a new hash, so the
    one-pager is rebuilt. ``built_by``: ``extract`` (Oracle's quick read of the sections,
    shown at once) until the ``one_pager`` job's answer replaces it (``oracle``)."""

    __tablename__ = "simple_one_pagers"
    __table_args__ = (
        CheckConstraint("built_by IN ('extract', 'oracle')", name="built_by"),
        UniqueConstraint("version_id", "sections_hash"),
    )

    document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("document_versions.id", ondelete="CASCADE"), nullable=False
    )
    sections_hash: Mapped[str] = mapped_column(Text, nullable=False)
    blocks: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, server_default="[]")
    built_by: Mapped[str] = mapped_column(Text, nullable=False, server_default="extract")
    job_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    built_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


<<<<<<< HEAD
class RoadmapKeyDate(TenantScoped, Base):
    """Simple roadmap-plus: one of a roadmap's published key dates (a conference, a product
    launch, a board meeting): a name, a day and an optional note. Owners' and the decider's
    changes wait in the roadmap's working draft (``overlay["key_dates"]``) and are written
    here when the draft is approved (oracle.simple.key_dates.publish)."""

    __tablename__ = "roadmap_key_dates"

    roadmap_document_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    on_date: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)


# --------------------------------------------------------------------------- S7

GOAL_SUGGESTION_STATUSES = ("open", "accepted", "rejected")
GOAL_SUGGESTION_ORIGINS = ("auto", "on_demand")


class SimpleGoalSuggestion(TenantScoped, Base):
    """Simple S7 (oracle.simple.additions): a feature Oracle suggests for a goal. ``open``
    until a person accepts it (an ``add_item`` change on the goal: ``change_id``,
    ``item_id``; undoing or declining that change reopens it) or rejects it (with an
    optional ``reason``; a rejected title is never suggested again for the goal).
    ``evidence``: [{"label", "kind", "ref", "url", "confidence"}]."""

    __tablename__ = "simple_goal_suggestions"
    __table_args__ = (
        CheckConstraint(_in("status", GOAL_SUGGESTION_STATUSES), name="status"),
        CheckConstraint(_in("origin", GOAL_SUGGESTION_ORIGINS), name="origin"),
        Index("ix_simple_goal_suggestions_goal_status", "goal_id", "status"),
    )

    goal_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    outcome: Mapped[str | None] = mapped_column(Text)
    why: Mapped[str | None] = mapped_column(Text)
    evidence: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]", default=list
    )
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="open",
                                        default="open")  # fmt: skip
    origin: Mapped[str] = mapped_column(Text, nullable=False, server_default="on_demand",
                                        default="on_demand")  # fmt: skip
    reason: Mapped[str | None] = mapped_column(Text)
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("llm_jobs.id", ondelete="SET NULL")
    )
    change_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("simple_changes.id", ondelete="SET NULL")
    )
    item_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SimpleGoalAuto(TenantScoped, Base):
    """A goal Oracle suggested features for automatically, once, when it had no items
    (oracle.simple.additions.suggest_for_empty_goals): never again for that goal."""

    __tablename__ = "simple_goal_autos"
    __table_args__ = (UniqueConstraint("goal_id"),)

    goal_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("entities.id", ondelete="CASCADE"), nullable=False
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("llm_jobs.id", ondelete="SET NULL")
    )
=======
VISUAL_SUBJECT_KINDS = (
    "suggestion",
    "draft_item",
    "change",
    "chat_card",
    "one_pager_line",
    "feature",
)


class SimpleVisual(TenantScoped, Base):
    """Simple S10: the visual of one proposal (oracle.simple.visuals), held against its
    subject (``subject_kind``, ``subject_id``). Its versions are the drawings; its comments
    are what a person asked to change. ``document_id``: the roadmap or PRD the subject
    belongs to (who reads it and who revises it follow that document), null when none."""

    __tablename__ = "simple_visuals"
    __table_args__ = (
        CheckConstraint(_in("subject_kind", VISUAL_SUBJECT_KINDS), name="subject_kind"),
        UniqueConstraint("tenant_id", "subject_kind", "subject_id"),
    )

    subject_kind: Mapped[str] = mapped_column(Text, nullable=False)
    subject_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    document_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("documents.id", ondelete="CASCADE"), index=True
    )
    # What the proposal adds or changes, in words (the drafting job's brief).
    brief: Mapped[str] = mapped_column(Text, nullable=False)
    requested_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class SimpleVisualVersion(TenantScoped, Base):
    """One drawing of a visual: the user flow (its steps as data and as sanitised SVG), the
    low-fi wireframe of the screen it touches (sanitised HTML, none when it touches no
    screen) and the numbered annotations tying parts to PRD sections and requirements.
    Version 1 is the draft; each revise adds the next."""

    __tablename__ = "simple_visual_versions"
    __table_args__ = (UniqueConstraint("visual_id", "number"),)

    visual_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("simple_visuals.id", ondelete="CASCADE"), nullable=False, index=True
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    goal: Mapped[str | None] = mapped_column(Text)
    # [{"id", "label", "kind": step|decision, "feature", "change": new|changed|same,
    #   "section_key"}]
    steps: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False)
    # {"title", "regions": [...]}; null: the proposal touches no screen.
    screen: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    flow_svg: Mapped[str] = mapped_column(Text, nullable=False)
    wireframe_html: Mapped[str | None] = mapped_column(Text)
    annotations: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, nullable=False, server_default="[]"
    )
    # Harmless markup the sanitiser dropped (reported, as the design check does).
    removed: Mapped[list[str]] = mapped_column(JSONB, nullable=False, server_default="[]")
    job_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # Who asked for this drawing (the proposal's author, or the reviser); null: Oracle.
    made_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)


class SimpleVisualComment(TenantScoped, Base):
    """A comment on a visual's version (optionally on one numbered annotation); a revise
    addresses every open one (``addressed_in``: the version that did)."""

    __tablename__ = "simple_visual_comments"

    visual_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("simple_visuals.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    annotation: Mapped[int | None] = mapped_column(Integer)
    body: Mapped[str] = mapped_column(Text, nullable=False)
    author_id: Mapped[uuid.UUID] = mapped_column(Uuid, nullable=False)
    addressed_in: Mapped[int | None] = mapped_column(Integer)
>>>>>>> origin/swarm/task_b44b2216e0bb442a8481
