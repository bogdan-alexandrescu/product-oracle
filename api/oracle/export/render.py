"""Render a stored version as HTML (Jinja2 template) or as markdown with a banner.

Without a theme, citations ``[c:<id>]`` become numbered footnote references. Numbers
follow the order of first use in the document; citations that are defined but never
used are listed after the used ones so nothing in the front matter is dropped.

With a theme (the document's, else its template version's suggested theme, else the
company default for its kind) the export follows O1c: the body renders without
citation markers, and the ``Sources and data points`` section becomes an appendix in
smaller type, grouped by section, under an as-of / version / approval header. The
theme's tokens become CSS variables and its CSS comes last.

O1f: an export is of the full layer (every section, as before) or of the brief layer
(the version's brief sections, then the Sources and data points appendix). In a brief
export, links to detail sections that are not in it keep their text and lose the
link. The deck (oracle.export.deck) is built from the brief layer too.

O4b: links to another document's version (``/documents/<slug>/v/<n>#<section>``, a
roadmap's links to its PRD) become absolute URLs to that section in the app, and a
version built from another one (a roadmap from its PRD version) says so in its banner.
"""

import re
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime
from functools import cache
from pathlib import Path
from urllib.parse import urlsplit

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markdown_it import MarkdownIt
from markdown_it.rules_inline import StateInline
from markupsafe import Markup, escape
from sqlalchemy import func, inspect, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from oracle import company_time, safe_yaml
from oracle.branding import Brand, load_brand
from oracle.config import get_settings
from oracle.docs import layers
from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.docs.parser import strip_citations
from oracle.docs.schemas import VersionSource
from oracle.swarm.settings import get_runtime_settings
from oracle.templates.models import Template, TemplateVersion, Theme

HERE = Path(__file__).resolve().parent
TEMPLATES = HERE / "templates"
STATIC = HERE / "static"

# [c:c1] or [c:c1, c2]
_CITE = re.compile(r"\[c:\s*([A-Za-z0-9_.:\-]+(?:\s*,\s*[A-Za-z0-9_.:\-]+)*)\s*\]")
# Parsers normally strip the id from the heading; this guards against one that does not.
_HEADING_ID = re.compile(r"(?<!\s)\s*\{#[^}]*\}\s*$")


class NotFound(LookupError):
    pass


class NoBrief(ValueError):
    """A brief or deck export of a version that has no brief sections."""


LAYER_LABEL = {"full": "Full", "brief": "Brief", "deck": "Deck"}


@dataclass
class ExportVersion:
    """Everything an export needs, loaded once from the database."""

    document: Document
    version: DocumentVersion
    sections: list[Section]
    citations: list[Citation]
    latest_number: int
    theme: Theme | None = None
    # How the theme was chosen: "document", "template" or "company_default".
    theme_source: str | None = None
    template_name: str | None = None
    # O1f: "full" (every section), "brief" or "deck" (brief sections + the appendix).
    layer: str = "full"
    # Every section of the version, whatever the layer (the deck expands detail).
    all_sections: list[Section] = field(default_factory=list)
    # Provenance (O4b): the document version this one was built from.
    source: VersionSource | None = None
    # v2 (§7, §16.9): each section's internal claim-to-source links, for the appendix
    # only ({"key", "links": [{"claim", "label", "kind", "confidence"}]}).
    evidence_links: list[dict] = field(default_factory=list)
    # The markdown the export serves, when it is not the stored one (a spec's, labelled).
    markdown: str | None = None
    # E1: a spec version's states by section key (oracle.specs.contract.PartState), shown
    # as elements no body can produce, and the citations an edit added (Added sources).
    spec_states: dict[str, list] = field(default_factory=dict)
    added_citations: set[str] = field(default_factory=set)

    @property
    def added_label(self) -> str | None:
        """The state label of the Added sources list (a spec's only)."""
        if not self.added_citations:
            return None
        from oracle.specs.contract import ADDED_LABEL

        return ADDED_LABEL

    # A roadmap (O4 'document dates'): the sections as stored, and the dates marked now
    # (unverified, withdrawn) that ``sections`` carry a marker after.
    stored_sections: list[Section] = field(default_factory=list)
    date_marks: list = field(default_factory=list)
    # The Company time zone the export's dates are shown in (#463).
    zone: str = company_time.DEFAULT_ZONE
    # O5: the company's branding (oracle.branding.Brand): the header's logo and the accent.
    brand: Brand | None = None

    @property
    def title(self) -> str:
        """The document's title, with the marker after a flagged date it writes (when it
        is this version's title)."""
        from oracle.roadmap import doc_dates

        title = self.document.title
        mine = [m for m in self.date_marks if m.where == "title"]
        if mine and title == doc_dates.version_title(self.version):
            return doc_dates.annotate(title, mine).replace("**", "")
        return title

    @property
    def source_label(self) -> str | None:
        """ "From <PRD title> v<n>" for a version built from another document's."""
        if self.source is None:
            return None
        return f"From {self.source.title} v{self.source.version}"

    @property
    def source_url(self) -> str | None:
        if self.source is None:
            return None
        return app_url(f"/documents/{self.source.slug}/v/{self.source.version}")

    @property
    def status(self) -> str:
        """Status of this version (not the document): approved, superseded, or the
        document's status for the latest version."""
        if self.version.approved_at is not None:
            return "approved"
        if self.version.number < self.latest_number:
            return "superseded"
        return self.document.status

    @property
    def date(self) -> datetime:
        return self.version.approved_at or self.version.created_at

    @property
    def filename_stem(self) -> str:
        slug = re.sub(r"[^A-Za-z0-9._-]+", "-", self.document.slug).strip("-") or "document"
        suffix = "" if self.layer == "full" else f"-{self.layer}"
        return f"{slug}-v{self.version.number}{suffix}"

    @property
    def layer_label(self) -> str:
        return LAYER_LABEL.get(self.layer, self.layer)


