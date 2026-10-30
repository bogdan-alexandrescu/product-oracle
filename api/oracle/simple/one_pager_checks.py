"""The one-pager reads clearly (the owner's pick, 2026-10-30): who has the problem, how each
outcome is measured, codes with names, footnote marks with their notes, and numbers that
add up. Deterministic reads of the PRD's own sections; the one-pager calls :func:`annotate`
on every read and :func:`problem_check` on the job's answer.

- **Who has it**: the PRD's users or personas section (:func:`who_has_it`); the problem
  block carries it (``who``), and a job answer whose problem names no one of it is asked
  again (:func:`problem_check`).
- **How it is measured**: each outcome line carries its measure and its source from the PRD
  (``measure``, ``measure_source``): "counted as ..." / "source: ..." words or a metrics
  table's definition and source columns (:func:`measures`).
- **Codes with names**: a feature or ticket code (F-26, P0) gets the name the PRD gives it
  beside it (:func:`glossary`); a code the PRD never names is a "Needs a look" item.
- **Footnotes**: a mark (†, ‡, §) stays only with its note (``footnotes``); a mark with no
  note in the PRD is dropped.
- **Numbers that don't add up** (:func:`numbers`): a per-unit target times the stated units
  against a company-wide target, and a count said in words against the items listed.

The "Needs a look" items (:class:`Look`) are the PRD's owners' only; the page renders them
as one list, which other checks (the Definition of Done quality checks) can join.
"""

import re
from dataclasses import dataclass, field
from typing import Any

from oracle.docs.models import Section

WHO_SAYS_NOTHING = "Who has it is not in the PRD yet"

_WHO_HEAD = re.compile(r"\b(?:users?|personas?|who\b|audiences?|customers?)", re.I)
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


def _plain(text: str) -> str:
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


def who_has_it(sections: list[Section]) -> str | None:
    """Who has the problem, from the PRD's users or personas section: each bullet's lead
    ("New admins: ..." -> "New admins"), else its first sentence. None when the PRD has
    no such section (the page says :data:`WHO_SAYS_NOTHING`)."""
    for sec in sections:
        head = sec.heading or ""
        if not _WHO_HEAD.search(head) or re.search(r"problem", head, re.I):
            continue
        bullets, rows, prose = _rows(_guidanceless(sec.body_md or ""))
        named = [re.split(r"\s*(?::|—|–| - )\s*", b, maxsplit=1)[0] for b in bullets]
        named += [r[0] for r in rows if r and r[0]]
        if not named and prose:
            named = [re.split(r"(?<=[.!?])\s+", " ".join(prose))[0].rstrip(".")]
        named = [" ".join(n.split()[:12]) for n in named if n.strip()]
        if named:
            return " ".join("; ".join(named).split()[:30])
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


def _measure_in(text: str) -> Measure | None:
    m = _MEASURE.search(text)
    if not m:
        return None
    name = text[: m.start()].strip(" :,;·-—–")
    rest = text[m.end() :]
    s = _SOURCE.search(rest)
    measure = (rest[: s.start()] if s else rest).strip(" :,;·-—–.")
    source = s.group("s").strip(" :,;·-—–.") if s else None
    if not measure:
        return None
    return Measure(name, measure, source or None)


def measures(sections: list[Section]) -> list[Measure]:
    """Every measure the PRD states: "<metric> ... counted as <what> · from <source>"
    lines, and a table's definition and source columns (its first cell names the metric)."""
    out: list[Measure] = []
    for sec in sections:
        bullets, rows, prose = _rows(sec.body_md or "")
        for text in bullets + re.split(r"(?<=[.!?])\s+", " ".join(prose)):
            if m := _measure_in(text):
                out.append(m)
        head = _header(sec.body_md or "")
        mcol = next((i for i, h in enumerate(head) if i and _MEASURE_COL.search(h)), None)
        scol = next((i for i, h in enumerate(head) if i and _SOURCE_COL.search(h)), None)
        for r in rows:
            if mcol is not None and mcol < len(r) and r[mcol]:
                src = r[scol] if scol is not None and scol < len(r) and r[scol] else None
                out.append(Measure(r[0], r[mcol], src))
            elif m := _measure_in(" · ".join(r)):
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

CODE = re.compile(r"\b(?:[A-Z]{1,3}-\d{1,4}|P[0-3])\b")
# A priority code the PRD never names reads as the usual words.
PRIORITY = {"P0": "top priority", "P1": "high priority", "P2": "medium priority",
            "P3": "low priority"}  # fmt: skip
_NAMED = re.compile(r"^\s*(?:[:=—–]|\s-\s|\()\s*(?P<n>[A-Za-z][^.;,()|:\n]*)")
_CAPITAL = re.compile(r"^\s+(?P<n>[A-Z][^.;,()|:\n]*)")


def _name(text: str) -> str:
    return " ".join(text.split()[:5]).strip(" -—–")


