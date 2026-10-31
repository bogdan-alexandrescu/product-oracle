import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

TrashItemType = Literal["document", "intake", "run"]


class TrashItem(BaseModel):
    """A document, intake or run as it was when it went to Trash."""

    type: TrashItemType
    id: uuid.UUID
    slug: str | None = None
    title: str
    # A document's kind (prd, roadmap, spec, update, ...), "intake", or a run's flow.
    kind: str
    # qa4-docs-26: a run in the delete dialog, in words: when it ran and what it wrote.
    created_at: datetime | None = None
    wrote: str | None = None


class DependentsOut(BaseModel):
    """What the delete dialog lists: the root and everything that goes to Trash with it.
    ``published``: ask once more, the external copy stays where it is. ``working_runs``:
    runs to cancel before the delete is allowed."""

    root: TrashItem
    items: list[TrashItem]
    published: bool
    working_runs: list[uuid.UUID] = []


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
