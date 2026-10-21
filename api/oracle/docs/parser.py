"""Draft parser: YAML front matter + markdown body -> sections and citations.

Pure functions, no database. See docs/mvp-app.md 'Draft import format'.

``parse_draft`` either returns a :class:`ParsedDraft` or raises :class:`DraftError`
carrying EVERY problem found (missing ids, duplicate ids, unknown citations, bad
front matter), so the agent track can fix a draft in one pass.
"""

import hashlib
import json
import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from markdown_it import MarkdownIt
from markdown_it.token import Token
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from oracle import parse_budget, safe_yaml
from oracle.config import get_settings
from oracle.docs import layers
from oracle.docs.schemas import (
    CONFIDENCE_MAX,
    CONFIDENCE_MIN,
    CONFIDENCE_RANGE,
    CitationSource,
    ImportProblem,
)
from oracle.review.schemas import Resolution

# Levels 1-3 start a section; deeper headings are part of the section body.
SECTION_LEVELS = (1, 2, 3)
SECTION_ID_RE = re.compile(r"(?<!\s)\s*\{#([A-Za-z0-9][A-Za-z0-9_.:-]*)\}\s*$")
CITATION_RE = re.compile(r"\[c:([^\[\]\s]+)\]")
# A citation marker plus the horizontal space before it, removed from body_text.
CITATION_STRIP_RE = re.compile(r"(?<![ \t])[ \t]*\[c:[^\[\]\s]+\]")


def strip_citations(text: str) -> str:
    """``text`` without its ``[c:id]`` markers. A nested ``[c:[c:x]a]`` leaves ``[c:a]``
    after one pass, so strip until the text stops changing (at most 3 passes)."""
    for _ in range(3):
        stripped = CITATION_STRIP_RE.sub("", text)
        if stripped == text:
            break
        text = stripped
    return text


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

# The markers an export writes after a roadmap date that rests on no verified basis
# (oracle.roadmap.doc_dates.annotate_markdown): dropped on import, so an exported body
# imports as the text it was exported from.
DATE_MARK_COMMENT_RE = re.compile(
    r"[ \t]?(?:<!-- oracle: date (?:unverified|withdrawn) -->"
    r"|# oracle: date (?:unverified|withdrawn)$)",
    re.M,
)
# The banner line a markdown export writes after the front matter
# (oracle.export.render.render_markdown), dropped on import with the markers above.
EXPORT_BANNER_RE = re.compile(r"^<!-- Product Oracle export: [^\n]*? -->\n", re.M)

# Every parse of a draft is of untrusted text: guarded (oracle.parse_budget), so a parse
# stops at its CPU budget. The sections come from the block structure alone (headings and
# their lines need no inline parse); a section's body text from a full parse of its body.
_md = parse_budget.guard(MarkdownIt("commonmark", {"html": False}).enable("table"))
_blocks = parse_budget.guard(
    MarkdownIt("commonmark", {"html": False}).enable("table").disable(["inline", "text_join"])
)

# The longest line a draft's body may hold (owner decision, 2026-10-20). Checked once,
# linearly, before any markdown parse: markdown-it's inline parse is quadratic on one long
# line of tag-like text ('<b>' x 300k, 900 KB, took ~40 s).
MAX_LINE = 20_000
# The most '[' an inline block (a paragraph, heading or table cell) may leave open at once:
# markdown-it's own nesting limit (``maxNesting``), past which it no longer parses nested
# links as written. Many open brackets are what makes its link scan slow ('![' x 500k
# took ~35 s), so such a block is refused before its inline parse.
MAX_OPEN_BRACKETS = 20
_BRACKET_OR_ESCAPE = re.compile(r"\\.|[\[\]]", re.S)


def long_line(text: str) -> int | None:
    """The 1-based number of the first line of ``text`` over :data:`MAX_LINE` characters,
    or None. Linear."""
    for number, line in enumerate(text.split("\n"), start=1):
        if len(line) > MAX_LINE:
            return number
    return None


