"""PRD source words: a run's PRD names its sources and issues the way a person reads them.

The Sources and data points section lists each source by its title in plain words, never
a citation key ("c7,", "c45:"), a file path or file name ("docs/alerting.md") or a
bracket tag ("[BE]"), and writes each code with its name (#306, oracle.docs.named_codes,
which reads the other sections). The body names an issue by what it is, never by its
number ("be#1357"). A run's PRD draft that breaks either rule is imported with a warning
naming each token and its line in the file (never refused), so the writer's retry can fix
it, and the run sends it back to the writer (oracle.docs.draft_checks.SENT_BACK).

A false flag costs the writer a revision, so the check leans to not flagging: a citation
key is one of the draft's own citation ids standing as a source's name (at the start of
the line or in brackets), never a word like "p95," or "v2,"; a title that is a file name
or carries a tag ("Roadmap 2027.xlsx (Google Drive, Oct 2)", "Design review [DRAFT]
(Notion, Oct 3)") passes when it gives its place and date; lowercase product names
("next.js") and bare domains ("example.com/pricing") pass.

Every pattern reads untrusted text and stays linear (see oracle.jobs.prompting).
"""

import re
from collections.abc import Iterable

from oracle import safe_yaml
from oracle.docs import named_codes
from oracle.docs.parser import ParsedSection, split_front_matter
from oracle.docs.schemas import VersionWarning

SOURCES = "source_not_named"
ISSUES = "issue_number"
# The warning codes of this check (a run sends a draft with either back to the writer).
CODES = (SOURCES, ISSUES)

# Where a citation key stands as a source's name: at the start of a list item or table
# row, or right after an opening bracket or another key in brackets.
_KEY_START = re.compile(r"[ \t]*(?:(?:[-*+]|\d{1,3}[.)]|\|)[ \t]+)?")
# A bracket group: its text between "(" or "[" and the closing bracket.
_GROUP = re.compile(r"[(\[]([^()\[\]\n]{1,200})[)\]]")
# A key's word: what may follow it up to its colon or comma ("c45:", "c7 ,").
_KEY_WORD = re.compile(r"([^\s,:()\[\]]{1,60})([ \t]*[:,])?")
# A URL or a link's target: read neither for paths nor for file names; a bare domain
# with a path ("example.com/pricing/plan.html") is a place, not a file.
_URL = re.compile(
    r"\]\([^)\s]*\)|\bhttps?://\S+|(?<![\w./-])(?:[\w-]{1,63}\.){1,6}[A-Za-z]{2,24}/\S*"
)
# A path ("docs/alerting.md", "src/app/page.tsx") or a file name ("pricing-notes.md").
_PATH = re.compile(r"(?<![\w./-])(?:[\w.-]{1,80}/){1,12}[\w.-]{0,80}\.[A-Za-z0-9]{1,5}\b")
_FILE = re.compile(
    r"(?<![\w./-])[a-z0-9][\w-]{0,80}(?:\.[\w-]{1,40}){0,3}\."
    r"(?:md|mdx|txt|pdf|docx?|csv|xlsx?|pptx?|json|ya?ml|toml|py|tsx?|jsx?|html?|sql|log)\b"
)
# A bracket tag ("[BE]", "[WEB-API]"), not a link's text ("[Beta](#milestone-beta)").
_TAG = re.compile(r"\[[A-Z][A-Z0-9&/_-]{0,15}\](?![(\[:])")
# A lowercase product name that ends like a script ("next.js", "vue.js"), not a file.
_PRODUCT = re.compile(r"[a-z]{1,40}\.js")
# A date as a source gives it ("Oct 2", "Sep 30, 2026", "as of September").
_DATE = re.compile(
    r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}\.?[ \t]+\d{1,4}\b"
    r"|\bas of [A-Z][a-z]{2,8}\b"
)
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


