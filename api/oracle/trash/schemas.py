import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

# trash-features-goals: a roadmap feature or a goal, too (oracle.simple.trash_items).
# edit-decisions: an open decision or a PRD question (oracle.simple.decision_sheet).
# port-an-decisions: a meeting's agenda item or a request.
# removed-tracks: a product track.
# goal-map-editing: a goal milestone.
TrashItemType = Literal[
    "document",
    "intake",
    "run",
    "feature",
    "goal",
    "decision",
    "question",
    "agenda_item",
    "request",
    "track",
    "milestone",
]


class TrashItem(BaseModel):
    """A document, intake, run, roadmap feature or goal as it was when it went to Trash."""

    type: TrashItemType
    id: uuid.UUID
    slug: str | None = None
    title: str
    # A document's kind (prd, roadmap, spec, update, ...), "intake", a run's flow,
    # "feature", "goal", "Track" or "Milestone".
    kind: str
    # A feature's code on its roadmap ("F-26"), shown before its name.
    code: str | None = None
    # qa4-docs-26: a run in the delete dialog, in words: when it ran and what it wrote.
    created_at: datetime | None = None
    wrote: str | None = None
    # G-4: what Restore brings back with it: a goal's features (those that served it when it
    # was deleted) and a removed agenda item's meeting, by its title.
    features: int | None = None
    meeting: str | None = None


class DependentsOut(BaseModel):
    """What the delete dialog lists: the root and everything that goes to Trash with it.
    ``published``: ask once more, the external copy stays where it is. ``working_runs``:
    runs to cancel before the delete is allowed. ``feeds`` (delete-prd-simple): the roadmap
    items and tracks a PRD feeds; they stay, without it."""

    root: TrashItem
    items: list[TrashItem]
    published: bool
    working_runs: list[uuid.UUID] = []
    feeds: list[TrashItem] = []


class NotRestored(BaseModel):
    """Something a restore could not bring back with the entry, and why."""

    item: TrashItem
    reason: str


class TrashEntryOut(BaseModel):
    """One delete in Settings › Trash: restored together, purged after ``days_left``."""

    id: uuid.UUID
    root: TrashItem
    items: list[TrashItem]
    deleted_by: uuid.UUID | None = None
    deleted_by_name: str | None = None
    deleted_at: datetime
    reason: str | None = None
    published: bool
    purge_after: datetime
    days_left: int
    # A restore's answer: what could not come back with it (empty in Trash's list).
    not_restored: list[NotRestored] = []
    # Whether the caller may restore it: owners anything, whoever deleted a feature or a
    # goal that one too (oracle.trash.service.may_restore).
    can_restore: bool = False


class RegenerateEstimateIn(BaseModel):
    # A note to the agents, kept with the run and in the audit.
    note: str | None = Field(default=None, max_length=2000)


class RegenerateEstimateOut(BaseModel):
    """A draft run that would regenerate the document, estimated; nothing is spent until
    it is started. Over the threshold an owner approves it first."""

    run_id: uuid.UUID
    document_slug: str
    kind: str
    flow: str
    inputs: list[str]
    estimate_usd: float
    approval_threshold_usd: float
    needs_owner_approval: bool
    note: str | None = None


class RegenerateIn(BaseModel):
    # The run ``…/regenerate/estimate`` made.
    run_id: uuid.UUID
    note: str | None = Field(default=None, max_length=2000)
