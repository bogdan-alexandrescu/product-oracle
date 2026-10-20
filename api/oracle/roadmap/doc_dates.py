"""Dates written in a roadmap document's text (O4, owner 2026-10-19, 'document dates').

The verified-basis rule for dates (oracle.roadmap.schedule) covers the roadmap's own
text too: the Now section, Present, and the PDF and slide exports. Every day-precision
date written in a roadmap's sections (``2026-11-30``, ``Nov 30, 2026``,
``30 November 2026``) must match a verified schedule basis of the roadmap's PRD that
supports exactly that date; a basis limited to an item (``item_key``) or to a tracker
issue's items (``tracker_key``) matches only where the date's line or section names that
item (its key, or its horizon anchor ``now-<key>``) or that tracker key. Month and
quarter phrases (``November 2026``, ``Q4``) are horizons, not dates. The Sources and data
points section (evidence, with retrieval dates), the layout block, guidance comments,
presenter notes and link targets are not scanned.

On import (oracle.docs.service.import_draft):

- a person's import (and Oracle's own revisions) is refused when a date has no verified
  basis (``unverified_date``);
- a run's import keeps the version, marks each such date ``unverified`` and records the
  problem as a version warning.

On read (:func:`marks`) each date is checked again against the bases as they stand: a
date whose basis was withdrawn (and that no other verified basis supports) is marked
``date withdrawn`` in the document view, Present and every export. The approved text is
never rewritten; the marker is rendered next to the date.
"""

import re
import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any, Literal, Protocol

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle.docs.layers import slide_body
from oracle.roadmap import schedule
from oracle.roadmap.models import HORIZONS

Status = Literal["verified", "unverified", "withdrawn"]
LABELS: dict[str, str | None] = {
    "verified": None,
    "unverified": "unverified",
    "withdrawn": "date withdrawn",
}
# Worst first: one date written twice in a section shows its worst status.
_RANK = {"withdrawn": 0, "unverified": 1, "verified": 2}

SOURCES_KEY = "sources"
SKIPPED_KEYS = {"layout"}

_MONTHS = {
    m: n
    for n, names in enumerate(
        [
            ("jan", "january"),
            ("feb", "february"),
            ("mar", "march"),
            ("apr", "april"),
            ("may",),
            ("jun", "june"),
            ("jul", "july"),
            ("aug", "august"),
            ("sep", "sept", "september"),
            ("oct", "october"),
            ("nov", "november"),
            ("dec", "december"),
        ],
        start=1,
    )
    for m in names
}
_MONTH = r"(?P<month>" + "|".join(sorted(_MONTHS, key=len, reverse=True)) + r")\.?"
_DAY = r"(?P<day>[0-3]?[0-9])(?:st|nd|rd|th)?"
_YEAR = r"(?P<year>[12][0-9]{3})"
DATE_PATTERNS = [
    re.compile(
        r"(?<![\w/.-])(?P<year>[12][0-9]{3})-(?P<month>[01][0-9])-(?P<day>[0-3][0-9])(?![\w-])"
    ),
    re.compile(rf"(?<![\w-]){_MONTH}\s+{_DAY},?\s+{_YEAR}(?![\w-])", re.IGNORECASE),
    re.compile(rf"(?<![\w-]){_DAY}\s+{_MONTH},?\s+{_YEAR}(?![\w-])", re.IGNORECASE),
]
# Link targets ("](...)") and autolinks are not text a reader sees as a date.
_LINK_TARGET = re.compile(r"\]\([^)\n]*\)")
_AUTOLINK = re.compile(r"<[a-z][a-z0-9+.-]*:[^>\s]*>", re.IGNORECASE)
_HEADING_ID = re.compile(r"\s*\{#[^}]*\}\s*$")


class _SectionLike(Protocol):
    section_key: str
    level: int
    heading: str
    body_md: str


@dataclass(frozen=True)
class Found:
    """One date as written in a section: where, and the text around it."""

    section_key: str
    text: str
    day: date
    line: int  # 1-based, within the section (0: the heading)
    context: str  # the section's heading and anchor, and the date's line


