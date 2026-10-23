"""#396 Warnings speak the app's words: the one helper for the warnings and gate messages a
person reads (a version's warnings, an import's problems, the publish gate's blocks).

A person can act on "record a date basis on Plan › Dates", not on an API route, and a raw
id tells them nothing. So a message names the document by its title and the section by
its heading, says where in the app to act, and never carries an HTTP method, a ``/v1/``
route or a UUID; the ids stay in the machine fields (``code``, ``refs``,
``section_keys``) for agents and the API.

:func:`legacy` reads the wording stored on versions before #396 (the version warning's
validator): it rewrites only those exact phrases and moves any id they carried into
``refs``. Nothing else is rewritten, so no message loses an id; a builder gives its own
message the app's words and its ids ``refs`` (tests/test_warning_wording.py scans them).
"""

import re
from collections.abc import Mapping, Sequence

from fastapi import HTTPException

# Where a person records the estimate, capacity or commitment a date rests on (F3,
# Plan › Dates). A viewer cannot record one: the engineering lead can.
RECORD_DATE_BASIS = "record a date basis on Plan › Dates (or ask the engineering lead to)"
MISSING_SOURCE_ITEM = "a source item Oracle no longer has"
# A spec version (or its flow or wireframe) whose PRD changed since it was written (C2):
# the tech brief's page shows the reasons beside its Potentially stale label, and (#481)
# the Review and Reconcile controls that settle it.
STALE = (
    "may be stale: the PRD it rests on changed since it was written (the reasons are beside "
    "its Potentially stale label). Review or reconcile it from its tech brief page "
    "(Potentially stale › Review / Reconcile) before approving"
)

Refs = dict[str, str | list[str]]


class Refused(HTTPException):
    """A refusal a person reads (``detail``, in the app's words) with the ids agents need
    beside it (``refs``); oracle.main serves it as ``{"detail": ..., "refs": ...}``."""

    def __init__(
        self,
        status_code: int,
        detail: str,
        refs: Refs,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        # The headers of the error it replaces (a Retry-After) are kept.
        super().__init__(status_code, detail, headers)
        self.refs = refs


_METHOD = r"\b(?:GET|POST|PUT|PATCH|DELETE)\b"
_UUID = r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
_API_WORDS = re.compile(rf"/v1/|{_METHOD}|{_UUID}")

# The wording stored on versions before #396, as the old builders wrote it: the date
# messages' routes, and the ids the citation and left-open feedback warnings named.
_LEGACY_ROUTES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"record one \(POST /v1/schedule-bases\)"), RECORD_DATE_BASIS),
    (re.compile(r"\(record one with POST /v1/schedule-bases\)"), f"({RECORD_DATE_BASIS})"),
    (
        re.compile(r"Record a basis \(POST /v1/schedule-bases\)"),
        "Record a date basis on Plan › Dates (or ask the engineering lead to),",
    ),
]
_LEGACY_CITATION = re.compile(
    r"citation '(?P<cite_key>[^']*)' names source item '(?P<source_item>[^']*)', which this "
    r"company does not have"
)
_LEGACY_LEFT_OPEN = re.compile(r"these stay open: (?P<ids>.+)$")


def api_words(text: str) -> list[str]:
    """The HTTP methods, ``/v1/`` routes and UUIDs in ``text``, in order: what a message a
    person reads must not carry."""
    return [m.group(0) for m in _API_WORDS.finditer(text)]


def legacy(text: str) -> tuple[str, Refs]:
    """``text`` as stored before #396, in the app's words, and the ids it named (for
    ``refs``). Any other text is returned as it is."""
    if not _API_WORDS.search(text):
        return text, {}
    for pattern, repl in _LEGACY_ROUTES:
        text = pattern.sub(repl, text)
    refs: Refs = {}
    if m := _LEGACY_CITATION.search(text):
        refs = {"cite_key": m["cite_key"], "source_item": m["source_item"]}
        text = text[: m.start()] + f"a citation names {MISSING_SOURCE_ITEM}" + text[m.end() :]
    elif m := _LEGACY_LEFT_OPEN.search(text):
        ids = [i.strip() for i in m["ids"].split(",")]
        refs = {"feedback_items": ids}
        text = text[: m.start()] + _left_open(len(ids))
    return text, refs


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


def _left_open(n: int) -> str:
    return f"{n} feedback item{'s stay' if n != 1 else ' stays'} open"


def feedback_left_open(
    skipped: Mapping[str, str | None], headings: Mapping[str, str]
) -> tuple[str, Refs]:
    """The warning for the feedback an agent's draft may not close, and its ``refs``;
    ``skipped``: feedback id -> the section it is on (None: the whole document). The
    message names each section by its heading; the feedback ids are in ``refs``."""
    keys = list(dict.fromkeys(skipped.values()))
    places = [quoted(headings.get(k), "an untitled section") for k in keys if k]
    if None in keys:
        places.append("the document")
    message = (
        "an agent's draft closes feedback only as addressed, and only on a section whose text "
        f"or evidence it changed in this version; {_left_open(len(skipped))}: on "
        f"{listed(places)}"
    )
    return message, {"feedback_items": list(skipped)}
