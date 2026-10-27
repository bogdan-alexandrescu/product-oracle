"""Simple S2 (#723): the constraint checker. Pure functions over the items of one read
(oracle.simple.service builds the nodes); every flag has a one-line reason and the
one-click fixes S3 applies.

- ``dependency_order``: a dependency ends on or after the day the item starts (two window
  estimates never conflict); the line names the item and its dependency.
  Fixes: shift_dependents, move_dependency, accept_risk.
- ``blocker_date``: an open blocker of the item is expected after the item starts.
  Fixes: accept_risk.
- ``outside_milestone``: the bar ends after its milestone's date. Fixes: accept_risk.
- ``cut_with_dependents``: the item is cut and items not cut depend on it.
  Fixes: accept_risk.
- ``draft_without_owner``: a draft item (added in Simple) without an owner. No fixes.

A risk accepted on a flag (``roadmap_items.accepted_risks``: ``{"flag", "subject"?, "note"}``,
a missing subject covering every subject of that flag) keeps the flag, amber, with its note.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal

from oracle.simple.dates import Dated

FlagKind = Literal[
    "dependency_order",
    "blocker_date",
    "outside_milestone",
    "cut_with_dependents",
    "draft_without_owner",
]
Fix = Literal["shift_dependents", "move_dependency", "accept_risk"]
FIXES: dict[str, list[str]] = {
    "dependency_order": ["shift_dependents", "move_dependency", "accept_risk"],
    "blocker_date": ["accept_risk"],
    "outside_milestone": ["accept_risk"],
    "cut_with_dependents": ["accept_risk"],
    "draft_without_owner": [],
}
TITLE = 40


@dataclass(frozen=True)
class Blocker:
    id: str
    title: str
    expected: date | None
    open: bool


@dataclass
class Node:
    id: str
    title: str
    start: Dated
    end: Dated
    depends_on: list[str] = field(default_factory=list)
    status: str = "planned"
    draft: bool = False
    owner_id: str | None = None
    blockers: list[Blocker] = field(default_factory=list)
    # (name, date) of the item's milestone, when it has a date.
    milestone: tuple[str, date] | None = None
    accepted_risks: list[dict[str, Any]] = field(default_factory=list)


@dataclass(frozen=True)
class Flag:
    kind: str
    reason: str
    fixes: list[str]
    state: Literal["red", "amber"]
    subject: str | None = None
    risk_note: str | None = None


def _t(title: str) -> str:
    title = " ".join(title.split())
    return title if len(title) <= TITLE else title[: TITLE - 1] + "…"


def _day(d: date, year: bool = False) -> str:
    return f"{d:%b} {d.day}" + (f" {d.year}" if year else "")


def _risk(node: Node, kind: str, subject: str | None) -> dict[str, Any] | None:
    for r in node.accepted_risks or []:
        if not isinstance(r, dict) or r.get("flag") != kind:
            continue
        if r.get("subject") in (None, "") or str(r.get("subject")) == str(subject):
            return r
    return None


def _flag(node: Node, kind: str, reason: str, subject: str | None = None) -> Flag:
    risk = _risk(node, kind, subject)
    return Flag(
        kind=kind,
        reason=reason,
        fixes=list(FIXES[kind]),
        state="amber" if risk is not None else "red",
        subject=subject,
        risk_note=(str(risk.get("note")) if risk.get("note") else None) if risk else None,
    )


def check(nodes: list[Node]) -> dict[str, list[Flag]]:
    """Each node's flags, by node id (every node has an entry)."""
    by_id = {n.id: n for n in nodes}
    dependents: dict[str, list[Node]] = {n.id: [] for n in nodes}
    for n in nodes:
        for dep in n.depends_on:
            if dep in dependents and dep != n.id:
                dependents[dep].append(n)
    out: dict[str, list[Flag]] = {}
    for n in nodes:
        flags: list[Flag] = []
        for dep_id in n.depends_on:
            dep = by_id.get(dep_id)
            if dep is None or dep.id == n.id or dep.status == "cut":
                continue
            if dep.end.estimated and n.start.estimated:
                continue
            if dep.end.date >= n.start.date:
                # Named both ways: a change card lists the dependents' lines under the moved
                # item, so "Starts ..." alone read as the moved item's own start.
                years = n.start.date.year != dep.end.date.year
                reason = (
                    f"'{_t(n.title)}' starts {_day(n.start.date, years)}, but "
                    f"'{_t(dep.title)}', which it depends on, ends {_day(dep.end.date, years)}"
                )
                flags.append(_flag(n, "dependency_order", reason, dep.id))
        for b in n.blockers:
            if b.open and b.expected is not None and b.expected > n.start.date:
                reason = (
                    f"Starts {_day(n.start.date)}, but blocker '{_t(b.title)}' is expected "
                    f"to clear {_day(b.expected)}"
                )
                flags.append(_flag(n, "blocker_date", reason, b.id))
        if n.milestone is not None and n.end.date > n.milestone[1]:
            name, day = n.milestone
            reason = f"Ends {_day(n.end.date)}, after its milestone '{_t(name)}' ({_day(day)})"
            flags.append(_flag(n, "outside_milestone", reason, name))
        if n.status == "cut":
            live = [d for d in dependents[n.id] if d.status != "cut"]
            if live:
                more = f" and {len(live) - 1} other" + ("s" if len(live) > 2 else "")
                reason = f"Cut, but '{_t(live[0].title)}'{more if len(live) > 1 else ''} " + (
                    "depend on it" if len(live) > 1 else "depends on it"
                )
                flags.append(_flag(n, "cut_with_dependents", reason))
        if n.draft and not n.owner_id:
            flags.append(_flag(n, "draft_without_owner", "Draft with no owner to confirm it"))
        out[n.id] = flags
    return out
