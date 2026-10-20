import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DocumentStatus = Literal["draft", "in_review", "approved"]
# "oracle": Oracle's own baseline (a goal, decision, constraint or feature); its ``ref`` is
# free text naming the baseline item, not a link.
CitationSource = Literal[
    "slack", "notion", "gdocs", "github", "fireflies", "upload", "web", "oracle"
]
Verdict = Literal["approved", "changes_requested", "rejected"]
# O1f: brief sections make up the brief layer; the full layer is every section.
Layer = Literal["brief", "detail"]
BriefSource = Literal["draft", "template", "full_heading", "none"]
DocumentKind = Literal["prd", "roadmap"]


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


class VersionSource(BaseModel):
    """Provenance: the document version this version was built from (a roadmap's
    approved PRD version, O4b)."""

    document_id: uuid.UUID
    slug: str
    title: str
    kind: DocumentKind
    version: int
    version_id: uuid.UUID
    approved_at: datetime | None = None


class DocumentSummary(ORM):
    id: uuid.UUID
    slug: str
    title: str
    status: DocumentStatus
    kind: DocumentKind = "prd"
    template: str | None = None
    template_version: str | None = None
    theme: str | None = None
    latest_version: int | None = None
    # The latest approved version's number, if any (a PRD a roadmap can be built from).
    approved_version: int | None = None
    # Provenance of the latest version (roadmaps: the PRD version it came from).
    source: VersionSource | None = None
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
    # Provenance: the document version this one was built from, if any.
    source: VersionSource | None = None
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
    # What the writer computed for the citation: the source item it read (null when the
    # company has no such item), its confidence 0-1 and the low-confidence flag. With no
    # confidence, ``confidence_note`` says why ("owner decision, locked").
    item_id: uuid.UUID | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)
    confidence_note: str | None = None
    low_confidence: bool = False


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
    body_text: str = Field(
        description="Plain text of the body, citation markers removed. A table is one line "
        "per row (header first, no separator row), cells joined by ' | '; a literal '|' in "
        "a cell is '\\|'."
    )
    content_hash: str
    citation_keys: list[str] = []
    verdict: SectionVerdict | None = None
    layer: Layer = "detail"
    # Presenter notes: the section's fenced ``notes`` block only; guidance is never used
    # (O1g).
    notes: str | None = None


class DateMarkOut(BaseModel):
    """A date written in a roadmap's text, checked against its PRD's schedule bases now
    (O4 'document dates', oracle.roadmap.doc_dates). ``label`` is the marker shown next
    to the date (``unverified``, ``date withdrawn``); None for a verified date. The
    text itself is never rewritten."""

    section_key: str
    text: str
    date: date
    status: Literal["verified", "unverified", "withdrawn"]
    label: str | None = None
    # The references of the bases that support it (or, withdrawn, that did).
    bases: list[str] = []
    # Where it is written: the front matter title (``section_key`` is ""), a section's
    # heading or its body.
    where: Literal["title", "heading", "body"] = "body"


class VersionOut(VersionSummary):
    front_matter: dict[str, Any] = {}
    sections: list[SectionOut] = []
    citations: list[CitationOut] = []
    # Roadmaps only: each date its text writes, one per date and section.
    date_marks: list[DateMarkOut] = []


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
