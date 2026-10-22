"""Interview payloads: the members' routes (``InterviewOut``) and the customer's
(``PublicInterview``, ``PublicInterviewTurn``), which carry nothing of the company but its name."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Status = Literal["draft", "invited", "in_progress", "finished", "expired", "revoked"]
Kind = Literal["team", "customer"]

NAME_MAX = 120
TOPIC_MAX = 300
PROMPT_MAX = 300
INTRO_MAX = 300
GUIDE_MAX = 8
MESSAGE_MAX = 2000

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=NAME_MAX)]
Prompt = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=PROMPT_MAX)
]
Intro = Annotated[str, StringConstraints(strip_whitespace=True, max_length=INTRO_MAX)]


class InterviewSubject(BaseModel):
    """What the interview is about: exactly one of an intake, a request theme or a topic."""

    model_config = ConfigDict(extra="forbid")

    intake_id: uuid.UUID | None = None
    theme_id: uuid.UUID | None = None
    topic: (
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=TOPIC_MAX)]
        | None
    ) = None

    @model_validator(mode="after")
    def _one(self) -> "InterviewSubject":
        given = [v for v in (self.intake_id, self.theme_id, self.topic) if v is not None]
        if len(given) != 1:
            raise ValueError("subject: give exactly one of intake_id, theme_id or topic")
        return self


class InterviewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["customer"] = "customer"
    interviewee_name: Name
    interviewee_company: Name | None = None
    subject: InterviewSubject


class InterviewGuideItemIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Annotated[str, StringConstraints(max_length=64)] | None = None
    prompt: Prompt
    purpose: (
        Annotated[str, StringConstraints(strip_whitespace=True, max_length=PROMPT_MAX)] | None
    ) = None


class InterviewPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lock_version: int
    intro: Intro | None = None
    guide: Annotated[list[InterviewGuideItemIn], Field(max_length=GUIDE_MAX)] | None = None
    interviewee_name: Name | None = None
    interviewee_company: Name | None = None


class InterviewGuideItem(BaseModel):
    id: str
    prompt: str
    purpose: str | None = None


class InterviewJobState(BaseModel):
    id: uuid.UUID
    status: str
    error: str | None = None


class InterviewMessageOut(BaseModel):
    id: uuid.UUID
    role: Literal["oracle", "interviewee"]
    kind: str
    body: str
    guide_item: str | None = None
    created_at: datetime


class InterviewOut(BaseModel):
    id: uuid.UUID
    kind: Kind
    status: Status
    title: str
    intake_id: uuid.UUID | None = None
    theme_id: uuid.UUID | None = None
    topic: str | None = None
    intro: str | None = None
    guide: list[InterviewGuideItem]
    guide_job: InterviewJobState | None = None
    interviewee_name: str | None = None
    interviewee_company: str | None = None
    link_expires_at: datetime | None = None
    link_opened_at: datetime | None = None
    created_by: uuid.UUID
    created_by_name: str | None = None
    created_at: datetime
    finished_at: datetime | None = None
    lock_version: int
    messages: list[InterviewMessageOut]
    # InterviewSnapshot: quick_facts, quotes, needs, insights; {} until written.
    snapshot: dict[str, Any]
    snapshot_job: InterviewJobState | None = None
    # The requests its snapshot created.
    request_ids: list[uuid.UUID]
    # The caller may edit, link or withdraw it (its creator or an approver).
    can_manage: bool


class InterviewSummary(BaseModel):
    id: uuid.UUID
    kind: Kind
    status: Status
    title: str
    interviewee_name: str | None = None
    interviewee_company: str | None = None
    created_by: uuid.UUID
    created_by_name: str | None = None
    created_at: datetime
    finished_at: datetime | None = None
    request_count: int


class InterviewLinkOut(BaseModel):
    """The private link, shown once."""

    url: str
    expires_at: datetime


# --- the customer's routes --------------------------------------------------------------


class PublicInterviewMessage(BaseModel):
    role: Literal["oracle", "customer"]
    body: str
    at: datetime


class PublicInterviewProgress(BaseModel):
    asked: int
    total: int


class PublicInterview(BaseModel):
    company: str
    interviewee_name: str
    intro: str
    status: Literal["invited", "in_progress", "finished"]
    messages: list[PublicInterviewMessage]
    progress: PublicInterviewProgress


class PublicInterviewTurn(BaseModel):
    messages: list[PublicInterviewMessage]
    progress: PublicInterviewProgress
    done: bool


class PublicInterviewMessageIn(BaseModel):
    body: str


class PublicInterviewDone(BaseModel):
    done: bool


class PublicInterviewRefusal(BaseModel):
    reason: Literal["used", "expired", "withdrawn"]
