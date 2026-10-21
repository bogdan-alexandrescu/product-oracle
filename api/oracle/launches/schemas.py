"""Request and response models of the launch and changelog routes (H6)."""

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

LaunchState = Literal["planned", "ready", "launched", "cancelled"]
TaskAudience = Literal["internal", "external"]
TaskStatus = Literal["todo", "drafted", "done", "skipped"]
ChangelogCategory = Literal["added", "changed", "deprecated", "removed", "fixed", "security"]
ChangelogAudience = Literal["internal", "public"]
ChangelogStatus = Literal["draft", "published", "withdrawn"]
RequesterKind = Literal["request", "member", "manual"]
NoteStatus = Literal["drafted", "sent", "skipped", "notified"]
NoteChannel = Literal["email", "slack", "call", "in_app", "other"]
Tier = int


class TierSuggestion(BaseModel):
    tier: int
    # In words: "New feature serving a top goal (Raise activation)".
    reason: str
    innovation: Literal["new", "improvement", "fix"]
    goal: Literal["top", "other", "none"]
    goal_title: str | None = None
    item_key: str | None = None
    # What the approver said when they set another tier (tier_reason_override).
    person_reason: str | None = None


class TaskCounts(BaseModel):
    total: int = 0
    # Done or skipped.
    closed: int = 0
    open: int = 0


class NoteCounts(BaseModel):
    total: int = 0
    sent: int = 0
    skipped: int = 0
    notified: int = 0
    # Still to send or skip.
    open: int = 0


class LaunchItem(BaseModel):
    item_key: str
    title: str | None = None
    horizon: str | None = None
    roadmap_slug: str | None = None
    roadmap_version: int | None = None


class TaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    launch_id: uuid.UUID
    key: str | None
    title: str
    position: int
    audience: TaskAudience
    status: TaskStatus
    owner_id: uuid.UUID | None = None
    body: str | None = None
    skip_reason: str | None = None
    done_by: uuid.UUID | None = None
    done_at: datetime | None = None
    # Whether Oracle drafts it: yes, an outline, or no (a person's task).
    drafts: Literal["yes", "outline", "no"] = "no"
    # Listed as optional in this tier.
    optional: bool = False
    # "Draft by Oracle. A person checks and sends it." on an external task's draft.
    notice: str | None = None
    lock_version: int
    updated_at: datetime


class LaunchSummary(BaseModel):
    id: uuid.UUID
    title: str
    track_id: uuid.UUID | None = None
    roadmap_version_id: uuid.UUID | None = None
    item_keys: list[str]
    state: LaunchState
    tier: int | None = None
    tier_suggestion: TierSuggestion
    owner_id: uuid.UUID | None = None
    ready_at: datetime | None = None
    launched_at: datetime | None = None
    cancel_reason: str | None = None
    kit_run_id: uuid.UUID | None = None
    kit_error: str | None = None
    task_counts: TaskCounts
    notes: NoteCounts
    lock_version: int
    created_at: datetime
    updated_at: datetime


class LaunchOut(LaunchSummary):
    items: list[LaunchItem] = []
    tasks: list[TaskOut] = []


class LaunchCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    track_id: uuid.UUID
    item_keys: list[str] = Field(min_length=1, max_length=50)
    owner_id: uuid.UUID | None = None


class LaunchPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    owner_id: uuid.UUID | None = None
    tier: int | None = Field(default=None, ge=1, le=3)
    tier_reason_override: str | None = Field(default=None, max_length=2000)
    item_keys: list[str] | None = Field(default=None, min_length=1, max_length=50)
    lock_version: int


class LaunchedIn(BaseModel):
    # When it went out; now when not given.
    at: datetime | None = None


class CancelIn(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


class TaskCreate(BaseModel):
    key: str | None = Field(default=None, min_length=1, max_length=80)
    title: str = Field(min_length=1, max_length=300)
    audience: TaskAudience
    owner_id: uuid.UUID | None = None


class TaskPatch(BaseModel):
    body: str | None = Field(default=None, max_length=50_000)
    owner_id: uuid.UUID | None = None
    status: TaskStatus | None = None
    skip_reason: str | None = Field(default=None, max_length=2000)
    lock_version: int


class ChangelogEntryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    launch_id: uuid.UUID | None = None
    category: ChangelogCategory
    audience: ChangelogAudience
    title: str
    body: str
    released_on: date
    status: ChangelogStatus
    published_by: uuid.UUID | None = None
    published_actor: str | None = None
    published_at: datetime | None = None
    created_actor: str
    lock_version: int
    created_at: datetime
    updated_at: datetime


class ChangelogCreate(BaseModel):
    launch_id: uuid.UUID | None = None
    category: ChangelogCategory
    audience: ChangelogAudience
    title: str = Field(min_length=1, max_length=300)
    body: str = Field(default="", max_length=20_000)
    # Needed for a public entry; an internal one defaults to today.
    released_on: date | None = None


class ChangelogPatch(BaseModel):
    category: ChangelogCategory | None = None
    audience: ChangelogAudience | None = None
    title: str | None = Field(default=None, min_length=1, max_length=300)
    body: str | None = Field(default=None, max_length=20_000)
    released_on: date | None = None
    lock_version: int


class RequesterNoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    launch_id: uuid.UUID
    requester_kind: RequesterKind
    request_id: uuid.UUID | None = None
    member_id: uuid.UUID | None = None
    display_name: str
    contact_hint: str | None = None
    # What they asked, in their own words.
    asked: str | None = None
    body: str | None = None
    status: NoteStatus
    channel: NoteChannel | None = None
    sent_on: date | None = None
    sent_by: uuid.UUID | None = None
    skip_reason: str | None = None
    notified_at: datetime | None = None
    # A member is told inside Oracle (Notify members); anyone else by a person.
    internal: bool = False
    notice: str | None = None
    created_at: datetime
    updated_at: datetime


class RequesterCreate(BaseModel):
    """Someone who asked, added by hand: a name and what they gave to reach them."""

    display_name: str = Field(min_length=1, max_length=200)
    contact_hint: str | None = Field(default=None, max_length=300)
    asked: str | None = Field(default=None, max_length=5000)


class RequesterNotePatch(BaseModel):
    body: str | None = Field(default=None, max_length=20_000)
    status: Literal["sent", "skipped"] | None = None
    channel: NoteChannel | None = None
    sent_on: date | None = None
    skip_reason: str | None = Field(default=None, max_length=2000)


class NotifiedOut(BaseModel):
    notified: int


class InboxLaunch(BaseModel):
    """A launch row of the Inbox: Ready to launch (owner), Set tier (approvers), Notes
    to send (owner) are counted; Shipped (a member's personal note) is shown only."""

    launch_id: uuid.UUID
    # "Ready to launch · Hard budget caps", "Notes to send · Hard budget caps · 3", ...
    title: str
    item: str
    reason: Literal["ready", "set_tier", "notes_to_send", "shipped_note"]
    state: LaunchState
    counted: bool
    count: int = 1
    # The personal note, on a Shipped row.
    note: str | None = None
    at: datetime | None = None
