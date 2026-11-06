"""PRD source words: a run's PRD names its sources and issues the way a person reads them.

The Sources and data points section lists each source by its title in plain words, never
a citation key ("c7,", "c45:"), a file path or file name ("docs/alerting.md") or a
bracket tag ("[BE]"), and writes each code with its name (#306, oracle.docs.named_codes,
which reads the other sections). The body names an issue by what it is, never by its
number ("be#1357"). A run's PRD draft that breaks either rule is imported with a warning
naming the line in the file (never refused), and the run sends it back to the writer
(oracle.docs.draft_checks.SENT_BACK). The warnings never repeat the raw tokens.

Every pattern reads untrusted text and stays linear (see oracle.jobs.prompting).
"""

import re
from collections.abc import Iterable

from oracle.docs import named_codes
from oracle.docs.parser import ParsedSection
from oracle.docs.schemas import VersionWarning

SOURCES = "source_not_named"
ISSUES = "issue_number"
# The warning codes of this check (a run sends a draft with either back to the writer).
CODES = (SOURCES, ISSUES)

# A citation key: a small letter and digits, then a colon or a comma ("c7,", "c45:").
_KEY = re.compile(r"(?<![\w./#-])[a-z]\d{1,4}[ \t]*[:,]")
# A URL or a link's target: read neither for paths nor for file names.
_URL = re.compile(r"\]\([^)\s]*\)|\bhttps?://\S+")
# A path ("docs/alerting.md", "src/app/page.tsx") or a file name ("pricing-notes.md").
_PATH = re.compile(r"(?<![\w./-])(?:[\w.-]{1,80}/){1,12}[\w.-]{0,80}\.[A-Za-z0-9]{1,5}\b")
_FILE = re.compile(
    r"(?<![\w./-])[a-z0-9][\w-]{0,80}(?:\.[\w-]{1,40}){0,3}\."
    r"(?:md|mdx|txt|pdf|docx?|csv|xlsx?|pptx?|json|ya?ml|toml|py|tsx?|jsx?|html?|sql|log)\b"
)
# A bracket tag ("[BE]", "[WEB-API]"), not a link's text ("[Beta](#milestone-beta)").
_TAG = re.compile(r"\[[A-Z][A-Z0-9&/_-]{0,15}\](?![(\[:])")
# An issue by its number: a repository's short name and a number ("be#1357", "web#12"),
# or the word issue, PR or ticket and a number ("issue #88").
_ISSUE = re.compile(
    r"(?<![\w#/.-])[A-Za-z][\w.-]{0,40}#\d{1,7}\b"
    r"|\b(?:issue|issues|PR|PRs|pull request|ticket|tickets|bug)[ \t]+#\d{1,7}\b",
    re.IGNORECASE,
)


def _plain(heading: str) -> str:
    """A heading without its {#id}."""
    return re.sub(r"\s*\{#[^}]*\}\s*$", "", heading).strip()


def _start(s: ParsedSection, file_lines: list[str] | None) -> int:
    """The 1-based line in the whole file of the body's first line: the parser strips the
    blank lines after the heading, so they are skipped in the file (one assumed without
    it)."""
    at = s.body_line or s.line + 1
    if file_lines is None:
        return at + 1 if s.body_md else at
    while at <= len(file_lines) and not file_lines[at - 1].strip():
        at += 1
    return at


def _lines(s: ParsedSection, file_lines: list[str] | None) -> Iterable[tuple[int, str]]:
    """The section's body lines with their 1-based line in the whole file, outside code
    fences."""
    start = _start(s, file_lines)
    fenced = False
    for i, line in enumerate(s.body_md.splitlines()):
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
            continue
        if not fenced:
            yield start + i, line


def _source_problems(line: str) -> list[str]:
    """What a Sources line does wrong, in plain words, in order."""
    out = []
    if _KEY.search(line):
        out.append("a citation key")
    bare = _URL.sub(" ", line)
    if _PATH.search(bare) or _FILE.search(bare):
        out.append("a file path or file name")
    if _TAG.search(line):
        out.append("a tag")
    return out


def _unnamed_lines(s: ParsedSection, file_lines: list[str] | None) -> list[tuple[int, str]]:
    """The codes the section uses without their names, each at its first line."""
    unnamed = named_codes.findings(s.body_md, s.heading).unnamed
    out: list[tuple[int, str]] = []
    for code in unnamed:
        at = re.compile(rf"(?<![\w-]){re.escape(code)}(?![\w-])")
        line = next((n for n, text in _lines(s, file_lines) if at.search(text)), None)
        if line is not None:
            out.append((line, code))
    return out


def check(sections: Iterable[ParsedSection], markdown: str | None = None) -> list[VersionWarning]:
    """Warnings for a run's PRD draft: the Sources sections' lines that carry a citation
    key, a file path, a tag or a code without its name, and the body's issue numbers, by
    their line in ``markdown`` (the draft the sections were parsed from)."""
    file_lines = markdown.splitlines() if markdown is not None else None
    found: dict[str, list[tuple[int, str]]] = {}
    headings: dict[str, str] = {}
    issues: dict[str, list[int]] = {}
    for s in sections:
        if s.section_key.startswith("sources"):
            rows = [
                (n, ", ".join(why))
                for n, text in _lines(s, file_lines)
                if (why := _source_problems(text))
            ]
            rows += [(n, f"{code} without its name") for n, code in _unnamed_lines(s, file_lines)]
            if rows:
                found[s.section_key] = sorted(rows)
                headings[s.section_key] = _plain(s.heading) or s.section_key
            continue
        lines = [n for n, text in _lines(s, file_lines) if _ISSUE.search(text)]
        if lines:
            issues[s.section_key] = lines
            headings[s.section_key] = _plain(s.heading) or s.section_key
    warnings: list[VersionWarning] = []
    if found:
        warnings.append(
            VersionWarning(
                code=SOURCES,
                message="These source lines show what a person cannot read: "
                + "; ".join(
                    f"{headings[k]}: " + ", ".join(f"line {n} ({why})" for n, why in rows)
                    for k, rows in found.items()
                )
                + ". List each source by its title in plain words, never a citation key, "
                "a file path, a file name or a tag, and write each code with its name.",
                section_keys=list(found),
            )
        )
    if issues:
        warnings.append(
            VersionWarning(
                code=ISSUES,
                message="These lines name an issue by its number: "
                + "; ".join(
                    f"{headings[k]}, " + ", ".join(f"line {n}" for n in lines)
                    for k, lines in issues.items()
                )
                + ". Name each issue by what it is, in plain words.",
                section_keys=list(issues),
            )
        )
    return warnings
