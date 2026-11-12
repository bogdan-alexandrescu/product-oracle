"""The one-pager reads clearly (the owner's pick, 2026-10-30): who has the problem, how each
outcome is measured, codes with names, footnote marks with their notes, and numbers that
add up. Deterministic reads of the PRD's own sections; the one-pager calls :func:`annotate`
on every read and :func:`problem_check` on the job's answer.

- **Who has it**: the PRD's users or personas section (:func:`who_has_it`); the problem
  block carries it (``who``), and a job answer whose problem names no one of it is asked
  again, once, and built either way (:func:`problem_check`).
- **How it is measured**: each outcome line carries its measure and its source from the PRD
  (``measure``, ``measure_source``): "counted as ..." / "source: ..." words or a metrics
  table's definition and source columns (:func:`measures`).
- **Codes with names**: a feature or ticket code (F-26, P0) gets the name the PRD gives it
  beside it (:func:`glossary`); a code the PRD never names is a "Needs a look" item.
- **Footnotes**: a mark (†, ‡, §, a trailing *) stays only with its note (``footnotes``); a
  mark with no note in the PRD is dropped.
- **Numbers that don't add up** (:func:`numbers`): a per-unit target times the stated units
  against a company-wide target, and a count said in words against the items listed. Each
  carries its fix (:func:`set_number`): the count set to the items listed, the company-wide
  target to what its parts add up to; a count in a section's heading ("Later · 8 items") is
  set in the heading (``part`` "heading"; owner, Nov 5, 'Fix the heading too').

The "Needs a look" items (:class:`Look`) are the PRD's owners' only; the page renders them
as one list, which other checks (the Definition of Done quality checks) can join.
"""

import re
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Context, Decimal
from typing import Any

from oracle.docs.models import Section
from oracle.docs.parser import strip_citations

WHO_SAYS_NOTHING = "Who has it is not in the PRD yet"

_WHO_HEAD = re.compile(r"\b(?:users?|personas?|who\b|audiences?|customers?)", re.I)
# A heading that names the people first (ad-onepager review): personas, users, who has it.
_WHO_BEST = re.compile(r"\b(?:personas?|users?|who has it)\b", re.I)
# What people say or do is never who they are: "User stories", "Customer quotes".
_WHO_NOT = re.compile(
    r"\b(?:stor(?:y|ies)|flows?|quotes?|journeys?|scenarios?|problems?)\b",
    re.I,
)
_BULLET = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")
_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
_MD = re.compile(r"[*_`]+|\[([^\]]*)\]\([^)]*\)|\{#[^}]*\}|<!--.*?-->")
_WORD = re.compile(r"[A-Za-z][A-Za-z'-]{3,}")
_STOP = frozenset(
    "this that them they their with from have will when what which into than then more "
    "most some only also each every week month year days were been does done they're "
    "there here about after before over under people".split()
)


@dataclass
class Look:
    """One "Needs a look" item: what to look at, in plain words, and where it is."""

    kind: str
    text: str
    where: list[str] = field(default_factory=list)
    source_keys: list[str] = field(default_factory=list)
    # A "numbers" item's one-click fix (owner, Nov 5): the number ``before`` in the words
    # ``said`` of the section ``section`` set to ``value`` (oracle.simple.one_pager's
    # set_section_number), ``part`` "heading" when the number is in the section's heading;
    # None when the words are in neither.
    fix: dict[str, str] | None = None


# A citation an older quick read cut ("time [c…", "time [c:c"): only at the line's end.
_CUT_CITE = re.compile(r"[ \t]*\[c(?:(?=…$)|:[^\]\s…]*(?=…?$))")


def resolved(text: str) -> str:
    """``text`` as the PRD's PDF reads it: no ``[c:id]`` marker left (the export's resolver,
    oracle.docs.parser.strip_citations), and none an older quick read cut at its end."""
    # A cut marker goes first: strip_citations would drop its "[c:" opener and leave "c4…".
    return strip_citations(_CUT_CITE.sub("", text or ""))


def _plain(text: str) -> str:
    """Markdown's words, no ``[c:id]`` marker left."""
    text = resolved(text or "")
    return " ".join(_MD.sub(lambda m: m.group(1) or "", text or "").split())


def _rows(body: str) -> tuple[list[str], list[list[str]], list[str]]:
    """A section's bullets, its tables' body rows (cells) and its other lines."""
    bullets: list[str] = []
    rows: list[list[str]] = []
    prose: list[str] = []
    lines = (body or "").splitlines()
    for i, raw in enumerate(lines):
        if _TABLE_SEP.match(raw) and "-" in raw:
            continue
        if raw.strip().startswith("|"):
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            if not (_TABLE_SEP.match(nxt) and "-" in nxt):
                rows.append([_plain(c) for c in raw.strip().strip("|").split("|")])
            continue
        if m := _BULLET.match(raw):
            bullets.append(_plain(m.group(1)))
        elif raw.strip():
            prose.append(_plain(raw))
    return bullets, rows, prose