def too_many_open_brackets(text: str) -> bool:
    """``text`` (one inline block) leaves more than :data:`MAX_OPEN_BRACKETS` '[' open at
    some point (a backslash-escaped bracket does not count). Linear."""
    depth = 0
    for m in _BRACKET_OR_ESCAPE.finditer(text):
        if m.group() == "[":
            depth += 1
            if depth > MAX_OPEN_BRACKETS:
                return True
        elif m.group() == "]" and depth:
            depth -= 1
    return False


class DraftError(ValueError):
    def __init__(self, problems: list[ImportProblem]):
        self.problems = problems
        super().__init__("; ".join(p.message for p in problems))


# A citation id: what a [c:id] marker can name, and nothing that could break a line of the
# markdown it is served in (E1: a spec names its added sources by id).
CITATION_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$"


class CitationIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(pattern=CITATION_ID_PATTERN)
    source: CitationSource
    ref: str = Field(min_length=1)
    title: str | None = None
    excerpt: str | None = None
    retrieved_at: datetime | None = None
    # What the writer computed for this citation (owner decision 2026-10-20). ``item`` is
    # kept as written: the import checks it against the company's source items and drops
    # one it does not have with a warning, never a refusal.
    item: str | None = None
    confidence: float | None = Field(default=None, ge=CONFIDENCE_MIN, le=CONFIDENCE_MAX)
    # Why there is no score, or how it was reached ("owner decision, locked").
    confidence_note: str | None = None
    low_confidence: bool = False

    @field_validator("item", mode="before")
    @classmethod
    def _item_as_text(cls, value: Any) -> str | None:
        return _optional_str(value)


@dataclass
class ParsedSection:
    section_key: str
    ordinal: int
    level: int
    heading: str
    body_md: str
    body_text: str
    citation_keys: list[str]
    line: int  # 1-based line of the heading in the whole file
    # 1-based line in the whole file where the body starts (the parser's token.map[1]):
    # after the heading line, or after a setext heading's underline.
    body_line: int = 0
    # The heading's markup ("#".."###" for ATX, "=" or "-" for setext) and its nesting
    # (0 at the top level, more inside a list or block quote).
    markup: str = "#"
    nesting: int = 0

    @property
    def content_hash(self) -> str:
        return sha256(f"{self.level}\n{self.heading}\n{self.body_md}")


@dataclass
class ParsedDraft:
    document: str | None
    title: str
    template: str | None
    template_version: str | None
    snapshot: str | None
    front_matter: dict[str, Any]
    citations: list[CitationIn]
    resolutions: list[Resolution]
    sections: list[ParsedSection]
    markdown: str
    content_hash: str
    # O1f: the front matter's ``brief: [section ids]``; None when the draft has none.
    brief: list[str] | None = None
    problems: list[ImportProblem] = field(default_factory=list)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# (cite key, ref, title, excerpt, source, retrieved_at) of a citation a section cites.
CitedEntry = tuple[str, str | None, str | None, str | None, str | None, str | None]


def section_revision(content_hash: str, layer: str, cited: list[CitedEntry]) -> str:
    """A section's revision: its text (``content_hash``), the citation entries it cites
    (ref, title, excerpt, source and retrieved_at, in citing order) and its brief-layer
    membership, so changing the evidence behind a section, or moving it in or out of the
    brief, is a new revision (CR-06). A detail section that cites nothing keeps its
    content hash. Section links are not part of it: they are added after a version is
    imported, so the review state adds them (``oracle.review.state.review_revision``)."""
    if layer != "brief" and not cited:
        return content_hash
    canonical = json.dumps(
        [content_hash, layer, [list(c) for c in cited]], ensure_ascii=False, separators=(",", ":")
    )
    return sha256(canonical)


