"""Request and response schemas of the module catalogue and composition routes."""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from oracle.modules.composer import (
    ComposedModule,
    CompositionProblem,
    KnowledgeState,
    OutlineEntry,
)
from oracle.modules.registry import ModulePolicySettings
from oracle.v2.contract import MODULE_ID_PATTERN, ModulePolicy
from oracle.v2.schemas import CompositionInputs, CompositionRevisionStatus, ModuleOrigin

ModuleKey = Field(pattern=MODULE_ID_PATTERN, max_length=100)


class ProblemsOut(BaseModel):
    """A refused request: every problem found, each with a stable code."""

    detail: str
    problems: list[CompositionProblem]


# --- catalogue --------------------------------------------------------------------------


class ModuleVersionSummary(BaseModel):
    version: str
    origin: ModuleOrigin
    contract_hash: str
    created_by: uuid.UUID | None = None
    created_at: datetime


class CatalogModuleOut(BaseModel):
    key: str
    title: str
    description: str | None = None
    builtin: bool
    archived: bool
    # The effective release (the newest; a company override when there is one).
    version: str
    origin: ModuleOrigin
    policy: ModulePolicy
    # Company module policy for it, if any: required, optional or disabled.
    company_policy: Literal["required", "optional", "disabled"] | None = None
    applies_to: list[str]
    depends_on: list[str]
    conflicts_with: list[str]
    section_ids: list[str]
    brief_layer: bool
    full_layer: bool
    required_review_role: str
    # A packaged release newer than the effective one, not applied because the company
    # overrode the module.
    upgrade_available: str | None = None
    versions: list[ModuleVersionSummary]


class CatalogModuleDetail(CatalogModuleOut):
    contract: dict[str, Any]


class ModuleContractIn(BaseModel):
    """A module contract (oracle.v2.contract.ModuleContract) as JSON."""

    contract: dict[str, Any]


class PackModuleOut(BaseModel):
    key: str
    title: str
    policy: ModulePolicy


class PackOut(BaseModel):
    id: str
    version: str
    title: str
    description: str
    categories: list[str]
    modules: list[PackModuleOut]


class ModulePolicyOut(ModulePolicySettings):
    is_default: bool
    updated_at: datetime | None = None


# --- template manifests -----------------------------------------------------------------


class ManifestModuleIn(BaseModel):
    module_key: str = ModuleKey
    section_ids: list[str] = Field(default=[], max_length=50)
    policy: ModulePolicy
    module_version: str | None = None
    display_order: int | None = Field(default=None, ge=0, le=10_000)


class ManifestIn(BaseModel):
    modules: list[ManifestModuleIn] = Field(min_length=1, max_length=200)


class ManifestModuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    module_key: str
    module_version: str | None = None
    policy: ModulePolicy
    display_order: int
    section_ids: list[str]
    # Mapped sections the template's latest version has, and those it does not.
    sections_present: list[str] = []
    sections_absent: list[str] = []
    created_by: uuid.UUID | None = None


class ManifestOut(BaseModel):
    template: str
    template_id: uuid.UUID
    template_version: int
    # A company edit (never replaced by a packaged manifest).
    edited: bool
    manifest_format: int
    modules: list[ManifestModuleOut]
    # Template sections no module claims: template-owned, preserved as-is.
    unmapped_sections: list[str]


# --- composition ------------------------------------------------------------------------


class ProvenanceIn(BaseModel):
    knowledge_state: KnowledgeState
    evidence_ids: list[str] = Field(default=[], max_length=100)
    source: str | None = Field(default=None, max_length=500)


class AdvisoryIn(BaseModel):
    """An advisory signal for a conditional module (AI analysis or a priority score)."""

    score: float = Field(ge=0, le=1)
    rationale: str = Field(min_length=1, max_length=1000)


class ChangesIn(BaseModel):
    add: list[str] = Field(default=[], max_length=100)
    remove: list[str] = Field(default=[], max_length=100)
    # Every included module, in the wanted order; omit to keep the computed order.
    order: list[str] | None = Field(default=None, max_length=300)