def _header(body: str) -> list[str]:
    lines = (body or "").splitlines()
    for i, raw in enumerate(lines[1:], 1):
        if _TABLE_SEP.match(raw) and "-" in raw and lines[i - 1].strip().startswith("|"):
            return [_plain(c).lower() for c in lines[i - 1].strip().strip("|").split("|")]
    return []


def _terms(text: str) -> set[str]:
    return {w.lower().rstrip("s") for w in _WORD.findall(text or "") if w.lower() not in _STOP}


# --------------------------------------------------------------------------- who has it


def _guidanceless(body: str) -> str:
    """A template's guidance is never who has it (one_pager.template_only): its comments,
    and lines that are only placeholders or arrows."""
    body = re.sub(r"<!--.*?(?:-->|\Z)", "", body, flags=re.S)
    keep = [
        x
        for x in body.splitlines()
        if re.search(r"[^\W_]", _BULLET.sub(r"\1", re.sub(r"<[^<>\n]*>", "", x)))
    ]
    return "\n".join(keep)


# A users section of labelled lines (a run's PRD: "Primary: …", "Job story: …", "Owner: …",
# "Not the target: …"): the label says what the line is, its words who. The people come
# first (the primary ones), a story only when no line names people, the excluded never.
_LABEL = re.compile(
    r"^(?:(?P<primary>primary|main|core|target)(?:\s+(?:users?|personas?|segments?|audiences?))?"
    r"|(?P<out>not\b.*|non[- ]target.*|anti[- ]personas?|out of scope|excluded)"
    r"|(?P<story>(?:job\s+)?stor(?:y|ies)|jobs?(?:\s+to\s+be\s+done)?|jtbd|scenarios?|quotes?)"
    r"|(?P<people>secondary|tertiary|also|other|owners?|buyers?|segments?|personas?|users?"
    r"|audiences?|customers?|who(?:\s+has\s+it)?)(?:\s+(?:users?|personas?|segments?))?)$",
    re.I,
)


# A job story ("When ..., I want ...") or a note on the people ("The primary segment is a
# hypothesis ...") says what they do or how sure we are, never who they are (CLD's walk B,
# 2026-11-01).
_STORY = re.compile(r"^\s*(?:when\b.*\bI\b|as an?\b.*,\s*I\b|I\s+want\b)", re.I)
# How sure the PRD is of them ("Low confidence: ...", "Confidence: medium") is never who
# they are either (vqa-one-pager: "Who has it: Low confidence").
_NOTE_LINE = re.compile(
    r"\bhypothes|\bassum|\bto be (?:confirmed|validated|tested)\b|\bconfiden|\bcertaint",
    re.I,
)
WHO_WORDS = 30


def _said_not_who(text: str) -> bool:
    return bool(_STORY.search(text) or _NOTE_LINE.search(text))


def _whole(text: str, words: int = WHO_WORDS) -> str:
    """A sentence whole, never cut mid-way: over ``words`` it is its first clause (up to a
    comma, semicolon or dash), and "" when even that is too long."""
    text = " ".join(text.split()).rstrip(".")
    if len(text.split()) <= words:
        return text
    clause = re.split(r"\s*(?:[,;]|—|–| - )\s*", text, maxsplit=1)[0]
    return clause if len(clause.split()) <= words else ""


def _sentence(text: str) -> str:
    """A labelled line's words as who has it: its first sentence, whole."""
    return _whole(re.split(r"(?<=[.!?])\s+", text.strip())[0])


def _joined(names: list[str]) -> str:
    """Names joined with "; ", as many whole ones as fit in :data:`WHO_WORDS` words."""
    out: list[str] = []
    for n in names:
        if out and len(" ".join([*out, n]).split()) > WHO_WORDS:
            break
        out.append(n)
    return "; ".join(out)


def _labelled(pairs: list[tuple[str, str]]) -> str | None:
    """Who has it from labelled lines ("" when no line names people), None when no line is
    labelled."""
    kinds: dict[str, list[str]] = {"primary": [], "people": [], "story": [], "out": []}
    if not any(_LABEL.match(label.strip()) for label, _ in pairs):
        return None
    for label, words in pairs:
        # A lead among labelled lines ("New admins: ...") names its people.
        if not (m := _LABEL.match(label.strip())):
            if len(label.split()) <= 8 and not _said_not_who(label):
                kinds["people"].append(label.strip())
        elif words := _sentence(words):
            kinds[next(k for k, v in m.groupdict().items() if v)].append(words)
    # A job story names no one ("When ..., I want ..."): never who has it.
    named = kinds["primary"] or kinds["people"]
    return _joined(named)