def sources_keys(sections: list[Section]) -> set[str]:
    """The Sources and data points section and its sub-sections."""
    out: set[str] = set()
    level = None
    for s in sections:
        if s.section_key == SOURCES_KEY:
            level = s.level
            out.add(s.section_key)
        elif level is not None:
            if s.level <= level:
                break
            out.add(s.section_key)
    return out


def detached(ev: ExportVersion) -> ExportVersion:
    """``ev`` with copies of its rows that no session holds: what a render on the export
    pool reads, so the request can end its transaction first (no database connection held
    while it waits for the pool) and a render that outlives its request never reads an
    expired row. Each copy carries the row's columns; a row read twice is copied once."""
    copies: dict[int, object] = {}

    def copy(row):
        if row is None:
            return None
        key = id(row)
        if key not in copies:
            mapper = inspect(row).mapper
            copies[key] = mapper.class_(**{a.key: getattr(row, a.key) for a in mapper.column_attrs})
        return copies[key]

    return replace(
        ev,
        document=copy(ev.document),
        version=copy(ev.version),
        sections=[copy(s) for s in ev.sections],
        citations=[copy(c) for c in ev.citations],
        theme=copy(ev.theme),
        all_sections=[copy(s) for s in ev.all_sections],
        stored_sections=[copy(s) for s in ev.stored_sections],
    )


def apply_layer(ev: ExportVersion, layer: str) -> ExportVersion:
    """Restrict the export to a layer. Raises NoBrief for a version without a brief."""
    ev.layer = layer
    if layer == "full":
        return ev
    brief = [s for s in ev.all_sections if s.layer == layers.BRIEF]
    if not brief:
        raise NoBrief(
            f"version {ev.version.number} of '{ev.document.slug}' has no brief sections; "
            "export the full document instead"
        )
    appendix = sources_keys(ev.all_sections)
    ev.sections = [
        s for s in ev.all_sections if s.layer == layers.BRIEF or s.section_key in appendix
    ]
    return ev


_SECTION_LINK = re.compile(r'<a href="#([^"]+)">(.*?)</a>', re.S)
# A theme that makes the version header a running element repeats it on every PDF page.
_POSITION_RUNNING = re.compile(r"position\s*:\s*running\s*\(", re.IGNORECASE)
_BRACE_OR_END = re.compile(r"[{};]")
# The repeated header sits in the page's top margin, so its title and source are capped.
HEADER_TEXT_MAX = 90


def _without_comments(css: str) -> str:
    out, i = [], 0
    while (start := css.find("/*", i)) != -1:
        out.append(css[i:start])
        end = css.find("*/", start + 2)
        if end == -1:
            return "".join(out)
        i = end + 2
    out.append(css[i:])
    return "".join(out)


def running_header(css: str | None) -> bool:
    """True when a ``.doc-header`` rule of the theme's CSS sets ``position: running(...)``.

    One pass over the braces, so any CSS a caller sends is read in linear time: only the
    declarations of rules with no nested block are searched, and those never overlap.
    """
    css = _without_comments(css or "")
    frames: list[list] = []  # [selector, body start, has a nested block]
    selector_start = 0
    for m in _BRACE_OR_END.finditer(css):
        ch = m.group()
        if ch == "{":
            if frames:
                frames[-1][2] = True
            frames.append([css[selector_start : m.start()], m.end(), False])
            selector_start = m.end()
        elif ch == "}":
            if frames:
                selector, body_start, nested = frames.pop()
                if (
                    not nested
                    and any(part.strip() == ".doc-header" for part in selector.split(","))
                    and _POSITION_RUNNING.search(css, body_start, m.start())
                ):
                    return True
            selector_start = m.end()
        elif not frames:
            selector_start = m.end()
    return False


