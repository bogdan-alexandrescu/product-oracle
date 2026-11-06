import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

from oracle.docs.schemas import DocumentKind
from oracle.runs.schemas import Flow


class Rebuild(BaseModel):
    """The rebuild sign (owner's pick A): a run that will make a new version of a document,
    as the chip beside its version pill says it (``oracle.rebuilds.service``)."""

    run_id: uuid.UUID
    flow: Flow
    flow_title: str
    document_slug: str
    document_title: str | None = None
    document_kind: DocumentKind | None = None
    # A run writing a new document (Baseline to PRD making a new PRD): no version of it
    # exists yet, so there is no page to open; the sign names it as a new PRD and links the run.
    new_document: bool = False
    # prd_to_roadmap: the PRD it reads (its sign lists the run beside the PRD's own runs).
    source_slug: str | None = None
    # scheduled: not started yet; waiting: at a stop on a person; done: its new version
    # landed and is not approved yet.
    state: Literal["scheduled", "running", "waiting", "failed", "done"]
    # The steps it runs, by their titles, and the one it is on (1-based; failed: where it
    # stopped; done: the last).
    steps: list[str]
    step: int
    # The version everyone reads until the new one is approved (None: none approved yet),
    # and the version the run makes (done: made).
    from_version: int | None = None
    to_version: int
    # Who started it (their name, else their email), and when.
    started_by: str | None = None
    started_at: datetime | None = None
    # When a scheduled run is set to start, if it says.
    scheduled_for: datetime | None = None
    # A running run's time left, from how long the flow's steps took before; None unknown.
    minutes_left: int | None = None
    # Running or scheduled: its next stop, who decides it and what they do there.
    next_stop: str | None = None
    next_stop_who: str | None = None
    next_stop_action: str | None = None
    # Waiting: on whom, and what they do ("review the new draft").
    waits_on: str | None = None
    waits_on_action: str | None = None
    review_link: str | None = None
    error: str | None = None


class CompanyRoadmapRebuilds(BaseModel):
    """The company roadmap every PRD feeds: a PRD's rebuild changes it too."""

    slug: str
    title: str
    prds: int


class RebuildsOut(BaseModel):
    rebuilds: list[Rebuild]
    company_roadmap: CompanyRoadmapRebuilds | None = None
