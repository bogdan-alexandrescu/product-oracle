"""Request and response models of the specs routes (``/v1/spec-requests``,
``/v1/design-artifacts``)."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from oracle.docs.schemas import VersionSource
from oracle.runs.schemas import KnobsIn
from oracle.trace.schemas import TraceOutput
from oracle.v2.schemas import (
    ArtifactKind,
    ArtifactRequestOut,
    ArtifactReviewEventOut,
    ArtifactVersionOut,
)

Depth = Literal["brief", "full"]
Part = Literal[
    "context",
    "product_requirement",
    "engineering_approach",
    "open_decision",
    "assumption",
    "proposed",
]
ApproachStatus = Literal["proposed", "approved"]
DesignReviewKind = Literal["comment", "approved", "changes_requested", "rejected"]


class SpecRequestCreate(BaseModel):
    # The approved PRD (slug or id) and its version; the latest approved one when omitted.
    prd: str = Field(min_length=1, max_length=200)
    prd_version: int | None = Field(default=None, ge=1)
    # The requirements the spec covers: baseline requirement entities (ids).
    requirement_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    # PRD sections the spec covers, besides those linked to the requirements.
    section_keys: list[str] = Field(default_factory=list, max_length=50)
    # A baseline feature the spec is for (titles the spec).
    feature_id: uuid.UUID | None = None
    # "brief": a technical brief; "full": a full engineering spec (§11.1).
    depth: Depth = "brief"
    # SVG user flows and 2-4 low-fidelity wireframes of key screens (O2, on by default).
    design: bool = True
    screens: int = Field(default=3, ge=2, le=4)
    # Who may approve the proposed engineering approach (approvers or owners). Empty: any
    # approver; an owner always may.
    engineering_approver_ids: list[uuid.UUID] = Field(default_factory=list, max_length=20)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    # The spec document's slug; "<prd>-<feature or requirement>-spec" when omitted.
    document: str | None = Field(default=None, min_length=1, max_length=200)
    knobs: KnobsIn = KnobsIn()


class RegenerateIn(BaseModel):
    # The approved PRD version to build from; the latest approved one when omitted.
    prd_version: int | None = Field(default=None, ge=1)
    # Why (shown to the agents and kept in the audit).
    reason: str | None = Field(default=None, max_length=2000)
    knobs: KnobsIn = KnobsIn()


class RequirementOut(BaseModel):
    id: uuid.UUID
    key: str | None = None
    title: str | None = None
    status: str | None = None
    # PRD sections of the source version that link it.
    section_keys: list[str] = []
    # The requirement no longer exists in the baseline.
    missing: bool = False


class SpecSectionOut(BaseModel):
    key: str
    heading: str
    layer: str
    part: Part
    # Only what Oracle locks is decided (E1): its own parts (product requirements, the
    # decided half of the acceptance criteria, sources). The summary, engineering approach,
    # open decisions and assumptions are decided once an engineering approver approves the
    # version. A section an edit added, and proposed acceptance criteria (part "proposed"),
    # are never decided.
    decided: bool
    # The state as the document view, exports and markdown show it.
    label: str
    # The acceptance criteria are listed as two parts with the same key: the half Oracle
    # wrote from the PRD ("decided") and the proposed half ("proposed"), when there is one.
    half: Literal["decided", "proposed"] | None = None
    # The template does not have the section: an edit added it.
    added: bool = False


class SpecVersionOut(BaseModel):
    artifact_version: ArtifactVersionOut
    document_version: int | None = None
    document_version_id: uuid.UUID | None = None
    approach_status: ApproachStatus
    approved_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    origin: str | None = None


class AnnotationOut(BaseModel):
    id: str
    target: str
    note: str
    section_key: str | None = None
    requirement_ids: list[uuid.UUID] = []
    # Review events on this annotation, oldest first.
    reviews: list[ArtifactReviewEventOut] = []


class DesignOutputOut(BaseModel):
    name: str
    title: str | None = None
    screen: str | None = None
    media_type: str
    size_bytes: int
    sha256: str
    section_keys: list[str] = []
    requirement_ids: list[uuid.UUID] = []
    annotations: list[AnnotationOut] = []
    # What the sanitiser dropped (harmless markup outside the allowlist).
    removed: list[str] = []
    # GET this path for the file (served static, sandboxed, no network).
    content_url: str


class DesignArtifactOut(BaseModel):
    request_id: uuid.UUID
    kind: ArtifactKind
    title: str
    version: ArtifactVersionOut
    outputs: list[DesignOutputOut]
    # Review events on the version as a whole (not on an annotation), oldest first.
    reviews: list[ArtifactReviewEventOut] = []
    # The version's dependencies and why any is stale (oracle.trace).
    lineage: TraceOutput | None = None


class SpecSummary(BaseModel):
    request: ArtifactRequestOut
    document_slug: str | None = None
    document_id: uuid.UUID | None = None
    prd: VersionSource | None = None
    depth: Depth
    latest_version: int | None = None
    approach_status: ApproachStatus | None = None
    freshness: str | None = None


class SpecOut(SpecSummary):
    requirements: list[RequirementOut]
    section_keys: list[str]
    engineering_approver_ids: list[uuid.UUID] = []
    code_capability_map: Literal["used", "unavailable"]
    versions: list[SpecVersionOut]
    # The latest spec version's sections, with the part each belongs to.
    sections: list[SpecSectionOut] = []
    design: list[DesignArtifactOut] = []
    # Spec, flow and wireframe versions that are not fresh, with their reasons.
    stale: list[TraceOutput] = []
    run_id: uuid.UUID | None = None
    run_status: str | None = None


class SpecRequestCreated(BaseModel):
    spec: SpecOut
    run_id: uuid.UUID


class RegenerationOut(BaseModel):
    """A proposed regeneration: a draft run nobody has started. Estimate and start it like
    any run (the >$50 approval and the 1.5x pause apply); it writes new versions for review,
    and the current ones stay until a reviewer approves the new ones."""

    request_id: uuid.UUID
    run_id: uuid.UUID
    prd_version: int
    section_keys: list[str]
    dropped_section_keys: list[str] = []
    reasons: list[str] = []


class DesignReviewIn(BaseModel):
    kind: DesignReviewKind
    body: str | None = Field(default=None, max_length=5000)
    # An annotation of one of the version's outputs: the review is about it.
    output: str | None = Field(default=None, max_length=80)
    annotation_id: str | None = Field(default=None, max_length=40)


class DesignReviewOut(BaseModel):
    event: ArtifactReviewEventOut
    version: ArtifactVersionOut
