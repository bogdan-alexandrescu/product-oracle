"""The one staging list (G4): everything staged for one target, from every origin."""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

Source = Literal["suggestion", "next_draft_change", "checkpoint_action"]
# row: a review screen's row action (D8); discussion: staged from a discussion (G4);
# review: an accepted review suggestion (C1e).
Origin = Literal["row", "discussion", "review"]


class StagingTarget(BaseModel):
    kind: Literal["document", "checkpoint"]
    label: str
    document_id: uuid.UUID | None = None
    slug: str | None = None
    next_version: int | None = None
    run_id: uuid.UUID | None = None
    checkpoint_id: uuid.UUID | None = None
    checkpoint_kind: str | None = None


class StagingDiscussion(BaseModel):
    """The discussion a row came from. For a private discussion the reader is not in, only
    that it is private: ``id`` and ``title`` are null. ``private`` is its visibility now."""

    id: uuid.UUID | None = None
    title: str | None = None
    private: bool = False


class StagingPerson(BaseModel):
    user_id: uuid.UUID
    name: str


class StagingItem(BaseModel):
    id: uuid.UUID
    source: Source
    # The G1 kind (item_horizon, section_edit, ...), else D8's kind (accept, waive, ...).
    kind: str
    label: str
    item_key: str | None = None
    section_key: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    state: Literal["staged", "suggested"]
    reason: str | None = None
    origin: Origin
    discussion: StagingDiscussion | None = None
    # How the row was staged (from a private discussion), as recorded; never rewritten.
    from_private: bool = False
    # "From discussion <title>" or "From a private discussion"; null for other origins.
    origin_line: str | None = None
    staged_by: StagingPerson | None = None
    suggested_by: StagingPerson | None = None
    at: datetime | None = None
    section_gone: bool = False
    section_locked: bool = False
    # A next-draft row's version (the unstage route's lock_version).
    lock_version: int | None = None


class StagingCounts(BaseModel):
    staged: int = 0
    suggested: int = 0


class StagingList(BaseModel):
    target: StagingTarget
    items: list[StagingItem]
    counts: StagingCounts
    # The checkpoint's draft revision (D8); null for a document.
    revision: int | None = None
    # The reader may stage and remove here (the approver role, on a pending target).
    can_stage: bool = False


class UnstageIn(BaseModel):
    lock_version: int


class NextDraftChangeOut(BaseModel):
    """A discussion's section change waiting for the document's next draft."""

    id: uuid.UUID
    document_id: uuid.UUID
    section_key: str
    raised_on_version: int
    instruction: str
    text: str | None = None
    reason: str | None = None
    status: Literal["staged", "unstaged", "applied", "superseded"]
    applied_in_version: int | None = None
    from_private: bool = False
    lock_version: int
