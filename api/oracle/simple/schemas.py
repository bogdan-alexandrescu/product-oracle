"""Simple S2 (#723): the company-wide roadmap read and the date suggestions; S3a: the
change engine's sessions and changes."""

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

DateSource = Literal["typed", "accepted", "engineering", "tracker", "estimated"]
RoadmapGroup = Literal["goal", "track", "prd"]
PhaseKey = Literal["discover", "build", "beta", "launch"]
FlagKind = Literal[
    "dependency_order",
    "blocker_date",
    "outside_milestone",
    "cut_with_dependents",
    "draft_without_owner",
]
FixKind = Literal["shift_dependents", "move_dependency", "accept_risk"]
ItemStatus = Literal["planned", "in_progress", "done", "cut", "draft"]
SuggestionStatus = Literal["open", "accepted", "edited", "dismissed"]


class SimpleDate(BaseModel):
    date: dt.date
    source: DateSource
    # Drawn hatched: the horizon's window (or a span backed off from a known date).
    estimated: bool


class SimpleWindow(BaseModel):
    start: dt.date
    end: dt.date


class SimpleWindows(BaseModel):
    now: SimpleWindow
    next: SimpleWindow
    later: SimpleWindow


class SimplePhase(BaseModel):
    key: PhaseKey
    start: dt.date
    end: dt.date
    estimated: bool


class SimpleFlag(BaseModel):
    kind: FlagKind
    # One line, in words.
    reason: str
    fixes: list[FixKind]
    # red: broken; amber: broken, and accepted as a risk (risk_note).
    state: Literal["red", "amber"]
    # What the flag is about: the dependency's item id, the blocker's id, the milestone's name.
    subject: str | None = None
    risk_note: str | None = None


class SimpleDocRef(BaseModel):
    id: uuid.UUID
    slug: str
    title: str


class SimpleGoalRef(BaseModel):
    id: uuid.UUID
    key: str
    title: str


class SimpleTrackRef(BaseModel):
    id: uuid.UUID
    title: str


class SimpleItemMilestone(BaseModel):
    name: str | None = None
    date: dt.date | None = None
    # item: the item's own milestone; track: a track milestone naming the item.
    source: Literal["item", "track"]


