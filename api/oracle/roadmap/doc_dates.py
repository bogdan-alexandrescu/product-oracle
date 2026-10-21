"""Dates written in a roadmap document's text (O4, owner 2026-10-19 and 2026-10-20,
'document dates').

The verified-basis rule for dates (oracle.roadmap.schedule) covers the roadmap's own
text too: the document view, Present, every export, the markdown and MCP. Every
day-precision date a reader sees must match a verified schedule basis of the roadmap's
PRD that supports exactly that date.

What counts as written (:func:`find`): the text as rendered, not the markdown source.
Each block is rendered with markdown-it (entities and escapes decoded, soft breaks as
spaces, emphasis flattened, code spans and code blocks included, link text included;
a link destination is not text, but a "destination" with spaces is not a link and an
autolink shows its URL, so both are text). The rendered text is normalized before the
date patterns run: no-break and other Unicode spaces are spaces, U+2010-U+2015 and
U+2212 are hyphens, zero-width characters and soft hyphens are dropped, and fullwidth
and other compatibility forms (``２０２６``) fold to ASCII (NFKC). The forms found:

- year first: ``2026-11-30``, ``2026/11/30``, ``2026.11.30``, ISO datetimes
  (``2026-11-30T09:00Z``), compact ``20261130``, ``2026-Nov-30``;
- day and month numbers: ``30/11/2026``, ``11/30/2026``, ``30.11.2026``, ``30-11-2026``
  and two-digit years with ``/``; a form that reads as two different days
  (``05/06/2026``) is verified only when a basis supports both;
- month names: ``Nov 30, 2026``, ``30 November 2026``, ``the 30th of November, 2026``,
  ``30-Nov-2026``;
- year-less ``Nov 30``, ``30 Nov``, ``the 30th of November``: the first such day on or
  after the version's date (the import day for a draft).

Month and quarter phrases (``November 2026``, ``Q4``) are horizons, not dates.

Where: every section's heading and body, the front matter ``title``, ``notes`` blocks
(Present shows them) and the layout section's text (its YAML block is for the renderer).
Not scanned: the Sources and data points section and everything after it (evidence,
with retrieval dates), by the layers rule (``layers._sources_keys``): ``{#sources}``
must then be the last part of the document, and a roadmap whose ``{#sources}`` is
followed by another top-level part is refused (``sources_not_last``) on a person's
import; on a run's import only the sources section's own sub-sections are exempt.

Scope: a basis limited to an item (``item_key``), or to the items a tracker issue is
matched to (``tracker_key``), supports a date only where that item owns the date: the
item's own section (``{#now-<key>}``), or a table row, list item or paragraph whose
first item link is that item's (``[Payment](#now-payment-step)``). A mention of the
key elsewhere does not count. A tracker basis also supports a date in a block that
names the tracker key.

On import (oracle.docs.service.import_draft):

- a person's import (and Oracle's own revisions) is refused when a date has no verified
  basis (``unverified_date``);
- a run's import keeps the version, marks each such date ``unverified`` and records the
  problem as a version warning; the version cannot be approved until every marker is
  resolved (a basis recorded, or a new draft without the date).

On read (:func:`marks_for_version`) each date is checked again against the bases as they
stand: a date whose basis was withdrawn (and that no other verified basis supports) is
marked ``date withdrawn`` everywhere it shows. The approved text is never rewritten; the
marker is rendered next to the date (:func:`annotate`: at the exact span :func:`find`
returned).

Off the event loop (owner 2026-10-20): :func:`find` parses the whole text with markdown-it
and runs on the parse pool (oracle.safe_yaml), never on the event loop. A stored version's
dates are found once and kept in this process (:func:`found_for_version`: a request waits
``WAIT_SECONDS``, then gets a 503 while the job goes on; a job past ``JOB_SECONDS`` gives
up and the version's reads are refused, 422). An import's are found within
``WAIT_SECONDS`` (else the draft is refused, ``too_slow``) and kept for the version it
stores (:func:`keep_for_version`).
"""

import asyncio
import bisect
import hashlib
import re
import unicodedata
import uuid
from array import array
from collections import OrderedDict
from collections.abc import Callable, Hashable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any, Literal, Protocol

from fastapi import HTTPException, status
from markdown_it import MarkdownIt
from markdown_it.token import Token
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from oracle import safe_yaml
from oracle.docs import layers
from oracle.docs.parser import DATE_MARK_COMMENT_RE
from oracle.roadmap import schedule
from oracle.roadmap.models import HORIZONS

Status = Literal["verified", "unverified", "withdrawn"]
Where = Literal["title", "heading", "body"]
LABELS: dict[str, str | None] = {
    "verified": None,
    "unverified": "unverified",
    "withdrawn": "date withdrawn",
}
# The markdown export's marker after a flagged date: an HTML comment, so the exported
# body imports again (oracle.docs.parser drops these comments on import).
COMMENTS: dict[str, str] = {
    "unverified": "<!-- oracle: date unverified -->",
    "withdrawn": "<!-- oracle: date withdrawn -->",
}
# Worst first: one date written twice in a section shows its worst status.
_RANK = {"withdrawn": 0, "unverified": 1, "verified": 2}

SOURCES_KEY = layers.SOURCES_SECTION_ID
LAYOUT_KEY = "layout"
TITLE_KEY = ""  # the section_key of a date in the front matter title

_md = MarkdownIt("commonmark", {"html": False}).enable("table")
# text_special tokens keep an entity's or escape's source form (``&nbsp;``, ``\\,``).
_md.disable("text_join")

# --------------------------------------------------------------------------- patterns

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
# A full name, or an abbreviation with an optional period ("Nov.", not "November.").
_MONTH = (
    r"(?P<month>"
    + "|".join(
        n if len(n) > 4 or n in ("may", "june", "july") else rf"{n}\.?"
        for n in sorted(_MONTHS, key=len, reverse=True)
    )
    + r")(?![A-Za-z])"
)
_DAY = r"(?P<day>[0-3]?[0-9])(?:st|nd|rd|th)?(?![0-9])"
_YEAR = r"(?P<year>[12][0-9]{3}|['\u2019][0-9]{2})(?![0-9])"
_NUM_BEFORE = r"(?<![0-9])(?<![0-9][./-])"
_NUM_AFTER = r"(?![0-9])(?![./-][0-9])"
# Between a month and a day, or before a year: spaces, or one . / - (with spaces).
_SEP = r"(?:\s*[./-]\s*|\s+)"
_SEP_YEAR = r"(?:\s*,\s*|\s*[./-]\s*|\s+)"

