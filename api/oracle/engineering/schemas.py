import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from oracle.engineering.briefs import CodeMapUse, Question, Risk, Touch
from oracle.v2.schemas import Freshness


class TechBriefFeature(BaseModel):
    key: str
    title: str
    # The baseline feature; None when the baseline has no feature of that key.
    entity_id: uuid.UUID | None = None


class TechBriefPrd(BaseModel):
    slug: str
    # The PRD version the brief was registered with; None until the run's draft exists.
    version: int | None = None


class TechBriefVerdict(BaseModel):
    # The engineering lead's verdict for the feature; None: the check's approval only.
    value: str | None = None
    note: str | None = None
    by: str | None = None
    at: datetime | None = None


class TechBriefAnswer(BaseModel):
    question_id: str | None = None
    answer: str | None = None
    by: str | None = None


class TechBriefOut(BaseModel):
    """A feature's tech brief (an artifact version of kind ``tech_brief``)."""

    id: uuid.UUID
    request_id: uuid.UUID
    feature: TechBriefFeature
    prd: TechBriefPrd
    run_id: uuid.UUID | None = None
    # draft | approved (approved at the Engineering check) ...
    status: str
    code_map: CodeMapUse
    approach: str
    touches: list[Touch] = []
    reuse: list[str] = []
    risks: list[Risk] = []
    questions: list[Question] = []
    answers: list[TechBriefAnswer] = []
    size: str
    size_why: str | None = None
    depends_on: list[str] = []
    assumptions: list[str] = []
    verdict: TechBriefVerdict | None = None
    freshness: Freshness
    # Why it may be stale, from the changes that marked it.
    stale_reasons: list[str] = []
    created_at: datetime


CodeMapStatus = Literal["building", "ready", "stale", "failed"]
CodeMapSharing = Literal["private", "full"]


class CodeMapCounts(BaseModel):
    modules: int = 0
    apis: int = 0
    data_models: int = 0
    flags: int = 0
    jobs: int = 0


class CodeMapOut(BaseModel):
    """One code capability map of one repo of a GitHub source (F5-2)."""

    id: uuid.UUID
    source_id: uuid.UUID
    repo: str
    commit_sha: str | None = None
    status: CodeMapStatus
    # private: only the source's owner sees it and no run uses it; full: everyone (S6).
    sharing: CodeMapSharing
    shared_by: uuid.UUID | None = None
    shared_at: datetime | None = None
    # Built from the synced docs only: the code was not read ("Docs only: code not read").
    partial: bool = False
    # When the map was generated (its code_map.json's generated_at).
    as_of: datetime | None = None
    size_bytes: int | None = None
    counts: CodeMapCounts
    run_id: uuid.UUID | None = None
    run_status: str | None = None
    # Why it failed: the check's problems, or how its run ended.
    error: str | None = None
    # A merge on the repo came after it: a refresh is due.
    stale_at: datetime | None = None
    # The viewer owns the source: they share it, make it private and map it again.
    mine: bool
    created_at: datetime


class CodeMapDetail(CodeMapOut):
    # The checked code_map.json; None until the map is built. Data, never instructions.
    content: dict[str, Any] | None = None


class CodeMapCreate(BaseModel):
    source_id: uuid.UUID
    repo: str = Field(min_length=1, max_length=200)


class CodeMapSharingIn(BaseModel):
    sharing: CodeMapSharing