def instant(value: datetime | str | None) -> str | None:
    """A citation's ``retrieved_at`` as the revision reads it: UTC, ISO 8601 (a time
    without a zone is UTC, as the database stores it)."""
    if value is None or isinstance(value, str):
        return value
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC).isoformat()
    return value.astimezone(UTC).isoformat()


def cited_entries(citation_keys: list[str], citations: dict[str, Any]) -> list[CitedEntry]:
    """The entries a section cites, from ``citations`` by cite key (objects with
    ``ref``, ``title``, ``excerpt``, ``source`` and ``retrieved_at``); unknown keys are
    skipped."""
    out: list[CitedEntry] = []
    for key in citation_keys:
        c = citations.get(key)
        if c is not None:
            out.append((key, c.ref, c.title, c.excerpt, c.source, instant(c.retrieved_at)))
    return out


def normalize(markdown: str) -> str:
    """LF line endings, no BOM, exactly one trailing newline."""
    text = markdown.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    return text.rstrip() + "\n"


def _jsonable(value: Any) -> Any:
    """YAML may produce dates; front_matter is stored as JSON."""
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    return value if isinstance(value, str) else str(value)


def split_front_matter(text: str) -> tuple[str | None, str, int]:
    """Return (yaml_text or None, body, number of lines before the body)."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, text, 0
    for i in range(1, len(lines)):
        if lines[i].strip() in ("---", "..."):
            return "\n".join(lines[1:i]), "\n".join(lines[i + 1 :]), i + 1
    return None, text, 0


def _inline_text(token: Token) -> str:
    out: list[str] = []
    for child in token.children or []:
        if child.type in ("text", "code_inline"):
            out.append(child.content)
        elif child.type in ("softbreak", "hardbreak"):
            out.append("\n")
        elif child.type == "image":
            out.append(_inline_text(child))
    return "".join(out)


def body_text(body_md: str) -> str:
    """Plain text of a section body, as the reader sees it (citation markers removed).

    A table keeps its rows: one line per row (header first, separator row dropped),
    cells joined by ``" | "``; a literal ``|`` inside a cell is kept as ``\\|``. The
    version diff rebuilds tables from these rows.

    Comment anchors (TextQuoteSelector) are relative to this text.
    """
    blocks: list[str] = []
    row: list[str] | None = None
    for token in _md.parse(body_md):
        parse_budget.check()
        if token.type == "tr_open":
            row = []
            continue
        if token.type == "tr_close":
            if row is not None and any(row):
                blocks.append(" | ".join(row))
            row = None
            continue
        if token.type == "inline":
            text = _inline_text(token)
        elif token.type in ("fence", "code_block"):
            text = token.content.rstrip("\n")
        else:
            continue
        text = strip_citations(text).strip()
        if row is not None:
            row.append(text.replace("|", "\\|"))
        elif text:
            blocks.append(text)
    return "\n".join(blocks)


def unclosed_fence(body_md: str) -> str | None:
    """The marker of a code fence ``body_md`` leaves open at its end, else ``None``. An
    open fence swallows whatever follows it, headings of later sections included, so a
    draft composed from sections closes it (``oracle.jobs.service.compose_markdown``).
    Trailing whitespace-only lines are ignored: the parser may or may not count them
    into the fence."""
    lines = body_md.split("\n")
    while lines and not lines[-1].strip():
        lines.pop()
    for token in reversed(_md.parse(body_md)):
        if token.level != 0 or token.map is None:
            continue
        if token.type != "fence":
            return None
        start, end = token.map
        if end < len(lines):
            return None
        marker = token.markup
        closing = re.compile(rf" {{0,3}}{re.escape(marker[0])}{{{len(marker)},}}[ \t]*")
        last = len(lines) - 1
        if last > start and closing.fullmatch(lines[last]):
            return None
        return marker
    return None


def section_keys(markdown: str) -> list[str]:
    """The section keys of a draft, in order, as :func:`parse_draft` reads them; other
    problems are ignored (a composed draft is checked for lost sections with it)."""
    _, body, offset = split_front_matter(normalize(markdown))
    return [s.section_key for s in _parse_sections(body, offset, []) if s.section_key]


def _parse_front_matter(yaml_text: str | None, problems: list[ImportProblem]) -> dict[str, Any]:
    if yaml_text is None:
        problems.append(
            ImportProblem(
                code="missing_front_matter",
                message="draft must start with YAML front matter between '---' lines",
                line=1,
            )
        )
        return {}
    try:
        data = safe_yaml.load(yaml_text) or {}
    except safe_yaml.SafeYamlError as exc:
        # Invalid or refused (oracle.safe_yaml): too large, too deep, anchors, tags...
        problems.append(
            ImportProblem(
                code="invalid_front_matter",
                message=f"front matter is not valid YAML: {exc}",
                line=exc.line + 1 if exc.line else None,
            )
        )
        return {}
    if not isinstance(data, dict):
        problems.append(
            ImportProblem(code="invalid_front_matter", message="front matter must be a mapping")
        )
        return {}
    return _jsonable(data)


def _shown_id(key: str | None) -> str:
    """A citation id as a problem names it: JSON-quoted when it is not a valid id."""
    if not key:
        return "no id"
    return key if re.fullmatch(CITATION_ID_PATTERN, key) else json.dumps(key[:100])


def _citation_field(error: Any) -> str:
    """What is wrong with one field of a citation: the field, a source this Oracle does not
    accept by name, and a confidence that is not a number from 0 to 1 (the run page groups
    refused citations by it)."""
    if tuple(error["loc"]) == ("source",) and error["type"] == "literal_error":
        return f"source '{error['input']}' isn't accepted"
    if tuple(error["loc"]) == ("confidence",):
        return f"confidence must be {CONFIDENCE_RANGE}"
    return ".".join(map(str, error["loc"]))


def _parse_citations(raw: Any, problems: list[ImportProblem]) -> list[CitationIn]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        problems.append(
            ImportProblem(code="invalid_citation", message="'citations' must be a list")
        )
        return []
    citations: list[CitationIn] = []
    seen: set[str] = set()
    for i, item in enumerate(raw):
        parse_budget.check()
        key = str(item.get("id")) if isinstance(item, dict) and item.get("id") else None
        try:
            citation = CitationIn.model_validate(
                {**item, "id": key} if isinstance(item, dict) else item
            )
        except ValidationError as exc:
            fields = ", ".join(_citation_field(e) for e in exc.errors())
            if any(e["loc"] == ("id",) for e in exc.errors()):
                fields += " (letters, digits and _ . : -, up to 100, from a letter or digit)"
            problems.append(
                ImportProblem(
                    code="invalid_citation",
                    message=f"citation #{i + 1} ({_shown_id(key)}) is invalid: {fields}",
                    cite_key=key,
                )
            )
            continue
        if citation.id in seen:
            problems.append(
                ImportProblem(
                    code="duplicate_citation",
                    message=f"citation id '{citation.id}' is defined more than once",
                    cite_key=citation.id,
                )
            )
            continue
        seen.add(citation.id)
        citations.append(citation)
    return citations


def _parse_resolutions(raw: Any, problems: list[ImportProblem]) -> list[Resolution]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        problems.append(
            ImportProblem(code="invalid_resolution", message="'resolutions' must be a list")
        )
        return []
    resolutions: list[Resolution] = []
    for i, item in enumerate(raw):
        parse_budget.check()
        try:
            resolutions.append(Resolution.model_validate(item))
        except ValidationError as exc:
            fields = ", ".join(".".join(map(str, e["loc"])) for e in exc.errors())
            problems.append(
                ImportProblem(
                    code="invalid_resolution",
                    message=f"resolution #{i + 1} is invalid: {fields}",
                )
            )
    return resolutions


def _parse_sections(
    body: str, line_offset: int, problems: list[ImportProblem]
) -> list[ParsedSection]:
    lines = body.split("\n")
    # (heading line index, body start index, level, heading text or None, key or None)
    heads: list[tuple[int, int, int, str, str | None]] = []
    shape: dict[int, tuple[str, int]] = {}
    tokens = _blocks.parse(body)
    crowded = next(
        (t for t in tokens if t.type == "inline" and too_many_open_brackets(t.content)), None
    )
    if crowded is not None:
        # Refused before any inline parse (the body text below is one per section).
        line = crowded.map[0] + 1 + line_offset if crowded.map else None
        raise DraftError(
            [
                *problems,
                ImportProblem(
                    code="too_many_open_brackets",
                    message=f"a paragraph leaves more than {MAX_OPEN_BRACKETS} '[' open: "
                    "close them, or write a literal one as '\\['",
                    line=line,
                ),
            ]
        )
    for token_index, token in enumerate(tokens):
        parse_budget.check()
        if token.type != "heading_open" or token.map is None:
            continue
        level = int(token.tag[1])
        if level not in SECTION_LEVELS:
            continue
        raw = tokens[token_index + 1].content.strip()
        match = SECTION_ID_RE.search(raw)
        start, end = token.map
        shape[start] = (token.markup, token.level)
        if match is None:
            problems.append(
                ImportProblem(
                    code="missing_section_id",
                    message=f"heading '{raw}' (level {level}) must end with {{#section-id}}",
                    line=start + 1 + line_offset,
                )
            )
            heads.append((start, end, level, raw, None))
        else:
            heads.append((start, end, level, raw[: match.start()].strip(), match.group(1)))

    first = heads[0][0] if heads else len(lines)
    if "\n".join(lines[:first]).strip():
        problems.append(
            ImportProblem(
                code="content_before_heading",
                message="text before the first heading belongs to no section",
                line=line_offset + 1,
            )
        )
    if not heads:
        problems.append(
            ImportProblem(code="no_sections", message="draft has no level 1-3 headings")
        )

    sections: list[ParsedSection] = []
    seen: set[str] = set()
    for i, (start, body_start, level, heading, key) in enumerate(heads):
        parse_budget.check()
        body_end = heads[i + 1][0] if i + 1 < len(heads) else len(lines)
        if key is None:
            continue
        line = start + 1 + line_offset
        if key in seen:
            problems.append(
                ImportProblem(
                    code="duplicate_section_id",
                    message=f"section id '{key}' is used more than once",
                    section_key=key,
                    line=line,
                )
            )
            continue
        seen.add(key)
        body_md = "\n".join(lines[body_start:body_end]).strip("\n")
        citation_keys = list(dict.fromkeys(CITATION_RE.findall(f"{heading}\n{body_md}")))
        sections.append(
            ParsedSection(
                section_key=key,
                ordinal=len(sections) + 1,
                level=level,
                heading=heading,
                body_md=body_md,
                body_text=body_text(body_md),
                citation_keys=citation_keys,
                line=line,
                body_line=body_start + 1 + line_offset,
                markup=shape[start][0],
                nesting=shape[start][1],
            )
        )
    return sections


def _check_citations(
    sections: list[ParsedSection], citations: list[CitationIn], problems: list[ImportProblem]
) -> None:
    known = {c.id for c in citations}
    for section in sections:
        for key in section.citation_keys:
            if key not in known:
                problems.append(
                    ImportProblem(
                        code="unknown_citation",
                        message=f"[c:{key}] in section '{section.section_key}' is not "
                        "defined in front matter 'citations'",
                        cite_key=key,
                        section_key=section.section_key,
                        line=section.line,
                    )
                )


def prepared(markdown: str) -> str:
    """A draft's text as :func:`parse_draft` reads it: an export's banner and date marker
    comments dropped, then :func:`normalize`."""
    return normalize(EXPORT_BANNER_RE.sub("", DATE_MARK_COMMENT_RE.sub("", markdown)))


def body_problems(text: str) -> list[ImportProblem]:
    """What refuses a draft (``text`` as :func:`prepared` reads it) before any markdown
    parse: a body line over :data:`MAX_LINE` characters. Linear. (The front matter is
    YAML, with caps of its own: :mod:`oracle.safe_yaml`.)"""
    _, body, offset = split_front_matter(text)
    number = long_line(body)
    if number is None:
        return []
    return [
        ImportProblem(
            code="line_too_long",
            message=f"line {number + offset} is over {MAX_LINE:,} characters: break it into "
            "paragraphs or list items",
            line=number + offset,
        )
    ]


def parse_draft(markdown: str) -> ParsedDraft:
    """Parse and validate a draft. Raises :class:`DraftError` listing every problem.

    Bounded: a body line over :data:`MAX_LINE` characters is refused before any markdown
    parse, a paragraph with too many open brackets before its inline parse, and the parse
    stops at its CPU budget (:mod:`oracle.parse_budget`: the caller's, else
    ``PARSE_SECONDS`` of its own, refused as ``too_slow``). CPU-bound: async callers run it
    with :func:`parse_draft_async`."""
    if parse_budget.active():
        return _parse_draft(markdown)
    seconds = safe_yaml.PARSE_SECONDS
    try:
        with parse_budget.limit(seconds):
            return _parse_draft(markdown)
    except parse_budget.Exceeded:
        raise DraftError(
            [
                ImportProblem(
                    code="too_slow",
                    message=f"the draft took more than {seconds:g} s to read; keep it small "
                    "and plain",
                )
            ]
        ) from None


def _parse_draft(markdown: str) -> ParsedDraft:
    # The request body is capped (413); a run's file is not, so the draft is too.
    limit = get_settings().max_body_bytes
    if len(markdown.encode("utf-8")) > limit:
        raise DraftError(
            [ImportProblem(code="draft_too_large", message=f"draft is larger than {limit} bytes")]
        )
    text = prepared(markdown)
    if refused := body_problems(text):
        raise DraftError(refused)
    problems: list[ImportProblem] = []

    yaml_text, body, offset = split_front_matter(text)
    fm = _parse_front_matter(yaml_text, problems)
    citations = _parse_citations(fm.get("citations"), problems)
    resolutions = _parse_resolutions(fm.get("resolutions"), problems)
    sections = _parse_sections(body, offset, problems)
    _check_citations(sections, citations, problems)
    for code, message, key in layers.brief_problems(
        fm.get("brief"), [s.section_key for s in sections]
    ):
        problems.append(ImportProblem(code=code, message=message, section_key=key))

    document = _optional_str(fm.get("document"))
    if document is not None and not SLUG_RE.match(document):
        problems.append(
            ImportProblem(
                code="invalid_document",
                message=f"document slug '{document}' must match {SLUG_RE.pattern}",
            )
        )
    title = _optional_str(fm.get("title")) or (sections[0].heading if sections else "")
    if fm and not title:
        problems.append(ImportProblem(code="missing_title", message="front matter needs a title"))

    if problems:
        raise DraftError(problems)
    return ParsedDraft(
        document=document,
        title=title,
        template=_optional_str(fm.get("template")),
        template_version=_optional_str(fm.get("template_version")),
        snapshot=_optional_str(fm.get("snapshot")),
        front_matter=fm,
        citations=citations,
        resolutions=resolutions,
        sections=sections,
        markdown=text,
        content_hash=sha256(text),
        brief=layers.marked_brief(fm),
    )


async def parse_draft_async(markdown: str) -> ParsedDraft:
    """:func:`parse_draft` on the parse pool (:func:`oracle.safe_yaml.run_parse_within`), at
    most ``PARSE_SECONDS``: the event loop never parses a draft (untrusted text)."""
    try:
        return await safe_yaml.run_parse_within(parse_draft, markdown, name="the draft")
    except safe_yaml.ParseTimeout as exc:
        raise DraftError([ImportProblem(code=exc.code, message=str(exc))]) from exc


def is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True