# (kind, pattern), most specific first: a later match overlapping an earlier is dropped.
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "ymd",
        re.compile(
            rf"{_NUM_BEFORE}(?P<year>[12][0-9]{{3}})(?P<s>\s?[./-]\s?)(?P<month>[0-9]{{1,2}})"
            rf"(?P=s)(?P<day>[0-9]{{1,2}}){_NUM_AFTER}"
        ),
    ),
    (
        "names",
        re.compile(rf"(?<![A-Za-z]){_MONTH}{_SEP}{_DAY}{_SEP_YEAR}{_YEAR}", re.IGNORECASE),
    ),
    (
        "names",
        re.compile(
            rf"(?<![A-Za-z0-9])(?:the\s+)?{_DAY}(?:\s+of)?{_SEP}{_MONTH}{_SEP_YEAR}{_YEAR}",
            re.IGNORECASE,
        ),
    ),
    (
        "names",
        re.compile(
            rf"(?<![0-9])(?P<year>[12][0-9]{{3}})\s*[./ -]\s*{_MONTH}\s*[./ -]\s*{_DAY}",
            re.IGNORECASE,
        ),
    ),
    (
        "compact",
        re.compile(
            r"(?<![A-Za-z0-9])(?P<year>(?:19|20)[0-9]{2})(?P<month>[01][0-9])(?P<day>[0-3][0-9])"
            r"(?![A-SU-Za-su-z0-9])"
        ),
    ),
    (
        "dmy",
        re.compile(
            rf"{_NUM_BEFORE}(?P<a>[0-9]{{1,2}})(?P<s>\s?[./-]\s?)(?P<b>[0-9]{{1,2}})(?P=s)"
            rf"(?P<year>[0-9]{{4}}){_NUM_AFTER}"
        ),
    ),
    (
        "dmy",
        re.compile(
            rf"{_NUM_BEFORE}(?P<a>[0-9]{{1,2}})/(?P<b>[0-9]{{1,2}})/(?P<year>[0-9]{{2}}){_NUM_AFTER}"
        ),
    ),
    ("md", re.compile(rf"(?<![A-Za-z]){_MONTH}{_SEP}{_DAY}", re.IGNORECASE)),
    (
        "md",
        re.compile(rf"(?<![A-Za-z0-9])(?:the\s+)?{_DAY}(?:\s+of)?{_SEP}{_MONTH}", re.IGNORECASE),
    ),
]

_SPACES = {
    "\u00a0",
    "\u1680",
    "\u202f",
    "\u205f",
    "\u3000",
    *(chr(c) for c in range(0x2000, 0x200B)),
}
_HYPHENS = {"\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2015", "\u2212", "\ufe63"}
_INVISIBLE = {"\u00ad", "\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u180e"}
# _fold on ASCII text, as one str.translate.
_ASCII_FOLD = str.maketrans("\t\n\r\f\v", "     ")


def _fold(ch: str) -> str:
    """One rendered character as the date patterns read it."""
    if ch in _INVISIBLE:
        return ""
    if ch in _SPACES or ch in "\t\n\r\f\v":
        return " "
    if ch in _HYPHENS:
        return "-"
    if ch < "\u0080":
        return ch
    folded = unicodedata.normalize("NFKC", ch)
    return folded if folded.isascii() else ch


def _year(raw: str) -> int:
    raw = raw.lstrip("'\u2019")
    return 2000 + int(raw) if len(raw) == 2 else int(raw)


def _safe(y: int, m: int, d: int) -> date | None:
    try:
        return date(y, m, d)
    except ValueError:
        return None


def _on_or_after(month: int, day: int, ref: date) -> date | None:
    for year in (ref.year, ref.year + 1, ref.year + 2, ref.year + 3, ref.year + 4):
        found = _safe(year, month, day)
        if found is not None and found >= ref:
            return found
    return None


def _days(kind: str, m: re.Match[str], ref: date) -> tuple[date, ...]:
    """The day(s) a match reads as: none when it is no real day."""
    if kind == "dmy":
        a, b, year = int(m["a"]), int(m["b"]), _year(m["year"])
        days = {d for d in (_safe(year, b, a), _safe(year, a, b)) if d is not None}
        return tuple(sorted(days))
    if kind == "md":
        month = _MONTHS[m["month"].lower().rstrip(".")]
        found = _on_or_after(month, int(m["day"]), ref)
        return (found,) if found else ()
    month_raw = m["month"]
    month = int(month_raw) if month_raw.isdigit() else _MONTHS[month_raw.lower().rstrip(".")]
    found = _safe(_year(m["year"]), month, int(m["day"]))
    return (found,) if found else ()


def _plausible(kind: str, m: re.Match[str]) -> bool:
    # "may" is a verb as often as a month: only "May" (or "MAY") is the month.
    word = m.groupdict().get("month")
    return not (word and word.rstrip(".") == "may")


@dataclass(frozen=True)
class Hit:
    """A date in normalized text: its span there and the day(s) it reads as."""

    start: int
    end: int
    days: tuple[date, ...]


_DIGIT = re.compile(r"[0-9]")
# No date contains one of these (nor do the patterns look at one around a date).
_NO_DATE = re.compile(r"[!\"#$%&()*+:;<=>?@\[\\\]^_`{|}~]")
_STRETCH = 8192