def who_has_it(sections: list[Section]) -> str | None:
    """Who has the problem, from the PRD's users or personas section, as one plain line:
    labelled lines ("Primary: ...") by the primary people's words (:func:`_labelled`), else
    each bullet's lead ("New admins: ..." -> "New admins"), else a sentence naming people,
    whole. Never a label, a job story or a note on the people ("The primary segment is a
    hypothesis"). None when the PRD has no such section (the page says
    :data:`WHO_SAYS_NOTHING`)."""
    heads = [x for x in sections if _WHO_HEAD.search(x.heading or "")]
    heads = [x for x in heads if not _WHO_NOT.search(x.heading or "")]
    heads.sort(key=lambda x: not _WHO_BEST.search(x.heading or ""))
    split = re.compile(r"\s*(?::|—|–| - )\s*")
    for sec in heads:
        bullets, rows, prose = _rows(_guidanceless(sec.body_md or ""))
        # A bold lead in prose ("**Job story:** When ...") is a labelled line too.
        lines = bullets + [p for p in prose if re.match(r"^[A-Z][\w ]{0,30}:\s", p)]
        prose = [p for p in prose if p not in lines]
        pairs = [(p[0], p[1]) for b in lines if len(p := split.split(b, maxsplit=1)) == 2]
        pairs += [(r[0], " ".join(r[1:])) for r in rows if len(r) > 1 and r[0]]
        if any(_LABEL.match(label.strip()) for label, _ in pairs):
            if who := _labelled(pairs):
                return who
            continue
        named = []
        for b in lines:
            p = split.split(b, maxsplit=1)
            if _said_not_who(p[0]):
                continue
            if len(p) == 2 and len(p[0].split()) <= 8:
                named.append(p[0])
            elif not _said_not_who(b):
                named.append(_sentence(b))
        named += [r[0] for r in rows if r and r[0] and not _said_not_who(r[0])]
        if not named:
            said = re.split(r"(?<=[.!?])\s+", " ".join(prose))
            named = [_sentence(x) for x in said if x and not _said_not_who(x)][:1]
        named = [n for n in named if n.strip()]
        if named:
            return _joined(named)
    return None


def names_who(text: str, who: str) -> bool:
    return bool(_terms(text) & _terms(who))


def problem_check(blocks: list[dict[str, Any]], sections: list[Section]) -> str | None:
    """The job's quality check: with a users or personas section in the PRD, the problem
    block must name someone in it. The reason it fails, else None."""
    who = who_has_it(sections)
    if who is None:
        return None
    problem = next((b for b in blocks if b.get("key") == "problem"), None)
    if problem is None:
        return None
    text = " ".join(str(x.get("text") or "") for x in problem.get("lines") or [])
    if names_who(text, who):
        return None
    return f"The problem names no one. Say who has it, from the PRD: {who}."


# --------------------------------------------------------------------------- measures

_MEASURE = re.compile(
    r"\b(?:counted as|measured as|measured by|measured on|defined as|definition|we count)\b"
    r"\s*:?\s*",
    re.I,
)
_SOURCE = re.compile(
    r"(?:\bsources?\s*:?\s*|[;·,|]\s*from\s+|\bfrom\s+(?=(?:the|our)\b)|\bvia\s+)(?P<s>[^.;·|]+)",
    re.I,
)
_MEASURE_COL = re.compile(r"defin|measure|counted|how")
_SOURCE_COL = re.compile(r"source|data|where")


@dataclass
class Measure:
    name: str
    measure: str
    source: str | None


# A source named only by its citation ("source: [c:c1]") leaves its word behind.
_SOURCE_LEFT = re.compile(r"[\s;,·|]*\b(?:sources?|from|via)\s*:?\s*$", re.I)


def _measure_in(text: str) -> Measure | None:
    m = _MEASURE.search(text)
    if not m:
        return None
    name = text[: m.start()].strip(" :,;·-—–")
    rest = text[m.end() :]
    s = _SOURCE.search(rest)
    measure = _SOURCE_LEFT.sub("", rest[: s.start()] if s else rest).strip(" :,;·-—–.")
    source = s.group("s").strip(" :,;·-—–.") if s else None
    if not measure:
        return None
    return Measure(name, measure, source or None)


