import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

DocumentStatus = Literal["draft", "in_review", "approved"]
CitationSource = Literal["slack", "notion", "gdocs", "github", "fireflies", "upload", "web"]
Verdict = Literal["approved", "changes_requested", "rejected"]
# O1f: brief sections make up the brief layer; the full layer is every section.
Layer = Literal["brief", "detail"]
BriefSource = Literal["draft", "template", "full_heading", "none"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class VersionWarning(BaseModel):
    """A non-fatal import finding stored on the version."""

    code: Literal["locked_section_changed"] | str
    message: str
    section_keys: list[str] = []


class ImportProblem(BaseModel):
    code: Literal["missing_section_id", "duplicate_section_id", "unknown_citation"] | str
    message: str
    section_key: str | None = None
    cite_key: str | None = None
    line: int | None = None


class ImportErrorResponse(BaseModel):
    """422 body when a draft cannot be imported. Lists every problem, not just the first."""

    detail: str
    errors: list[ImportProblem]


class DocumentSummary(ORM):
    id: uuid.UUID
    slug: str
    title: str
    status: DocumentStatus
    template: str | None = None
    template_version: str | None = None
    latest_version: int | None = None
    created_at: datetime
    updated_at: datetime


class VersionSummary(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    number: int
    content_hash: str
    snapshot: str | None = None
    warnings: list[VersionWarning] = []
    imported_by: uuid.UUID | None = None
    approved_at: datetime | None = None
    # Where the brief layer came from; "none": no brief, the version opens on the full
    # document.
    brief_source: BriefSource = "none"
    created_at: datetime


class DocumentOut(DocumentSummary):
    versions: list[VersionSummary] = []


class CitationOut(ORM):
    id: uuid.UUID
    cite_key: str
    source: CitationSource
    ref: str
    title: str | None = None
    excerpt: str | None = None
    retrieved_at: datetime | None = None


class SectionVerdict(ORM):
    """Latest verdict for a section in this version."""

    verdict: Verdict
    note: str | None = None
    reviewer_id: uuid.UUID | None = None
    created_at: datetime


class SectionOut(ORM):
    id: uuid.UUID
    section_key: str
    ordinal: int
    level: int
    heading: str
    body_md: str
    body_text: str
    content_hash: str
    citation_keys: list[str] = []
    verdict: SectionVerdict | None = None
    layer: Layer = "detail"
    # Presenter notes: the section's fenced ``notes`` block only; guidance is never used
    # (O1g).
    notes: str | None = None


class VersionOut(VersionSummary):
    front_matter: dict[str, Any] = {}
    sections: list[SectionOut] = []
    citations: list[CitationOut] = []


class WordOp(BaseModel):
    op: Literal["equal", "insert", "delete"]
    text: str


class SectionDiff(BaseModel):
    section_key: str
    # added / removed / changed / unchanged; "moved" is a separate flag because a
    # section can move and change at once.
    status: Literal["added", "removed", "changed", "unchanged"]
    moved: bool = False
    from_ordinal: int | None = None
    to_ordinal: int | None = None
    from_heading: str | None = None
    to_heading: str | None = None
    # The section's layer in each version (None where it does not exist).
    from_layer: Layer | None = None
    to_layer: Layer | None = None
    # Word-level ops over body_text (and heading); only for status == "changed".
    words: list[WordOp] | None = None


class DiffOut(BaseModel):
    document_id: uuid.UUID
    from_version: int
    to_version: int
    sections: list[SectionDiff]
