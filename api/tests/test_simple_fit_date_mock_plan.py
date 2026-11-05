"""Bring a date in: the web mock's plan (web/lib/api/mock/fit-date-plan.json) read through the
real router (oracle.simple.fit_date_router.build_plan) and the real engine
(oracle.simple.fit_date), at each goal target the fixture pins. The mock runs the same capacity
queue on the same plan, and the web's smaller-goal spec reads the same pinned numbers, so the
mock's days, ranking, pick and dates are the API's.

Test cards (protects / fails_when / no_claim):

- test_mock_plan_matches_the_engine (fit-date follow-ups, round 2; review follow-up): protects=
  the numbers the mock and its Playwright spec are held to are the API's on the mock's plan: the
  plan is a PRD (team line, must-keep rules) and a plan view built from the fixture and read by
  build_plan, so the goal's own work is shrunk, the levers named, the guard and must flags set
  and the slices sized by build_plan itself (a split, a lever build_plan never names, is sized
  by build_plan's own _slice_pw); fails_when=the pinned days, person-weeks, ranking, pick or
  dates drift from fit_date.answer on build_plan's plan (a hand-set "5 days sooner" for a slice
  that saves 4 person-weeks, or build_plan's shrink or slice sizing changes); no_claim=the
  wording of costs, owners and the wait's name (invented fixture text layered on afterwards).
"""

import dataclasses
import datetime as dt
import json
from pathlib import Path

import pytest

from oracle.simple import fit_date as fd
from oracle.simple import plan
from oracle.simple.fit_date_router import FitBaselineGoalOut, _scale, _slice_pw, build_plan
from oracle.simple.schemas import SimpleMilestoneTarget, SimplePlanMilestone, SimpleSlice

FIXTURE = Path(__file__).resolve().parents[2] / "web/lib/api/mock/fit-date-plan.json"
GOAL = "Replied threads"
OTHER = "Reply time"
# Levers the fixture names that build_plan does not derive from a plan view (a move of an item
# of 4 weeks or more; a split): layered on build_plan's item.
LAYERED = ("move", "split")


def _text(raw: dict, codes: dict[str, str]) -> str:
    """The PRD: its team line and its must-keep rules, as build_plan reads them."""
    rules = []
    for i in raw["items"]:
        if i.get("must"):
            rules.append(f"- {codes[i['id']]} {i['title']}: must-include: {i.get('cost', '')}")
        elif i.get("guard"):
            kind, why = i["guard"].split(": ", 1)
            rules.append(f"- {codes[i['id']]} {i['title']}: {kind.lower()}: {why}")
    team = f"{raw['engineers']} engineers at {round(raw['focus'] * 100)}% focus"
    return "# Larkspur Help Desk\n\nTeam: " + team + "\n\n## Must keep\n\n" + "\n".join(rules)


def _view(raw: dict, codes: dict[str, str], target: dt.date) -> plan.View:
    """The plan view: milestones dated so the M2 hold is the fixture's wait and the asked
    milestone ends on the target; one slice per item, its goal saying whether it is the goal's
    own work (own, must-keep) or another goal's (ungate, split) or PM-owned (next PRD)."""
    start = dt.date.fromisoformat(raw["start"])
    m1_end = start + dt.timedelta(days=18)
    names = {m["code"]: m["name"].removeprefix(f"{m['code']} ") for m in raw["milestones"]}
    wait = next(m.get("wait_days", 0) for m in raw["milestones"] if m["code"] == "M2")
    milestones = [
        SimplePlanMilestone(code="M1", name=names["M1"], start_date=start, end_date=m1_end),
        SimplePlanMilestone(
            code="M2", name=names["M2"], start_date=m1_end + dt.timedelta(days=wait + 3),
            end_date=target,
            targets=[SimpleMilestoneTarget(goal=GOAL, target="40 replied threads")],
        ),
        SimplePlanMilestone(code="M3", name=names["M3"]),
    ]  # fmt: skip
    slices = []
    for i in raw["items"]:
        lever = i.get("lever")
        goal = None if lever == "next_prd" else OTHER if lever in ("ungate", "split") else GOAL
        slices.append(
            SimpleSlice(
                code=i["id"], feature_code=codes[i["id"]], name=i["title"],
                milestone=i["milestone"], milestone_name=names[i["milestone"]],
                effort_weeks=i["pw"], pm_owned=lever == "next_prd",
                goal=goal,
            )
        )  # fmt: skip
    return plan.View(milestones=milestones, slices=slices)


def _plan(raw: dict, goal_target: float, hard: bool = False) -> fd.Plan:
    g = raw["goal"]
    scale = _scale(
        FitBaselineGoalOut(
            id="00000000-0000-0000-0000-000000000001", title=GOAL, target=goal_target,
            comparison="at_least", start=g["start"], plan_target=g["plan_target"],
        )
    )  # fmt: skip
    codes = {i["id"]: f"F-{n:02d}" for n, i in enumerate(raw["items"], 1)}
    target = dt.date.fromisoformat(raw["hard_target" if hard else "target"])
    start = dt.date.fromisoformat(raw["start"])
    p = build_plan(_text(raw, codes), _view(raw, codes, target), raw["milestone"], start, scale)
    assert p is not None
    assert (p.start, p.engineers, p.focus, p.target) == (
        start, raw["engineers"], raw["focus"], target,
    )  # fmt: skip
    assert p.focus_raise == raw["focus_raise"]
    by_id = {i["id"]: i for i in raw["items"]}
    items = []
    for it in p.items:
        i = by_id[it.id]
        assert (it.guard, it.must) == (i.get("guard"), bool(i.get("must"))), it.id
        lever = i.get("lever")
        if lever in LAYERED:
            # build_plan's own size; the split's first slice sized as build_plan sizes one.
            it = dataclasses.replace(
                it, lever=lever, slice_pw=_slice_pw(it.pw) if lever == "split" else None
            )
        elif lever:
            assert it.lever == lever, it.id
        items.append(dataclasses.replace(it, owner=i.get("owner"), cost=i.get("cost")))
    waits = {m["code"]: m for m in raw["milestones"]}
    milestones = []
    for m in p.milestones:
        w = waits[m.code]
        assert (m.name, m.wait_days) == (w["name"], w.get("wait_days", 0)), m.code
        milestones.append(
            dataclasses.replace(m, wait_name=w.get("wait_name"), wait_cost=w.get("wait_cost"))
        )
    return dataclasses.replace(
        p, items=tuple(items), milestones=tuple(milestones), focus_cost=raw["focus_cost"]
    )


def _measured(p: fd.Plan) -> dict:
    a = fd.answer(p)
    return {
        "today": a.today.isoformat(),
        "changes": [[c.id, c.days, c.pw_saved] for c in a.changes],
        "pick": list(a.pick),
        "pick_date": a.pick_date.isoformat(),
        "best_date": a.best_date.isoformat(),
        "reachable": a.reachable,
    }


CASES = [
    "fit-date@40",
    "fit-date@37",
    "fit-date@25",
    "fit-date-hard@40",
    "fit-date-hard@33",
    "fit-date-hard@30",
    "fit-date-hard@27",
    "fit-date-hard@25",
    "fit-date-hard@21",
]


@pytest.mark.parametrize("case", CASES)
def test_mock_plan_matches_the_engine(case):
    raw = json.loads(FIXTURE.read_text())
    scenario, target = case.split("@")
    got = _measured(_plan(raw, float(target), hard=scenario == "fit-date-hard"))
    assert raw["expect"].get(case) == got, json.dumps(got)