def glossary(sections: list[Section]) -> dict[str, str]:
    """Each code the PRD names: "F-26: Bulk invite", "F-26 — Bulk invite", "F-26 (Bulk
    invite)", a bullet or heading "F-26 Bulk invite", or a table row "| F-26 | Bulk invite |"."""
    out: dict[str, str] = {}
    for sec in sections:
        lines = [sec.heading or ""] + (sec.body_md or "").splitlines()
        for raw in lines:
            if raw.strip().startswith("|"):
                cells = [_plain(c) for c in raw.strip().strip("|").split("|")]
                for i, c in enumerate(cells[:-1]):
                    if CODE.fullmatch(c) and cells[i + 1] and not CODE.fullmatch(cells[i + 1]):
                        out.setdefault(c, _name(cells[i + 1]))
                continue
            text = _plain((m.group(1) if (m := _BULLET.match(raw)) else raw).lstrip("# "))
            for c in CODE.finditer(text):
                rest = text[c.end() :]
                n = _NAMED.match(rest) or (_CAPITAL.match(rest) if c.start() == 0 else None)
                if n and _name(n.group("n")):
                    out.setdefault(c.group(0), _name(n.group("n")))
    return out


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
        return f"{code} {name}"

    return CODE.sub(put, text), missing


# --------------------------------------------------------------------------- footnotes

_MARK = re.compile(r"(?<=\S)([†‡§])")
_NOTE = re.compile(r"^\s*(?:[-*+]\s+)?(?P<mark>[†‡§])\s*(?P<note>\S.*)$")


def footnote_notes(sections: list[Section]) -> dict[str, str]:
    out: dict[str, str] = {}
    for sec in sections:
        for raw in (sec.body_md or "").splitlines():
            if m := _NOTE.match(raw):
                out.setdefault(m.group("mark"), _plain(m.group("note")))
    return out


def marked(text: str, notes: dict[str, str]) -> tuple[str, list[str]]:
    """The text with only the marks whose note the PRD has, and those notes."""
    kept: list[str] = []

    def put(m: re.Match[str]) -> str:
        mark = m.group(1)
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


def _n(x: float) -> str:
    return str(int(x)) if x == int(x) else f"{x:g}"


def _sentences(sec: Section) -> list[str]:
    bullets, rows, prose = _rows(sec.body_md or "")
    out = [s for s in re.split(r"(?<=[.!?])\s+", " ".join(prose)) if s]
    return out + bullets + [" · ".join(r) for r in rows]


def numbers(sections: list[Section]) -> list[Look]:
    """The PRD's own numbers that disagree, each naming both numbers and where they are."""
    looks: list[Look] = []
    for sec in sections:
        bullets, rows, prose = _rows(sec.body_md or "")
        listed = len(bullets) + len(rows)
        head = _plain(sec.heading or "")
        hm = _HEAD_COUNT.search(head)
        shown = int(hm.group("n")) if hm else None
        if shown is not None and listed and shown != listed:
            looks.append(Look(
                "numbers",
                f"“{head}” says {shown} items, but it lists {listed}.",
                [head], [sec.section_key],
            ))  # fmt: skip
        target = shown if shown is not None else listed
        if not target:
            continue
        for s in [head, *re.split(r"(?<=[.!?])\s+", " ".join(prose))]:
            for m in _COUNT.finditer(s):
                n = _num(m.group("n"))
                if n is None or n == target:
                    continue
                said = f"{m.group('n')} {m.group('noun')}{m.group('tail')}".strip()
                looks.append(Look(
                    "numbers",
                    f"“{said}” says {_n(n)}, but “{head}” shows {target} items.",
                    [head], [sec.section_key],
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
                if total is None or total == per * count[0]:
                    continue
                looks.append(Look(
                    "numbers",
                    f"{_n(per)} {m.group('unit')} per {thing} × {count[2]} is "
                    f"{_n(per * count[0])}, but the company-wide target says {_n(total)}.",
                    list(dict.fromkeys(_plain(x.heading or "") for x in (sec, count[1], tsec))),
                    list(dict.fromkeys(x.section_key for x in (sec, count[1], tsec))),
                ))  # fmt: skip
                break
    return looks


# --------------------------------------------------------------------------- the read


def annotate(blocks: list[Any], sections: list[Section]) -> list[Look]:
    """One call from the one-pager's read: fills each block's and line's clear-reading
    fields in place (``who``; each line's codes with names, its footnotes; each outcome's
    ``measure`` and ``measure_source``) and returns the "Needs a look" items."""
    names = glossary(sections)
    notes = footnote_notes(sections)
    found = measures(sections)
    who = who_has_it(sections)
    looks: list[Look] = []
    unnamed: dict[str, list[str]] = {}
    for b in blocks:
        if b.key == "problem":
            b.who = who
        for x in b.lines:
            x.text, missing = with_names(x.text, names)
            if x.full:
                x.full = with_names(x.full, names)[0]
            for code in missing:
                unnamed.setdefault(code, []).extend(k for k in x.source_keys)
            x.text, x.footnotes = marked(x.text, notes)
            if x.full:
                x.full = marked(x.full, notes)[0]
            if x.metric is not None:
                x.metric.name = marked(with_names(x.metric.name, names)[0], notes)[0]
                x.metric.to = marked(x.metric.to, notes)[0]
            if b.kind == "metrics":
                m = measure_for(x.full or x.text, x.metric.name if x.metric else None, found)
                if m is not None:
                    x.measure, x.measure_source = m.measure, m.source
    heads = {s.section_key: _plain(s.heading or "") for s in sections}
    for code, keys in unnamed.items():
        keys = list(dict.fromkeys(keys))
        looks.append(Look(
            "code", f"{code} has no name in the PRD.", [heads.get(k, k) for k in keys], keys
        ))  # fmt: skip
    return looks + numbers(sections)
