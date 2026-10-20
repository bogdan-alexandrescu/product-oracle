"""Draft parser: YAML front matter + markdown body -> sections and citations.

Pure functions, no database. See docs/mvp-app.md 'Draft import format'.

``parse_draft`` either returns a :class:`ParsedDraft` or raises :class:`DraftError`
carrying EVERY problem found (missing ids, duplicate ids, unknown citations, bad
front matter), so the agent track can fix a draft in one pass.
"""

import hashlib
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from markdown_it import MarkdownIt
from markdown_it.token import Token
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from oracle import safe_yaml
from oracle.config import get_settings
from oracle.docs import layers
from oracle.docs.schemas import CitationSource, ImportProblem
from oracle.review.schemas import Resolution

# Levels 1-3 start a section; deeper headings are part of the section body.
SECTION_LEVELS = (1, 2, 3)
SECTION_ID_RE = re.compile(r"\s*\{#([A-Za-z0-9][A-Za-z0-9_.:-]*)\}\s*$")
CITATION_RE = re.compile(r"\[c:([^\]\s]+)\]")
# A citation marker plus the horizontal space before it, removed from body_text.
CITATION_STRIP_RE = re.compile(r"[ \t]*\[c:[^\]\s]+\]")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")

_md = MarkdownIt("commonmark", {"html": False}).enable("table")


class DraftError(ValueError):
    def __init__(self, problems: list[ImportProblem]):
        self.problems = problems
        super().__init__("; ".join(p.message for p in problems))


class CitationIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(min_length=1)
    source: CitationSource
    ref: str = Field(min_length=1)
    title: str | None = None
    excerpt: str | None = None
    retrieved_at: datetime | None = None


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
        text = CITATION_STRIP_RE.sub("", text).strip()
        if row is not None:
            row.append(text.replace("|", "\\|"))
        elif text:
            blocks.append(text)
    return "\n".join(blocks)


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
        key = str(item.get("id")) if isinstance(item, dict) and item.get("id") else None
        try:
            citation = CitationIn.model_validate(
                {**item, "id": key} if isinstance(item, dict) else item
            )
        except ValidationError as exc:
            fields = ", ".join(".".join(map(str, e["loc"])) for e in exc.errors())
            problems.append(
                ImportProblem(
                    code="invalid_citation",
                    message=f"citation #{i + 1} ({key or 'no id'}) is invalid: {fields}",
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
    for token_index, token in enumerate(tokens := _md.parse(body)):
        if token.type != "heading_open" or token.map is None:
            continue
        level = int(token.tag[1])
        if level not in SECTION_LEVELS:
            continue
        raw = tokens[token_index + 1].content.strip()
        match = SECTION_ID_RE.search(raw)
        start, end = token.map
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


def parse_draft(markdown: str) -> ParsedDraft:
    """Parse and validate a draft. Raises :class:`DraftError` listing every problem."""
    # The request body is capped (413); a run's file is not, so the draft is too.
    limit = get_settings().max_body_bytes
    if len(markdown.encode("utf-8")) > limit:
        raise DraftError(
            [ImportProblem(code="draft_too_large", message=f"draft is larger than {limit} bytes")]
        )
    text = normalize(markdown)
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


def is_uuid(value: str) -> bool:
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True