def _stretches(text: str) -> list[tuple[int, int]]:
    """Where the patterns look: ``text`` cut at a character no date contains about every
    ``_STRETCH`` characters, leaving out each stretch without a digit (every date has
    one). A date never crosses a cut and a pattern sees the text before a stretch, so the
    hits are those of one scan of the whole text; but each regex call is short. One call
    holds the GIL, so a pattern's scan of a 1 MB text stalled every other thread, the
    event loop's included, for a quarter of a second."""
    out: list[tuple[int, int]] = []
    start, n = 0, len(text)
    while start < n:
        end = n
        if start + _STRETCH < n:
            cut = _NO_DATE.search(text, start + _STRETCH)
            end = cut.start() if cut else n
        if _DIGIT.search(text, start, end):
            out.append((start, end))
        start = end
    return out


def _hits(text: str, ref: date) -> list[Hit]:
    stretches = _stretches(text)
    # 1 where an earlier pattern's date is (a list of spans made this quadratic: minutes
    # for a body of dates).
    taken = bytearray(len(text))
    out: list[Hit] = []
    for kind, pattern in _PATTERNS:
        for start, end in stretches:
            for m in pattern.finditer(text, start, end):
                if taken.find(1, m.start(), m.end()) >= 0:
                    continue
                if not _plausible(kind, m):
                    continue
                days = _days(kind, m, ref)
                if days:
                    out.append(Hit(m.start(), m.end(), days))
                    taken[m.start() : m.end()] = b"\x01" * (m.end() - m.start())
    return sorted(out, key=lambda h: h.start)


def dates_in(text: str, ref: date | None = None) -> list[tuple[str, date, int]]:
    """Every day-precision date in plain ``text``: (as written, first day, start)."""
    rendered = _Rendered()
    rendered.add_plain(text, 0)
    return [(rendered.text[s:e], h.days[0], s) for h, s, e in rendered.find(ref or date.today())]


# --------------------------------------------------------------------------- rendering


@dataclass
class _Rendered:
    """Rendered text with, per character: the source span it came from, where a marker
    after it goes (after a whole code span, autolink or entity), whether it is in a code
    block, and the block it belongs to (-1: a separator).

    The text is kept as chunks and joined once when read: appending each character to
    one string copied the whole text every time (quadratic: most of the 19 s a 1 MB body
    took). The per-character facts are flat arrays, not an object per character: freeing
    a million tuples is one call that holds the GIL (40 ms here) while the event loop's
    thread waits."""

    parts: list[str] = field(default_factory=list)
    src_start: array[int] = field(default_factory=lambda: array("q"))
    src_end: array[int] = field(default_factory=lambda: array("q"))
    src_insert: array[int] = field(default_factory=lambda: array("q"))
    fence: bytearray = field(default_factory=bytearray)
    owner: array[int] = field(default_factory=lambda: array("q"))

    @property
    def size(self) -> int:
        """The length of the text so far (one ``owner`` entry per character)."""
        return len(self.owner)

    @property
    def text(self) -> str:
        if len(self.parts) != 1:
            self.parts = ["".join(self.parts)]
        return self.parts[0]

    def span(self, k: int) -> tuple[int, int, int]:
        """Character ``k``'s source span and where a marker after it goes."""
        return self.src_start[k], self.src_end[k], self.src_insert[k]

    def add(
        self,
        chunk: str,
        start: int,
        end: int,
        insert: int | None = None,
        *,
        block: int = 0,
        fence: bool = False,
    ) -> None:
        self.parts.append(chunk)
        at = end if insert is None else insert
        n = len(chunk)
        if n == 1:
            self.src_start.append(start)
            self.src_end.append(end)
            self.src_insert.append(at)
            self.fence.append(fence)
            self.owner.append(block)
            return
        self.src_start.extend([start] * n)
        self.src_end.extend([end] * n)
        self.src_insert.extend([at] * n)
        self.fence.extend([fence] * n)
        self.owner.extend([block] * n)

    def separate(self) -> None:
        if self.owner:
            self.add(" ", -1, -1, block=-1)

    def add_plain(self, text: str, offset: int) -> None:
        for i, ch in enumerate(text):
            self.add(ch, offset + i, offset + i + 1)

    def find(self, ref: date) -> list[tuple[Hit, int, int]]:
        """Hits with their span in ``self.text``."""
        text = self.text
        if text.isascii():
            # _fold of an ASCII character: itself, or a space; offsets do not move.
            norm = text.translate(_ASCII_FOLD)
            return [(h, h.start, h.end) for h in _hits(norm, ref) if h.end > h.start]
        folded: list[str] = []
        back = array("q")
        for i, ch in enumerate(text):
            f = _fold(ch)
            folded.append(f)
            back.extend([i] * len(f))
        norm = "".join(folded)
        out = []
        for h in _hits(norm, ref):
            if h.end > h.start:
                out.append((h, back[h.start], back[h.end - 1] + 1))
        return out


def _line_starts(text: str) -> list[int]:
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def _line_of(starts: list[int], offset: int) -> int:
    """The 0-based line of a source offset."""
    return max(bisect.bisect_right(starts, offset) - 1, 0)


class _Source:
    """Finds a block's content in the source lines it came from."""

    def __init__(self, text: str) -> None:
        self.text = text
        self.starts = _line_starts(text)
        self.lines = text.split("\n")
        self.cursor: dict[int, int] = {}

    def locate(self, content: str, first_line: int) -> list[int]:
        """The source offset of each character of ``content`` (a block's content: its
        lines, each found in source line ``first_line + k``, past what was found there
        before, as table cells share a line)."""
        out: list[int] = []
        for k, line in enumerate(content.split("\n")):
            n = min(first_line + k, len(self.lines) - 1)
            src_line = self.lines[n]
            at = src_line.find(line, self.cursor.get(n, 0)) if line else -1
            if at < 0 and line:
                at = src_line.find(line)
            base = self.starts[n] + max(at, 0)
            out.extend(base + i for i in range(len(line)))
            if at >= 0:
                self.cursor[n] = at + len(line)
            out.append(self.starts[n] + len(src_line))  # the newline
        return out[:-1]


@dataclass
class _Block:
    start: int  # its span in the rendered text
    end: int
    item: str | None = None  # its first item link's key
    items_by_line: dict[int, str] = field(default_factory=dict)  # source line -> key


def _item_link(href: str) -> str | None:
    if not href.startswith("#"):
        return None
    return _item_of_anchor(href[1:])


