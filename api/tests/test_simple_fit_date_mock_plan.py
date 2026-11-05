"""Bring a date in: the web mock's plan (web/lib/api/mock/fit-date-plan.json) through the real
engine (oracle.simple.fit_date), at each goal target the fixture pins. The mock runs the same
capacity queue on the same plan, and the web's smaller-goal spec reads the same pinned numbers,
so the mock's days, ranking, pick and dates are the API's.

Test cards (protects / fails_when / no_claim):

- test_mock_plan_matches_the_engine (fit-date follow-ups, round 2): protects=the numbers the
  mock and its Playwright spec are held to are the engine's on the mock's plan, the goal's own
  work shrunk as build_plan shrinks it (a tenth at least, rounded to a tenth of a week; a
  slice half its whole weeks, never more than the item); fails_when=the pinned days, person-
  weeks, ranking, pick or dates drift from fit_date.answer (a hand-set "5 days sooner" for a
  slice that saves 4 person-weeks); no_claim=the wording of costs (invented fixture text).
"""

import datetime as dt
import json
import math
from pathlib import Path

import pytest

from oracle.simple import fit_date as fd
from oracle.simple.fit_date_router import FitBaselineGoalOut, _scale

FIXTURE = Path(__file__).resolve().parents[2] / "web/lib/api/mock/fit-date-plan.json"


def _plan(raw: dict, goal_target: float, hard: bool = False) -> fd.Plan:
    g = raw["goal"]
    scale = _scale(
        FitBaselineGoalOut(
            id="00000000-0000-0000-0000-000000000001", title="Goal", target=goal_target,
            comparison="at_least", start=g["start"], plan_target=g["plan_target"],
        )
    )  # fmt: skip
    items = []
    for i in raw["items"]:
        pw = i["pw"]
        if scale < 1 and i.get("own"):
            # As build_plan: a share of its size, a tenth at least, to a tenth of a week.
            pw = max(round(pw * scale, 1), round(pw * 0.1, 1), min(pw, 0.1))
        lever = i.get("lever")
        items.append(
            fd.Item(
                id=i["id"], title=i["title"], pw=pw, milestone=i["milestone"],
                guard=i.get("guard"), must=bool(i.get("must")), owner=i.get("owner"),
                lever=lever, cost=i.get("cost"),
                slice_pw=min(math.ceil(pw) / 2, pw) if lever in ("slice", "split") else None,
            )
        )  # fmt: skip
    milestones = tuple(
        fd.Milestone(m["code"], m["name"], m.get("wait_days", 0), m.get("wait_name"),
                     m.get("wait_cost"))
        for m in raw["milestones"]
    )  # fmt: skip
    return fd.Plan(
        dt.date.fromisoformat(raw["start"]), raw["engineers"], raw["focus"], milestones,
        tuple(items), raw["milestone"],
        dt.date.fromisoformat(raw["hard_target" if hard else "target"]),
        raw["focus_raise"], raw["focus_cost"],
    )  # fmt: skip


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
    "fit-date-hard@30",
    "fit-date-hard@25",
    "fit-date-hard@21",
]


@pytest.mark.parametrize("case", CASES)
def test_mock_plan_matches_the_engine(case):
    raw = json.loads(FIXTURE.read_text())
    scenario, target = case.split("@")
    got = _measured(_plan(raw, float(target), hard=scenario == "fit-date-hard"))
    assert raw["expect"].get(case) == got, json.dumps(got)
