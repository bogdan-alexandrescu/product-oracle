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

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

from oracle.runs.models import Checkpoint
from oracle.runs.schemas import Gate, GateLeft

BLOCKING = "blocking"
# O4 Roadmap shape: a date shows only on a verified basis, so a date is never waived (its
# fixes are Remove date or Record basis).
DATE_CODES = frozenset({"unverified_date", "date_outside_now", "undated_source", "invalid_date"})
DATE_NOT_WAIVED = "a date is never waived: remove it or record a verified basis"
FILE_NOT_WAIVED = "a problem of the whole file is never waived: send it back to the agents"


class Action(Protocol):
    item_key: str
    kind: str
    state: str
    answers: Any


@dataclass(frozen=True)
class Source:
    """Where a kind's blocking reasons are read (the checkpoint's stored check): its
    reasons (``{item, item_title, code, severity, label}``) and its file-level problems."""

    read: Callable[[Checkpoint], tuple[list[dict[str, Any]], int]]
    not_waivable: frozenset[str]


def _roadmap_items(cp: Checkpoint) -> tuple[list[dict[str, Any]], int]:
    check = (cp.payload or {}).get("items_check")
    if not isinstance(check, dict):
        return [], 0
    return list(check.get("reasons") or []), int(check.get("file_problems") or 0)


# The spec owning each checkpoint kind registers its blocking reasons here.
BLOCKING_SOURCES: dict[str, Source] = {
    "roadmap_items": Source(_roadmap_items, DATE_CODES),
}


def waivable(kind: str, code: str) -> bool:
    source = BLOCKING_SOURCES.get(kind)
    return source is not None and code not in source.not_waivable


def _waives(action: Action, kind: str, reason: dict[str, Any]) -> bool:
    """A staged waiver of the reason's item answers the codes it names (every waivable
    reason of the item when it names none); a non-waivable code is never answered."""
    if action.state != "staged" or action.kind != "waive" or action.item_key != reason["item"]:
        return False
    code = reason["code"]
    return waivable(kind, code) and (not action.answers or code in action.answers)


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
    stored, file_problems = source.read(cp)
    staged = [a for a in actions if a.state == "staged"]
    left = [
        GateLeft(
            item=r["item"],
            item_title=r.get("item_title"),
            code=r["code"],
            label=r.get("label") or r["code"],
            waivable=waivable(cp.kind, r["code"]),
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