def _item_of_anchor(anchor: str | None) -> str | None:
    if not anchor:
        return None
    m = re.match(r"^(?:" + "|".join(HORIZONS) + r")-(?P<key>.+)$", anchor)
    return m["key"] if m else None


def _render_inline(
    out: _Rendered,
    children: list[Token],
    content: str,
    pos: list[int],
    index: int,
    block: _Block,
    starts: list[int],
) -> None:
    """Append the rendered text of an inline token's children, mapping each character
    to its source offset through ``pos`` (the offsets of ``content``'s characters)."""
    end_of = len(content)

    def at(i: int) -> int:
        if not pos:
            return 0
        return pos[i] if 0 <= i < len(pos) else pos[-1] + 1

    def add(chunk: str, start: int, stop: int, insert: int | None = None) -> None:
        out.add(chunk, start, stop, insert, block=index)

    def skip_destination(i: int) -> int:
        """After a link's text: past ``](dest "title")`` or ``][ref]``."""
        j = content.find("]", i)
        if j < 0:
            return i
        j += 1
        if j < end_of and content[j] == "(":
            depth = 0
            while j < end_of:
                if content[j] == "\\":
                    j += 2
                    continue
                if content[j] == "(":
                    depth += 1
                elif content[j] == ")":
                    depth -= 1
                    if depth == 0:
                        return j + 1
                j += 1
            return end_of
        if j < end_of and content[j] == "[":
            k = content.find("]", j)
            return k + 1 if k >= 0 else j
        return j

    cur = 0
    i = 0
    while i < len(children):
        t = children[i]
        if t.type == "text":
            found = content.find(t.content, cur)
            found = cur if found < 0 else found
            for k, ch in enumerate(t.content):
                add(ch, at(found + k), at(found + k) + 1)
            cur = found + len(t.content)
        elif t.type == "text_special":
            found = content.find(t.markup, cur)
            found = cur if found < 0 else found
            start, stop = at(found), at(found + len(t.markup) - 1) + 1
            add(t.content, start, stop, stop)
            cur = found + len(t.markup)
        elif t.type == "code_inline":
            open_at = content.find(t.markup, cur)
            open_at = cur if open_at < 0 else open_at
            body_at = open_at + len(t.markup)
            inner = content.find(t.content, body_at) if t.content else -1
            close_from = inner + len(t.content) if inner >= 0 else body_at
            close_at = content.find(t.markup, close_from)
            close_at = body_at + len(t.content) if close_at < 0 else close_at
            after = at(close_at + len(t.markup) - 1) + 1
            for k, ch in enumerate(t.content):
                src = at(inner + k) if inner >= 0 else at(body_at)
                add(ch, src, src + 1, after)
            cur = close_at + len(t.markup)
        elif t.type == "link_open" and t.markup == "autolink":
            open_at = content.find("<", cur)
            close_at = content.find(">", open_at + 1) if open_at >= 0 else -1
            if open_at < 0 or close_at < 0:
                open_at, close_at = cur, cur
            after = at(close_at) + 1
            # The URL as shown, each character mapped into <...>; a marker goes after.
            j = i + 1
            while j < len(children) and children[j].type != "link_close":
                shown = children[j].content
                inner = content.find(shown, open_at + 1)
                for k, ch in enumerate(shown):
                    src = at(inner + k) if inner >= 0 else at(open_at)
                    add(ch, src, src + 1, after)
                j += 1
            i = j  # at its link_close
            cur = close_at + 1
        elif t.type == "link_open":
            found = content.find("[", cur)
            cur = found + 1 if found >= 0 else cur
            key = _item_link(str(t.attrs.get("href") or ""))
            if key:
                block.item = block.item or key
                block.items_by_line.setdefault(_line_of(starts, at(cur)), key)
        elif t.type == "link_close":
            cur = skip_destination(cur)
        elif t.type == "image":
            # The alt text shows where the image cannot.
            alt_at = content.find("![", cur)
            alt_at = cur if alt_at < 0 else alt_at + 2
            found = content.find(t.content, alt_at)
            for k, ch in enumerate(t.content):
                src = at(found + k) if found >= 0 else at(alt_at)
                add(ch, src, src + 1)
            cur = skip_destination(alt_at)
        elif t.type in ("softbreak", "hardbreak"):
            nl = content.find("\n", cur)
            nl = cur if nl < 0 else nl
            add(" ", at(nl), at(nl), at(nl))
            cur = nl + 1
        elif t.markup:  # emphasis and strong delimiters
            found = content.find(t.markup, cur)
            cur = found + len(t.markup) if found >= 0 else cur
        i += 1


def _render_body(body: str, *, skip_yaml: bool) -> tuple[_Rendered, list[_Block], list[int]]:
    """A section body's (or heading's) rendered text, block by block (a paragraph,
    heading, list item, table row or code block), and its source line starts."""
    out = _Rendered()
    src = _Source(body)
    blocks: list[_Block] = []
    row: _Block | None = None
    row_index = -1
    for t in _md.parse(body):
        if t.type == "tr_open":
            out.separate()
            row = _Block(out.size, out.size)
            blocks.append(row)
            row_index = len(blocks) - 1
            continue
        if t.type == "tr_close":
            if row is not None:
                row.end = out.size
            row = None
            continue
        if t.type in ("fence", "code_block") and t.map:
            info = (t.info or "").strip().lower()
            if skip_yaml and info in ("yaml", "yml"):
                continue
            out.separate()
            index = len(blocks)
            blk = _Block(out.size, out.size)
            blocks.append(blk)
            first = t.map[0] + (1 if t.type == "fence" else 0)
            content = t.content.rstrip("\n")
            pos = src.locate(content, first)
            for k, ch in enumerate(content):
                p = pos[k] if k < len(pos) else 0
                out.add(ch, p, p + 1, block=index, fence=True)
            blk.end = out.size
            continue
        if t.type != "inline" or t.map is None:
            continue
        if row is None:
            out.separate()
            blk = _Block(out.size, out.size)
            blocks.append(blk)
            index = len(blocks) - 1
        else:
            if out.owner and out.owner[-1] == row_index:
                out.add(" ", -1, -1, block=row_index)  # between cells
            blk, index = row, row_index
        pos = src.locate(t.content, t.map[0])
        _render_inline(out, t.children or [], t.content, pos, index, blk, src.starts)
        blk.end = out.size
    return out, blocks, src.starts


