import uuid
from datetime import date, datetime
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, model_validator

from oracle import wording
from oracle.roadmap.schemas import DraftRoadmapSummary

DocumentStatus = Literal["draft", "in_review", "approved"]
# "oracle": Oracle's own baseline (a goal, decision, constraint or feature); its ``ref`` is
# free text naming the baseline item, not a link.
CitationSource = Literal[
    "slack", "notion", "gdocs", "github", "fireflies", "upload", "web", "oracle"
]
# A citation's confidence (owner, 2026-10-20): a number from 0 to 1, or none. The import
# (oracle.docs.parser.CitationIn), the API (CitationOut), the contract agents read and the
# database's check (migration 0019_citation_confidence) keep these bounds.
CONFIDENCE_MIN = 0
CONFIDENCE_MAX = 1
CONFIDENCE_RANGE = f"a number from {CONFIDENCE_MIN} to {CONFIDENCE_MAX}"


def citation_contract() -> str:
    """The citation contract as agents read it (draft prompts, push_draft), its sources
    generated from :data:`CitationSource` and its confidence bounds from
    :data:`CONFIDENCE_MIN` and :data:`CONFIDENCE_MAX`, so they cannot drift."""
    sources = ", ".join(get_args(CitationSource))
    return (
        "Citation contract: citations are a list under citations in the YAML front matter; "
        f"each has id, source (one of: {sources}), ref (a URL to the item; for oracle, the "
        'baseline item\'s kind and key, e.g. "baseline decision <key>"), title, excerpt and '
        "retrieved_at (when you read it, ISO 8601), and may have item (the id of the source "
        f"item you read), confidence ({CONFIDENCE_RANGE}: how much the evidence counts; "
        "null when there is no score, with confidence_note saying why) and low_confidence "
        "(true when the confidence is under the company's low threshold). Every [c:id] chip "
        "in the body must match a citation's id. Oracle refuses a draft with any other "
        f"source, a confidence outside {CONFIDENCE_MIN} to {CONFIDENCE_MAX}, a ref with "
        "a scheme other than http, https or urn (for oracle, one that names no baseline "
        "item of the company), or a chip that matches no id."
    )


# Where a text built at import (a flow's task, an MCP tool's description) states the
# citation contract: filled in when the text is read (:func:`with_citation_contract`).
CITATION_CONTRACT_MARK = "{citation_contract}"


def with_citation_contract(text: str) -> str:
    """``text`` with the citation contract where it has :data:`CITATION_CONTRACT_MARK`."""
    if CITATION_CONTRACT_MARK not in text:
        return text
    return text.replace(CITATION_CONTRACT_MARK, citation_contract())


Verdict = Literal["approved", "changes_requested", "rejected"]
# O1f: brief sections make up the brief layer; the full layer is every section.
Layer = Literal["brief", "detail"]
BriefSource = Literal["draft", "template", "full_heading", "none"]
DocumentKind = Literal["prd", "roadmap", "spec", "vision", "strategy", "update", "pricing"]
DocumentVisibility = Literal["company", "approvers"]
# O5: who a roadmap rendering is for (oracle.roadmap.variants).
Audience = Literal["board", "team", "engineering", "public"]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class VersionWarning(BaseModel):
    """A non-fatal import finding stored on the version."""

    code: Literal["locked_section_changed"] | str
    # What a person reads, in the app's words (#396: its builder writes them; the wording
    # stored before #396 is read through oracle.wording.legacy); the ids are in ``refs``
    # and ``section_keys``.
    message: str
    section_keys: list[str] = []
    # The ids agents and the API need (a date's text and PRD slug, a citation's key and
    # source item, the feedback left open), never shown to a person.
    refs: dict[str, str | list[str]] = {}

    @model_validator(mode="after")
    def _stored_before_396(self) -> "VersionWarning":
        message, refs = wording.legacy(self.message)
        if refs or message != self.message:
            self.message, self.refs = message, {**refs, **self.refs}
        return self


class ImportProblem(BaseModel):
    code: Literal["missing_section_id", "duplicate_section_id", "unknown_citation"] | str
    message: str
    section_key: str | None = None
    cite_key: str | None = None
    line: int | None = None
    # The ids agents and the API need (#396), when the message is one a person reads.
    refs: dict[str, str | list[str]] = {}


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


class UpdatePeriod(BaseModel):
    """The period an update covers (its latest version's front matter ``period``)."""

    model_config = ConfigDict(populate_by_name=True)

    from_: date = Field(alias="from")
    to: date


class DocumentSummary(ORM):
    id: uuid.UUID
    slug: str
    title: str
    status: DocumentStatus
    kind: DocumentKind = "prd"
    template: str | None = None
    template_version: str | None = None
    theme: str | None = None
    # H8: "approvers": owners and approvers only (an update, unless an owner opened it).
    visibility: DocumentVisibility = "company"
    # O5: a roadmap's default audience (the picker's variant); a roadmap without one
    # reads as "team". None for every other kind.
    audience: Audience | None = None
    # H8: an update's period, from its latest version's front matter.
    period: UpdatePeriod | None = None
    latest_version: int | None = None
    # The latest approved version's number, if any (a PRD a roadmap can be built from).
    approved_version: int | None = None
    # Provenance of the latest version (roadmaps: the PRD version it came from).
    source: VersionSource | None = None
    created_at: datetime
    updated_at: datetime

    @model_validator(mode="after")
    def _default_audience(self) -> "DocumentSummary":
        if self.kind != "roadmap":
            self.audience = None
        elif self.audience is None:
            self.audience = "team"
        return self


