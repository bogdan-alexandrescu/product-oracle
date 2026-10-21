"""Launches, their checklist tasks, changelog entries and requester notes (H6,
migration 0020_launches).

- ``launches``: one shipped unit, by default one roadmap item of a track (or several a
  person grouped). Planned when a roadmap version is approved (items in Now), Ready
  when every ship signal of its items is in (``oracle.roadmap.shipped``), Launched by a
  person only, or Cancelled. Its tier is Oracle's suggestion until an approver sets it.
- ``launch_tasks``: the tier's checklist (``oracle.launches.checklist``) plus tasks
  people add; Oracle's ``launch_kit`` run drafts their text.
- ``changelog_entries``: dated, categorized lines (Keep a Changelog), internal or
  public. A public entry is published by an approver only; Oracle posts nothing outside.
- ``requester_notes``: a personal note to one person who asked for an item. People
  send external notes themselves; Oracle never does.
"""

import uuid
from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    Index,
    Integer,
    SmallInteger,
    Text,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from oracle.db import Base, TenantScoped
from oracle.docs.models import _in
from oracle.v2.models import _fk, _json, _lock_version, _texts, _updated_at

LAUNCH_STATES = ("planned", "ready", "launched", "cancelled")
TASK_AUDIENCES = ("internal", "external")
TASK_STATUSES = ("todo", "drafted", "done", "skipped")
CHANGELOG_CATEGORIES = ("added", "changed", "deprecated", "removed", "fixed", "security")
CHANGELOG_AUDIENCES = ("internal", "public")
CHANGELOG_STATUSES = ("draft", "published", "withdrawn")
REQUESTER_KINDS = ("request", "member", "manual")
NOTE_STATUSES = ("drafted", "sent", "skipped", "notified")
NOTE_CHANNELS = ("email", "slack", "call", "in_app", "other")


class Launch(TenantScoped, Base):
    __tablename__ = "launches"
    __table_args__ = (
        CheckConstraint(_in("state", LAUNCH_STATES), name="state"),
        CheckConstraint("tier BETWEEN 1 AND 3", name="tier"),
        # One live launch per set of items of a track.
        Index(
            "ux_launches_item",
            "tenant_id",
            "track_id",
            "item_keys",
            unique=True,
            postgresql_where=text("state <> 'cancelled'"),
        ),
    )

    title: Mapped[str] = mapped_column(Text, nullable=False)
    track_id: Mapped[uuid.UUID | None] = _fk("product_tracks", "SET NULL")
    # The approved roadmap version the items were read from.
    roadmap_version_id: Mapped[uuid.UUID | None] = _fk("document_versions", "SET NULL")
    item_keys: Mapped[list[str]] = _texts()
    state: Mapped[str] = mapped_column(
        Text, nullable=False, default="planned", server_default="planned"
    )
    # Set by an approver; until then ``tier_suggestion`` stands.
    tier: Mapped[int | None] = mapped_column(SmallInteger)
    tier_set_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # {"tier", "reason", "innovation", "goal"} (oracle.launches.tiers).
    tier_suggestion: Mapped[dict[str, Any]] = _json()
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    launched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    launched_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    kit_run_id: Mapped[uuid.UUID | None] = _fk("runs", "SET NULL")
    # Why the kit run's launch.yaml was refused, when it was.
    kit_error: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lock_version: Mapped[int] = _lock_version()
    updated_at: Mapped[datetime] = _updated_at()


class LaunchTask(TenantScoped, Base):
    __tablename__ = "launch_tasks"
    __table_args__ = (
        CheckConstraint(_in("audience", TASK_AUDIENCES), name="audience"),
        CheckConstraint(_in("status", TASK_STATUSES), name="status"),
        CheckConstraint("status <> 'skipped' OR skip_reason IS NOT NULL", name="skip_reason"),
    )

    launch_id: Mapped[uuid.UUID] = _fk("launches", nullable=False)
    # The checklist key (oracle.launches.checklist); null for a task a person added.
    key: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    audience: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, default="todo", server_default="todo")
    owner_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    body: Mapped[str | None] = mapped_column(Text)
    skip_reason: Mapped[str | None] = mapped_column(Text)
    done_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lock_version: Mapped[int] = _lock_version()
    updated_at: Mapped[datetime] = _updated_at()


class ChangelogEntry(TenantScoped, Base):
    __tablename__ = "changelog_entries"
    __table_args__ = (
        CheckConstraint(_in("category", CHANGELOG_CATEGORIES), name="category"),
        CheckConstraint(_in("audience", CHANGELOG_AUDIENCES), name="audience"),
        CheckConstraint(_in("status", CHANGELOG_STATUSES), name="status"),
    )

    launch_id: Mapped[uuid.UUID | None] = _fk("launches", "SET NULL")
    category: Mapped[str] = mapped_column(Text, nullable=False)
    audience: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    body: Mapped[str] = mapped_column(Text, nullable=False, default="", server_default="")
    released_on: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="draft", server_default="draft"
    )
    published_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # The audit actor that published it ("user:<id>", or "oracle" within its limits).
    published_actor: Mapped[str | None] = mapped_column(Text)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_actor: Mapped[str] = mapped_column(Text, nullable=False)
    lock_version: Mapped[int] = _lock_version()
    updated_at: Mapped[datetime] = _updated_at()


class RequesterNote(TenantScoped, Base):
    __tablename__ = "requester_notes"
    __table_args__ = (
        UniqueConstraint("launch_id", "requester_kind", "request_id", "member_id"),
        CheckConstraint(_in("requester_kind", REQUESTER_KINDS), name="requester_kind"),
        CheckConstraint(_in("status", NOTE_STATUSES), name="status"),
        CheckConstraint(f"channel IS NULL OR {_in('channel', NOTE_CHANNELS)}", name="channel"),
    )

    launch_id: Mapped[uuid.UUID] = _fk("launches", nullable=False)
    requester_kind: Mapped[str] = mapped_column(Text, nullable=False)
    request_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    member_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    # Only what the requester gave in their request; Oracle never looks contact details up.
    contact_hint: Mapped[str | None] = mapped_column(Text)
    # What they asked, in their words (their request or comment), quoted in the note.
    asked: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(
        Text, nullable=False, default="drafted", server_default="drafted"
    )
    channel: Mapped[str | None] = mapped_column(Text)
    sent_on: Mapped[date | None] = mapped_column(Date)
    sent_by: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    skip_reason: Mapped[str | None] = mapped_column(Text)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = _updated_at()