@dataclass
class Mark:
    section_key: str
    text: str
    day: date
    status: Status
    line: int
    bases: list[str]

    @property
    def label(self) -> str | None:
        return LABELS[self.status]

    def as_json(self) -> dict[str, Any]:
        return {
            "section_key": self.section_key,
            "text": self.text,
            "date": self.day,
            "status": self.status,
            "label": self.label,
            "bases": self.bases,
        }


def _parse(m: re.Match[str]) -> date | None:
    month = m["month"]
    number = int(month) if month.isdigit() else _MONTHS.get(month.lower().rstrip("."))
    try:
        return date(int(m["year"]), number or 0, int(m["day"]))
    except ValueError:
        return None


def dates_in(text: str) -> list[tuple[str, date, int]]:
    """Every day-precision date in ``text``: (as written, date, start offset)."""
    found: list[tuple[str, date, int]] = []
    taken: list[tuple[int, int]] = []
    for pattern in DATE_PATTERNS:
        for m in pattern.finditer(text):
            if any(m.start() < end and start < m.end() for start, end in taken):
                continue
            day = _parse(m)
            if day is not None:
                found.append((m.group(0), day, m.start()))
                taken.append((m.start(), m.end()))
    return sorted(found, key=lambda f: f[2])


def _scanned(sections: Sequence[_SectionLike]) -> list[_SectionLike]:
    out: list[_SectionLike] = []
    sources_level: int | None = None
    for s in sections:
        if s.section_key == SOURCES_KEY:
            sources_level = s.level
            continue
        if sources_level is not None:
            if s.level > sources_level:
                continue
            sources_level = None
        if s.section_key not in SKIPPED_KEYS:
            out.append(s)
    return out


def _visible(text: str) -> str:
    return _AUTOLINK.sub("<>", _LINK_TARGET.sub("]()", text))


def find(sections: Sequence[_SectionLike]) -> list[Found]:
    """Every date written in the roadmap's sections, in document order."""
    out: list[Found] = []
    for s in _scanned(sections):
        heading = _HEADING_ID.sub("", s.heading or "")
        head = f"{heading} {{#{s.section_key}}}"
        lines = [(0, heading)] + list(enumerate(_visible(slide_body(s.body_md)).split("\n"), 1))
        for n, line in lines:
            for text, day, _ in dates_in(_visible(line) if n == 0 else line):
                out.append(Found(s.section_key, text, day, n, f"{head}\n{line}"))
    return out


_KEY_CHAR = r"A-Za-z0-9_.\-"


def _names_key(key: str, text: str) -> bool:
    """Whether ``text`` names an item key as a whole (or its horizon anchor)."""
    for needle in (key, *(f"{h}-{key}" for h in HORIZONS)):
        pattern = rf"(?<![{_KEY_CHAR}]){re.escape(needle)}(?![A-Za-z0-9_\-])"
        if re.search(pattern, text, re.IGNORECASE):
            return True
    return False


def covering(found: Found, bases: Iterable[schedule.Basis]) -> list[schedule.Basis]:
    """The bases (of the roadmap's PRD) that support this date where it is written."""
    out = []
    for b in bases:
        if b.supports_date != found.day:
            continue
        if b.item_key:
            if not _names_key(b.item_key, found.context):
                continue
        elif b.tracker_key:
            if not (
                schedule._names(b.tracker_key, found.context)
                or any(_names_key(k, found.context) for k in b.item_keys or ())
            ):
                continue
        out.append(b)
    return out