def citation_ids(sections: Iterable[ParsedSection], markdown: str | None) -> set[str]:
    """The draft's own citation ids: its front matter's citations[].id and the ids its
    sections cite with [c:...]."""
    ids = {k for s in sections for k in s.citation_keys}
    if markdown is None:
        return ids
    yaml_text = split_front_matter(markdown)[0]
    try:
        data = safe_yaml.load(yaml_text) if yaml_text else None
    except safe_yaml.SafeYamlError:
        data = None
    cites = data.get("citations") if isinstance(data, dict) else None
    for c in cites if isinstance(cites, list) else []:
        if isinstance(c, dict) and isinstance(c.get("id"), str | int):
            ids.add(str(c["id"]))
    return ids


def _placed(line: str) -> bool:
    """Whether a source line gives its place and its date in brackets ("(Google Drive,
    Oct 2)"): a title that is a file name or carries a tag reads well then."""
    return any(
        _DATE.search(g.group(1)) and re.search(r"[A-Za-z]", _DATE.sub("", g.group(1)))
        for g in _GROUP.finditer(line)
    )


def _keys(line: str, ids: set[str]) -> list[str]:
    """The citation keys a source line uses as a source's name, as written ("c45:")."""
    out = []
    first = _KEY_WORD.match(line, _KEY_START.match(line).end())  # type: ignore[union-attr]
    if first and first.group(1) in ids and (first.group(2) or not line[first.end() :].strip()):
        out.append(first.group(0).strip())
    for g in _GROUP.finditer(line):
        parts = [p.strip() for p in g.group(1).split(",")]
        out += [p for p in parts if p in ids]
    return out


def _source_problems(line: str, ids: set[str]) -> list[str]:
    """What a Sources line does wrong, each with its token, in plain words, in order."""
    out = [f"'{k}' is a citation key" for k in _keys(line, ids)]
    placed = _placed(line)
    bare = _URL.sub(" ", line)
    out += [f"'{m.group(0)}' is a file path" for m in _PATH.finditer(bare)]
    if not placed:
        bare = _PATH.sub(" ", bare)
        out += [
            f"'{m.group(0)}' is a file name"
            for m in _FILE.finditer(bare)
            if not _PRODUCT.fullmatch(m.group(0))
        ]
    tags = list(_TAG.finditer(line))
    lead = _KEY_START.match(line).end()  # type: ignore[union-attr]
    out += [f"'{t.group(0)}' is a tag" for t in tags if not placed or t.start() == lead]
    return out


def _unnamed_lines(s: ParsedSection, file_lines: list[str] | None) -> list[tuple[int, str]]:
    """The codes the section uses without their names, each at its first line."""
    unnamed = named_codes.findings(s.body_md, s.heading, prd=True).unnamed
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
    their token and line in ``markdown`` (the draft the sections were parsed from)."""
    sections = list(sections)
    file_lines = markdown.splitlines() if markdown is not None else None
    ids = citation_ids(sections, markdown)
    found: dict[str, list[tuple[int, str]]] = {}
    headings: dict[str, str] = {}
    issues: dict[str, list[tuple[int, str]]] = {}
    for s in sections:
        if s.section_key.startswith("sources"):
            rows = [
                (n, f"{why}; name the source by its title")
                for n, text in _lines(s, file_lines)
                for why in _source_problems(text, ids)
            ]
            rows += [
                (n, f"'{code}' has no name; write it with its name")
                for n, code in _unnamed_lines(s, file_lines)
            ]
            if rows:
                found[s.section_key] = sorted(rows, key=lambda r: r[0])
                headings[s.section_key] = _plain(s.heading) or s.section_key
            continue
        lines = [
            (n, m.group(0).strip())
            for n, text in _lines(s, file_lines)
            for m in _ISSUE.finditer(text)
        ]
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
                    f"{headings[k]}, " + "; ".join(f"line {n}: {why}" for n, why in rows)
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
                    f"{headings[k]}, "
                    + "; ".join(f"line {n}: '{token}' is an issue number" for n, token in lines)
                    for k, lines in issues.items()
                )
                + ". Name each issue by what it is, in plain words.",
                section_keys=list(issues),
            )
        )
    return warnings
