"""Named codes (#306): the codes an agent's draft uses read well on their own.

A section names a code the first time it uses it (``F-28 Retire the legacy deploy path``,
or ``the legacy deploy path (F-28)``); later mentions may use the code alone. Three or
more codes are a list, one per line with its name, never a comma-separated run. A run's
draft that breaks either rule is imported with a warning per rule (never refused).

Every pattern reads untrusted text and stays linear (see oracle.jobs.prompting).
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field

from oracle.docs.parser import ParsedSection
from oracle.docs.schemas import VersionWarning

# A code: one to three capitals, a dash, digits (F-28, REQ-4, D-12), one capital and
# digits without a dash (G1 a goal, R1 a requirement, M1 a milestone), or one capital, a
# dash and a capital with optional digits (G-B, G-A1: lettered goals); a slice's small
# letter after the digits (F-25b) and a key result (KR 1.1, KR-2) too.
_CODE = re.compile(
    r"(?<![\w-])(KR[ -]?\d{1,2}(?:\.\d{1,2})?|[A-Z]{1,3}-\d{1,5}[a-z]?|[A-Z]\d{1,4}"
    r"|[A-Z]-[A-Z]\d{0,3})(?![\w-])"
)
# Standards, quarters, halves and versions that look like codes and are not ones.
_NOT_CODES = {"UTF", "SHA", "ISO", "MD", "TLS", "SSL", "RFC", "Q", "H", "V"}
# Lettered pairs that are words, not codes ("an A-B test", "the X-Y axis").
_NOT_LETTERED = {"A-B", "X-Y"}
# What may stand between two codes of a run: a comma, a slash, "and" or "or".
_JOINER = re.compile(r"[ \t]*(?:,|/|&|,?[ \t]+(?:and|or))[ \t]*")
# A name after a code: an optional separator, then a capital.
_NAME_AFTER = re.compile(r"[ \t]*(?:[:·–—-][ \t]*)?(\w)")
# A name in brackets or after a separator, which may start with a number or hold commas
# ("M3 (200 teams and 50 seats, and onboarding at scale)", "G1 (activation)"): a word that
# is no code and no reference, or a number then a word; never "(see below)", "(40%)", "(M3)".
_NAME_MARKED = re.compile(
    r"[ \t]*(?:\(|[:·–—])[ \t]*"
    r"(?:(?!(?:[A-Z]{1,3}-\d|[A-Z]\d|(?:see|cf|e\.g|i\.e)\b))[A-Za-z]|\d[\d,.]*[ \t]+[A-Za-z])"
)
# The warning codes of this check (a run sends a draft with either back to the writer).
CODES = ("unnamed_code", "codes_not_listed")
# Run of codes this long or longer must be a list.
RUN = 3


@dataclass
class Findings:
    # Codes whose first mention in the section has no name, in order.
    unnamed: list[str] = field(default_factory=list)
    # Runs of three or more codes written inline instead of as a list.
    runs: list[list[str]] = field(default_factory=list)


def _codes(text: str) -> list[re.Match[str]]:
    return [
        m
        for m in _CODE.finditer(text)
        if _prefix(m.group(1)) not in _NOT_CODES and m.group(1) not in _NOT_LETTERED
    ]


def codes_in(text: str) -> list[str]:
    """The codes ``text`` writes, in order."""
    return [m.group(1) for m in _codes(text)]


def only_codes(text: str) -> bool:
    """Whether ``text`` is codes alone, with no name ("G-B, G-C, G-A1"): a table cell a
    renderer replaces with the names it knows."""
    codes = _codes(text)
    if not codes:
        return False
    rest = _CODE.sub("", text)
    return not re.sub(r"(?:,|/|&|\band\b|\bor\b|\s)+", "", rest)


def _in_table(text: str, at: int) -> bool:
    """Whether ``at`` is on a table row: a cell cannot hold a list, so each code in it
    needs its name (a roadmap's Goal column, "G-B, G-C, G-A1")."""
    return text[text.rfind("\n", 0, at) + 1 :].lstrip().startswith("|")


def _prefix(code: str) -> str:
    return code.split("-")[0] if "-" in code else code.rstrip("0123456789")


def findings(body: str, heading: str = "") -> Findings:
    """The named-code problems of one section body (codes its heading names count as
    named)."""
    out = Findings()
    named = {m.group(1) for m in _codes(heading)}
    codes = _codes(body)
    # Group consecutive codes joined only by commas, "and" or "or".
    groups: list[list[re.Match[str]]] = []
    for m in codes:
        prev = groups[-1][-1] if groups else None
        gap = body[prev.end() : m.start()] if prev else ""
        if prev and len(gap) <= 12 and _JOINER.fullmatch(gap):
            groups[-1].append(m)
        else:
            groups.append([m])
    for group in groups:
        if len(group) >= RUN and not _in_table(body, group[0].start()):
            out.runs.append([m.group(1) for m in group])
            named.update(m.group(1) for m in group)
            continue
        for m in group:
            code = m.group(1)
            if code in named:
                continue
            named.add(code)
            after = _NAME_AFTER.match(body, m.end())
            # "the legacy deploy path (F-28)": named before it.
            in_parens = body[m.start() - 1 : m.end() + 1] == f"({code})"
            marked = _NAME_MARKED.match(body, m.end())
            if not in_parens and not marked and not (after and after.group(1).isupper()):
                out.unnamed.append(code)
    return out


def _plain(heading: str) -> str:
    """A heading without its {#id}."""
    return re.sub(r"\s*\{#[^}]*\}\s*$", "", heading).strip()


def check(sections: Iterable[ParsedSection]) -> list[VersionWarning]:
    """Warnings for a draft's sections (the Sources and data points sections hold source
    references, not prose, and are not read)."""
    unnamed: dict[str, list[str]] = {}
    headings: dict[str, str] = {}
    runs: dict[str, list[list[str]]] = {}
    for s in sections:
        if s.section_key.startswith("sources"):
            continue
        found = findings(s.body_md, s.heading)
        if found.unnamed:
            unnamed[s.section_key] = found.unnamed
            headings[s.section_key] = _plain(s.heading) or s.section_key
        if found.runs:
            runs[s.section_key] = found.runs
    warnings: list[VersionWarning] = []
    if unnamed:
        warnings.append(
            VersionWarning(
                code="unnamed_code",
                message="These codes have no name where the section first uses them: "
                + "; ".join(f"{headings[k]}: {', '.join(v)}" for k, v in unnamed.items())
                + ". Write each with its name the first time: 'F-28 Retire the legacy "
                "deploy path', or 'M3 (its name)' when the name holds numbers or commas.",
                section_keys=list(unnamed),
            )
        )
    if runs:
        warnings.append(
            VersionWarning(
                code="codes_not_listed",
                message="three or more codes written in a row instead of a list, one per "
                "line with its name: "
                + "; ".join(
                    f"{k} ({' / '.join(', '.join(r) for r in v)})" for k, v in runs.items()
                ),
                section_keys=list(runs),
            )
        )
    return warnings
