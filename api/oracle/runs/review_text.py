"""The generated text a run review shows, read plainly (walk-eng-check ITEM 11).

Agents write an architect's approach, a date's assumptions and its no-date reason; the
review shows them as a person reads them (.claude/rules/oracle-product.md): month-first
dates ("Nov 2, 2026", never 2026-11-02), a code with its name (a feature key with its
title, a brief's question id as its question), and no confidence numbers ("(plan, 0.73)"),
bare question ids ("decision Q1", "FS-Q2") or citation ids ("[c:c4]") in prose.

:func:`plain` rewrites one text; :func:`review_payload` the text fields of a checkpoint's
payload as the run read serves it (the stored payload keeps what the agent wrote, and the
structured fields, a proposed ``supports_date`` or a key, are never rewritten). The
agents' tasks ask for the same (``oracle.runs.flows.PLAIN_PROSE``).
"""

import copy
import re
from collections.abc import Mapping
from datetime import date
from typing import Any

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

_CITE = re.compile(r"[ \t]*\[c:[^\]\n]*\]")
# A citation cut at the text's end ("... [c:c").
_CUT_CITE = re.compile(r"[ \t]*\[c(?::[^\]\s]*)?$")
_ISO = re.compile(
    r"\b(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b"
)
_SCORE = r"(?:0?\.\d+|1\.0+)"
# "(0.6)" or "(confidence 0.6)": the whole bracket goes.
_ALONE = re.compile(rf"[ \t]*\((?:confidence[:\s]*)?{_SCORE}\)", re.IGNORECASE)
# "(plan, 0.73)": the number goes, the words stay.
_TRAILING = re.compile(rf",\s*(?:confidence[:\s]*)?{_SCORE}\s*\)", re.IGNORECASE)
# ", confidence 0.55" in a sentence.
_NAMED = re.compile(rf",?[ \t]*\bconfidence[:\s]*{_SCORE}\b", re.IGNORECASE)
# A question or decision named by its id alone: "decision Q1", "question FS-Q2", "FS-Q2".
# A bare "Q4" stays: it is a quarter as often as not.
_ASKED = re.compile(r"\b(decision|question)\s+(?:[A-Z]{1,4}-)?Q\d{1,3}\b", re.IGNORECASE)
_PREFIXED = re.compile(r"\b[A-Z]{1,4}-Q\d{1,3}\b")
_SPACES = re.compile(r"[ \t]{2,}")
_BEFORE_MARK = re.compile(r"[ \t]+([,.;:!?)])")


def month_first(day: date) -> str:
    return f"{MONTHS[day.month - 1]} {day.day}, {day.year}"


def _date(m: re.Match[str]) -> str:
    try:
        return month_first(date(int(m[1]), int(m[2]), int(m[3])))
    except ValueError:
        return m[0]


def _code_like(key: str) -> bool:
    """A key that reads as a code, never as a word of a sentence (it has a hyphen or a
    digit)."""
    return bool(re.search(r"[-\d]", key))


def plain(
    text: str | None,
    *,
    codes: Mapping[str, str] | None = None,
    questions: Mapping[str, str] | None = None,
) -> str:
    """``text`` as a run review shows it. ``codes``: key -> name of the codes the review
    knows (each code's first mention gets its name after it, unless it has it already);
    ``questions``: id -> question of the questions the text may name by id (the id becomes
    the quoted question)."""
    if not text:
        return text or ""
    out = _CUT_CITE.sub("", _CITE.sub("", text))
    out = _TRAILING.sub(")", _ALONE.sub("", out))
    out = _NAMED.sub("", out)
    out = _ISO.sub(_date, out)
    for qid, question in (questions or {}).items():
        if not qid or not question:
            continue
        said = re.compile(rf"\b(?:(?i:decision|question)\s+)?{re.escape(qid)}\b")
        out = said.sub(lambda _m, q=question: f'"{q}"', out)
    out = _ASKED.sub(lambda m: f"an open {m[1].lower()}", out)
    out = _PREFIXED.sub("an open question", out)
    for key, name in (codes or {}).items():
        if not key or not name or name == key or not _code_like(key):
            continue
        first = re.search(rf"(?<![\w-]){re.escape(key)}(?![\w-])", out)
        if first is None or out[first.end() :].lstrip(" (").startswith(name):
            continue
        out = f"{out[: first.end()]} {name}{out[first.end() :]}"
    out = _BEFORE_MARK.sub(r"\1", _SPACES.sub(" ", out))
    return out.strip()


def _briefs(check: dict[str, Any]) -> None:
    features = [f for f in check.get("features") or [] if isinstance(f, dict)]
    codes = {str(f.get("key")): str(f.get("title") or "") for f in features}
    for f in features:
        asked = {
            str(q.get("id")): str(q.get("question") or "")
            for q in f.get("questions") or []
            if isinstance(q, dict)
        }
        if isinstance(f.get("approach"), str):
            f["approach"] = plain(f["approach"], codes=codes, questions=asked)
        for q in f.get("questions") or []:
            if isinstance(q, dict) and isinstance(q.get("question"), str):
                q["question"] = plain(q["question"], codes=codes)


def _dates(check: dict[str, Any]) -> None:
    items = [i for i in check.get("items") or [] if isinstance(i, dict)]
    others = [i for i in check.get("others") or [] if isinstance(i, dict)]
    codes = {str(i.get("key")): str(i.get("title") or "") for i in (*items, *others)}
    for i in items:
        if isinstance(i.get("assumptions"), list):
            i["assumptions"] = [
                plain(a, codes=codes) if isinstance(a, str) else a for a in i["assumptions"]
            ]
        if isinstance(i.get("no_date_reason"), str):
            i["no_date_reason"] = plain(i["no_date_reason"], codes=codes)


# Checkpoint kind -> (the payload key its review reads, what reads it plainly).
_READERS = {"eng_review": ("briefs_check", _briefs), "eng_dates": ("dates_check", _dates)}


def review_payload(kind: str, payload: dict[str, Any] | None) -> dict[str, Any] | None:
    """``payload`` with the generated text its review shows read plainly (a copy: the
    stored payload is never changed)."""
    reader = _READERS.get(kind)
    if not payload or reader is None:
        return payload
    key, fn = reader
    check = payload.get(key)
    if not isinstance(check, dict):
        return payload
    check = copy.deepcopy(check)
    fn(check)
    return {**payload, key: check}