def _cap(text: str, limit: int) -> str:
    """``text`` cut at a word boundary to at most ``limit`` characters, with an ellipsis."""
    if len(text) <= limit:
        return text
    cut = text[: max(1, limit - 1)]
    if " " in cut[limit // 2 :]:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(" ,;:-") + "…"


def _header_source(source: VersionSource | None) -> str | None:
    """The "From <PRD title> v<n>" label with only the title capped, so v<n> survives."""
    if source is None:
        return None
    suffix = f" v{source.version}"
    return f"From {_cap(source.title, HEADER_TEXT_MAX - len('From ') - len(suffix))}{suffix}"


# A link to another document's version in rendered HTML, with its optional section.
_DOC_LINK = re.compile(r'href="(/documents/[A-Za-z0-9][A-Za-z0-9_.-]*/v/\d+)(?:#([^"]*))?"')


def app_url(path: str) -> str:
    base = get_settings().app_url or get_runtime_settings().public_url
    return base.rstrip("/") + path


def absolute_doc_links(html: str) -> str:
    """Links to another document's version open that version in the app, at the
    section (the app's section anchors are ``s-<id>``)."""

    def sub(m: re.Match[str]) -> str:
        fragment = f"#s-{m.group(2)}" if m.group(2) else ""
        return f'href="{escape(app_url(m.group(1)))}{fragment}"'

    return _DOC_LINK.sub(sub, html)


def unlink_missing(html: str, present: set[str]) -> str:
    """Links to sections that are not in this export keep their text, lose the link."""

    def sub(m: re.Match[str]) -> str:
        if m.group(1) in present or m.group(1).startswith(("src-", "fn-", "ref-")):
            return m.group(0)
        return f'<span class="detail-ref" data-section-ref="{m.group(1)}">{m.group(2)}</span>'

    return _SECTION_LINK.sub(sub, html)


async def load_export_version(db: AsyncSession, doc: str, n: int) -> ExportVersion:
    """Look up ``doc`` (slug or id) and version number ``n``; raise NotFound."""
    match = Document.slug == doc
    try:
        match = or_(match, Document.id == uuid.UUID(doc))
    except ValueError:
        pass
    document = await db.scalar(select(Document).where(match))
    if document is None:
        raise NotFound("Document not found")
    version = await db.scalar(
        select(DocumentVersion)
        .where(DocumentVersion.document_id == document.id, DocumentVersion.number == n)
        .options(selectinload(DocumentVersion.sections), selectinload(DocumentVersion.citations))
    )
    if version is None:
        raise NotFound("Version not found")
    latest = await db.scalar(
        select(func.max(DocumentVersion.number)).where(DocumentVersion.document_id == document.id)
    )
    stored = sorted(version.sections, key=lambda s: s.ordinal)
    ordered, marks = stored, []
    if document.kind in ("roadmap", "update"):
        ordered, marks = await _marked_dates(db, version, stored)
    ev = ExportVersion(
        document=document,
        version=version,
        sections=list(ordered),
        citations=list(version.citations),
        latest_number=latest or version.number,
        all_sections=ordered,
        stored_sections=stored,
        date_marks=marks,
        zone=await company_time.company_time_zone(db),
        brand=await load_brand(db),
    )
    if version.source_version_id is not None:
        from oracle.docs.service import version_sources

        sources = await version_sources(db, [version.source_version_id])
        ev.source = sources.get(version.source_version_id)
    from oracle.trace.evidence import appendix_links

    ev.evidence_links = await appendix_links(db, version)
    if document.kind == "spec":
        await _label_spec(db, ev)
    await _resolve_theme(db, ev)
    return ev


async def _label_spec(db: AsyncSession, ev: ExportVersion) -> None:
    """E1: every export of a spec version (HTML, PDF, slides, PPTX, markdown) shows each
    part's decided/proposed state, 'Proposed · added in an edit' on a section an edit
    added, and the citations an edit added in their own Added sources list. The HTML,
    PDF and slides render each label as an element a body can not produce (bodies render
    without raw HTML), never as body markdown; the markdown carries it as a line."""
    from oracle.specs import contract, lineage

    approved = await lineage.approach_approved(db, ev.version)
    oracle = await lineage.oracle_citation_keys(db, ev.version)
    keys = contract.keys_of(ev.version.front_matter)
    ev.spec_states = {
        s.section_key: contract.part_states(s.section_key, s.body_md or "", approved, keys)
        for s in ev.all_sections
        if s.section_key not in contract.UNLABELLED
    }
    ev.added_citations = {
        c.cite_key for c in ev.citations if oracle is None or c.cite_key not in oracle
    }
    # Off the event loop: the version's text is an edit's (oracle.safe_yaml).
    ev.markdown = await safe_yaml.run_parse(
        contract.label_markdown, ev.version.markdown, approved, oracle
    )


def state_html(state) -> str:
    """A spec part's state label as an export shows it: a classed element of its own."""
    kind = "added" if state.added else ("decided" if state.decided else "proposed")
    return (
        f'<p class="spec-state spec-state-{kind}" data-spec-state="{kind}">'
        f"{escape(state.label)}</p>"
    )


def section_body_html(ev: ExportVersion, key: str, text: str, render) -> str:
    """A section's body rendered by ``render`` (markdown -> HTML, without raw HTML), with
    a spec's state labels inserted as elements: at the top and, for the acceptance
    criteria, before the proposed half."""
    states = ev.spec_states.get(key)
    if not states:
        return render(text)
    if len(states) > 1:
        from oracle.specs.contract import ACCEPTANCE_PROPOSED_LABEL, split_acceptance

        decided, proposed = split_acceptance(text)
        return (
            state_html(states[0])
            + render(decided)
            + state_html(states[1])
            + render(f"{ACCEPTANCE_PROPOSED_LABEL}\n\n{proposed or ''}")
        )
    return state_html(states[0]) + render(text)


async def _marked_dates(
    db: AsyncSession, version: DocumentVersion, sections: list[Section]
) -> tuple[list[Section], list]:
    """A roadmap's sections with the marker after each date that rests on no verified
    basis now (``[unverified]``, ``[date withdrawn]``, O4 'document dates'), at the exact
    span the date check found, and those flagged dates. Unsaved copies: the stored,
    approved text is never changed."""
    from oracle.roadmap import doc_dates

    marks = doc_dates.flagged(await doc_dates.occurrences_for_version(db, version, sections))
    if not marks:
        return sections, []
    by_section: dict[tuple[str, str], list] = {}
    for m in marks:
        by_section.setdefault((m.section_key, m.where), []).append(m)
    out = []
    for s in sections:
        heads = by_section.get((s.section_key, "heading"))
        bodies = by_section.get((s.section_key, "body"))
        if not heads and not bodies:
            out.append(s)
            continue
        out.append(
            Section(
                id=s.id,
                version_id=s.version_id,
                section_key=s.section_key,
                ordinal=s.ordinal,
                level=s.level,
                heading=doc_dates.annotate(s.heading, heads or []),
                body_md=doc_dates.annotate(s.body_md, bodies or []),
                body_text=s.body_text,
                content_hash=s.content_hash,
                citation_keys=list(s.citation_keys or []),
                layer=s.layer,
            )
        )
    return out, marks


async def _resolve_theme(db: AsyncSession, ev: ExportVersion) -> None:
    """Document theme, else the template version's suggested theme, else the company
    default for the document's kind, else the built-in default theme for the kind
    (clean-document for PRDs, roadmap-board for roadmaps). Archived themes and templates
    still resolve."""
    from oracle.templates.builtins import DEFAULT_THEME_FOR_KIND
    from oracle.templates.service import company_draft_defaults, version_meta

    document = ev.document
    candidates: list[tuple[str, str | None]] = [("document", document.theme)]
    if document.template:
        template = await db.scalar(select(Template).where(Template.key == document.template))
        if template is not None:
            ev.template_name = template.name
            tv = None
            if document.template_version and document.template_version.isdigit():
                tv = await db.scalar(
                    select(TemplateVersion).where(
                        TemplateVersion.template_id == template.id,
                        TemplateVersion.version == int(document.template_version),
                    )
                )
            if tv is not None:
                candidates.append(("template", version_meta(tv.body).suggested_theme))
    defaults = await company_draft_defaults(db)
    candidates.append(("company_default", (defaults.get(document.kind) or {}).get("theme")))
    for source, key in candidates:
        if not key:
            continue
        theme = await db.scalar(select(Theme).where(Theme.key == key))
        if theme is not None:
            ev.theme, ev.theme_source = theme, source
            return
    # Nothing chosen: the built-in default theme (seeded at startup and company creation;
    # an export reads, it never seeds).
    key = DEFAULT_THEME_FOR_KIND.get(document.kind, DEFAULT_THEME_FOR_KIND["prd"])
    theme = await db.scalar(select(Theme).where(Theme.key == key))
    if theme is not None:
        ev.theme, ev.theme_source = theme, "builtin_default"


# --- markdown -> HTML with citation footnotes -------------------------------------


@dataclass
class _Footnotes:
    by_key: dict[str, Citation]
    numbers: dict[str, int] = field(default_factory=dict)
    ref_counts: dict[str, int] = field(default_factory=dict)

    def reference(self, key: str) -> tuple[int, str] | None:
        """Number and anchor id for one more use of ``key``; None if unknown."""
        if key not in self.by_key:
            return None
        number = self.numbers.setdefault(key, len(self.numbers) + 1)
        count = self.ref_counts.get(key, 0) + 1
        self.ref_counts[key] = count
        return number, f"ref-{number}-{count}"


def _citation_rule(state: StateInline, silent: bool) -> bool:
    if not state.src.startswith("[c:", state.pos):
        return False
    m = _CITE.match(state.src, state.pos)
    if m is None:
        return False
    if not silent:
        token = state.push("citation", "", 0)
        token.meta = {"keys": [k.strip() for k in m.group(1).split(",")], "raw": m.group(0)}
    state.pos = m.end()
    return True


def _render_citation(renderer, tokens, idx, options, env) -> str:
    notes: _Footnotes = env["footnotes"]
    links = []
    missing = []
    for key in tokens[idx].meta["keys"]:
        ref = notes.reference(key)
        if ref is None:
            missing.append(key)
            continue
        number, anchor = ref
        links.append(f'<a href="#fn-{number}" id="{anchor}">{number}</a>')
    html = f'<sup class="cite">[{", ".join(links)}]</sup>' if links else ""
    if missing:
        raw = escape(f"[c:{', '.join(missing)}]")
        html += f'<span class="cite cite-missing">{raw}</span>'
    return html


# Owner decision (2026-10-20): an image loads only when Oracle stores it, a path of this
# app under STORED_IMAGES. One a browser could read as another host ('/\evil.com', a
# control character) or that leaves the prefix (a dot segment, '%2e%2e') is not one.
STORED_IMAGES = "/uploads/"
_URL_UNSAFE = re.compile(r"[\\\x00-\x20\x7f-\x9f]")
_DOT_SEGMENT = re.compile(r"(?:^|/)(?:\.|%2e){1,2}(?:/|$)", re.I)


def stored_image(src: str) -> bool:
    """``src`` is an image Oracle stores: a path under :data:`STORED_IMAGES`, with no
    backslash, control character, space or dot segment."""
    if not src.startswith(STORED_IMAGES) or _URL_UNSAFE.search(src):
        return False
    parts = urlsplit(src)
    return not (parts.scheme or parts.netloc or _DOT_SEGMENT.search(parts.path))


def image_label(src: str, alt: str) -> tuple[str, str | None]:
    """How an image that does not load shows (owner decision, 2026-10-20): its alt text and
    the host of an http(s) URL ('chart (example.com)'), with the URL to link; just its alt
    text, with nothing to link, for anything else."""
    parts = urlsplit(src)
    if parts.scheme in ("http", "https") and parts.hostname and not _URL_UNSAFE.search(src):
        return (f"{alt} ({parts.hostname})" if alt else parts.hostname), src
    return alt, None


def _render_image(self, tokens, idx, options, env) -> str:
    """A stored image as an image with its alt text; any other as :func:`image_label`: an
    export's reader never contacts an outside host. Plain strings: a ``Markup`` here would
    escape the HTML rendered around it."""
    tok = tokens[idx]
    src = str(tok.attrGet("src") or "")
    alt = self.renderInlineAsText(tok.children or [], options, env)
    if stored_image(src):
        return f'<img src="{escape(src)}" alt="{escape(alt)}">'
    label, href = image_label(src, alt)
    if href is None:
        return str(escape(label))
    return f'<a href="{escape(href)}" rel="noopener noreferrer">{escape(label)}</a>'


@cache
def _markdown() -> MarkdownIt:
    # Raw HTML in drafts is not rendered: exports are shared, drafts are agent-written.
    md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
    md.inline.ruler.before("link", "citation", _citation_rule)
    md.add_render_rule("citation", _render_citation)
    md.add_render_rule("image", _render_image)
    return md


def _safe_href(ref: str | None) -> str | None:
    if not ref:
        return None
    return ref if urlsplit(ref).scheme in ("http", "https") else None


def _format_dt(value: datetime | None, zone: str) -> str:
    """A moment in the Company time zone with its short name (#463)."""
    return company_time.stamp(value, zone) if value is not None else ""


@dataclass
class RenderedSection:
    key: str
    level: int
    heading: Markup
    body: Markup


@dataclass
class RenderedFootnote:
    number: int
    key: str
    source: str
    title: str
    ref: str
    href: str | None
    excerpt: str | None
    retrieved_at: str
    backref: str | None


def build_context(ev: ExportVersion) -> dict:
    md = _markdown()
    notes = _Footnotes(by_key={c.cite_key: c for c in ev.citations})
    sections = []
    present = {s.section_key for s in ev.sections}
    for s in ev.sections:
        # One env per section: markdown-it keeps link reference definitions in it, and a
        # definition in one section must not turn text in another into a link.
        env = {"footnotes": notes}
        heading = _HEADING_ID.sub("", s.heading)
        sections.append(
            RenderedSection(
                key=s.section_key,
                level=min(max(s.level, 1), 6),
                heading=Markup(md.renderInline(heading, env)),
                # Guidance comments and presenter notes are never exported.
                body=Markup(
                    absolute_doc_links(
                        unlink_missing(
                            section_body_html(
                                ev,
                                s.section_key,
                                layers.slide_body(s.body_md),
                                lambda text, env=env: md.render(text, env),
                            ),
                            present,
                        )
                    )
                ),
            )
        )
    # Unused citations go last, in front-matter order.
    for c in ev.citations:
        notes.numbers.setdefault(c.cite_key, len(notes.numbers) + 1)
    footnotes = []
    for key, number in sorted(notes.numbers.items(), key=lambda kv: kv[1]):
        c = notes.by_key[key]
        footnotes.append(
            RenderedFootnote(
                number=number,
                key=key,
                source=c.source,
                title=c.title or c.ref,
                ref=c.ref,
                href=_safe_href(c.ref),
                excerpt=c.excerpt,
                retrieved_at=_format_dt(c.retrieved_at, ev.zone),
                backref=f"ref-{number}-1" if notes.ref_counts.get(key) else None,
            )
        )
    headings = {r.key: r.heading for r in sections}
    v = ev.version
    return {
        # E1: a spec's citations added in an edit, listed apart from Oracle's Sources.
        "added_footnotes": [f for f in footnotes if f.key in ev.added_citations],
        "added_label": ev.added_label,
        "title": ev.title,
        "slug": ev.document.slug,
        "number": v.number,
        "status": ev.status,
        "date": _format_dt(ev.date, ev.zone),
        "imported_at": _format_dt(v.created_at, ev.zone),
        "approved_at": _format_dt(v.approved_at, ev.zone),
        "snapshot": v.snapshot,
        "has_title_section": any(s.level == 1 for s in ev.sections),
        "sections": sections,
        "footnotes": [f for f in footnotes if f.key not in ev.added_citations],
        "evidence_links": [
            {"key": e["key"], "heading": headings[e["key"]], "links": e["links"]}
            for e in ev.evidence_links
            if e["key"] in headings
        ],
        "css": Markup(stylesheet()),
        **brand_context(ev),
        "layer": ev.layer,
        "layer_label": ev.layer_label,
        "source_label": ev.source_label,
        "source_url": ev.source_url,
    }


def brand_context(ev: ExportVersion, accent: bool = True) -> dict:
    """The header partial (O5): the logo as the one ``data:`` image an export holds, the
    company's name, and (``accent``) the brand's accent over the stylesheet's."""
    from oracle.branding import BRAND_CSS, accent_css, render_brand_header

    return {
        "brand_header": render_brand_header(ev.brand),
        "brand_css": Markup(BRAND_CSS) if ev.brand is not None else Markup(""),
        "accent_css": accent_css(ev.brand) if accent else Markup(""),
    }


@cache
def stylesheet() -> str:
    return (STATIC / "prd.css").read_text(encoding="utf-8")


@cache
def _jinja() -> Environment:
    return Environment(
        loader=FileSystemLoader(TEMPLATES),
        autoescape=select_autoescape(["html", "j2"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )


def render_html(ev: ExportVersion) -> str:
    """A self-contained HTML page (stylesheet inlined), also the input for the PDF."""
    if ev.theme is not None:
        return render_themed_html(ev)
    return _jinja().get_template("prd.html.j2").render(**build_context(ev))


# --- themed export (O1c) ----------------------------------------------------------

SOURCES_KEY = "sources"
# A roadmap's machine-readable layout block is for the renderer, not the reader.
HIDDEN_ROADMAP_SECTIONS = {"layout"}
NO_GOAL_PHRASE = "serves no confirmed goal"
_REQ_ID = re.compile(r"(<(?:li|td)>(?:<p>)?)(R\d{1,4})\b")
_PASS_FAIL = re.compile(r"<td>\s*(pass(?:ed)?|fail(?:ed)?|\u2713|\u2717)\s*</td>", re.IGNORECASE)


def _strip_citation(renderer, tokens, idx, options, env) -> str:
    return ""


def _link_citation(renderer, tokens, idx, options, env) -> str:
    numbers: dict[str, int] = env["numbers"]
    links = [
        f'<a href="#src-{numbers[k]}">{numbers[k]}</a>'
        for k in tokens[idx].meta["keys"]
        if k in numbers
    ]
    return f'<span class="src-refs">[{", ".join(links)}]</span>' if links else ""


@cache
def _themed_markdown(link: bool) -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
    md.inline.ruler.before("link", "citation", _citation_rule)
    md.add_render_rule("citation", _link_citation if link else _strip_citation)
    md.add_render_rule("image", _render_image)
    return md


def _decorate(html: str) -> str:
    """Requirement id badges and pass/fail table cells."""
    html = _REQ_ID.sub(r'\1<span class="req-id">\2</span>', html)

    def cell(m: re.Match[str]) -> str:
        word = m.group(1).lower()
        cls = "cell-pass" if word.startswith("pass") or word == "\u2713" else "cell-fail"
        return f'<td class="{cls}">{escape(m.group(1))}</td>'

    return _PASS_FAIL.sub(cell, html)


@dataclass
class ThemedSection:
    key: str
    level: int
    heading: Markup
    body: Markup
    flagged: bool = False
    children: list["ThemedSection"] = field(default_factory=list)


def token_css(tokens: dict) -> str:
    """Theme tokens as an @page rule and CSS custom properties.

    Tokens are validated on save (hex colours, plain font stacks, numeric spacing,
    known page sizes), so they are safe to write into CSS here.
    """
    spacing = tokens.get("spacing") or {}
    page = tokens.get("page") or {}
    size = page.get("size", "A4")
    orientation = page.get("orientation", "portrait")
    margin = spacing.get("page_margin_mm", 20)
    return f"@page {{ size: {size} {orientation}; margin: {margin}mm; }}\n" + token_vars(tokens)


def token_vars(tokens: dict, selector: str = ":root") -> str:
    """Theme tokens as CSS custom properties on ``selector``."""
    fonts = tokens.get("fonts") or {}
    colors = tokens.get("colors") or {}
    spacing = tokens.get("spacing") or {}
    margin = spacing.get("page_margin_mm", 20)
    lines = [f"{selector} {{"]
    for name in ("body", "heading", "mono"):
        if fonts.get(name):
            lines.append(f"  --font-{name}: {fonts[name]};")
    for name, value in colors.items():
        lines.append(f"  --color-{re.sub(r'[^a-z0-9-]', '', name.lower())}: {value};")
    if "base_size_pt" in spacing:
        lines.append(f"  --size-base: {spacing['base_size_pt']}pt;")
    if "line_height" in spacing:
        lines.append(f"  --line-height: {spacing['line_height']};")
    if "section_gap_rem" in spacing:
        lines.append(f"  --section-gap: {spacing['section_gap_rem']}rem;")
    lines.append(f"  --page-margin: {margin}mm;")
    lines.append("}")
    return "\n".join(lines)


@cache
def themed_stylesheet() -> str:
    return (STATIC / "themed.css").read_text(encoding="utf-8")


def build_themed_context(ev: ExportVersion) -> dict:
    theme = ev.theme
    assert theme is not None
    # O5: the brand's accent replaces the theme's (checked when an owner saves it).
    tokens = ev.brand.apply_accent(theme.tokens) if ev.brand is not None else theme.tokens or {}
    features = tokens.get("features") or {}
    hidden = HIDDEN_ROADMAP_SECTIONS if ev.document.kind == "roadmap" else set()

    # Split the body from the Sources and data points section (and its sub-sections).
    body: list[Section] = []
    sources: list[Section] = []
    in_sources = False
    sources_level = 0
    for s in ev.sections:
        if s.section_key == SOURCES_KEY:
            in_sources, sources_level = True, s.level
        elif in_sources and s.level <= sources_level:
            in_sources = False
        if s.section_key in hidden:
            continue
        (sources if in_sources else body).append(s)

    # Citation numbers: order of first use anywhere, then front-matter order.
    by_key = {c.cite_key: c for c in ev.citations}
    numbers: dict[str, int] = {}
    for s in [*body, *sources]:
        for key in s.citation_keys or []:
            if key in by_key:
                numbers.setdefault(key, len(numbers) + 1)
    for c in ev.citations:
        numbers.setdefault(c.cite_key, len(numbers) + 1)

    plain, linked = _themed_markdown(False), _themed_markdown(True)
    present = {s.section_key for s in ev.sections} | {"sources"}

    def render(s: Section, md: MarkdownIt) -> ThemedSection:
        # One env per section, so a link reference definition stays in its section.
        env = {"numbers": numbers}
        heading = _HEADING_ID.sub("", s.heading)
        return ThemedSection(
            key=s.section_key,
            level=min(max(s.level, 1), 6),
            heading=Markup(md.renderInline(heading, env)),
            body=Markup(
                absolute_doc_links(
                    unlink_missing(
                        _decorate(
                            section_body_html(
                                ev,
                                s.section_key,
                                _body_md(s, md is plain),
                                lambda text: md.render(text, env),
                            )
                        ),
                        present,
                    )
                )
            ),
            # Roadmap items (cards) that say they serve no confirmed goal get the flag.
            flagged=ev.document.kind == "roadmap"
            and s.level == 3
            and NO_GOAL_PHRASE in layers.strip_comments(s.body_md or "").lower(),
        )

    def _body_md(s: Section, strip: bool) -> str:
        # Guidance comments and presenter notes are never exported.
        text = layers.slide_body(s.body_md or "")
        # O1c: the body renders without citation markers (and the space before them).
        return strip_citations(text) if strip else text

    rendered = [render(s, plain) for s in body]
    # Group each level-2 section with the level-3 sections under it (cards on a board).
    groups: list[ThemedSection] = []
    for r in rendered:
        if r.level >= 3 and groups and groups[-1].level == 2:
            groups[-1].children.append(r)
        else:
            groups.append(r)

    has_title_section = any(s.level == 1 for s in body)
    toc = [
        {"key": r.key, "level": r.level, "heading": r.heading}
        for r in rendered
        if r.level == 2 or (r.level == 3 and not features.get("legend"))
    ]
    sources_rendered = [render(s, linked) for s in sources]
    if sources_rendered and sources_rendered[0].key == SOURCES_KEY:
        sources_heading = sources_rendered[0].heading
        sources_intro = sources_rendered[0].body
        sources_parts = sources_rendered[1:]
    else:
        sources_heading, sources_intro, sources_parts = Markup("Sources and data points"), None, []

    # Evidence by section, from the citation markers each section carried.
    headings = {r.key: r.heading for r in rendered}
    by_section = []
    for s in body:
        # Oracle's Sources list only Oracle's citations; added ones have their own list.
        keys = [k for k in s.citation_keys or [] if k in by_key and k not in ev.added_citations]
        if keys:
            by_section.append(
                {
                    "key": s.section_key,
                    "heading": headings.get(s.section_key, s.section_key),
                    "sources": [
                        {"number": numbers[k], "title": by_key[k].title or by_key[k].ref}
                        for k in keys
                    ],
                }
            )
    # Evidence links by section (O1c: listed here, never in the body).
    evidence_links = [
        {"key": e["key"], "heading": headings[e["key"]], "links": e["links"]}
        for e in ev.evidence_links
        if e["key"] in headings
    ]
    source_list = [
        RenderedFootnote(
            number=number,
            key=key,
            source=by_key[key].source,
            title=by_key[key].title or by_key[key].ref,
            ref=by_key[key].ref,
            href=_safe_href(by_key[key].ref),
            excerpt=by_key[key].excerpt,
            retrieved_at=_format_dt(by_key[key].retrieved_at, ev.zone),
            backref=None,
        )
        for key, number in sorted(numbers.items(), key=lambda kv: kv[1])
    ]
    added_source_list = [f for f in source_list if f.key in ev.added_citations]
    source_list = [f for f in source_list if f.key not in ev.added_citations]

    v = ev.version
    body_classes = [
        f"theme-{re.sub(r'[^a-z0-9-]', '', theme.key)}",
        f"kind-{ev.document.kind}",
        f"orientation-{(tokens.get('page') or {}).get('orientation', 'portrait')}",
    ]
    if features.get("toc"):
        body_classes.append("has-toc")
    if features.get("numbered_headings"):
        body_classes.append("numbered")
    if features.get("appendix_break"):
        body_classes.append("appendix-break")
    running = running_header(theme.css)
    return {
        "title": ev.title,
        "slug": ev.document.slug,
        "kind": ev.document.kind,
        "number": v.number,
        "latest_number": ev.latest_number,
        "status": ev.status,
        "as_of": v.snapshot or _format_dt(ev.date, ev.zone),
        "imported_at": _format_dt(v.created_at, ev.zone),
        "approved_at": _format_dt(v.approved_at, ev.zone),
        "snapshot": v.snapshot,
        "template": ev.document.template,
        "template_name": ev.template_name,
        "template_version": ev.document.template_version,
        "theme_key": theme.key,
        "theme_name": theme.name,
        "body_class": " ".join(body_classes),
        "toc": toc if features.get("toc") else [],
        "status_header": bool(features.get("status_header")),
        "legend": bool(features.get("legend")),
        "page_fit": features.get("page_fit"),
        "has_title_section": has_title_section,
        "groups": groups,
        "sources_heading": sources_heading,
        "sources_intro": sources_intro,
        "sources_parts": sources_parts,
        "by_section": by_section,
        "evidence_links": evidence_links,
        "source_list": source_list,
        "added_source_list": added_source_list,
        "added_label": ev.added_label,
        "css": Markup(themed_stylesheet()),
        "token_css": Markup(token_css(tokens)),
        **brand_context(ev, accent=False),
        "theme_css": Markup(theme.css or ""),
        # The theme repeats the header on every PDF page: themed.css keeps it short enough
        # for the page's top margin (stored theme copies included, so it lives here).
        "running_header": running,
        "header_title": _cap(ev.title, HEADER_TEXT_MAX) if running else None,
        "header_source_label": _header_source(ev.source) if running else None,
        "layer": ev.layer,
        "layer_label": ev.layer_label,
        "source_label": ev.source_label,
        "source_url": ev.source_url,
    }


def render_themed_html(ev: ExportVersion) -> str:
    return _jinja().get_template("themed.html.j2").render(**build_themed_context(ev))


# --- markdown export --------------------------------------------------------------


def banner_line(ev: ExportVersion) -> str:
    parts = [
        f"{ev.document.title} ({ev.document.slug})",
        f"version {ev.version.number}",
        f"status {ev.status}",
        f"imported {_format_dt(ev.version.created_at, ev.zone)}",
    ]
    if ev.layer != "full":
        parts.insert(2, ev.layer_label.lower())
    if ev.version.approved_at is not None:
        parts.append(f"approved {_format_dt(ev.version.approved_at, ev.zone)}")
    if ev.source is not None:
        parts.append(f"from {ev.source.title} ({ev.source.slug}) version {ev.source.version}")
    # "--" would end the HTML comment early.
    return "Product Oracle export: " + " · ".join(parts).replace("--", "- -")


def render_markdown(ev: ExportVersion) -> str:  # full layer only
    """The stored markdown with a banner comment.

    The comment goes after the YAML front matter (front matter must stay first), so
    the export can still be re-imported. A roadmap's flagged dates carry an HTML comment
    after each (``<!-- oracle: date unverified -->``), which the import drops.
    """
    from oracle.roadmap import doc_dates

    banner = f"<!-- {banner_line(ev)} -->\n"
    markdown = (
        ev.markdown
        if ev.markdown is not None
        else doc_dates.annotate_markdown(
            ev.version.markdown, ev.stored_sections or ev.sections, ev.date_marks
        )
    )
    if markdown.startswith("---"):
        m = re.compile(r"^---[ \t]*\r?\n.*?^(?:---|\.\.\.)[ \t]*(?:\r?\n|\Z)", re.S | re.M).match(
            markdown
        )
        if m:
            head, rest = markdown[: m.end()], markdown[m.end() :]
            if not head.endswith("\n"):
                head += "\n"
            return head + banner + rest
    return banner + markdown
