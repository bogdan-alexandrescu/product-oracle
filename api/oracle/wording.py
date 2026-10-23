"""#396 Warnings speak the app's words: the one helper for the warnings and gate messages a
person reads (a version's warnings, an import's problems, the publish gate's blocks).

A person can act on "record a date basis on Plan › Dates", not on an API route, and a raw
id tells them nothing. So a message names the document by its title and the section by
its heading, says where in the app to act, and never carries an HTTP method, a ``/v1/``
route or a UUID; the ids stay in the machine fields (``code``, ``refs``,
``section_keys``) for agents and the API.

:func:`say` is the guard every served message passes through (the schemas' validators):
it rewrites the wording stored on versions before #396 and, should a new message still
carry a route or an id, drops it and logs the message so it is fixed at its builder.
"""

import logging
import re
from collections.abc import Sequence

log = logging.getLogger(__name__)

# Where a person records the estimate, capacity or commitment a date rests on (F3,
# Plan › Dates). A viewer cannot record one: the engineering lead can.
RECORD_DATE_BASIS = "record a date basis on Plan › Dates (or ask the engineering lead to)"
MISSING_SOURCE_ITEM = "a source item Oracle no longer has"

_METHOD = r"\b(?:GET|POST|PUT|PATCH|DELETE)\b"
_UUID = r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
_API_WORDS = re.compile(rf"/v1/|{_METHOD}|{_UUID}")

# The wording stored on versions before #396, as the old builders wrote it.
_LEGACY: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"record one \(POST /v1/schedule-bases\)"), RECORD_DATE_BASIS),
    (re.compile(r"\(record one with POST /v1/schedule-bases\)"), f"({RECORD_DATE_BASIS})"),
    (
        re.compile(r"Record a basis \(POST /v1/schedule-bases\)"),
        "Record a date basis on Plan › Dates (or ask the engineering lead to),",
    ),
    (
        re.compile(r"citation '[^']*' names source item '[^']*', which this company does not have"),
        f"a citation names {MISSING_SOURCE_ITEM}",
    ),
]
# What is left of a route or an id after that: dropped (a parenthesised route with its
# brackets), a bare route as "the app", an id as "an item".
_FALLBACK: list[tuple[re.Pattern[str], str]] = [
    (re.compile(rf"\s*\((?:[^()]*\s)?{_METHOD} /v1/[^()]*\)"), ""),
    (re.compile(rf"{_METHOD} /v1/\S*"), "the app"),
    (re.compile(r"/v1/\S*"), "the app"),
    (re.compile(_METHOD), "a request"),
    (re.compile(_UUID), "an item"),
]


def api_words(text: str) -> list[str]:
    """The HTTP methods, ``/v1/`` routes and UUIDs in ``text``, in order: what a message a
    person reads must not carry."""
    return [m.group(0) for m in _API_WORDS.finditer(text)]


def say(text: str) -> str:
    """``text`` in the app's words: the pre-#396 wording rewritten, and any route or id
    still in it dropped (and logged, so its builder is fixed)."""
    if not _API_WORDS.search(text):
        return text
    for pattern, repl in _LEGACY:
        text = pattern.sub(repl, text)
    if not _API_WORDS.search(text):
        return text
    log.warning("a message a person reads carried API words: %r", text)
    for pattern, repl in _FALLBACK:
        text = pattern.sub(repl, text)
    return text


def quoted(name: str | None, fallback: str) -> str:
    """A title or heading as a person sees it, in quotes; ``fallback`` when it is blank."""
    name = (name or "").strip()
    return f'"{name}"' if name else fallback


def listed(names: Sequence[str]) -> str:
    """``"A"``, ``"A" and "B"``, ``"A", "B" and "C"``."""
    if len(names) <= 1:
        return "".join(names)
    return f"{', '.join(names[:-1])} and {names[-1]}"


def unknown_source_item(headings: Sequence[str]) -> str:
    """The warning for a citation whose source item this company does not have (another
    company's, deleted, or not an id at all); ``headings``: the sections citing it."""
    where = (
        f" in {listed([quoted(h, 'an untitled section') for h in headings])}" if headings else ""
    )
    return f"a citation{where} names {MISSING_SOURCE_ITEM}; the citation is kept without it"
