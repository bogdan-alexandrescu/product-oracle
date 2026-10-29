"""The rituals API's shapes (``/v1/rituals``, ``/v1/ritual-occurrences``)."""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from oracle.rituals.schedule import RitualSchedule

RitualStatus = Literal["active", "paused"]
OccurrenceStatus = Literal["scheduled", "ready", "held", "skipped", "missed", "failed"]
SummaryState = Literal["none", "running", "ready", "failed", "not_started"]
SummaryMode = Literal["on_demand", "always"]


class RitualCreate(BaseModel):
    # "custom", or a built-in key the company does not have.
    kind: str = "custom"
    title: str = Field(min_length=1, max_length=120)
    # In the Company time zone: a ritual has no zone of its own (owner decision 2026-10-22).
    schedule: RitualSchedule | None = None
    duration_min: int | None = Field(None, ge=5, le=480)
    prep_hours: int | None = Field(None, ge=0, le=168)
    owner_id: uuid.UUID | None = None
    attendee_ids: list[uuid.UUID] = []


class RitualPatch(BaseModel):
    lock_version: int
    title: str | None = Field(None, min_length=1, max_length=120)
    schedule: RitualSchedule | None = None
    duration_min: int | None = Field(None, ge=5, le=480)
    prep_hours: int | None = Field(None, ge=0, le=168)
    owner_id: uuid.UUID | None = None
    attendee_ids: list[uuid.UUID] | None = None


class RitualOut(BaseModel):
    id: uuid.UUID
    kind: str
    title: str
    builtin: bool
    # The rule and ``timezone``, always the Company time zone.
    schedule: dict[str, Any]
    duration_min: int
    prep_hours: int
    owner_id: uuid.UUID
    attendee_ids: list[uuid.UUID]
    status: RitualStatus
    next_due_at: datetime | None
    lock_version: int
    # H5: "Weekly metrics review" on the goals check-in the review replaced (paused while
    # the review is active); null otherwise.
    replaced_by: str | None = None
    # The newest occurrence with a pre-read whose meeting time has come: Company › Rituals'
    # "Last pre-read".
    last_pre_read: "OccurrenceSummary | None" = None
    # The next meeting's occurrence when its pre-read is ready ahead of it (Prepare now, or
    # the ticker's lead time): Company › Rituals' Next links to it.
    next_pre_read: "OccurrenceSummary | None" = None


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


class OccurrenceDecision(BaseModel):
    """A decision recorded with an occurrence; ``href`` opens it on Company › Decisions."""

    id: uuid.UUID
    number: int
    title: str
    href: str


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
    # The decisions recorded with it: named on Mark held, or recorded from it (Record
    # decision: the occurrence is the decision's subject), in number order.
    decisions: list[OccurrenceDecision] = []
    summary_run_id: uuid.UUID | None
    summary: str | None
    summary_state: SummaryState
    summary_note: str | None
    # Whether Oracle writes this occurrence's summary now (H7: a competitive digest's is not
    # offered at H11 market Observe).
    summary_offered: bool = True
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
    # Its kind's run: $3.00 (ritual_summary), a metrics review's $1.50 (metrics_variance),
    # the competitive digest's $7.00.
    per_summary_usd: float = 3.0


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
