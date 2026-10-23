"""The rituals API's shapes (``/v1/rituals``, ``/v1/ritual-occurrences``)."""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from oracle.rituals.schedule import Schedule

RitualStatus = Literal["active", "paused"]
OccurrenceStatus = Literal["scheduled", "ready", "held", "skipped", "missed", "failed"]
SummaryState = Literal["none", "running", "ready", "failed", "not_started"]
SummaryMode = Literal["on_demand", "always"]


class RitualCreate(BaseModel):
    # "custom", or a built-in key the company does not have.
    kind: str = "custom"
    title: str = Field(min_length=1, max_length=120)
    schedule: Schedule | None = None
    duration_min: int | None = Field(None, ge=5, le=480)
    prep_hours: int | None = Field(None, ge=0, le=168)
    owner_id: uuid.UUID | None = None
    attendee_ids: list[uuid.UUID] = []


class RitualPatch(BaseModel):
    lock_version: int
    title: str | None = Field(None, min_length=1, max_length=120)
    schedule: Schedule | None = None
    duration_min: int | None = Field(None, ge=5, le=480)
    prep_hours: int | None = Field(None, ge=0, le=168)
    owner_id: uuid.UUID | None = None
    attendee_ids: list[uuid.UUID] | None = None


class RitualOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    builtin: bool
    schedule: dict[str, Any]
    duration_min: int
    prep_hours: int
    owner_id: uuid.UUID
    attendee_ids: list[uuid.UUID]
    status: RitualStatus
    next_due_at: datetime | None
    lock_version: int
    # The newest occurrence with a pre-read: Company › Rituals' "Last pre-read".
    last_pre_read: "OccurrenceSummary | None" = None


class Period(BaseModel):
    from_: datetime | None = Field(None, alias="from", serialization_alias="from")
    to: datetime | None = None

    model_config = {"populate_by_name": True}


class OccurrenceSummary(BaseModel):
    id: uuid.UUID
    ritual_id: uuid.UUID
    due_at: datetime
    ends_at: datetime
    status: OccurrenceStatus


class PreRead(BaseModel):
    built_at: datetime | None = None
    blocks: list[dict[str, Any]] = []


class OccurrenceOut(BaseModel):
    id: uuid.UUID
    ritual_id: uuid.UUID
    kind: str
    title: str
    due_at: datetime
    ends_at: datetime
    duration_min: int
    owner_id: uuid.UUID
    attendee_ids: list[uuid.UUID]
    timezone: str
    status: OccurrenceStatus
    period: Period
    pre_read: PreRead
    attempts: int
    error: str | None
    notes: str | None
    skip_reason: str | None
    decision_ids: list[uuid.UUID]
    summary_run_id: uuid.UUID | None
    summary: str | None
    summary_state: SummaryState
    summary_note: str | None
    read_by_me: bool


class HeldIn(BaseModel):
    notes: str = Field("", max_length=10_000)
    decision_ids: list[uuid.UUID] = []


class SkipIn(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


class EstimateRitual(BaseModel):
    ritual_id: uuid.UUID
    title: str
    runs_per_month: float


class Estimate(BaseModel):
    per_summary_usd: float
    runs_per_month: float
    usd_per_month: float
    rituals: list[EstimateRitual]


class SummarySettingsIn(BaseModel):
    mode: SummaryMode


class SummarySettingsOut(BaseModel):
    mode: SummaryMode
    estimate: Estimate


class InboxRitual(BaseModel):
    """A ritual row of the Inbox: Pre-read ready (owner and attendees, until opened),
    Record notes (the ritual's owner, after the end) and Ritual failed to prepare
    (owners). ``counts``: in needs_me and the badge."""

    occurrence_id: uuid.UUID
    ritual_id: uuid.UUID
    title: str
    due_at: datetime
    reason: Literal["pre_read", "record_notes", "failed"]
    state: Literal["new", "open", "done"]
    counts: bool


RitualOut.model_rebuild()
