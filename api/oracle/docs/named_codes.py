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

# A code: one to three capitals, a dash, digits (F-28, REQ-4, D-12), or one capital and
# digits without a dash (G1 a goal, R1 a requirement, M1 a milestone).
_CODE = re.compile(r"(?<![\w-])([A-Z]{1,3}-\d{1,5}|[A-Z]\d{1,4})(?![\w-])")
# Standards, quarters, halves and versions that look like codes and are not ones.
_NOT_CODES = {"UTF", "SHA", "ISO", "MD", "TLS", "SSL", "RFC", "Q", "H", "V"}
# What may stand between two codes of a run: a comma, a slash, "and" or "or".
_JOINER = re.compile(r"[ \t]*(?:,|/|&|,?[ \t]+(?:and|or))[ \t]*")
# A name after a code: an optional separator, then a capital.
_NAME_AFTER = re.compile(r"[ \t]*(?:[:·–—-][ \t]*)?(\w)")
# Run of codes this long or longer must be a list.
RUN = 3


@dataclass
class Findings:
    # Codes whose first mention in the section has no name, in order.
    unnamed: list[str] = field(default_factory=list)
    # Runs of three or more codes written inline instead of as a list.
    runs: list[list[str]] = field(default_factory=list)


def _codes(text: str) -> list[re.Match[str]]:
    return [m for m in _CODE.finditer(text) if _prefix(m.group(1)) not in _NOT_CODES]


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
        if len(group) >= RUN:
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
            if not in_parens and not (after and after.group(1).isupper()):
                out.unnamed.append(code)
    return out


def check(sections: Iterable[ParsedSection]) -> list[VersionWarning]:
    """Warnings for a draft's sections (the Sources and data points sections hold source
    references, not prose, and are not read)."""
    unnamed: dict[str, list[str]] = {}
    runs: dict[str, list[list[str]]] = {}
    for s in sections:
        if s.section_key.startswith("sources"):
            continue
        found = findings(s.body_md, s.heading)
        if found.unnamed:
            unnamed[s.section_key] = found.unnamed
        if found.runs:
            runs[s.section_key] = found.runs
    warnings: list[VersionWarning] = []
    if unnamed:
        warnings.append(
            VersionWarning(
                code="unnamed_code",
                message="codes used without their name on first mention (write "
                "'F-28 Retire the legacy deploy path', not 'F-28'): "
                + "; ".join(f"{k} ({', '.join(v)})" for k, v in unnamed.items()),
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
