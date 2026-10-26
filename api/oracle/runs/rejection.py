"""The plain summary of a refused draft (owner, 2026-10-20): the run page, the Inbox and MCP
show the same line instead of the validator's raw list.

Problems are grouped by cause (their code; invalid citations by each field that is wrong
with them), largest group first. A knock-on ``unknown_citation`` (a reference to a citation
the parser dropped because it was invalid) counts against the rejected citation it depends
on (the same ``cite_key``), not as a cause of its own.

One analysis (:func:`_causes`), two renderings: :func:`summary`, one line for people, and
:func:`findings`, the review findings a refused draft goes back to its writer with (each
group's messages, capped, and what a valid draft does). What is stored of a refusal
(:func:`refused`) is capped too: the first :data:`MAX_PROBLEMS` problems and their count.
"""

import re
from collections import Counter
from collections.abc import Sequence
from typing import Any

from oracle.docs.schemas import ImportProblem, citation_contract

# The problem a segment that left no draft file has (oracle.runs.service._advance).
MISSING_DRAFT = "missing_draft"

# What a refusal stores (the segment, the review's payload, the runs list, the Inbox): the
# first MAX_PROBLEMS problems, and the count when there are more.
MAX_PROBLEMS = 50
# The messages a finding lists per group; the rest are counted.
FINDINGS_LISTED = 10

# What :func:`oracle.docs.parser._parse_citations` says of an invalid citation.
_INVALID = re.compile(r" is invalid: (?P<what>.+)$")
_SOURCE = re.compile(r"^source '(?P<source>.*)' isn't accepted$")
_SOURCE_START, _SOURCE_END = "source '", "' isn't accepted"

# One sentence per code: (one, many).
_PHRASES: dict[str, tuple[str, str]] = {
    "unknown_citation": (
        "1 reference cites a citation that isn't defined",
        "{n} references cite citations that aren't defined",
    ),
    "missing_section_id": (
        "1 heading has no {{#section-id}}",
        "{n} headings have no {{#section-id}}",
    ),
    "duplicate_section_id": (
        "1 section id is used more than once",
        "{n} section ids are used more than once",
    ),
    "duplicate_citation": (
        "1 citation id is defined more than once",
        "{n} citation ids are defined more than once",
    ),
}


def _plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


class _Group:
    def __init__(self, order: int, problems: list[ImportProblem], what: str | None = None):
        self.order = order
        self.problems = problems
        # Invalid citations: what is wrong with them.
        self.what = what
        # Knock-on references to these citations.
        self.knock_on = 0

    @property
    def size(self) -> int:
        return len(self.problems) + self.knock_on

    def sentence(self) -> str:
        n = len(self.problems)
        code = self.problems[0].code
        if self.what is not None:
            source = _SOURCE.match(self.what)
            if source:
                text = (
                    f"{n} {_plural(n, 'citation uses', 'citations use')} source "
                    f"'{source['source']}', which isn't accepted"
                )
            else:
                text = f"{n} {_plural(n, 'citation is', 'citations are')} invalid ({self.what})"
            if self.knock_on:
                k = self.knock_on
                fail = _plural(k, "reference fails", "references fail")
                text += f"; {k} {fail} because of {'it' if n == 1 else 'them'}"
            return text
        if code in _PHRASES:
            return _plural(n, *_PHRASES[code]).format(n=n)
        first = self.problems[0].message.rstrip(".")
        return first if n == 1 else f"{first} (and {n - 1} more like it)"


