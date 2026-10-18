"""Brief and full layers (O1f). Pure functions, no database.

Every document has a brief layer (slide-sized sections presented at an all-hands) and
a full layer (the whole version). A section is ``brief`` or ``detail``; the full layer
is every section. Which sections are brief comes from, in order:

1. the draft's own front matter ``brief: [section ids]`` (``draft``);
2. its template version's front matter ``brief: [...]`` (``template``);
3. a level-1 ``Full version`` heading with id ``full``: the sections before it, except
   the leading title section, are the brief (``full_heading``);
4. otherwise the version has no brief (``none``) and opens on the full document.

Presenter notes for a brief section are a fenced ``notes`` block in its body, else the
section's guidance text (the HTML comment under its heading, in the draft or in the
template).
"""

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

Layer = Literal["brief", "detail"]
BriefSource = Literal["draft", "template", "full_heading", "none"]
BRIEF: Layer = "brief"
DETAIL: Layer = "detail"
FULL_SECTION_ID = "full"
FULL_HEADING = "Full version"
SOURCES_SECTION_ID = "sources"

_NOTES_FENCE = re.compile(r"^```[ \t]*notes[ \t]*\n(.*?)^```[ \t]*$\n?", re.S | re.M)
_COMMENT = re.compile(r"<!--(.*?)-->", re.S)
# An in-document link to a section: [text](#section-id)
SECTION_LINK_RE = re.compile(r"\]\(#([A-Za-z0-9][A-Za-z0-9_.:-]*)\)")


@dataclass(frozen=True)
class SectionRef:
    key: str
    level: int


def marked_brief(front_matter: dict[str, Any] | None) -> list[str] | None:
    """The ``brief`` list of a front matter mapping; None when absent or malformed."""
    value = (front_matter or {}).get("brief")
    if isinstance(value, list) and all(isinstance(v, str) for v in value):
        return list(value)
    return None


def brief_problems(value: Any, keys: Sequence[str]) -> list[tuple[str, str, str | None]]:
    """(code, message, section_key) for a front matter ``brief`` value, given the ids
    of the document's or template's sections in order."""
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        return [("invalid_brief", "front matter 'brief' must be a list of section ids", None)]
    known = set(keys)
    in_sources = _sources_keys(keys)
    out: list[tuple[str, str, str | None]] = []
    for key in value:
        if key not in known:
            out.append(("unknown_brief_section", f"brief section '{key}' is not a section id", key))
        elif key == FULL_SECTION_ID:
            out.append(("full_section_brief", f"'{FULL_HEADING}' ({{#full}}) cannot be brief", key))
        elif key in in_sources:
            out.append(
                (
                    "sources_section_brief",
                    f"'{key}' is part of Sources and data points, which every export "
                    "appends on its own; it cannot be brief",
                    key,
                )
            )
    return out


def _sources_keys(keys: Sequence[str]) -> set[str]:
    """The sources section and every section after it (it must be last)."""
    if SOURCES_SECTION_ID not in keys:
        return set()
    return set(keys[list(keys).index(SOURCES_SECTION_ID) :])


def brief_before_full(sections: Sequence[SectionRef]) -> list[str]:
    """Sections before a level-1 ``{#full}`` heading, minus a leading level-1 title."""
    idx = next(
        (i for i, s in enumerate(sections) if s.key == FULL_SECTION_ID and s.level == 1), None
    )
    if idx is None:
        return []
    before = list(sections[:idx])
    if before and before[0].level == 1:
        before = before[1:]
    return [s.key for s in before]


def resolve_brief(
    sections: Sequence[SectionRef],
    *,
    draft_brief: list[str] | None,
    template_brief: list[str] | None,
) -> tuple[list[str], BriefSource]:
    """Which sections are brief, and where that came from (see the module docstring)."""
    keys = [s.key for s in sections]
    excluded = _sources_keys(keys) | {FULL_SECTION_ID}
    if draft_brief is not None:
        return [k for k in keys if k in set(draft_brief) - excluded], "draft"
    if template_brief:
        return [k for k in keys if k in set(template_brief) - excluded], "template"
    before = brief_before_full(sections)
    if before:
        return before, "full_heading"
    return [], "none"


def layers(keys: Iterable[str], brief: Iterable[str]) -> dict[str, Layer]:
    brief_set = set(brief)
    return {k: (BRIEF if k in brief_set else DETAIL) for k in keys}


def notes_block(body_md: str) -> str | None:
    """Text of the section's fenced ``notes`` blocks, joined; None without one."""
    found = [m.group(1).strip() for m in _NOTES_FENCE.finditer(body_md or "")]
    found = [f for f in found if f]
    return "\n\n".join(found) if found else None


def guidance(body_md: str) -> str | None:
    """The section's guidance text: its HTML comments, joined."""
    found = [" ".join(m.group(1).split()) for m in _COMMENT.finditer(body_md or "")]
    found = [f for f in found if f]
    return "\n\n".join(found) if found else None


def presenter_notes(body_md: str, template_guidance: str | None = None) -> str | None:
    return notes_block(body_md) or guidance(body_md) or template_guidance


def slide_body(body_md: str) -> str:
    """A section body as shown on a slide or in an export: no notes, no guidance."""
    text = _NOTES_FENCE.sub("", body_md or "")
    return _COMMENT.sub("", text).strip("\n")


def section_guidance(body: str) -> dict[str, str]:
    """Guidance per section id of a template (or draft) body: the comment under each
    level 1-3 heading, up to the next heading."""
    out: dict[str, str] = {}
    current: str | None = None
    chunk: list[str] = []
    heading = re.compile(r"^#{1,3}\s+.*?\{#([A-Za-z0-9][A-Za-z0-9_.:-]*)\}\s*$")

    def flush() -> None:
        if current is not None:
            text = guidance("\n".join(chunk))
            if text:
                out[current] = text

    in_fence = False
    for line in body.replace("\r\n", "\n").split("\n"):
        if line.startswith("```"):
            in_fence = not in_fence
        m = None if in_fence else heading.match(line)
        if m:
            flush()
            current, chunk = m.group(1), []
        else:
            chunk.append(line)
    flush()
    return out


def linked_sections(body_md: str) -> list[str]:
    """Section ids a body links to with ``[text](#id)``, in order, without repeats."""
    return list(dict.fromkeys(SECTION_LINK_RE.findall(_COMMENT.sub("", body_md or ""))))


def subtree(sections: Sequence[SectionRef], key: str) -> list[str]:
    """The section and the deeper sections that follow it (its sub-sections)."""
    out: list[str] = []
    level = None
    for s in sections:
        if level is None:
            if s.key == key:
                level = s.level
                out.append(s.key)
        elif s.level > level:
            out.append(s.key)
        else:
            break
    return out