async def prd_of(
    db: AsyncSession,
    document_id: uuid.UUID | None,
    source_version_id: uuid.UUID | None = None,
    markdown: str | None = None,
) -> uuid.UUID | None:
    """The PRD a roadmap's dates rest on: the PRD version it was built from, else the
    one its latest built version came from, else its track's PRD, else the one PRD its
    text links to (``/documents/<prd>/v/<n>#...``, as a roadmap draft links each item)."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.roadmap.models import ProductTrack
    from oracle.runs.roadmap import doc_links

    if source_version_id is not None:
        prd = await db.scalar(
            select(DocumentVersion.document_id).where(DocumentVersion.id == source_version_id)
        )
        if prd is not None:
            return prd
    if document_id is None:
        return None
    source = await db.scalar(
        select(DocumentVersion.source_version_id)
        .where(
            DocumentVersion.document_id == document_id,
            DocumentVersion.source_version_id.is_not(None),
        )
        .order_by(DocumentVersion.number.desc())
        .limit(1)
    )
    if source is not None:
        prd = await db.scalar(
            select(DocumentVersion.document_id).where(DocumentVersion.id == source)
        )
        if prd is not None:
            return prd
    track_prd = await db.scalar(
        select(ProductTrack.prd_document_id)
        .where(ProductTrack.roadmap_document_id == document_id)
        .order_by(ProductTrack.created_at)
        .limit(1)
    )
    if track_prd is not None or not markdown:
        return track_prd
    slugs = {link["slug"] for link in doc_links(markdown)}
    if not slugs:
        return None
    prds = list(
        await db.scalars(
            select(Document.id).where(Document.slug.in_(slugs), Document.kind == "prd")
        )
    )
    return prds[0] if len(prds) == 1 else None


async def check(
    db: AsyncSession, sections: Sequence[_SectionLike], prd_document_id: uuid.UUID | None
) -> list[Mark]:
    """Every date in the sections with its status against the PRD's bases now:
    verified, withdrawn (only a withdrawn basis supported it) or unverified."""
    found = find(sections)
    if not found:
        return []
    verified = await schedule.verified_bases(db, prd_document_id)
    withdrawn = await schedule.bases_with_status(db, prd_document_id, "withdrawn")
    out = []
    for f in found:
        support = covering(f, verified)
        if support:
            out.append(Mark(f.section_key, f.text, f.day, "verified", f.line, _refs(support)))
            continue
        gone = covering(f, withdrawn)
        status: Status = "withdrawn" if gone else "unverified"
        out.append(Mark(f.section_key, f.text, f.day, status, f.line, _refs(gone)))
    return out


def _refs(bases: list[schedule.Basis]) -> list[str]:
    return list(dict.fromkeys(b.reference for b in bases))


def problem_message(mark: Mark, prd_slug: str | None) -> str:
    where = "heading" if mark.line == 0 else f"line {mark.line}"
    of = f"PRD {prd_slug}" if prd_slug else "the roadmap's PRD (none is known)"
    if mark.status == "withdrawn":
        return (
            f"the date {mark.text} (section {mark.section_key}, {where}) rested on "
            f"{', '.join(mark.bases)}, which was withdrawn; drop the date or record a new basis"
        )
    return (
        f"the date {mark.text} (section {mark.section_key}, {where}) rests on no verified "
        f"estimate, capacity or commitment of {of} for this item; record one "
        "(POST /v1/schedule-bases) or drop the date. Oracle never invents dates"
    )


def flagged(marks: list[Mark]) -> list[Mark]:
    return [m for m in marks if m.status != "verified"]


def per_section(marks: list[Mark]) -> list[Mark]:
    """One mark per date text per section: its worst status (what a reader sees)."""
    best: dict[tuple[str, str], Mark] = {}
    for m in marks:
        key = (m.section_key, m.text)
        if key not in best or _RANK[m.status] < _RANK[best[key].status]:
            best[key] = m
    return list(best.values())


async def marks_for_version(db: AsyncSession, version: Any, sections: Sequence[Any]) -> list[Mark]:
    """The date marks of a stored roadmap version, re-checked now."""
    prd = await prd_of(db, version.document_id, version.source_version_id, version.markdown)
    return per_section(await check(db, sections, prd))


def annotate(text: str, marks: Iterable[Mark]) -> str:
    """``text`` with the marker after each flagged date (exports render this copy; the
    stored text is never changed)."""
    labels = {m.text: m.label for m in marks if m.label}
    if not labels:
        return text
    pattern = re.compile(
        r"(?<![\w/.-])("
        + "|".join(re.escape(t) for t in sorted(labels, key=len, reverse=True))
        + r")(?![\w-])"
    )
    return pattern.sub(lambda m: f"{m.group(1)} **[{labels[m.group(1)]}]**", text)
