"""The approve gate of a checkpoint (D3 Approve blocked by problems, call c3).

Approve stays refused while any **blocking** reason is open, on every path: the decide
route (web, Inbox, generated MCP tools), a confirmed or continued console approval, and a
counted console approval the tick reads (held, not followed). A blocking reason is open
unless a **staged** waiver answers it; a suggestion never counts, and staged edits do not
count until D7 Approve with edits applies and re-checks them. File-level problems are never
waived: the only way on is Send back.

Each checkpoint kind's blocking reasons come from the spec that owns the kind, registered in
:data:`BLOCKING_SOURCES` with the codes that may not be waived. :func:`approve_gate` is the
one gate every path reads.
"""

import hashlib
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

from oracle import wording
from oracle.engineering import check as eng_check
from oracle.engineering import dates as eng_dates
from oracle.runs.feature_set import FILE_PROBLEMS
from oracle.runs.models import Checkpoint
from oracle.runs.schemas import Gate, GateLeft

BLOCKING = "blocking"
# O4 Roadmap shape: a date shows only on a verified basis, so a date is never waived (its
# fixes are Remove date or Add a date source).
DATE_CODES = frozenset({"unverified_date", "date_outside_now", "undated_source", "invalid_date"})
DATE_NOT_WAIVED = "a date is never waived: remove it or add a date source"
FILE_NOT_WAIVED = "a problem of the whole file is never waived: send it back to the agents"
# C6 Feature set and PRD scope: a key the baseline does not know is fixed, never waived.
UNKNOWN_CODES = frozenset(
    {"unknown_feature", "unknown_requirement", "unknown_goal", "unknown_dependency"}
)
UNKNOWN_NOT_WAIVED = "This cannot be waived; leave it out or send it back"
# C8 Priority order snapshot: every problem is fixed by C9 moves or Request changes.
ORDER_NOT_WAIVED = "a priority order problem is never waived: send it back to the agents"


# A waiver names a problem by its code (every problem of the code on the item) or, for a C6
# or C8 problem, by its own ref: the code, REF_MARK and a short hash of what it is about.
REF_MARK = "~"


def problem_ref(p: dict[str, Any]) -> str:
    """One stored problem's own name among its feature's: two problems of the same code
    (a missing field on two requirements) are waived each on its own."""
    about = "\n".join(str(p.get(k) or "") for k in ("code", "feature", "requirement", "message"))
    return f"{p.get('code')}{REF_MARK}{hashlib.sha1(about.encode()).hexdigest()[:8]}"


def answer_code(answer: str) -> str:
    """The code a waiver's answer names (a ref's code)."""
    return answer.split(REF_MARK, 1)[0]


def names(answers: Iterable[str], code: str, ref: str | None) -> bool:
    """A reason is named by its code (all of the code) or by its own ref."""
    return any(a == code or (ref is not None and a == ref) for a in answers)


class Action(Protocol):
    item_key: str
    kind: str
    state: str
    answers: Any


@dataclass(frozen=True)
class Source:
    """Where a kind's blocking reasons are read (the checkpoint's stored check): its
    reasons (``{item, item_title, code, severity, label}``) and its file-level problems;
    ``not_waivable`` None when no reason of the kind is waived. ``refusal`` is the 422 a
    waiver of a reason that may not be waived gets."""

    read: Callable[[Checkpoint], tuple[list[dict[str, Any]], int]]
    not_waivable: frozenset[str] | None
    refusal: str
    # A kind whose reasons the staged actions themselves close (F4's Engineering check: a
    # staged verdict closes no_verdict): read with them instead of ``read``.
    live: Callable[[Checkpoint, list[Any]], tuple[list[dict[str, Any]], int]] | None = None


def _roadmap_items(cp: Checkpoint) -> tuple[list[dict[str, Any]], int]:
    check = (cp.payload or {}).get("items_check")
    if not isinstance(check, dict):
        return [], 0
    return list(check.get("reasons") or []), int(check.get("file_problems") or 0)


