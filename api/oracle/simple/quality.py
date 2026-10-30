"""Quality checks on what Oracle generates before people see it (the Simple plan's open
point on generation quality). Deterministic: no model call.

- :func:`one_pager`: a one-pager answer fills every block it was given (or marks one
  :data:`NOT_IN_PRD`), has 3 to 5 bets, every line links a section of its block and draws on
  it (shares a word with it), and no line holds a placeholder or model chatter.
- :func:`suggestion`: a goal suggestion names its goal (``goal_key``), is not a duplicate of
  a roadmap item or a baseline feature (oracle.simple.additions.reconcile, the matcher
  people see as "Looks like"), has a title a person reads in one line, and holds no
  placeholder or chatter.
- :func:`item_draft`: an added item's draft names one of the item's goals (when it has
  any) and its words hold no placeholder or chatter.

Each failure is ``{"check": <kind>, "say": <plain words>}``. The jobs (one_pager,
goal_suggestions, item_draft) ask once more with the failures named
(``failed_checks``); an answer that fails again is stored with its failures: owners read
it with a "Needs a look" note naming them, people below owner the last good version (or
nothing new).
"""

import re
from typing import Any

NOT_IN_PRD = "Not in the PRD yet"
# A title a person reads in one line.
TITLE_LINE = 60
TITLE_WORDS = 10
BETS = (3, 5)

_EMPTY = re.compile(r"^[\s\-*+•·.,:;–—]*$")
_TBD = re.compile(r"\b(?:TBD|TBC|TODO|FIXME)\b|\bto be (?:decided|determined|confirmed)\b", re.I)
_LOREM = re.compile(r"\blorem\b|\bipsum\b", re.I)
_CHATTER = re.compile(
    r"\bas an ai\b|\bas a (?:large )?language model\b|\bI(?: am|'m) (?:an ai|unable)\b"
    r"|\bI (?:cannot|can't|can not)\b|\bhere(?: is|'s) (?:the|a|your)\b|\bI hope this\b"
    r"|\bcertainly[,!]|^sure[,!]",
    re.I,
)
_BRACES = re.compile(r"\{[^{}\n]*\}|\{\{|\}\}")
_MARKDOWN = re.compile(
    r"^\s*(?:#{1,6}\s|[-*+]\s|>\s|\d+[.)]\s|\|)|\*\*|__|`|\[[^\]]*\]\([^)]*\)|^\s*[-*_]{3,}\s*$"
)
_WORD = re.compile(r"[^\W\d_]{4,}")


def _q(text: str, n: int = 6) -> str:
    """A line's first words, never cut mid-word."""
    words = " ".join(str(text or "").split()).split(" ")
    return " ".join(words[:n]) + ("…" if len(words) > n else "")


def words(text: str) -> list[dict[str, str]]:
    """The placeholder and chatter checks of one piece of text (``where`` names it)."""
    raw = str(text or "")
    out: list[dict[str, str]] = []
    if _EMPTY.match(raw):
        return [{"check": "empty", "say": "is empty"}]
    if _TBD.search(raw):
        out.append({"check": "tbd", "say": "says “TBD”"})
    if _LOREM.search(raw):
        out.append({"check": "lorem", "say": "holds placeholder text (lorem ipsum)"})
    if _CHATTER.search(raw.strip()):
        out.append({"check": "chatter", "say": "holds the model's chatter (“As an AI…”)"})
    if _BRACES.search(raw):
        out.append({"check": "braces", "say": "has an unfilled {placeholder}"})
    if any(_MARKDOWN.search(x) for x in raw.splitlines() or [raw]):
        out.append({"check": "markdown", "say": "has markdown left over"})
    return out


def _stems(text: str) -> set[str]:
    return {w.casefold()[:5] for w in _WORD.findall(text or "")}


def _add(out: list[dict[str, str]], check: str, say: str) -> None:
    if not any(x["say"] == say for x in out):
        out.append({"check": check, "say": say})


def marked(block: dict[str, Any]) -> bool:
    if block.get("missing") is True:
        return True
    texts = [" ".join(str((x or {}).get("text") or "").split()) for x in block.get("lines") or []
             if isinstance(x, dict)]  # fmt: skip
    return len(texts) == 1 and texts[0].rstrip(".").casefold() == NOT_IN_PRD.casefold()