# A success measures section (CLD's walk B, 2026-11-01): its lines say how each outcome is
# measured in their own words ("from 55% to 80% by Mar 31, recomputed daily"), with no
# "counted as". A clause that is the target, the baseline or the time frame is not how.
_SUCCESS_HEAD = re.compile(r"\b(?:success|outcomes?|measures?|metrics?|kpis?)\b", re.I)
_TARGET_CLAUSE = re.compile(
    r"(?:→|->|\bfrom\b[^,;]*\d[^,;]*\bto\b|^\s*(?:by|before|target|baseline|goal|today|now"
    r"|up|down|at least|at most|no more|no less|within)\b|^[\s~<>≥≤$€£]*\d[\d.,%]*\s*\S{0,8}\s*$)",
    re.I,
)
_TARGET = re.compile(
    r"\s(?:from\s+)?[~<>]?[$€£]?\d[\d.,]*\s?\S*\s*(?:→|->|\bto\b)\s*[~<>]?[$€£]?\d", re.I
)
_LEAD = re.compile(r"^(?P<name>[^:—–]{2,80}?)\s*(?::|—|–| - )\s*(?P<rest>.+)$")


def _stated(text: str) -> Measure | None:
    """How a success line measures its outcome in its own words: the line's clauses less its
    name, its target and its time frame ("Onboarding on time: from 55% to 80% by Mar 31,
    recomputed daily from the tracker" -> "recomputed daily", source "the tracker")."""
    text = re.sub(r"(?<=\d),(?=\d{3}\b)", "", _plain(text)).rstrip(".")
    lead = _LEAD.match(text)
    name, rest = (lead.group("name"), lead.group("rest")) if lead else ("", text)
    if not lead:
        at = _TARGET.search(text)
        if at is None:
            return None
        name, rest = text[: at.start()], text[at.start() :]
    # "from 55% to 80% by Mar 31": the target, its time frame with it.
    rest = re.sub(r"\bfrom\b[^,;(]*?\d[^,;(]*?(?:\bto\b|→|->)[^,;(]*", ";", rest, flags=re.I)
    s = _SOURCE.search(rest)
    source = s.group("s").strip(" :,;·-—–.") if s else None
    rest = rest[: s.start()] if s else rest
    clauses = [c.strip(" :,;·-—–.") for c in re.split(r"[,;·]|\s—\s|\s–\s|\(|\)", rest)]
    kept = [c for c in clauses if re.search(r"[A-Za-z]{3}", c) and not _TARGET_CLAUSE.search(c)]
    if not kept or not name.strip():
        return None
    return Measure(name.strip(" :,;·-—–"), ", ".join(kept), source or None)


def measures(sections: list[Section]) -> list[Measure]:
    """Every measure the PRD states in its words: "<metric> ... counted as <what> · from
    <source>" lines, and a table's definition and source columns (its first cell names the
    metric). A citation is never its words (vqa one-pager 2): a definition that is only
    citation ids ("counted as: [c:c4] [c:c11]") is no measure and a source named only by
    its citation none; a cited quote (a meeting's words, cut) or title (with its labels)
    is never how an outcome is measured."""
    out: list[Measure] = []
    for sec in sections:
        bullets, rows, prose = _rows(sec.body_md or "")
        success = bool(_SUCCESS_HEAD.search(sec.heading or ""))
        for text in bullets + re.split(r"(?<=[.!?])\s+", " ".join(prose)):
            if m := _measure_in(text):
                out.append(m)
            elif success and not _MEASURE.search(text) and (m := _stated(text)):
                out.append(m)
        head = _header(sec.body_md or "")
        mcol = next((i for i, h in enumerate(head) if i and _MEASURE_COL.search(h)), None)
        scol = next((i for i, h in enumerate(head) if i and _SOURCE_COL.search(h)), None)
        for r in rows:
            if mcol is not None and mcol < len(r) and r[mcol]:
                said = r[scol] if scol is not None and scol < len(r) else ""
                if measure := _plain(r[mcol]):
                    out.append(Measure(_plain(r[0]), measure, _plain(said) or None))
            elif m := _measure_in(" · ".join(r)):
                out.append(m)
            elif success and r and r[0] and (m := _stated(f"{r[0]}: {'; '.join(r[1:])}")):
                out.append(m)
    return out


def measure_for(text: str, name: str | None, found: list[Measure]) -> Measure | None:
    """The PRD's measure of an outcome line: one stated in the line itself, else the one
    whose metric shares the most words with the line's metric (at least two, or all of a
    short name)."""
    if m := _measure_in(text):
        return m
    want = _terms(name or text)
    best, score = None, 0
    for m in found:
        have = _terms(m.name)
        n = len(want & have)
        if n > score and (n >= 2 or n == len(have) or n == len(want)):
            best, score = m, n
    return best


# --------------------------------------------------------------------------- codes

# A standard's name (ISO-8601, RFC-3339) is not a feature or ticket code.
CODE = re.compile(r"\b(?!(?:ISO|RFC|UTF|IEC|SHA|CVE|EN|IEEE)-)(?:[A-Z]{1,3}-\d{1,4}|P[0-3])\b")
# A priority code the PRD never names reads as the usual words.
PRIORITY = {"P0": "top priority", "P1": "high priority", "P2": "medium priority",
            "P3": "low priority"}  # fmt: skip
