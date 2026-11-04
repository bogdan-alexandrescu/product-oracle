"""Bring a date in (Simple, FD1 a / FD2 a / FD3 a): Oracle's ranked changes for a milestone
that misses its target, the live date of a picked set and the re-plan they draft.

Pure functions, no database and no model call: the dates come from the same capacity queue
the roadmap's engineering dates use (sizes in person-weeks, the team's engineers at their
focus, milestone order, calendar-only waits), so a tick is answered at once and the same
picks always give the same date.

Each change is one lever on one item: ``move`` (after the date, to the next milestone),
``next_prd`` (out of this PRD), ``slice`` (ship only the slice the milestone needs),
``ungate`` (still built, the milestone no longer waits for it), ``split`` (a first slice in
the milestone, the rest after it), ``overlap`` (the milestone's work starts during the wait
before it) and ``capacity`` (raise the team's focus time). Guardrail and safety items (the
PRD's must-keep rules) are never offered; a must-include item is listed but cannot be picked.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, replace
from typing import Literal

Lever = Literal["move", "next_prd", "slice", "ungate", "split", "overlap", "capacity"]
CostKind = Literal["none", "risk", "gate", "goal", "must"]

# Least harm first: a tie on days saved ranks the gentler change higher.
HARM: dict[str, int] = {"none": 0, "risk": 1, "gate": 2, "goal": 3, "must": 9}
LEVER_COST: dict[str, CostKind] = {
    "move": "goal",
    "next_prd": "none",
    "slice": "none",
    "ungate": "gate",
    "split": "none",
    "overlap": "risk",
    "capacity": "risk",
}
LEVER_TITLE: dict[str, str] = {
    "move": "Move after the date",
    "next_prd": "Move to the next PRD",
    "slice": "Ship only the slice the milestone needs",
    "ungate": "Take off the gate, keep on the roadmap",
    "split": "Split so a first slice lands early",
    "overlap": "Overlap a calendar-only wait",
    "capacity": "Raise focus time",
}


@dataclass(frozen=True)
class Item:
    id: str
    title: str
    pw: float
    milestone: str
    gate: bool = True
    # The PRD's must-keep rule that locks it ("Guardrail: ..."); None: Oracle may change it.
    guard: str | None = None
    must: bool = False
    owner: str | None = None
    # The lever the PRD allows for it (move when none is named).
    lever: Lever | None = None
    # slice: the milestone's slice; split: the first slice (the rest goes after).
    slice_pw: float | None = None
    cost: str | None = None


@dataclass(frozen=True)
class Milestone:
    code: str
    name: str
    # A calendar-only wait before this milestone's work starts (a hold after the one before).
    wait_days: int = 0
    wait_name: str | None = None
    wait_cost: str | None = None


@dataclass(frozen=True)
class Plan:
    start: dt.date
    engineers: int
    focus: float
    milestones: tuple[Milestone, ...]
    items: tuple[Item, ...]
    # The milestone asked about and its target.
    milestone: str
    target: dt.date
    # The focus the team can raise to (the capacity lever), None when it cannot.
    focus_raise: float | None = None
    focus_cost: str | None = None


@dataclass(frozen=True)
class Change:
    id: str
    lever: Lever
    item: str
    title: str
    days: int
    pw_saved: float
    cost_kind: CostKind
    cost: str
    pickable: bool
    moves: tuple[tuple[str, dt.date | None, dt.date | None], ...]


@dataclass(frozen=True)
class Schedule:
    milestones: dict[str, dt.date]
    items: dict[str, dt.date]


def _days(pw: float, capacity: float) -> int:
    return round(pw / capacity * 7)


def schedule(plan: Plan) -> Schedule:
    """The capacity queue: milestone order, each milestone's gated items before the ones it
    no longer waits for; a milestone lands when its last gated item ends; a wait before a
    milestone holds every later start."""
    capacity = plan.engineers * plan.focus
    load = 0.0
    held = 0
    ms: dict[str, dt.date] = {}
    ends: dict[str, dt.date] = {}
    last = plan.start
    for m in plan.milestones:
        held += m.wait_days
        mine = [i for i in plan.items if i.milestone == m.code]
        for it in [i for i in mine if i.gate] + [i for i in mine if not i.gate]:
            load += it.pw
            ends[it.id] = plan.start + dt.timedelta(days=_days(load, capacity) + held)
            if it.gate:
                last = ends[it.id]
        ms[m.code] = last if any(i.gate for i in mine) else max(ms.values(), default=plan.start)
    return Schedule(ms, ends)


def _next_code(plan: Plan, code: str) -> str | None:
    codes = [m.code for m in plan.milestones]
    i = codes.index(code)
    return codes[i + 1] if i + 1 < len(codes) else None


def apply(plan: Plan, change_ids: list[str] | tuple[str, ...]) -> Plan:
    """The plan with the picked changes in it (unknown, locked or must-include ids are
    ignored, so a stale pick never cuts what Oracle will not)."""
    offered = {c.id: c for c in _levers(plan)}
    items = list(plan.items)
    milestones = list(plan.milestones)
    focus = plan.focus
    for cid in change_ids:
        c = offered.get(cid)
        if c is None or not c.pickable:
            continue
        if c.lever == "capacity":
            focus = plan.focus_raise or focus
            continue
        if c.lever == "overlap":
            code = cid.removeprefix("wait:")
            milestones = [replace(m, wait_days=0) if m.code == code else m for m in milestones]
            continue
        idx = next(i for i, it in enumerate(items) if it.id == cid)
        it = items[idx]
        after = _next_code(plan, it.milestone)
        if c.lever == "next_prd":
            items.pop(idx)
        elif c.lever == "move":
            items.pop(idx)
            items.append(replace(it, milestone=after or it.milestone, gate=after is not None))
        elif c.lever == "ungate":
            items[idx] = replace(it, gate=False)
        elif c.lever == "slice":
            items[idx] = replace(it, pw=it.slice_pw or it.pw)
        elif c.lever == "split":
            first = it.slice_pw or it.pw
            items[idx] = replace(it, pw=first)
            if after and it.pw > first:
                items.append(replace(it, id=f"{it.id}:2", pw=it.pw - first, milestone=after))
    return replace(plan, items=tuple(items), milestones=tuple(milestones), focus=focus)


def _levers(plan: Plan) -> list[Change]:
    """Every change Oracle may offer, unranked and unmeasured (days filled by ``answer``)."""
    out: list[Change] = []
    asked = plan.milestone
    codes = [m.code for m in plan.milestones]
    for it in plan.items:
        if it.milestone != asked or not it.gate or it.guard:
            continue
        lever: Lever = it.lever or "move"
        kind: CostKind = "must" if it.must else LEVER_COST[lever]
        cost = it.cost or ""
        out.append(
            Change(it.id, lever, it.title, LEVER_TITLE[lever], 0, 0, kind, cost, not it.must, ())
        )
    # A wait before the asked milestone (or one before it) can overlap.
    for m in plan.milestones[: codes.index(asked) + 1]:
        if m.wait_days > 0:
            out.append(
                Change(
                    f"wait:{m.code}",
                    "overlap",
                    m.wait_name or f"{m.code} {m.wait_days}-day wait",
                    LEVER_TITLE["overlap"],
                    0,
                    0,
                    "risk",
                    m.wait_cost or "",
                    True,
                    (),
                )
            )
    if plan.focus_raise and plan.focus_raise > plan.focus:
        out.append(
            Change(
                "focus",
                "capacity",
                f"Team focus {round(plan.focus * 100)}% to {round(plan.focus_raise * 100)}%",
                LEVER_TITLE["capacity"],
                0,
                0,
                "risk",
                plan.focus_cost or "",
                True,
                (),
            )
        )
    return out


def _pw_saved(plan: Plan, after: Plan) -> float:
    def gated(p: Plan) -> float:
        return sum(i.pw for i in p.items if i.milestone == plan.milestone and i.gate)

    return round(gated(plan) - gated(after), 1)


def date_of(plan: Plan, picks: list[str] | tuple[str, ...] = ()) -> dt.date:
    return schedule(apply(plan, picks)).milestones[plan.milestone]


@dataclass(frozen=True)
class Answer:
    today: dt.date
    target: dt.date
    changes: tuple[Change, ...]
    pick: tuple[str, ...]
    pick_date: dt.date
    best_date: dt.date
    reachable: bool
    locked: tuple[tuple[Item, bool], ...]


def answer(plan: Plan) -> Answer:
    """Oracle's answer: each change measured alone against today's plan, ranked strictly by
    days saved for the least harm (a must-include item too, by its days, never pickable),
    Oracle's pick ticked, the best reachable date and the locked items with whether cutting
    one would have reached the target."""
    base = schedule(plan)
    today = base.milestones[plan.milestone]
    measured: list[Change] = []
    for c in _levers(plan):
        if c.pickable:
            after_plan = apply(plan, [c.id])
        else:
            # A must-include item: what moving it would save, shown, never applied.
            after_plan = replace(
                plan,
                items=tuple(
                    replace(i, milestone=_next_code(plan, i.milestone) or i.milestone)
                    if i.id == c.id
                    else i
                    for i in plan.items
                ),
            )
        after = schedule(after_plan)
        moves = tuple(
            (m.name, base.milestones[m.code], after.milestones[m.code])
            for m in plan.milestones
            if base.milestones[m.code] != after.milestones[m.code]
        )
        days = (today - after.milestones[plan.milestone]).days
        measured.append(replace(c, days=days, pw_saved=_pw_saved(plan, after_plan), moves=moves))
    ranked = sorted(measured, key=lambda c: (-c.days, HARM[c.cost_kind], c.item))
    pickable = [c.id for c in ranked if c.pickable and c.days > 0]
    best = date_of(plan, pickable)
    reachable = best <= plan.target
    pick: list[str] = []
    if reachable:
        # Down the ranked list until the date reaches the target, then drop any pick the
        # target does not need, the most harmful first.
        for cid in pickable:
            if date_of(plan, pick) <= plan.target:
                break
            pick.append(cid)
        by_harm = sorted(pick, key=lambda i: -HARM[next(c for c in ranked if c.id == i).cost_kind])
        for cid in by_harm:
            rest = [p for p in pick if p != cid]
            if date_of(plan, rest) <= plan.target:
                pick = rest
    else:
        pick = pickable
    locked = []
    for it in plan.items:
        if it.guard and it.milestone == plan.milestone:
            without = replace(
                apply(plan, pickable),
                items=tuple(i for i in apply(plan, pickable).items if i.id != it.id),
            )
            locked.append((it, schedule(without).milestones[plan.milestone] <= plan.target))
    return Answer(
        today,
        plan.target,
        tuple(ranked),
        tuple(pick),
        date_of(plan, pick),
        best,
        reachable,
        tuple(locked),
    )


@dataclass(frozen=True)
class Draft:
    prd: tuple[tuple[str, str], ...]
    dates: tuple[tuple[str, dt.date | None, dt.date | None], ...]
    new_target: dt.date | None
    needs_estimate: tuple[Item, ...]
    plan: Plan


def draft(plan: Plan, picks: list[str] | tuple[str, ...]) -> Draft:
    """The re-plan the picks write: what changes in the PRD, every date that moves (the
    target too when no set reaches it) and the items whose scope changed (sliced or split),
    which need a new estimate from their owners."""
    offered = {c.id: c for c in _levers(plan) if c.pickable}
    picked = [offered[p] for p in picks if p in offered]
    new = apply(plan, [c.id for c in picked])
    before, after = schedule(plan), schedule(new)
    words = {
        "move": "Moved to the next milestone",
        "next_prd": "Moved to the next PRD",
        "slice": "First slice only in this milestone",
        "ungate": "No longer holds the milestone; still built",
        "split": "First slice in this milestone; the rest after it",
        "overlap": "Work starts during the wait",
        "capacity": "Focus time raised",
    }
    prd = tuple((c.item, words[c.lever]) for c in picked)
    dates: list[tuple[str, dt.date | None, dt.date | None]] = []
    new_date = after.milestones[plan.milestone]
    new_target = new_date if new_date > plan.target else None
    if new_target:
        dates.append(("Target", plan.target, new_target))
    for m in plan.milestones:
        if before.milestones[m.code] != after.milestones[m.code]:
            dates.append((m.name, before.milestones[m.code], after.milestones[m.code]))
    titles = {i.id: i.title for i in plan.items}
    for iid, end in before.items.items():
        moved_to = after.items.get(iid)
        if moved_to != end:
            dates.append((titles[iid], end, moved_to))
    resized = {c.id for c in picked if c.lever in ("slice", "split")}
    needs = tuple(i for i in plan.items if i.id in resized)
    return Draft(prd, tuple(dates), new_target, needs, new)