class VersionSummary(ORM):
    id: uuid.UUID
    document_id: uuid.UUID
    number: int
    content_hash: str
    snapshot: str | None = None
    warnings: list[VersionWarning] = []
    # How the version came in, e.g. base_version_missing: imported without a base
    # version, so nothing checked that it keeps the changes made since.
    notes: list[VersionWarning] = []
    # The member or API token id; a run's draft has the id of the person it acted for.
    imported_by: uuid.UUID | None = None
    # Who imported it, as people read it (#256): the member's display name, "Oracle" for
    # a run's draft, or "API token <its name>". None when the importer is gone.
    imported_by_name: str | None = None
    # A run's refused draft an owner imported again (owner, 2026-10-25): "imported again by
    # <retrier> on 2026-10-25 14:59 PDT", in the Company time zone, as the audit records it.
    # The version stays the run creator's (``imported_by``).
    imported_again: str | None = None
    approved_at: datetime | None = None
    # Where the brief layer came from; "none": no brief, the version opens on the full
    # document.
    brief_source: BriefSource = "none"
    # Provenance: the document version this one was built from, if any.
    source: VersionSource | None = None
    created_at: datetime


class DocumentOut(DocumentSummary):
    versions: list[VersionSummary] = []
    # Simple S3b (#723): changes waiting in the document's working draft and its open
    # Simple proposals, as a count (the "changes in review" banner; no details).
    changes_in_review: int = 0


class CitationOut(ORM):
    id: uuid.UUID
    cite_key: str
    source: CitationSource
    ref: str
    title: str | None = None
    excerpt: str | None = None
    retrieved_at: datetime | None = None
    # E1 (owner, 2026-10-20): a citation an edit added to a spec version. Listed under
    # 'Added sources' with ``state_label`` ('Proposed · added in an edit'), never in
    # Oracle's Sources.
    added: bool = False
    state_label: str | None = None
    # What the writer computed for the citation: the source item it read (null when the
    # company has no such item), its confidence 0-1 and the low-confidence flag. With no
    # confidence, ``confidence_note`` says why ("owner decision, locked").
    item_id: uuid.UUID | None = None
    confidence: float | None = Field(default=None, ge=CONFIDENCE_MIN, le=CONFIDENCE_MAX)
    confidence_note: str | None = None
    low_confidence: bool = False


class SectionVerdict(ORM):
    """Latest verdict for a section in this version."""

    verdict: Verdict
    note: str | None = None
    reviewer_id: uuid.UUID | None = None
    created_at: datetime
    # Set when an approval lapsed for good (C2: its approver was demoted or removed, its
    # API token or OAuth grant revoked): it no longer counts, and never will again.
    lapsed_at: datetime | None = None
    lapse_reason: str | None = None


class SpecPartState(BaseModel):
    """E1: the decided/proposed state of a part of a spec version's section, as the
    document view shows it (the exports and the markdown show the same label)."""

    label: str
    decided: bool
    # The template does not have the section: an edit added it ("Proposed · added in an
    # edit").
    added: bool = False
    # The acceptance criteria have two: the half Oracle wrote ("decided") and the proposed
    # half ("proposed"), which starts at the paragraph ``starts_at``.
    half: Literal["decided", "proposed"] | None = None
    starts_at: str | None = None


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
    # The review revision: the text, the citation entries it cites and its layer. Send
    # it as ``base_revision`` when saving the section.
    revision: str | None = None
    citation_keys: list[str] = []
    verdict: SectionVerdict | None = None
    layer: Layer = "detail"
    # Presenter notes: the section's fenced ``notes`` block only; guidance is never used
    # (O1g).
    notes: str | None = None
    # Spec versions only (E1): each part's state, in order; empty for other documents and
    # for a spec's title and "Full version" heading.
    spec_states: list[SpecPartState] = []


class ApprovalLapse(BaseModel):
    """A version approval that lapsed for good (C2), kept after a new approval."""

    approved_at: datetime | None = None
    approved_by: uuid.UUID | None = None
    approved_token_id: uuid.UUID | None = None
    approved_grant_id: uuid.UUID | None = None
    lapsed_at: datetime
    reason: str | None = None


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
    # Every approval of this version that lapsed, oldest first.
    approval_lapses: list[ApprovalLapse] = []
    front_matter: dict[str, Any] = {}
    sections: list[SectionOut] = []
    citations: list[CitationOut] = []
    # Roadmaps only: each date its text writes, one per date and section.
    date_marks: list[DateMarkOut] = []
    # PRDs only (E1): the version's items-only roadmap, for the Roadmap tab's label.
    draft_roadmap: DraftRoadmapSummary | None = None


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
    # E1: a spec section's states in the newer version (the older one for a removed
    # section): an added section shows 'Proposed · added in an edit' in the diff too.
    spec_states: list[SpecPartState] = []


class DiffOut(BaseModel):
    document_id: uuid.UUID
    from_version: int
    to_version: int
    sections: list[SectionDiff]


class VisibilityIn(BaseModel):
    """An owner's switch of who sees a document, with the reason (audited)."""

    model_config = ConfigDict(str_strip_whitespace=True)

    visibility: DocumentVisibility
    reason: str = Field(min_length=1, max_length=2000)


class DraftNewItems(BaseModel):
    """S4: "N new items since draft k, refresh?". What changed in the draft's author's own
    sources since the sources the draft was written from (its run's pin, or the moment it
    was imported when no run made it). Sources are private (S5): anyone but the author gets
    ``visible: false`` with neither ``as_of`` nor ``count``."""

    version: int
    # When the sources were read for this draft.
    as_of: datetime | None = None
    # Items new, changed or deleted since then.
    count: int | None = None
    visible: bool = False