# A name starts with a capital: "F-01: every newly connected account gets a plan" says what
# F-01 does, never its name (CLD's walk B, 2026-11-01).
_NAMED = re.compile(r"^\s*(?:[:=—–]|\s-\s|\()\s*(?P<n>[A-Z][^.;,()|:\n]*)")
_CAPITAL = re.compile(r"^\s+(?P<n>[A-Z][^.;,()|:\n]*)")


# A name written right after its code in prose ("so F-11 Photo editing is out"): its words
# up to the first that is not a name's (a verb, a joining word), at most four.
_NOT_NAME = (
    r"(?:is|are|was|were|be|been|will|would|can|could|may|might|must|shall|should|has|have|"
    r"had|do|does|did|gets?|stays?|waits?|goes|go|moves?|ships?|comes?|lands?|slips?|starts?|"
    r"ends?|needs?|and|or|but|nor|to|in|on|at|by|of|for|from|with|without|until|because|so|"
    r"which|that|who|as|into|after|before|than|then|also|too|now|later|first|next|out|not|"
    r"no|the|a|an|it|its|this|these|those|we|our|you|they|here|there)\b"
)
# Its first word starts with a capital ("F-50 requires login" names nothing).
_AFTER = re.compile(
    rf"^\s+(?P<n>(?!(?i:{_NOT_NAME}))[A-Z][\w'’-]*(?:\s+(?!(?i:{_NOT_NAME}))[A-Za-z][\w'’-]*){{0,3}})"
)


def _name(text: str) -> str:
    return " ".join(text.split()[:5]).strip(" -—–")


def glossary(sections: list[Section]) -> dict[str, str]:
    """Each code the PRD names: "F-26: Bulk invite", "F-26 — Bulk invite", "F-26 (Bulk
    invite)", a bullet, heading or cell "F-26 Bulk invite", a table row "| F-26 | Bulk invite |",
    or, when it is named nowhere else, prose "so F-26 Bulk invite is out"."""
    out: dict[str, str] = {}
    after: dict[str, str] = {}

    def scan(text: str) -> None:
        for c in CODE.finditer(text):
            rest = text[c.end() :]
            n = _NAMED.match(rest) or (_CAPITAL.match(rest) if c.start() == 0 else None)
            if n and _name(n.group("n")):
                out.setdefault(c.group(0), _name(n.group("n")))
            elif (n := _AFTER.match(rest)) and _name(n.group("n")):
                after.setdefault(c.group(0), _name(n.group("n")))

    # A feature's own section names it best: "### F-01 Pacing plan {#f-01}".
    for sec in sections:
        head = _plain((sec.heading or "").lstrip("# "))
        rest = head[c.end() :] if (c := CODE.match(head)) else ""
        if c and (n := _CAPITAL.match(rest) or _NAMED.match(rest)):
            out.setdefault(c.group(0), _name(n.group("n")))
    for sec in sections:
        lines = [sec.heading or ""] + (sec.body_md or "").splitlines()
        for raw in lines:
            if raw.strip().startswith("|"):
                cells = [_plain(c) for c in raw.strip().strip("|").split("|")]
                for i, c in enumerate(cells[:-1]):
                    if CODE.fullmatch(c) and cells[i + 1] and not CODE.fullmatch(cells[i + 1]):
                        out.setdefault(c, _name(cells[i + 1]))
                for c in cells:
                    if not CODE.fullmatch(c):
                        scan(c)
                continue
            scan(_plain((m.group(1) if (m := _BULLET.match(raw)) else raw).lstrip("# ")))
    return {**after, **out}


def with_names(text: str, names: dict[str, str]) -> tuple[str, list[str]]:
    """The text with each code's name beside it ("F-26 Bulk invite"), and the codes it has
    no name for."""
    missing: list[str] = []

    def put(m: re.Match[str]) -> str:
        code = m.group(0)
        name = names.get(code) or PRIORITY.get(code)
        if not name:
            if code not in missing:
                missing.append(code)
            return code
        after = text[m.end() :].lstrip(" :—–-(")
        if after.lower().startswith(name.lower()):
            return code
        # Already named where it stands: "Pacing plan (F-01)", "F-01 Pace gives ...".
        before = text[: m.start()].rstrip(" (—–-:").lower()
        named_here = PRIORITY.get(code) is None and _AFTER.match(text[m.end() :])
        if before.endswith(name.lower()) or named_here:
            return code
        return f"{code} {name}"

    return CODE.sub(put, text), missing


