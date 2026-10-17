"""Render a stored version as HTML (Jinja2 template) or as markdown with a banner.

Citations ``[c:<id>]`` become numbered footnote references. Numbers follow the order
of first use in the document; citations that are defined but never used are listed
after the used ones so nothing in the front matter is dropped.
"""

import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from urllib.parse import urlsplit

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markdown_it import MarkdownIt
from markdown_it.rules_inline import StateInline
from markupsafe import Markup, escape
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from oracle.docs.models import Citation, Document, DocumentVersion, Section

HERE = Path(__file__).resolve().parent
TEMPLATES = HERE / "templates"
STATIC = HERE / "static"

# [c:c1] or [c:c1, c2]
_CITE = re.compile(r"\[c:\s*([A-Za-z0-9_.\-]+(?:\s*,\s*[A-Za-z0-9_.\-]+)*)\s*\]")
# Parsers normally strip the id from the heading; this guards against one that does not.
_HEADING_ID = re.compile(r"\s*\{#[^}]*\}\s*$")


class NotFound(LookupError):
    pass


@dataclass
class ExportVersion:
    """Everything an export needs, loaded once from the database."""

    document: Document
    version: DocumentVersion
    sections: list[Section]
    citations: list[Citation]
    latest_number: int

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
        return f"{slug}-v{self.version.number}"


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
    return ExportVersion(
        document=document,
        version=version,
        sections=sorted(version.sections, key=lambda s: s.ordinal),
        citations=list(version.citations),
        latest_number=latest or version.number,
    )


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


@cache
def _markdown() -> MarkdownIt:
    # Raw HTML in drafts is not rendered: exports are shared, drafts are agent-written.
    md = MarkdownIt("commonmark", {"html": False}).enable(["table", "strikethrough"])
    md.inline.ruler.before("link", "citation", _citation_rule)
    md.add_render_rule("citation", _render_citation)
    return md


def _safe_href(ref: str | None) -> str | None:
    if not ref:
        return None
    return ref if urlsplit(ref).scheme in ("http", "https") else None


def _format_dt(value: datetime | None) -> str:
    if value is None:
        return ""
    if value.tzinfo is not None:
        value = value.astimezone(UTC)
    return value.strftime("%Y-%m-%d %H:%M UTC")


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
    env = {"footnotes": notes}
    sections = []
    for s in ev.sections:
        heading = _HEADING_ID.sub("", s.heading)
        sections.append(
            RenderedSection(
                key=s.section_key,
                level=min(max(s.level, 1), 6),
                heading=Markup(md.renderInline(heading, env)),
                body=Markup(md.render(s.body_md or "", env)),
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
                retrieved_at=_format_dt(c.retrieved_at),
                backref=f"ref-{number}-1" if notes.ref_counts.get(key) else None,
            )
        )
    v = ev.version
    return {
        "title": ev.document.title,
        "slug": ev.document.slug,
        "number": v.number,
        "status": ev.status,
        "date": _format_dt(ev.date),
        "imported_at": _format_dt(v.created_at),
        "approved_at": _format_dt(v.approved_at),
        "snapshot": v.snapshot,
        "has_title_section": any(s.level == 1 for s in ev.sections),
        "sections": sections,
        "footnotes": footnotes,
        "css": Markup(stylesheet()),
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
    return _jinja().get_template("prd.html.j2").render(**build_context(ev))


# --- markdown export --------------------------------------------------------------


def banner_line(ev: ExportVersion) -> str:
    parts = [
        f"{ev.document.title} ({ev.document.slug})",
        f"version {ev.version.number}",
        f"status {ev.status}",
        f"imported {_format_dt(ev.version.created_at)}",
    ]
    if ev.version.approved_at is not None:
        parts.append(f"approved {_format_dt(ev.version.approved_at)}")
    # "--" would end the HTML comment early.
    return "Product Oracle export: " + " · ".join(parts).replace("--", "- -")


def render_markdown(ev: ExportVersion) -> str:
    """The stored markdown with a banner comment.

    The comment goes after the YAML front matter (front matter must stay first), so
    the export can still be re-imported.
    """
    banner = f"<!-- {banner_line(ev)} -->\n"
    markdown = ev.version.markdown
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
