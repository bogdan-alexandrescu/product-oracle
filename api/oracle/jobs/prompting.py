"""Prompts, model answers and the house rules a proposed section body must follow.

Prompts are files under ``prompts/`` named ``<kind>.v<N>.md`` (see its README); a job
records the one it ran with. Answers are one JSON object, possibly fenced or wrapped in
prose, which :func:`parse_answer` digs out.

:func:`clean_body` enforces O1c and keeps section ids intact on any text a model
proposes for a section body: citation markers, links and bare URLs leave the body (the
Sources and data points section carries sources), and headings of level 1-3 become
level 4 so a body can never open, rename or drop a section. O1e: numbers stay.

Every pattern here reads untrusted text (an approver's edit, model output) and must stay
linear: no nested quantifiers, no leading ``\\s*`` without a lookbehind, no scan that runs
past the next opening bracket. ``re`` holds the GIL while it matches, so a slow pattern
freezes the whole process even on a worker thread (tests/test_prompting_regex_dos.py).
"""

import asyncio
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
    "refinement_batch": "refinement_batch.v2",
    "decision_options": "decision_options.v1",
    "discussion_reply": "discussion_reply.v2",
    "discussion_summary": "discussion_summary.v1",
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


_FENCE = re.compile(r"```(?:json)?\s*+(.*?)```", re.S)


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


#: The most section text the house rules read: the spec's cap on text (200k characters).
#: Request fields refuse more (422); a model answer with more is not used.
MAX_BODY_CHARS = 200_000

# A parenthesis group, up to its first ")", with at most one "(" inside: what main
# matched on real links ("Foo_(bar)"), without a scan that runs into the next group.
_PAREN = r"\((?:[^()]*\()?[^()]*\)"
_CITATION = re.compile(r"(?<![ \t])[ \t]*\[c:[^\[\]]*\]")
# The destination is atomic: each part has one way to match, so a failed link is given
# up at once instead of trying every split of its characters.
_LINK = re.compile(r"(?<!!)\[([^\[\]]+)\]\((?>(?:[^()\s]+|" + _PAREN + r")+)(?:\s+\"[^\"]*\")?\)")
_IMAGE = re.compile(r"!\[([^\[\]]*)\]" + _PAREN)
_URL = re.compile(r"(?<![ \t])[ \t]*<?https?://[^\s)>]+>?")
_EMPTY_PARENS = re.compile(r"(?<![ \t])[ \t]*\(\s*\)")
_HEADING = re.compile(r"^(\s{0,3})(#{1,3})(\s)", re.M)
# An id and the spaces beside it, on its line only ([^\S\n]: whitespace, not a newline).
_HEADING_ID = re.compile(r"(?<![^\S\n])[^\S\n]*\{#[^{}\n]*\}[^\S\n]*$", re.M)
_OWN_HEADING = re.compile(r"\s{0,3}#{1,3}\s+(.*)")


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
    own = _OWN_HEADING.match(first)
    title = own.group(1).rstrip() if own else ""
    if own and ("{#" in title or (heading and title.strip().lower() == heading.strip().lower())):
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


async def clean_body_in_thread(body: str, heading: str | None = None) -> CleanBody:
    """:func:`clean_body` on a worker thread, so the event loop serves other requests
    between its passes. It is no guard against a slow pattern (``re`` holds the GIL while
    it matches): the patterns must stay linear and the text capped."""
    return await asyncio.to_thread(clean_body, body, heading)


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