# --------------------------------------------------------------------------- footnotes

# A trailing "*" after a word or number is a mark too ("40%*"), never emphasis (``*a*``,
# ``**a**``: an odd count of "*" before it opens one).
_MARK = re.compile(r"(?<=[^\s*])([†‡§]|\\?\*(?![*\w]))")
_NOTE = re.compile(r"^\s*(?:[-*+]\s+)?(?P<mark>[†‡§])\s*(?P<note>\S.*)$")
_STAR_NOTE = re.compile(r"^\s*(?P<esc>\\)?\*\s+(?P<note>\S.*)$")


def footnote_notes(sections: list[Section]) -> dict[str, str]:
    out: dict[str, str] = {}
    for sec in sections:
        lines = (sec.body_md or "").splitlines()
        for i, raw in enumerate(lines):
            if m := _NOTE.match(raw):
                out.setdefault(m.group("mark"), _plain(m.group("note")))
            elif m := _STAR_NOTE.match(raw):
                # "\\* note", or a lone "* note" (a list of "*" bullets is no note).
                near = lines[max(i - 1, 0) : i] + lines[i + 1 : i + 2]
                if m.group("esc") or not any(_STAR_NOTE.match(x) for x in near):
                    out.setdefault("*", _plain(m.group("note")))
    return out


def marked(text: str, notes: dict[str, str]) -> tuple[str, list[str]]:
    """The text with only the marks whose note the PRD has, and those notes."""
    kept: list[str] = []

    def put(m: re.Match[str]) -> str:
        mark = m.group(1).lstrip("\\")
        if mark == "*" and text[: m.start()].count("*") % 2:
            return m.group(1)  # closes emphasis
        if mark in notes:
            if f"{mark} {notes[mark]}" not in kept:
                kept.append(f"{mark} {notes[mark]}")
            return mark
        return ""

    return _MARK.sub(put, text), kept


# --------------------------------------------------------------------------- numbers

_WORDS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen twenty".split()
)}  # fmt: skip
_NUM = r"(?:\d[\d,]*(?:\.\d+)?|" + "|".join(_WORDS) + r")"
_COUNT = re.compile(
    rf"\b(?P<n>{_NUM})\s+(?:(?:more|other|new|open|big|small|planned)\s+)?"
    r"(?P<noun>features|items|bets|ideas|requests|tickets|stories|epics|projects|risks)\b"
    r"(?P<tail>(?:\s+[a-z]+){0,3})",
    re.I,
)
_FIELD = re.compile(r"^[A-Z][\w ]{0,24}:\s")
_HEAD_COUNT = re.compile(r"(?:·|\()\s*(?P<n>\d+)\s+items?\b", re.I)
_PER = re.compile(
    rf"\b(?:each|every|per)\s+(?P<thing>[a-z]+?)s?\s+(?:[a-z]+\s+){{0,2}}?(?P<n>{_NUM})\s+"
    r"(?P<unit>[a-z]+(?:\s+[a-z]+)?)",
    re.I,
)
_TOTAL = re.compile(
    r"company[- ]wide|across the company|company target|whole company|in total|overall", re.I
)


def _num(text: str) -> float | None:
    t = text.lower().replace(",", "")
    if t in _WORDS:
        return float(_WORDS[t])
    try:
        return float(t)
    except ValueError:
        return None


def _round(x: float) -> Decimal:
    """``x`` to 6 places, an exact half away from zero, as the mock's ``toFixed(6)`` rounds it
    ("0.0078125" -> "0.007813"); a number is compared and written as rounded here."""
    return Decimal(x).quantize(Decimal("1e-6"), ROUND_HALF_UP, Context(prec=400))


def _n(x: float) -> str:
    """``x`` as a person writes it: thousands separators, no float noise, never cut or in
    exponent form ("0.3", not "0.30000000000000004"; "1,234,567.5", not "1.23457e+06")."""
    return f"{_round(x):,f}".rstrip("0").rstrip(".")


def _sentences(sec: Section) -> list[str]:
    bullets, rows, prose = _rows(sec.body_md or "")
    out = [s for s in re.split(r"(?<=[.!?])\s+", " ".join(prose)) if s]
    return out + bullets + [" · ".join(r) for r in rows]


def _number_at(body: str, said: str) -> re.Match[str] | None:
    """The first number in ``body`` that reads ``said`` (its first word the number, the
    words after it in order, any markup or spaces between)."""
    first, *rest = said.split()
    after = "".join(rf"[\W_]+{re.escape(w)}" for w in rest)
    return re.search(rf"(?<![\w.,]){re.escape(first)}(?![\w])(?={after}(?!\w))", body or "", re.I)