# --------------------------------------------------------------------------- finding


class _SectionLike(Protocol):
    section_key: str
    level: int
    heading: str
    body_md: str


@dataclass(frozen=True)
class Found:
    """One date as written: where, the text a reader sees, its source span."""

    section_key: str
    text: str
    days: tuple[date, ...]
    line: int  # 1-based, within the section body (0: the heading or the title)
    where: Where
    start: int  # source span in the heading, body or title
    end: int
    insert_at: int  # where a marker after it goes in that source
    owner: str | None  # the item that owns the date (its section, row or line)
    block: str  # the rendered block it is in (a tracker key named there counts)
    in_code: bool = False  # in a code block: a marker goes right after it, as text

    @property
    def day(self) -> date:
        return self.days[0]


@dataclass(frozen=True)
class Scope:
    """Which sections :func:`find` reads, and the problem with the sources section."""

    keys: list[str]
    exempt: set[str]
    misplaced_sources: bool


def scope(sections: Sequence[_SectionLike]) -> Scope:
    keys = [s.section_key for s in sections]
    if SOURCES_KEY not in keys:
        return Scope(keys, set(), False)
    refs = [layers.SectionRef(s.section_key, s.level) for s in sections]
    own = set(layers.subtree(refs, SOURCES_KEY))
    after = set(layers._sources_keys(keys))
    return Scope(keys, own, misplaced_sources=bool(after - own))


def _found_in(
    source: str,
    *,
    section_key: str,
    where: Where,
    section_item: str | None,
    ref: date,
    skip_yaml: bool = False,
    plain: bool = False,
) -> list[Found]:
    if plain:
        rendered = _Rendered()
        rendered.add_plain(source, 0)
        blocks: list[_Block] = []
        starts = _line_starts(source)
    else:
        rendered, blocks, starts = _render_body(source, skip_yaml=skip_yaml)
    out: list[Found] = []
    # One string per block, shared by its dates (what a version keeps stays small).
    block_texts: dict[int, str] = {}
    for hit, a, b in rendered.find(ref):
        spans = [rendered.span(k) for k in range(a, b) if rendered.src_start[k] >= 0]
        if not spans:
            continue
        start, end = spans[0][0], max(sp[1] for sp in spans)
        in_code = any(rendered.fence[a:b])
        insert = end if in_code else max(spans[-1][2], end)
        # Past closing emphasis right after the date (``**Nov 30, 2026**``).
        while not in_code and insert < len(source) and source[insert] in "*_~":
            insert += 1
        line = _line_of(starts, start)
        owner = section_item
        block_text = rendered.text
        index = next((rendered.owner[k] for k in range(a, b) if rendered.owner[k] >= 0), -1)
        if 0 <= index < len(blocks):
            blk = blocks[index]
            owner = blk.items_by_line.get(line) or blk.item or section_item
            if index not in block_texts:
                block_texts[index] = rendered.text[blk.start : blk.end]
            block_text = block_texts[index]
        out.append(
            Found(
                section_key,
                rendered.text[a:b],
                hit.days,
                line + 1 if where == "body" else 0,
                where,
                start,
                end,
                insert,
                owner,
                block_text,
                in_code,
            )
        )
    return out


def find(
    sections: Sequence[_SectionLike], *, title: str | None = None, ref: date | None = None
) -> list[Found]:
    """Every date a reader sees in the roadmap (title, headings, bodies), in document
    order. ``ref``: the version's date, for year-less dates."""
    ref = ref or date.today()
    out: list[Found] = []
    if title:
        out += _found_in(
            title, section_key=TITLE_KEY, where="title", section_item=None, ref=ref, plain=True
        )
    sc = scope(sections)
    # The item a section belongs to: its own anchor, else its parent item section's.
    stack: list[tuple[int, str | None]] = []
    for s in sections:
        while stack and stack[-1][0] >= s.level:
            stack.pop()
        item = _item_of_anchor(s.section_key) or (stack[-1][1] if stack else None)
        stack.append((s.level, item))
        if s.section_key in sc.exempt:
            continue
        out += _found_in(
            s.heading or "", section_key=s.section_key, where="heading", section_item=item, ref=ref
        )
        out += _found_in(
            s.body_md or "",
            section_key=s.section_key,
            where="body",
            section_item=item,
            ref=ref,
            skip_yaml=s.section_key == LAYOUT_KEY,
        )
    return out


def covering(found: Found, bases: Iterable[schedule.Basis]) -> list[schedule.Basis]:
    """The bases (of the roadmap's PRD) that support this date where it is written:
    every day it reads as, each by a basis in scope."""
    bases = list(bases)
    out: list[schedule.Basis] = []
    for day in found.days:
        here = [b for b in bases if b.supports_date == day and _in_scope(b, found)]
        if not here:
            return []
        out += here
    return out


def _in_scope(b: schedule.Basis, found: Found) -> bool:
    owner = (found.owner or "").lower()
    if b.item_key:
        return owner == b.item_key.lower()
    if b.tracker_key:
        if schedule._names(b.tracker_key, found.block):
            return True
        return bool(owner) and owner in {k.lower() for k in b.item_keys or ()}
    return True


def template_dates(body: str) -> set[tuple[str, str]]:
    """(section key, date as written) for each date a company template writes literally:
    exempt in drafts of that template (the company's text, not a schedule claim)."""
    from oracle.docs.parser import _parse_sections, split_front_matter

    _, rest, offset = split_front_matter(body.replace("\r\n", "\n"))
    sections = _parse_sections(rest, offset, [])
    return {(f.section_key, f.text) for f in find(sections) if f.where != "title"}


# --------------------------------------------------------------------------- off the event loop

# Finding the dates parses the whole text with markdown-it: CPU-bound, and seconds for a
# large body. It never runs on the event loop: on the parse pool
# (oracle.safe_yaml.run_parse_within), and once per stored version, since versions are
# immutable: what it found is kept in this process (an LRU, not the database), keyed by
# the version, its day and RENDERER. A template's literal dates are kept per template body.