# A token a C6 message may name a feature by: a key-shaped word or a row the agents left
# unkeyed ("#2"), after "requirement", "requirement key" or "goal" when it names one of those.
# Only a feature's, requirement's or goal's key and such a row are rewritten; any other word
# stays. A key's letters are spelt out (ASCII and the Latin letters), never \w, so the web's
# mock (web/lib/api/mock/runs.ts gateLabel) splits a message the same way.
_LETTERS = "A-Za-z0-9_\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f"
_TOKEN = re.compile(
    rf"(?<![{_LETTERS}-])(?:(?P<kind>requirement key|requirement|goal) )?"
    rf"(?<![{_LETTERS}-])(?P<token>#\d+|[{_LETTERS}][{_LETTERS}.]*(?:-[{_LETTERS}.]+)*)"
    rf"(?![{_LETTERS}-])"
)
# The one place a message names a feature that is not in the set (unknown_dependency).
_DEPENDS = re.compile(r"\bdepends on (\S+?)(?=,|\s|$)")
# A key that is itself a code ("G-B", "R12"), shown beside its name.
_CODE = re.compile(r"[A-Z][A-Z0-9]*(?:[-.][A-Z0-9]+)+[a-j]?|[A-Z]{1,4}\d+")


def _titled(
    message: str | None,
    titles: dict[str, str],
    keys: Iterable[str] = (),
    requirements: dict[str, str] | None = None,
    goals: dict[str, str] | None = None,
) -> str | None:
    """A C6 problem's message as people read it: each feature's key as its title (a key
    with none in words), as the review screen words it, and a "#n" row as its number; a
    requirement (quoted) and a goal by its name, with its key beside it when that is a code.
    ``keys``: the feature keys the check names beside the titled ones; ``requirements`` and
    ``goals``: the names of the requirements and goals the check names, by key."""
    if not message:
        return message
    features = set(titles) | set(keys) | set(_DEPENDS.findall(message))
    names = {"requirement": requirements or {}, "goal": goals or {}}

    def word(m: re.Match[str]) -> str:
        kind, token = m["kind"], m["token"]
        lead = f"{kind} " if kind else ""
        if token.startswith("#"):
            return lead + token[1:]
        own = names["goal" if kind == "goal" else "requirement"] if kind else {}
        if token in own:
            name = wording.named(
                own[token] or _words(token), token if _CODE.fullmatch(token) else None
            )
            return lead + (wording.quoted(name, name) if kind != "goal" else name)
        if token in features and (token[0].islower() or token[0].isdigit()):
            return lead + (titles.get(token) or _words(token))
        return m.group(0)

    text = _TOKEN.sub(word, message)
    return text[:1].upper() + text[1:]


def _words(key: str) -> str:
    """A key in words ("address-sharing" is "Address sharing"), as the web's keyWords."""
    words = re.sub(r"[-_]+", " ", key).strip()
    return words[:1].upper() + words[1:]


def _problems(check: Any, file_codes: Iterable[str] = ()) -> tuple[list[dict[str, Any]], int]:
    """A C6 or C8 stored check's problems as reasons: a problem of a feature is that
    feature's; one of no feature (or of the file itself) is file-level."""
    if not isinstance(check, dict):
        return [], 0
    reasons: list[dict[str, Any]] = []
    file_problems = 0
    titles = check.get("titles") or {}
    # Every feature of the file has a title or a problem of its own (a missing title is one).
    keys = {p["feature"] for p in check.get("problems") or [] if p.get("feature")}
    for p in check.get("problems") or []:
        blocking = p.get("blocking", True)
        if not p.get("feature") or p.get("code") in file_codes:
            file_problems += 1 if blocking else 0
            continue
        reasons.append(
            {
                "item": p["feature"],
                "item_title": titles.get(p["feature"]),
                "code": p.get("code"),
                "ref": problem_ref(p),
                "severity": BLOCKING if blocking else "advisory",
                "label": _titled(
                    p.get("message"),
                    titles,
                    keys,
                    check.get("requirement_names"),
                    check.get("goal_names"),
                ),
            }
        )
    return reasons, file_problems


def _feature_set(cp: Checkpoint) -> tuple[list[dict[str, Any]], int]:
    return _problems((cp.payload or {}).get("feature_set_check"), FILE_PROBLEMS)


def _priority_order(cp: Checkpoint) -> tuple[list[dict[str, Any]], int]:
    return _problems((cp.payload or {}).get("priority_check"))


def _eng_review(cp: Checkpoint) -> tuple[list[dict[str, Any]], int]:
    return eng_check.reasons(cp, [])