class ComposeIn(BaseModel):
    """What to compose from. Everything is optional; missing parts are derived from the
    document (its template, its latest composition) and the intake."""

    template: str | None = Field(default=None, max_length=200)
    template_version: int | None = Field(default=None, ge=1)
    packs: list[str] | None = Field(default=None, max_length=10)
    intake_id: uuid.UUID | None = None
    # Partial CompositionInputs: each root given here replaces the derived one.
    inputs: dict[str, Any] = {}
    # Where an input came from, by dotted path (e.g. "scope.capabilities").
    provenance: dict[str, ProvenanceIn] = Field(default={}, max_length=200)
    advisory: dict[str, AdvisoryIn] = Field(default={}, max_length=200)
    # Known field values by module, validated against each module's validators.
    field_values: dict[str, dict[str, Any]] = Field(default={}, max_length=200)
    changes: ChangesIn | None = None


class CompositionRecommendIn(ComposeIn):
    """Recommend for a document (id or slug), an intake, or neither (a template alone)."""

    document: str | None = Field(default=None, max_length=200)


class RevisionIn(ComposeIn):
    # The newest revision's number, the one the person started from (null before the
    # first): a stale number is a 409, never a silent overwrite.
    base_revision: int | None = None
    reason: str = Field(min_length=1, max_length=2000)
    # "working" saves a draft: it supersedes nothing and records no change event; only
    # "confirmed" puts a revision in force.
    status: Literal["confirmed", "working"] = "confirmed"


class PublishIn(BaseModel):
    # The approved document version number the composition is published with.
    version: int = Field(ge=1)


class CompositionSummary(BaseModel):
    mandatory: int
    suggested: int
    optional: int
    included: int
    excluded: int


class RecommendationOut(BaseModel):
    document_id: uuid.UUID | None = None
    intake_id: uuid.UUID | None = None
    template: str | None = None
    template_version: str | None = None
    packs: list[str]
    valid: bool
    summary: CompositionSummary
    modules: list[ComposedModule]
    problems: list[CompositionProblem]
    outline: list[OutlineEntry]
    inputs: CompositionInputs


class VersionChange(BaseModel):
    key: str
    before: str
    after: str


class RevisionDiff(BaseModel):
    added: list[str] = []
    removed: list[str] = []
    version_changed: list[VersionChange] = []
    reordered: bool = False
    # Added, removed or re-versioned modules: their sections' approvals are affected.
    material: bool = False
    affected_sections: list[str] = []


class RevisionSummary(BaseModel):
    id: uuid.UUID
    number: int
    status: CompositionRevisionStatus
    decided_by: uuid.UUID | None = None
    decided_at: datetime | None = None
    reason: str | None = None
    parent_number: int | None = None
    document_version_id: uuid.UUID | None = None
    diff: RevisionDiff


class InspectedModule(ComposedModule):
    # In the document's latest version: its sections that are there, and missing.
    sections_present: list[str] = []
    sections_missing: list[str] = []
    # The module's release history in the company, and a newer release if any.
    versions: list[ModuleVersionSummary] = []
    latest_version: str | None = None
    upgrade_available: str | None = None


class RevisionDetail(RevisionSummary):
    lock_version: int
    template: str | None = None
    template_version: str | None = None
    packs: list[str] = []
    inputs: CompositionInputs
    modules: list[InspectedModule]
    summary: CompositionSummary


class DocumentSectionsOut(BaseModel):
    version: int | None = None
    # Sections of the latest version no included module claims: preserved as-is.
    unmapped: list[str] = []


class InspectorOut(BaseModel):
    """Everything the composition inspector shows for one document (§4.5)."""

    document_id: uuid.UUID
    slug: str
    # True for a document with no composition yet (a legacy document): it reads,
    # reviews and exports exactly as before, and `recommendation` is a proposal.
    legacy: bool
    composition_id: uuid.UUID | None = None
    lock_version: int | None = None
    # The newest revision's number: the base_revision of the next one.
    head_revision: int | None = None
    # The confirmed (or published) revision in force.
    current: RevisionDetail | None = None
    # A working draft saved after it, if any: it changes nothing until confirmed.
    working: RevisionDetail | None = None
    recommendation: RecommendationOut | None = None
    revisions: list[RevisionSummary]
    sections: DocumentSectionsOut


__all__ = [
    "AdvisoryIn",
    "CatalogModuleDetail",
    "CatalogModuleOut",
    "ChangesIn",
    "ComposeIn",
    "CompositionSummary",
    "InspectedModule",
    "InspectorOut",
    "ManifestIn",
    "ManifestOut",
    "ModuleContractIn",
    "ModulePolicyOut",
    "ModuleVersionSummary",
    "PackOut",
    "ProblemsOut",
    "PublishIn",
    "CompositionRecommendIn",
    "RecommendationOut",
    "RevisionDetail",
    "RevisionDiff",
    "RevisionIn",
    "RevisionSummary",
]