# Bump when find() reads the same text differently: what older code found is not served.
RENDERER = 1
# A request waits at most this long for dates: a draft's import is then refused
# (too_slow), a stored version's read answers 503 while its dates are still being found.
WAIT_SECONDS = safe_yaml.PARSE_SECONDS
# Finding a stored version's dates gives up after this long: that version's reads are
# then refused (422) without parsing it again.
JOB_SECONDS = 4 * safe_yaml.PARSE_SECONDS
# Roughly what the kept results may hold, in bytes (least recently used out first).
KEPT_BYTES = 32 * 1024 * 1024
STILL_CHECKING = "This roadmap's dates are still being checked; try again in a few seconds"
TOO_LARGE = "This roadmap is too large to check its dates quickly"


class DatesUnavailable(HTTPException):
    """The dates of a roadmap could not be had in time: 503 with Retry-After while they are
    still being found (the next read is served from what is found), 422 once finding them
    gave up after ``JOB_SECONDS``. An HTTP error wherever a request reads them (the
    document view, its markdown, the exports, the publish gate): never a view without its
    date markers."""

    def __init__(self, *, pending: bool) -> None:
        self.pending = pending
        if pending:
            super().__init__(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                STILL_CHECKING,
                headers={"Retry-After": str(max(1, round(WAIT_SECONDS)))},
            )
        else:
            super().__init__(status.HTTP_422_UNPROCESSABLE_CONTENT, TOO_LARGE)


@dataclass(frozen=True)
class _Part:
    """What find() reads of a section: a copy, so the parse pool never touches a database
    row (its session may expire it meanwhile)."""

    section_key: str
    level: int
    heading: str
    body_md: str


def _parts(sections: Sequence[_SectionLike]) -> tuple[_Part, ...]:
    return tuple(_Part(s.section_key, s.level, s.heading or "", s.body_md or "") for s in sections)


def _find_all(parts: tuple[_Part, ...], title: str | None, ref: date) -> tuple[Found, ...]:
    return tuple(find(parts, title=title, ref=ref))


def _template_dates(body: str) -> frozenset[tuple[str, str]]:
    return frozenset(template_dates(body))


def _weight(value: Any) -> int:
    """About how many bytes a kept result holds."""
    if isinstance(value, tuple):  # what find() found
        blocks = {id(f.block): len(f.block) for f in value}
        return 512 * len(value) + sum(blocks.values()) + 64
    return 128 * len(value) + 64


_MISSING = object()


class _Kept:
    """Results kept per key (least recently used out first past ``KEPT_BYTES``), the keys
    whose job gave up, and the jobs running now (at most one per key)."""

    def __init__(self) -> None:
        self.values: OrderedDict[Hashable, tuple[Any, int]] = OrderedDict()
        self.weight = 0
        self.gave_up: OrderedDict[Hashable, None] = OrderedDict()
        self.running: dict[Hashable, asyncio.Task[Any]] = {}

    def get(self, key: Hashable) -> Any:
        hit = self.values.get(key)
        if hit is None:
            return _MISSING
        self.values.move_to_end(key)
        return hit[0]

    def put(self, key: Hashable, value: Any) -> None:
        old = self.values.pop(key, None)
        if old is not None:
            self.weight -= old[1]
        weight = _weight(value)
        self.values[key] = (value, weight)
        self.weight += weight
        while self.weight > KEPT_BYTES and len(self.values) > 1:
            _, (_, dropped) = self.values.popitem(last=False)
            self.weight -= dropped

    def give_up(self, key: Hashable) -> None:
        self.gave_up[key] = None
        while len(self.gave_up) > 1024:
            self.gave_up.popitem(last=False)


_KEPT = _Kept()


async def _job(key: Hashable, fn: Callable[..., Any], args: tuple[Any, ...]) -> Any:
    try:
        value = await safe_yaml.run_parse_within(
            fn, *args, name="the roadmap's dates", seconds=JOB_SECONDS
        )
    except safe_yaml.ParseTimeout:
        _KEPT.give_up(key)
        raise DatesUnavailable(pending=False) from None
    finally:
        if _KEPT.running.get(key) is asyncio.current_task():
            del _KEPT.running[key]
    _KEPT.put(key, value)
    return value


async def _kept(key: Hashable, fn: Callable[..., Any], *args: Any) -> Any:
    """``fn(*args)`` for ``key``: kept, else from the one job finding it (started when none
    runs), waited for at most ``WAIT_SECONDS``. The job goes on without the caller and
    keeps what it finds."""
    value = _KEPT.get(key)
    if value is not _MISSING:
        return value
    if key in _KEPT.gave_up:
        raise DatesUnavailable(pending=False)
    loop = asyncio.get_running_loop()
    job = _KEPT.running.get(key)
    if job is None or job.get_loop() is not loop:
        job = loop.create_task(_job(key, fn, args))
        # Its outcome is read even when every caller stopped waiting.
        job.add_done_callback(lambda t: t.cancelled() or t.exception())
        _KEPT.running[key] = job
    try:
        return await asyncio.wait_for(asyncio.shield(job), WAIT_SECONDS)
    except TimeoutError:
        raise DatesUnavailable(pending=True) from None


async def found_for_version(version: Any, sections: Sequence[_SectionLike]) -> tuple[Found, ...]:
    """:func:`find` of a stored version (its title, its day): found once, then kept."""
    ref = version_day(version)
    key = ("version", version.id, ref, RENDERER)
    return await _kept(key, _find_all, _parts(sections), version_title(version), ref)


async def found_for_draft(
    sections: Sequence[_SectionLike], *, title: str | None, ref: date
) -> tuple[Found, ...]:
    """:func:`find` of a draft on the parse pool, at most ``WAIT_SECONDS``
    (:class:`oracle.safe_yaml.ParseTimeout` past it)."""
    return await safe_yaml.run_parse_within(
        _find_all, _parts(sections), title, ref, name="the roadmap's dates", seconds=WAIT_SECONDS
    )


