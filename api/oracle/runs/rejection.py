"""The plain summary of a refused draft (owner, 2026-10-20): the run page, the Inbox and MCP
show the same line instead of the validator's raw list.

Problems are grouped by cause (their code; invalid citations by what is wrong with them),
largest group first. A knock-on ``unknown_citation`` (a reference to a citation the parser
dropped because it was invalid) counts against the rejected citation it depends on (the
same ``cite_key``), not as a cause of its own.
"""

import re
from collections.abc import Sequence

from oracle.docs.schemas import ImportProblem

# What :func:`oracle.docs.parser._parse_citations` says of an invalid citation.
_INVALID = re.compile(r" is invalid: (?P<what>.+)$")
_SOURCE = re.compile(r"^source '(?P<source>.*)' isn't accepted$")

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


def summary(name: str, problems: Sequence[ImportProblem]) -> str:
    """One plain line for a refused draft ``name`` (e.g. ``prd.md``), grouped by cause:
    "Oracle refused prd.md: 24 citations use source 'x', which isn't accepted; 102
    references fail because of them."."""
    groups: dict[tuple[str, str | None], _Group] = {}
    rejected: dict[str, _Group] = {}
    knock_on: list[ImportProblem] = []
    for p in problems:
        what = None
        if p.code == "invalid_citation" and (m := _INVALID.search(p.message)):
            what = m["what"]
        if p.code == "unknown_citation" and p.cite_key:
            knock_on.append(p)
            continue
        key = (p.code, what)
        group = groups.setdefault(key, _Group(len(groups), [], what))
        group.problems.append(p)
        if p.code == "invalid_citation" and p.cite_key:
            rejected[p.cite_key] = group
    for p in knock_on:
        if p.cite_key in rejected:
            rejected[p.cite_key].knock_on += 1
        else:
            group = groups.setdefault(("unknown_citation", None), _Group(len(groups), []))
            group.problems.append(p)
    ordered = sorted(groups.values(), key=lambda g: (-g.size, g.order))
    if not ordered:
        return f"Oracle refused {name}."
    return f"Oracle refused {name}: " + ". ".join(g.sentence() for g in ordered) + "."