def one_pager(answer: Any, specs: tuple[Any, ...], mapped: dict[str, list[Any]]) -> list[dict]:
    """The failed checks of a ``one_pager`` answer ([] when it passes)."""
    given = {
        b.get("key"): b
        for b in ((answer or {}).get("blocks") or [] if isinstance(answer, dict) else [])
        if isinstance(b, dict)
    }
    out: list[dict[str, str]] = []
    for spec in specs:
        block = given.get(spec.key) or {}
        title = f"“{spec.title}”"
        lines = [x for x in block.get("lines") or [] if isinstance(x, dict)]
        if marked(block):
            continue
        if not lines:
            _add(out, "empty_block", f"{title} is empty and not marked “{NOT_IN_PRD}”")
            continue
        if spec.key == "bets" and not BETS[0] <= len(lines) <= BETS[1]:
            n = len(lines)
            _add(out, "bets", f"{n} {'bet' if n == 1 else 'bets'}; a one-pager has 3 to 5")
        secs = {s.section_key: s for s in mapped.get(spec.key, [])}
        for raw in lines:
            text = str(raw.get("text") or "")
            keys = [str(k) for k in raw.get("source_keys") or []]
            linked = [secs[k] for k in keys if k in secs]
            if not keys or len(linked) < len(keys):
                _add(out, "unsourced", f"A line in {title} links no section of it")
            elif (mine := _stems(text)) and not mine & set().union(
                *(_stems(f"{s.heading or ''} {s.body_text or ''}") for s in linked)
            ):
                _add(out, "unsourced", f"“{_q(text)}” does not draw on the section it links")
            for f in words(text):
                _add(out, f["check"], f"A line in {title} {f['say']}")
            m = raw.get("metric")
            if isinstance(m, dict):
                for f in words(" ".join(str(m.get(k) or "") for k in ("name", "from", "to"))):
                    if f["check"] != "empty":
                        _add(out, f["check"], f"A measure in {title} {f['say']}")
    return out


def suggestion(
    raw: dict[str, Any], goal: Any, entries: list[Any], features: list[Any]
) -> list[dict[str, str]]:
    """The failed checks of one goal suggestion ([] when it passes)."""
    from oracle.simple import additions

    out: list[dict[str, str]] = []
    title = " ".join(str(raw.get("title") or "").split())
    named = str(raw.get("goal_key") or raw.get("goal") or "").strip().casefold()
    if named not in {str(goal.key).casefold(), str(goal.title or "").casefold()}:
        _add(out, "goal", f"“{_q(title)}” does not name its goal")
    for m in additions.reconcile(title, entries, features)[:1]:
        where = "on the roadmap" if m.kind == "item" else "a feature"
        _add(out, "duplicate", f"“{_q(title)}” repeats “{_q(m.title)}”, already {where}")
    if (
        "\n" in str(raw.get("title") or "")
        or len(title) > TITLE_LINE
        or (len(title.split()) > TITLE_WORDS)
    ):
        _add(out, "title", f"“{_q(title)}” is too long to read in one line")
    for field, what in (("title", "Its title"), ("outcome", "Its outcome"), ("why", "Its why")):
        for f in words(str(raw.get(field) or "")):
            if f["check"] != "empty" or field == "title":
                _add(out, f["check"], f"“{_q(title)}”: {what.lower()} {f['say']}")
    return out


def item_draft(answer: Any, goals: list[Any]) -> list[dict[str, str]]:
    """The failed checks of an ``item_draft`` answer ([] when it passes)."""
    out: list[dict[str, str]] = []
    if not isinstance(answer, dict):
        return [{"check": "empty", "say": "The draft is empty"}]
    if goals:
        named = str(answer.get("goal_key") or "").strip().casefold()
        if named not in {str(g.key).casefold() for g in goals}:
            _add(out, "goal", "The draft does not name the item's goal")
    for field, what in (("outcome", "Its outcome"), ("basis", "Its date's reason")):
        if answer.get(field):
            for f in words(str(answer[field])):
                _add(out, f["check"], f"{what} {f['say']}")
    return out


def said(checks: list[dict[str, str]] | None) -> list[str]:
    """The checks' plain words, as owners read them."""
    return [str(x.get("say") or "") for x in checks or [] if x.get("say")]