def keep_for_version(version_id: uuid.UUID, ref: date, found: Sequence[Found]) -> None:
    """What an import found, kept for the version it stored. Served when ``ref`` is the
    version's day (:func:`import_day`; not when the import crossed midnight UTC)."""
    _KEPT.put(("version", version_id, ref, RENDERER), tuple(found))


def import_day() -> date:
    """The day of a version imported now: its ``created_at`` (the database's clock) read
    in UTC, as :func:`version_day` reads it."""
    return datetime.now(UTC).date()


async def template_dates_async(body: str) -> frozenset[tuple[str, str]]:
    """:func:`template_dates` of a template body: found once (a day: year-less dates read
    against today), then kept."""
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    return await _kept(("template", digest, date.today(), RENDERER), _template_dates, body)


# --------------------------------------------------------------------------- checking


@dataclass
class Mark:
    section_key: str
    text: str
    day: date
    status: Status
    line: int
    bases: list[str]
    days: tuple[date, ...] = ()
    where: Where = "body"
    start: int = 0
    end: int = 0
    insert_at: int = 0
    in_code: bool = False

    @property
    def label(self) -> str | None:
        return LABELS[self.status]

    def as_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "section_key": self.section_key,
            "text": self.text,
            "date": self.day,
            "status": self.status,
            "label": self.label,
            "bases": self.bases,
            "where": self.where,
        }
        return out


def declared_prd(front_matter: dict[str, Any] | None) -> str | None:
    """The PRD a roadmap names itself in its front matter: ``prd: <slug>`` or
    ``prd: {document: <slug>, version: <n>}`` (as roadmap_items.yaml does)."""
    value = (front_matter or {}).get("prd")
    if isinstance(value, dict):
        value = value.get("document")
    return value if isinstance(value, str) and value else None


async def prd_of(
    db: AsyncSession,
    document_id: uuid.UUID | None,
    source_version_id: uuid.UUID | None = None,
    front_matter: dict[str, Any] | None = None,
) -> uuid.UUID | None:
    """The PRD a roadmap's dates rest on: the PRD version it was built from, else the
    one its latest built version came from, else its track's PRD, else the PRD its front
    matter names (``prd:``). Never a PRD its text merely links to: a roadmap with none of
    these has no PRD, and every date it writes is unverified."""
    from oracle.docs.models import Document, DocumentVersion
    from oracle.roadmap.models import ProductTrack

    if source_version_id is not None:
        prd = await db.scalar(
            select(DocumentVersion.document_id).where(DocumentVersion.id == source_version_id)
        )
        if prd is not None:
            return prd
    if document_id is not None:
        built = (
            select(DocumentVersion.source_version_id)
            .where(
                DocumentVersion.document_id == document_id,
                DocumentVersion.source_version_id.is_not(None),
            )
            .order_by(DocumentVersion.number.desc())
            .limit(1)
            .scalar_subquery()
        )
        track = (
            select(ProductTrack.prd_document_id)
            .where(ProductTrack.roadmap_document_id == document_id)
            .order_by(ProductTrack.created_at)
            .limit(1)
            .scalar_subquery()
        )
        prd = await db.scalar(
            select(
                func.coalesce(
                    select(DocumentVersion.document_id)
                    .where(DocumentVersion.id == built)
                    .scalar_subquery(),
                    track,
                )
            )
        )
        if prd is not None:
            return prd
    slug = declared_prd(front_matter)
    if slug is None:
        return None
    return await db.scalar(select(Document.id).where(Document.slug == slug, Document.kind == "prd"))


def check_found(
    found: list[Found],
    verified: list[schedule.Basis],
    withdrawn: list[schedule.Basis],
) -> list[Mark]:
    out = []
    for f in found:
        support = covering(f, verified)
        if support:
            status: Status = "verified"
            refs = _refs(support)
        else:
            gone = covering(f, withdrawn)
            status = "withdrawn" if gone else "unverified"
            refs = _refs(gone)
        out.append(
            Mark(
                f.section_key,
                f.text,
                f.day,
                status,
                f.line,
                refs,
                f.days,
                f.where,
                f.start,
                f.end,
                f.insert_at,
                f.in_code,
            )
        )
    return out


async def check(
    db: AsyncSession,
    found: Sequence[Found],
    prd_document_id: uuid.UUID | None,
    *,
    exempt: Iterable[tuple[str, str]] | None = None,
) -> list[Mark]:
    """Every date the roadmap writes (``found``: :func:`found_for_version` or
    :func:`found_for_draft`) with its status against the PRD's bases now: verified,
    withdrawn (only a withdrawn basis supported it) or unverified. Every occurrence.
    ``exempt``: (section key, date as written) pairs the company's template writes
    (:func:`template_dates`), which are not schedule claims and are left out."""
    skip = set(exempt or ())
    found = [f for f in found if (f.section_key, f.text) not in skip]
    if not found:
        return []
    bases = await schedule.bases_by_status(db, prd_document_id, ("verified", "withdrawn"))
    return check_found(found, bases["verified"], bases["withdrawn"])


def _refs(bases: list[schedule.Basis]) -> list[str]:
    return list(dict.fromkeys(b.reference for b in bases))


def _where(mark: Mark) -> str:
    if mark.where == "title":
        return "the title"
    place = "heading" if mark.line == 0 else f"line {mark.line}"
    return f"section {mark.section_key}, {place}"


def _reads_as(mark: Mark) -> str:
    if len(mark.days) > 1:
        return f" (it reads as {' or '.join(d.isoformat() for d in mark.days)})"
    return ""


def problem_message(mark: Mark, prd_slug: str | None) -> str:
    of = f"PRD {prd_slug}" if prd_slug else "the roadmap's PRD (none is known)"
    if mark.status == "withdrawn":
        return (
            f"the date {mark.text} ({_where(mark)}) rested on {', '.join(mark.bases)}, which "
            "was withdrawn; drop the date or record a new basis"
        )
    return (
        f"the date {mark.text}{_reads_as(mark)} ({_where(mark)}) rests on no verified "
        f"estimate, capacity or commitment of {of} for this item; record one "
        "(POST /v1/schedule-bases) or drop the date. Oracle never invents dates"
    )


