"""Prompts, model answers and the house rules a proposed section body must follow.

Prompts are files under ``prompts/`` named ``<kind>.v<N>.md`` (see its README); a job
records the one it ran with. Answers are one JSON object, possibly fenced or wrapped in
prose, which :func:`parse_answer` digs out.

:func:`clean_body` enforces O1c and keeps section ids intact on any text a model
proposes for a section body: citation markers, links and bare URLs leave the body (the
Sources and data points section carries sources), and headings of level 1-3 become
level 4 so a body can never open, rename or drop a section. O1e: numbers stay.
"""

import json
import re
from dataclasses import dataclass, field
from functools import cache
from pathlib import Path
from typing import Any

PROMPTS = Path(__file__).resolve().parent / "prompts"

#: The prompt each job kind runs with.
CURRENT = {
    "review_comments": "review_comments.v1",
    "reporting": "reporting.v1",
    "refinement": "refinement.v1",
    "intake_analysis": "intake_analysis.v2",
    "quality_review": "quality_review.v1",
}


@cache
def load(name: str) -> str:
    return (PROMPTS / f"{name}.md").read_text(encoding="utf-8")


def current(kind: str) -> tuple[str, str]:
    """(prompt name, prompt text) for a job kind."""
    name = CURRENT[kind]
    return name, load(name)


class AnswerError(ValueError):
    """The model's answer is not the JSON object its prompt asks for."""


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def parse_answer(text: str) -> dict[str, Any]:
    candidates = [m.group(1) for m in _FENCE.finditer(text)]
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    candidates.append(text)
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    raise AnswerError("the model did not answer with a JSON object")


def as_str(value: Any, limit: int = 20_000) -> str:
    if value is None:
        return ""
    return (value if isinstance(value, str) else str(value)).strip()[:limit]


_CITATION = re.compile(r"[ \t]*\[c:[^\]]*\]")
_LINK = re.compile(r"(?<!!)\[([^\]]+)\]\((?:[^()\s]+|\([^)]*\))+(?:\s+\"[^\"]*\")?\)")
_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_URL = re.compile(r"[ \t]*<?https?://[^\s)>]+>?")
_EMPTY_PARENS = re.compile(r"[ \t]*\(\s*\)")
_HEADING = re.compile(r"^(\s{0,3})(#{1,3})(\s)", re.M)
_HEADING_ID = re.compile(r"\s*\{#[^}]*\}\s*$", re.M)


@dataclass
class CleanBody:
    text: str
    # What had to go, for the job's output: "citation_markers", "links", "urls",
    # "headings".
    fixes: list[str] = field(default_factory=list)


def clean_body(body: str, heading: str | None = None) -> CleanBody:
    """A section body that follows O1c and cannot touch section ids."""
    fixes: list[str] = []
    text = body.replace("\r\n", "\n").strip("\n")
    # A body that starts with the section's own heading line (repeated, or carrying a
    # section id): drop the line, the section keeps its heading and id.
    first, _, rest = text.partition("\n")
    own = re.match(r"^\s{0,3}#{1,3}\s+(.*?)\s*$", first)
    if own and (
        "{#" in own.group(1)
        or (heading and own.group(1).strip().lower() == heading.strip().lower())
    ):
        text = rest.strip("\n")
        fixes.append("headings")
    for pattern, replacement, fix in (
        (_CITATION, "", "citation_markers"),
        (_IMAGE, r"\1", "links"),
        (_LINK, r"\1", "links"),
        (_URL, "", "urls"),
    ):
        text, n = pattern.subn(replacement, text)
        if n and fix not in fixes:
            fixes.append(fix)
    text = _EMPTY_PARENS.sub("", text)
    text, n = _HEADING.subn(r"\1####\3", text)
    if n and "headings" not in fixes:
        fixes.append("headings")
    text, n = _HEADING_ID.subn("", text)
    if n and "headings" not in fixes:
        fixes.append("headings")
    return CleanBody(text=text.strip("\n"), fixes=fixes)


def body_problems(body: str) -> list[str]:
    """O1c / section-id problems left in a body (empty when it is clean)."""
    problems = []
    if _CITATION.search(body):
        problems.append("citation_markers")
    if _LINK.search(body) or _IMAGE.search(body):
        problems.append("links")
    if _URL.search(body):
        problems.append("urls")
    if _HEADING.search(body):
        problems.append("headings")
    return problems