def _fields(what: str) -> list[str]:
    """The fields an invalid citation's "what" names, one per bad field: split at ", "
    outside parentheses (the id's rule has commas) and outside a refused source's quoted
    value. Linear."""
    out: list[str] = []
    rest = what
    while rest:
        end = -1
        if rest.startswith(_SOURCE_START):
            end = rest.find(_SOURCE_END, len(_SOURCE_START))
            end = end + len(_SOURCE_END) if end >= 0 else -1
        if end < 0:
            depth, end = 0, len(rest)
            for i, ch in enumerate(rest):
                if ch == "(":
                    depth += 1
                elif ch == ")" and depth:
                    depth -= 1
                elif depth == 0 and rest.startswith(", ", i):
                    end = i
                    break
        out.append(rest[:end])
        rest = rest[end:].removeprefix(", ")
    return out


def _what(p: ImportProblem) -> str | None:
    """What is wrong with an invalid citation, as the parser said it."""
    if p.code != "invalid_citation":
        return None
    # Only the last line can match (".+$" stops at a newline), so only it is searched: a
    # long line of " is invalid: " before it would be rescanned from each one.
    last_line = p.message.rfind("\n", 0, len(p.message) - 1) + 1
    m = _INVALID.search(p.message, last_line)
    return m["what"] if m else None


def _causes(problems: Sequence[ImportProblem]) -> tuple[list[ImportProblem], Counter[str]]:
    """The problems that are causes, and the knock-on references per rejected citation id
    (an ``unknown_citation`` naming a citation that was refused as invalid)."""
    rejected = {p.cite_key for p in problems if p.code == "invalid_citation" and p.cite_key}
    causes: list[ImportProblem] = []
    knock_on: Counter[str] = Counter()
    for p in problems:
        if p.code == "unknown_citation" and p.cite_key in rejected:
            knock_on[p.cite_key] += 1  # type: ignore[index]
        else:
            causes.append(p)
    return causes, knock_on


def summary(name: str, problems: Sequence[ImportProblem]) -> str:
    """One plain line for a refused draft ``name`` (e.g. ``prd.md``), grouped by cause:
    "Oracle refused prd.md: 24 citations use source 'x', which isn't accepted; 102
    references fail because of them.". A draft the segment did not leave
    (:data:`MISSING_DRAFT`) never reached the import: "Oracle could not import prd.md:
    the run's agents did not write it."."""
    if problems and all(p.code == MISSING_DRAFT for p in problems):
        return f"Oracle could not import {name}: the run's agents did not write it."
    causes, knock_on = _causes(problems)
    groups: dict[tuple[str, str | None], _Group] = {}
    # Every invalid citation of an id, in order: its knock-ons count against the first.
    rejected: dict[str, list[_Group]] = {}
    for p in causes:
        what = _what(p)
        for i, field in enumerate(_fields(what) if what is not None else [None]):
            group = groups.setdefault((p.code, field), _Group(len(groups), [], field))
            group.problems.append(p)
            if i == 0 and p.code == "invalid_citation" and p.cite_key:
                rejected.setdefault(p.cite_key, []).append(group)
    # Every knock-on names a rejected citation (:func:`_causes`).
    for key, n in knock_on.items():
        rejected[key][0].knock_on += n
    ordered = sorted(groups.values(), key=lambda g: (-g.size, g.order))
    if not ordered:
        return f"Oracle refused {name}."
    return f"Oracle refused {name}: " + ". ".join(g.sentence() for g in ordered) + "."


# A refused draft goes back to the writer before a person is asked (owner, 2026-10-20):
# the import's problems as review findings, grouped in plain words, each group with what
# a valid draft does. (label, problem codes, what to do); None: the citation contract,
# read when the findings are written.
FINDING_GROUPS: tuple[tuple[str, tuple[str, ...], str | None], ...] = (
    (
        "Citations",
        ("invalid_citation", "duplicate_citation", "unknown_citation"),
        None,
    ),
    (
        "Front matter",
        (
            "missing_front_matter",
            "invalid_front_matter",
            "invalid_document",
            "document_mismatch",
            "kind_mismatch",
            "missing_title",
        ),
        "The file starts with YAML front matter between --- lines: the document's title "
        "and the fields the task names, for this run's document.",
    ),
    (
        "Headings and section ids",
        (
            "missing_section_id",
            "duplicate_section_id",
            "content_before_heading",
            "no_sections",
            "sources_not_last",
        ),
        "A heading follows the front matter, every heading of levels 1 to 3 ends with a "
        "{#id} used once, and Sources and data points is the last section.",
    ),
    (
        "Feedback resolutions",
        ("invalid_resolution", "unknown_feedback_item"),
        "The resolutions list names each open feedback item by its feedback_id, with status "
        "addressed or declined and a note.",
    ),
    (
        "The file",
        ("missing_draft", "draft_too_large", "invalid_encoding"),
        "Write the whole draft as one UTF-8 markdown file.",
    ),
)
OTHER = "Other problems"