SOURCES_NOT_LAST = (
    "the Sources and data points section ({#sources}) must be the last part of a roadmap: "
    "move the sections after it before it"
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


def version_day(version: Any) -> date:
    created = getattr(version, "created_at", None)
    return created.date() if isinstance(created, datetime) else date.today()


def version_title(version: Any) -> str | None:
    title = (getattr(version, "front_matter", None) or {}).get("title")
    return title if isinstance(title, str) else None


async def occurrences_for_version(
    db: AsyncSession, version: Any, sections: Sequence[Any], *, prd: uuid.UUID | None = None
) -> list[Mark]:
    """Every date occurrence of a stored roadmap version, re-checked now. The text is read
    once per version, off the event loop (:func:`found_for_version`; raises
    :class:`DatesUnavailable` when that takes too long)."""
    found = await found_for_version(version, sections)
    if prd is None:
        prd = await prd_of(db, version.document_id, version.source_version_id, version.front_matter)
    return await check(db, found, prd, exempt=await version_template_dates(db, version))


async def version_template_dates(db: AsyncSession, version: Any) -> frozenset[tuple[str, str]]:
    """The literal dates of the template a stored version names (its front matter's
    template, else its document's)."""
    from oracle.docs.models import Document
    from oracle.docs.service import template_body

    fm = getattr(version, "front_matter", None) or {}
    named = (fm.get("template"), fm.get("template_version"))
    if not named[0]:
        row = (
            await db.execute(
                select(Document.template, Document.template_version).where(
                    Document.id == version.document_id
                )
            )
        ).first()
        named = (row[0], row[1]) if row else (None, None)
    body = await template_body(db, named[0], str(named[1]) if named[1] is not None else None)
    return await template_dates_async(body) if body else frozenset()


async def marks_for_version(db: AsyncSession, version: Any, sections: Sequence[Any]) -> list[Mark]:
    """The date marks of a stored roadmap version, re-checked now (one per date text per
    section, its worst status)."""
    return per_section(await occurrences_for_version(db, version, sections))


# --------------------------------------------------------------------------- annotating


def annotate(source: str, marks: Iterable[Mark], *, style: Literal["md", "comment"] = "md") -> str:
    """``source`` (a heading, body or title) with the marker after each flagged date, at
    the span :func:`find` returned: ``**[label]**`` for the rendered views and exports,
    an HTML comment for the markdown export. The stored text is never changed."""
    inserts: dict[int, list[str]] = {}
    for m in marks:
        if m.status == "verified":
            continue
        if style == "comment":
            text = f" {COMMENTS[m.status]}"
        else:
            # In a code block the marker is text (emphasis would show as asterisks).
            text = f" [{m.label}]" if m.in_code else f" **[{m.label}]**"
        at = min(max(m.insert_at, 0), len(source))
        if text not in inserts.setdefault(at, []):
            inserts[at].append(text)
    if not inserts:
        return source
    out: list[str] = []
    last = 0
    for at in sorted(inserts):
        out.append(source[last:at])
        out.extend(inserts[at])
        last = at
    out.append(source[last:])
    return "".join(out)


def annotate_markdown(markdown: str, sections: Sequence[Any], marks: Iterable[Mark]) -> str:
    """The stored markdown of a version with an HTML comment after each flagged date
    (``<!-- oracle: date unverified -->``, ``<!-- oracle: date withdrawn -->``; a YAML
    comment after a dated front matter title): the markdown export, GET .../markdown and
    MCP. Comments only, so the body imports again (the parser drops them)."""
    flagged_marks = [m for m in marks if m.status != "verified"]
    if not flagged_marks:
        return markdown
    lines = markdown.split("\n")
    starts = _line_starts(markdown)
    inserts: dict[int, str] = {}

    def put(at: int, status: str, *, yaml: bool = False) -> None:
        # In the front matter a YAML comment (an HTML comment would join the title).
        text = f" # oracle: date {status}" if yaml else f" {COMMENTS[status]}"
        if text not in inserts.get(at, ""):
            inserts[at] = inserts.get(at, "") + text

    by_key = {s.section_key: s for s in sections}
    body_at = _section_offsets(markdown, sections)
    for m in flagged_marks:
        if m.where == "title":
            n = next(
                (i for i, line in enumerate(lines[1:], 1) if re.match(r"^title\s*:", line)), None
            )
            if n is not None:
                put(starts[n] + len(lines[n]), m.status, yaml=True)
            continue
        section = by_key.get(m.section_key)
        where = body_at.get(m.section_key)
        if section is None or where is None:
            continue
        heading_at, body_start = where
        if m.where == "heading":
            if heading_at is not None:
                put(heading_at + m.insert_at, m.status)
        elif body_start is not None:
            put(body_start + m.insert_at, m.status)
    out: list[str] = []
    last = 0
    for at in sorted(inserts):
        out.append(markdown[last:at])
        out.append(inserts[at])
        last = at
    out.append(markdown[last:])
    return "".join(out)


def _section_offsets(
    markdown: str, sections: Sequence[Any]
) -> dict[str, tuple[int | None, int | None]]:
    """Each section's heading text and body offsets in the whole markdown."""
    out: dict[str, tuple[int | None, int | None]] = {}
    cursor = 0
    for s in sections:
        anchor = re.compile(
            r"^#{1,3}[ \t]+(.*?)[ \t]*\{#" + re.escape(s.section_key) + r"\}[ \t]*$", re.M
        )
        m = anchor.search(markdown, cursor)
        if m is None:
            out[s.section_key] = (None, None)
            continue
        heading_at = markdown.find(s.heading, m.start(1)) if s.heading else m.start(1)
        body_at = markdown.find(s.body_md, m.end()) if s.body_md else m.end()
        out[s.section_key] = (
            heading_at if heading_at >= 0 else None,
            body_at if body_at >= 0 else None,
        )
        cursor = m.end()
    return out


def strip_mark_comments(markdown: str) -> str:
    """A draft with Oracle's date marker comments removed (an exported body imports as
    the text it was exported from)."""
    return DATE_MARK_COMMENT_RE.sub("", markdown)