class DateSuggestionOut(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    item_key: str
    item_title: str
    start_date: dt.date
    end_date: dt.date
    # One sentence: why these dates.
    basis: str
    status: SuggestionStatus
    created_at: dt.datetime
    decided_by: uuid.UUID | None = None
    decided_at: dt.datetime | None = None
    # The caller may accept, edit or dismiss it: an owner, the roadmap's decider, or with
    # no decider the roadmap's track owner.
    can_decide: bool = False


class SimpleRoadmapItem(BaseModel):
    id: uuid.UUID
    key: str
    title: str
    outcome: str | None = None
    horizon: Literal["now", "next", "later"]
    roadmap: SimpleDocRef
    prd: SimpleDocRef | None = None
    goal: SimpleGoalRef | None = None
    track: SimpleTrackRef | None = None
    confidence: str | None = None
    status: ItemStatus
    draft: bool = False
    start: SimpleDate
    end: SimpleDate
    # The bar's source (its end's, else its start's) and whether it is an estimate.
    source: DateSource
    estimated: bool
    suggestion: DateSuggestionOut | None = None
    milestone: SimpleItemMilestone | None = None
    phases: list[SimplePhase]
    # Item ids (of this read) the item depends on, and those that depend on it.
    depends_on: list[uuid.UUID]
    needed_by: list[uuid.UUID]
    flags: list[SimpleFlag]


class SimpleGroup(BaseModel):
    # The goal's, track's or PRD's id; "none" for the items without one.
    key: str
    title: str
    item_ids: list[uuid.UUID]


class SimpleMilestone(BaseModel):
    id: uuid.UUID
    track_id: uuid.UUID
    name: str
    date: dt.date | None = None
    horizon: Literal["now", "next", "later"]
    status: Literal["planned", "done", "dropped"]
    item_ids: list[uuid.UUID]


class SimpleRoadmapOut(BaseModel):
    today: dt.date
    group: RoadmapGroup
    windows: SimpleWindows
    groups: list[SimpleGroup]
    items: list[SimpleRoadmapItem]
    milestones: list[SimpleMilestone]


class DateSuggestionEdit(BaseModel):
    start_date: dt.date
    end_date: dt.date

    @model_validator(mode="after")
    def _span(self) -> "DateSuggestionEdit":
        if self.end_date < self.start_date:
            raise ValueError("end_date must not be before start_date")
        return self


class RefreshOut(BaseModel):
    open: int = Field(description="Open suggestions after the refresh")


# --------------------------------------------------------------------------- S3a changes

ChangeOp = Literal[
    "move_dates",
    "change_horizon",
    "reorder",
    "cut",
    "restore",
    "edit_title",
    "edit_outcome",
    "accept_date_suggestion",
    "accept_risk",
    "shift_dependents",
    "move_dependency",
]
ChangeStatus = Literal["applied", "proposed", "accepted", "declined", "undone"]
SessionKind = Literal["editing", "meeting"]


class SimpleSessionIn(BaseModel):
    kind: SessionKind = "editing"


class SimpleSessionOut(BaseModel):
    id: uuid.UUID
    kind: SessionKind
    started_by: uuid.UUID
    started_at: dt.datetime
    last_change_at: dt.datetime | None
    closed_at: dt.datetime | None


class SimpleChangeIn(BaseModel):
    # The caller's open session; without one, an applied change goes to the caller's
    # open editing session (opened when none), a proposal to none.
    session_id: uuid.UUID | None = None
    op: ChangeOp
    # {"item_id"} for every op; accept_date_suggestion adds "suggestion_id"; accept_risk
    # "flag" and "subject" (optional); shift_dependents and move_dependency "subject" (the
    # dependency's item id of the flag).
    target: dict[str, Any]
    # The fields the change writes, as the caller saw them; for shift_dependents and
    # move_dependency, {item_id: {"start_date", "end_date"}} for the item and its subject.
    before: dict[str, Any]
    after: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = Field(default=None, max_length=500)


class SimpleDecisionIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


class SimplePersonRef(BaseModel):
    id: uuid.UUID
    name: str


class SimpleChangeOut(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID | None
    document_id: uuid.UUID | None
    op: ChangeOp
    target: dict[str, Any]
    before: dict[str, Any]
    after: dict[str, Any]
    status: ChangeStatus
    by: uuid.UUID
    by_name: str
    at: dt.datetime
    decided_by: uuid.UUID | None
    decided_at: dt.datetime | None
    reason: str | None
    decision_reason: str | None
    routed_to: list[uuid.UUID]
    undoes_id: uuid.UUID | None
    # An undone row reverses this change.
    undone: bool = False
    # The caller may accept or decline this proposal / undo this change now.
    can_decide: bool = False
    can_undo: bool = False


class SimpleItemFlags(BaseModel):
    item_id: uuid.UUID
    flags: list[SimpleFlag]


class SimpleChangeResult(BaseModel):
    change: SimpleChangeOut
    # S2's constraint checker on the touched items and their dependents, after the
    # change (for a proposal: as if it were applied).
    flags: list[SimpleItemFlags]


class SimpleChangeConflict(BaseModel):
    """The 409 detail: what the target holds now and who changed it last (null: not
    through Simple). Nothing was written."""

    message: str
    current: dict[str, Any]
    changed_by: SimplePersonRef | None
    changed_at: dt.datetime | None


class InboxSimpleChange(BaseModel):
    """A proposal waiting for me (``simple_proposals``) or a decision on my proposal
    (``simple_decisions``)."""

    id: uuid.UUID
    op: ChangeOp
    status: ChangeStatus
    item_id: uuid.UUID | None
    item_title: str | None
    document_id: uuid.UUID | None
    by: uuid.UUID
    by_name: str
    at: dt.datetime
    decided_by: uuid.UUID | None
    decided_at: dt.datetime | None
    reason: str | None
    decision_reason: str | None
    state: Literal["new", "open", "done"]
