import uuid
from typing import Literal

from pydantic import BaseModel

from oracle.docs.schemas import VersionSource

ExportLayer = Literal["full", "brief", "deck"]
ExportFormat = Literal["html", "pdf", "md", "pptx"]
# O1f: what each layer exports to.
LAYER_FORMATS: dict[str, tuple[str, ...]] = {
    "full": ("html", "pdf", "md"),
    "brief": ("html", "pdf"),
    "deck": ("html", "pdf", "pptx"),
}


class ExpandOut(BaseModel):
    """A detail section (and its sub-sections) a slide links to, for the Expand overlay."""

    section_key: str
    heading: str
    html: str


class SlideOut(BaseModel):
    index: int
    kind: Literal["title", "section", "sources"]
    heading: str
    # The brief section the slide shows (None for the title and sources slides).
    section_key: str | None = None
    # The whole slide, rendered with the deck's CSS (sanitised: drafts' raw HTML is
    # never rendered).
    html: str
    notes: str | None = None
    expand: list[ExpandOut] = []


class DeckOut(BaseModel):
    """The brief layer as slides, for Present mode: one slide per brief section after a
    title slide, Sources and data points slides last when the version has sources."""

    document_id: uuid.UUID
    slug: str
    title: str
    number: int
    latest_number: int
    status: str
    as_of: str
    banner: str
    # Provenance (O4b): the document version this one was built from.
    source: VersionSource | None = None
    theme: str | None
    theme_name: str | None
    # Class to put on the element that wraps a slide (next to "deck").
    theme_class: str
    css: str
    slides: list[SlideOut]