def set_number(body: str, said: str, value: str) -> str | None:
    """``body`` with the number of ``said`` set to ``value``; None when it holds no such
    words (changed since)."""
    m = _number_at(body, said)
    return (
        None if m is None else body[: m.start()] + as_written(m.group(0), value) + body[m.end() :]
    )


def as_written(old: str, value: str) -> str:
    """``value`` as ``old`` is written: a count in words stays in words ("Eight" -> "Six",
    its case kept); a numeral, or a value with no word for it, as a numeral."""
    if old.isdigit() or old.lower() not in _WORDS:
        return value
    word = next((w for w, i in _WORDS.items() if str(i) == value), None)
    if word is None:
        return value
    if old.isupper():
        return word.upper()
    return word.capitalize() if old[:1].isupper() else word


def _like(before: str, value: float) -> str:
    """``value`` written as ``before`` is: its thousands separators ("1,200,000") and at
    least its places after the point ("2.75" -> "2.50"), more when the value needs them."""
    places = len(before.partition(".")[2])
    own = f"{_round(value):f}".rstrip("0").partition(".")[2]
    return f"{_round(value):{',' if ',' in before else ''}.{max(places, len(own))}f}"


def _fix(
    sec: Section, said: str, before: str, value: float, heading: bool = False
) -> dict[str, str] | None:
    if _number_at((sec.heading if heading else sec.body_md) or "", said) is None:
        return None
    fix = {
        "section": sec.section_key,
        "said": said,
        "before": before,
        "value": _like(before, value),
    }
    return fix | {"part": "heading"} if heading else fix


def numbers(sections: list[Section]) -> list[Look]:
    """The PRD's own numbers that disagree, each naming both numbers and where they are."""
    looks: list[Look] = []
    for sec in sections:
        bullets, rows, prose = _rows(sec.body_md or "")
        listed = len(bullets) + len(rows)
        head = _plain(sec.heading or "")
        hm = _HEAD_COUNT.search(head)
        shown = int(hm.group("n")) if hm else None
        if shown is not None and hm is not None and listed and shown != listed:
            looks.append(Look(
                "numbers",
                f"“{head}” says {shown} items, but it lists {listed}.",
                [head], [sec.section_key],
                _fix(sec, head[hm.start("n"):hm.end()], hm.group("n"), listed, heading=True),
            ))  # fmt: skip
        target = shown if shown is not None else listed
        if not target:
            continue
        # A count disagrees only with a list of the same things (CLD's walk B, 2026-11-01):
        # "M1 ships two features" above its scope, exit and date lines ("Scope: ...") is no
        # list of features. Such a list counts only when its heading or header names them.
        listing = f"{head} {' '.join(_header(sec.body_md or ''))}".lower()
        fields = bool(bullets) and not rows and all(_FIELD.match(b) for b in bullets)
        for s in [head, *re.split(r"(?<=[.!?])\s+", " ".join(prose))]:
            for m in _COUNT.finditer(s):
                n = _num(m.group("n"))
                if n is None or n == target:
                    continue
                noun = m.group("noun").lower().removesuffix("s").removesuffix("ie")
                if hm is None and fields and noun not in listing:
                    continue
                # Every word from the number on ("two more features"), as _number_at reads it.
                said = " ".join(m.group(0).split())
                looks.append(Look(
                    "numbers",
                    f"“{said}” says {_n(n)}, but “{head}” shows {target} items.",
                    [head], [sec.section_key],
                    _fix(sec, said, m.group("n"), target, heading=s is head),
                ))  # fmt: skip
    looks += _per_unit(sections)
    return looks


def _per_unit(sections: list[Section]) -> list[Look]:
    said = [(sec, s) for sec in sections for s in _sentences(sec)]
    looks: list[Look] = []
    for sec, s in said:
        if _TOTAL.search(s):
            continue
        for m in _PER.finditer(s):
            per, thing = _num(m.group("n")), m.group("thing").lower()
            unit = [w for w in m.group("unit").lower().split() if len(w) > 3]
            if per is None or not unit or thing in ("month", "week", "day", "year", "quarter"):
                continue
            count = None
            for csec, cs in said:
                if c := re.search(rf"\b(?P<n>{_NUM})\s+{re.escape(thing)}s\b", cs, re.I):
                    count = (_num(c.group("n")), csec, c.group(0))
                    break
            if count is None or count[0] is None:
                continue
            for tsec, ts in said:
                if not _TOTAL.search(ts):
                    continue
                t = re.search(
                    rf"\b(?P<n>{_NUM})\s+(?:[a-z]+\s+){{0,2}}?(?:{'|'.join(map(re.escape, unit))})",
                    ts,
                    re.I,
                )
                total = _num(t.group("n")) if t else None
                # Equal as written: 0.1 × 3 is 0.3, not 0.30000000000000004.
                if total is None or _round(total) == _round(per * count[0]):
                    continue
                looks.append(Look(
                    "numbers",
                    f"{_n(per)} {m.group('unit')} per {thing} × {count[2]} is "
                    f"{_n(per * count[0])}, but the company-wide target says {t.group('n')}.",
                    list(dict.fromkeys(_plain(x.heading or "") for x in (sec, count[1], tsec))),
                    list(dict.fromkeys(x.section_key for x in (sec, count[1], tsec))),
                    _fix(tsec, t.group(0), t.group("n"), per * count[0]),
                ))  # fmt: skip
                break
    return looks