def _problem(p: ImportProblem | dict[str, Any]) -> ImportProblem:
    if isinstance(p, ImportProblem):
        return p
    code = str(p.get("code") or "")
    cite_key = p.get("cite_key")
    return ImportProblem(
        code=code,
        message=str(p.get("message") or code),
        cite_key=str(cite_key) if cite_key else None,
    )


def findings(
    name: str, problems: Sequence[ImportProblem | dict[str, Any]], total: int | None = None
) -> list[str]:
    """The review findings for a draft the import refused (the agents' rendering of
    :func:`summary`'s analysis): a lead line, then one finding per group of problems (at
    most :data:`FINDINGS_LISTED` messages and how many more, the knock-on references in
    one sentence, then what a valid draft does). ``total``: how many problems there were
    when only the first of them were stored (:func:`refused`)."""
    out = [
        f"Oracle could not import {name} as the document's next version, so it sent the "
        "draft back before a person reviews it. Fix every problem below and write the whole "
        "file again; keep the rest as it is."
    ]
    listed = [_problem(p) for p in problems]
    causes, knock_on = _causes(listed)
    groups: dict[str, list[str]] = {}
    hints: dict[str, str] = {}
    for p in causes:
        label, hint = next(
            ((g, h) for g, codes, h in FINDING_GROUPS if p.code in codes), (OTHER, "")
        )
        groups.setdefault(label, []).append(p.message.removesuffix("."))
        hints[label] = citation_contract() if hint is None else hint
    order = [g for g, _, _ in FINDING_GROUPS] + [OTHER]
    for label in sorted(groups, key=order.index):
        messages = groups[label]
        text = f"{label}: {'; '.join(messages[:FINDINGS_LISTED])}"
        if len(messages) > FINDINGS_LISTED:
            text += f"; and {len(messages) - FINDINGS_LISTED} more like them"
        text += "."
        if label == "Citations" and (k := sum(knock_on.values())):
            text += (
                f" {k} {_plural(k, 'reference fails', 'references fail')} only because "
                f"{_plural(k, 'it cites', 'they cite')} these invalid citations; "
                f"{_plural(k, 'it passes', 'they pass')} once the citations are fixed."
            )
        out.append(f"{text} {hints[label]}" if hints[label] else text)
    if total is not None and total > len(listed):
        out.append(
            f"Only the first {len(listed)} of {total} problems are listed; fix these and the "
            "import lists the rest."
        )
    return out


def refused(name: str, problems: Sequence[ImportProblem]) -> dict[str, Any]:
    """What a refused import stores: the error string (older readers), the first
    :data:`MAX_PROBLEMS` problems, their count when there were more (``problems_total``),
    and the summary of them all."""
    shown = list(problems[:MAX_PROBLEMS])
    more = len(problems) - len(shown)
    error = f"{name} was rejected: " + "; ".join(f"[{p.code}] {p.message}" for p in shown)
    out: dict[str, Any] = {
        "error": error + (f"; and {more} more" if more else ""),
        "problems": [p.model_dump(mode="json") for p in shown],
        "summary": summary(name, problems),
    }
    if more:
        out["problems_total"] = len(problems)
    return out