def _eng_dates(cp: Checkpoint) -> tuple[list[dict[str, Any]], int]:
    return eng_dates.reasons(cp, [])


def _live(cp: Checkpoint) -> tuple[list[dict[str, Any]], int]:
    """A kind whose reasons are read live, not stored (:data:`LIVE_KINDS`)."""
    return [], 0


# B2 Baseline review from this run: the goals a run proposed are its blocking reasons, read
# as of now (oracle.baseline.from_run.gate_reasons: a goal confirmed anywhere clears its
# reason), so every reader passes them as ``reasons``.
LIVE_KINDS = frozenset({"baseline_confirm"})
GOAL_NOT_WAIVED = "only an undecided goal from this run is waived (Leave proposed)"

# The spec owning each checkpoint kind registers its blocking reasons here.
BLOCKING_SOURCES: dict[str, Source] = {
    "baseline_confirm": Source(_live, frozenset(), GOAL_NOT_WAIVED),
    "roadmap_items": Source(_roadmap_items, DATE_CODES, DATE_NOT_WAIVED),
    # C6 (as last re-checked at approval, oracle.runs.service._recheck_scope).
    "feature_set": Source(_feature_set, UNKNOWN_CODES | set(FILE_PROBLEMS), UNKNOWN_NOT_WAIVED),
    # C8 (checked at segment end: nothing edits the order until pick C9).
    "priority_order": Source(_priority_order, None, ORDER_NOT_WAIVED),
    # F4 Engineering check: a verdict per feature and an answer per blocking question.
    "eng_review": Source(_eng_review, None, eng_check.NOT_WAIVED, live=eng_check.reasons),
    # F4 Engineering dates: each proposed date accepted, changed or marked No date.
    "eng_dates": Source(_eng_dates, None, eng_dates.NOT_WAIVED, live=eng_dates.reasons),
}


# Reasons of the roadmap items review only an owner waives (H4 §5 Waive): a waiver names
# them, never covers them by naming none, and is its own action (the field below), so an
# approver's waiver on the same item neither replaces it nor is replaced by it.
OWNER_WAIVES = frozenset({"stopped_but_planned"})
OWNER_WAIVE_FIELD = "owner"


def waivable(kind: str, code: str) -> bool:
    source = BLOCKING_SOURCES.get(kind)
    code = answer_code(code)
    return (
        source is not None and source.not_waivable is not None and code not in source.not_waivable
    )


def _waives(action: Action, kind: str, reason: dict[str, Any]) -> bool:
    """A staged waiver of the reason's item answers the codes and refs it names (every
    waivable reason of the item when it names none); a non-waivable code is never answered."""
    if action.state != "staged" or action.kind != "waive" or action.item_key != reason["item"]:
        return False
    code = reason["code"]
    return waivable(kind, code) and (
        not action.answers or names(action.answers, code, reason.get("ref"))
    )


def approve_gate(
    cp: Checkpoint,
    reasons: list[dict[str, Any]] | None,
    actions: Iterable[Action],
) -> Gate | None:
    """The gate of ``cp`` given its staged actions; ``reasons`` None reads the stored check.
    None for a kind with no registered blocking reasons (nothing to gate)."""
    source = BLOCKING_SOURCES.get(cp.kind)
    if source is None:
        return None
    staged = [a for a in actions if a.state == "staged"]
    stored, file_problems = source.live(cp, staged) if source.live else source.read(cp)
    left = [
        GateLeft(
            item=r["item"],
            item_title=r.get("item_title"),
            code=r["code"],
            ref=r.get("ref") or r["code"],
            label=r.get("label") or r["code"],
            waivable=waivable(cp.kind, r["code"]),
            question_id=r.get("question_id"),
        )
        for r in (stored if reasons is None else reasons)
        if r.get("severity") == BLOCKING and not any(_waives(a, cp.kind, r) for a in staged)
    ]
    return Gate(
        open=not left and not file_problems,
        blocking_open=len(left),
        file_problems=file_problems,
        left=left,
    )


def left_count(gate: Gate) -> int:
    return gate.blocking_open + gate.file_problems


def message(gate: Gate) -> str:
    n = left_count(gate)
    return (
        f"{n} blocking problem{'' if n == 1 else 's'} left: fix or waive them, or send back to "
        "the agents"
    )