# --------------------------------------------------------------------------- read as words

_MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
_ISO = re.compile(
    r"\b(?P<y>20\d\d)-(?P<m>0[1-9]|1[0-2])-(?P<d>0[1-9]|[12]\d|3[01])(?:T[\d:.]+Z?)?\b"
)
# An internal pointer: a link's or heading's anchor ("(#feature-pacing-plan)", "{#f-01}").
_POINTER = re.compile(r"\(\s*#[\w-]+\s*\)|\{#[^}]*\}")


def month_first(text: str) -> str:
    """Generated words as people read them: an ISO date month first ("2027-03-31" -> "Mar
    31, 2027"), no anchor or pointer left."""
    if not text:
        return text
    text = _ISO.sub(lambda m: f"{_MONTHS[int(m['m']) - 1]} {int(m['d'])}, {m['y']}", text)
    text = re.sub(r"\[([^\]]*)\]\(#[^)]*\)", r"\1", text)
    return " ".join(_POINTER.sub("", text).split())


def whole_word(cut: str, said: str) -> str:
    """A target an older build cut mid-word ("80% of acc") whole again from its line's
    words ("80% of accounts"); as it is when the line has no longer word there."""
    cut = cut.rstrip("…").strip()
    if not cut:
        return cut
    m = re.search(re.escape(cut) + r"[^\s,;.)]*", said or "")
    return m.group(0) if m else cut


# --------------------------------------------------------------------------- the read


def annotate(
    blocks: list[Any],
    sections: list[Section],
    checked: list[Any] | None = None,
) -> list[Look]:
    """One call from the one-pager's read: fills each block's and line's clear-reading
    fields in place (``who``; each line's codes with names, its footnotes; each outcome's
    ``measure`` and ``measure_source``, in the PRD's own words) and returns the
    "Needs a look" items; the numbers are those of ``checked`` when given (the sections as
    the reader's working draft has them, so a fixed number clears)."""
    names = glossary(sections)
    notes = footnote_notes(sections)
    found = measures(sections)
    who = who_has_it(sections)
    looks: list[Look] = []
    unnamed: dict[str, list[str]] = {}
    for b in blocks:
        if b.key == "problem":
            b.who = month_first(who) if who else who
        for x in b.lines:
            said = x.full or x.text
            x.text, missing = with_names(x.text, names)
            if x.full:
                x.full = with_names(x.full, names)[0]
            for code in missing:
                unnamed.setdefault(code, []).extend(k for k in x.source_keys)
            x.text, x.footnotes = marked(x.text, notes)
            if x.full:
                x.full = marked(x.full, notes)[0]
            x.text = month_first(x.text)
            x.full = month_first(x.full) if x.full else x.full
            if x.metric is not None:
                x.metric.name = month_first(marked(with_names(x.metric.name, names)[0], notes)[0])
                to = whole_word(x.metric.to, _plain(said))
                x.metric.to = month_first(marked(to, notes)[0])
            # The Edit box starts from the PRD's words, not the names and marks put in.
            x.words = said if (x.full or x.text) != said else None
            if b.kind == "metrics":
                m = measure_for(x.full or x.text, x.metric.name if x.metric else None, found)
                if m is not None:
                    x.measure = month_first(with_names(m.measure, names)[0])
                    x.measure_source = month_first(m.source) if m.source else None
    heads = {s.section_key: _plain(s.heading or "") for s in sections}
    for code, keys in unnamed.items():
        keys = list(dict.fromkeys(keys))
        looks.append(Look(
            "code", f"{code} has no name in the PRD.", [heads.get(k, k) for k in keys], keys
        ))  # fmt: skip
    return once(looks + numbers(sections if checked is None else checked))


def once(looks: list[Look]) -> list[Look]:
    """Each item once (vqa-one-pager): a disagreement the PRD states twice (the same sentence
    again in its Summary) is one item, not two of the same card; the first is kept."""
    seen: set[tuple[str, str, tuple[str, ...]]] = set()
    out: list[Look] = []
    for x in looks:
        key = (x.kind, x.text, tuple(x.source_keys))
        if key not in seen:
            seen.add(key)
            out.append(x)
    return out
