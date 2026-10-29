"""prd-timeline review: the milestone part's words read from a real PRD, not only the mock's:
each feature's kind and "what it does", each milestone's open decisions and risks (the
PRD's tables, or the ``prd_plan`` job's answer), each slice's flow (its feature's drawn
flow) and each goal's measured value with on track / behind (the goal's own metric).
Invented PRD, goals and features.

Test cards (protects / fails_when / no_claim):

- test_tables_give_kind_what_decisions_and_risks: protects=a features table's "Kind" and
  "What it does" columns, an open questions table with a milestone column and a risks
  table with a milestone column become the slices' kind and what and the milestones'
  decisions and risks; fails_when=any of them reads empty ("Other work", "No open
  decisions", "No risks written yet" on a PRD that states them); no_claim=the web.
- test_job_answer_gives_kind_what_decisions_and_risks: protects=the prd_plan job's answer
  keeps kind, what, decisions and risks through clean(); fails_when=clean() drops them;
  no_claim=the live model.
- test_prompt_asks_for_the_part: protects=the prd_plan prompt (a new version) asks for kind,
  what, decisions and risks; fails_when=the prompt never asks so the job never answers them;
  no_claim=the model's answer.
- test_plan_reads_flows_and_measured_goals: protects=the plan endpoint gives a slice its
  feature's flow steps (the roadmap item's drawn flow) and a goal named like a goal Oracle
  measures its current value with its unit and on track / behind against the target of the
  milestone running today, else the next; fails_when=every slice says "No flow yet" or
  every goal "Not counted yet"; no_claim=how a flow is drawn.
"""

from datetime import date

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.jobs import prompting
from oracle.roadmap.models import RoadmapItem
from oracle.simple import plan
from oracle.simple.models import SimpleVisual, SimpleVisualVersion
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_plan_api import (
    FIXTURE,
    clock,  # noqa: F401 - the autouse clock
    seed,
    url,
)

PRD = """# Team space

| Milestone | Name | Start | End | Engineer-weeks |
|---|---|---|---|---|
| M1 | Prove it | 2 Nov 2026 | 27 Nov 2026 | 8 |
| M2 | Scale volume | 30 Nov 2026 | 25 Dec 2026 | 8 |

## Features

| Feature | Name | Kind | What it does | Milestone | Effort | Goals |
|---|---|---|---|---|---|---|
| F-01 | Setup checklist | New for people | Ticks off setup steps | M1 | 3 | Activation |
| F-02 | Faster import | Behind the scenes | Imports big files fast | M2 | 2 | Growth |

## Open questions

| Question | Title | Milestone |
|---|---|---|
| Q7 | Legal input on the sample data | M1 |
| Q9 | Which plans get bulk import | M2 |

## Risks

| Milestone | Risk |
|---|---|
| M1 | Pilot teams may be too busy to try it |
| M2 | Big files may time out |
"""


def test_tables_give_kind_what_decisions_and_risks():
    view = plan.compute(plan.parse(PRD, date(2026, 10, 28)))
    s = {x.code: x for x in view.slices}
    assert (s["F-01"].kind, s["F-01"].what) == (
        "New for people",
        "Ticks off setup steps",
    )
    assert s["F-02"].kind == "Behind the scenes"
    m1, m2 = view.milestones
    assert [(d.code, d.title) for d in m1.decisions] == [("Q7", "Legal input on the sample data")]
    assert [(d.code, d.title) for d in m2.decisions] == [("Q9", "Which plans get bulk import")]
    assert [r.title for r in m1.risks] == ["Pilot teams may be too busy to try it"]
    assert [r.title for r in m2.risks] == ["Big files may time out"]


def test_job_answer_gives_kind_what_decisions_and_risks():
    answer = {
        "milestones": [
            {"code": "M1", "name": "Prove it", "start": "2026-11-02", "end": "2026-11-27",
             "decisions": [{"code": "Q7", "title": "Legal input"}, {"title": "no code"}],
             "risks": ["Pilot teams may be busy", ""]},
        ],
        "features": [
            {"code": "F-01", "name": "Setup checklist", "milestones": ["M1"], "effort": [3],
             "goals": ["Activation"], "kind": "New for people",
             "what": "Shows each setup step"},
        ],
    }  # fmt: skip
    view = plan.compute(plan.clean(answer))
    (m1,) = view.milestones
    assert [(d.code, d.title) for d in m1.decisions] == [("Q7", "Legal input")]
    assert [r.title for r in m1.risks] == ["Pilot teams may be busy"]
    (s,) = view.slices
    assert (s.kind, s.what) == ("New for people", "Shows each setup step")


def test_prompt_asks_for_the_part():
    name, text = prompting.current("prd_plan")
    assert name != "prd_plan.v1"
    for word in (
        '"kind"',
        '"what"',
        '"decisions"',
        '"risks"',
        '"why"',
        '"recommendation"',
        '"what_we_do"',
        '"summary"',
    ):
        assert word in text


async def test_plan_reads_flows_and_measured_goals(client):
    ctx = await make_ctx()
    ids = await seed(ctx, FIXTURE, items=("f-01", "f-03"))
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.scalar(select(RoadmapItem).where(RoadmapItem.item_key == "f-01"))
        v = SimpleVisual(subject_kind="feature", subject_id=item.id, document_id=ids["prd"],
                         brief="Setup checklist")  # fmt: skip
        s.add(v)
        await s.flush()
        s.add(SimpleVisualVersion(visual_id=v.id, number=1, title="Setup", flow_svg="<svg/>",
                                  steps=[{"id": "a", "label": "Open setup"},
                                         {"id": "b", "label": "Tick a step"}]))  # fmt: skip
        for key, title, attrs in (
            ("growth", "Growth", {"current": 30, "unit": "weekly active teams",
                                  "comparison": "at_least"}),
            ("activation", "Activation", {"current": 31, "unit": "%",
                                          "comparison": "at_least"}),
        ):  # fmt: skip
            s.add(Entity(type="goal", key=key, title=title, status="confirmed", origin="user",
                         attrs=attrs))  # fmt: skip
        await s.commit()
    body = (await client.get(url("guided-setup"), headers=ctx.as_("viewer"))).json()
    sl = {x["code"]: x for x in body["slices"]}
    assert sl["F-01"]["flow_steps"] == ["Open setup", "Tick a step"]
    assert sl["F-02"]["flow_steps"] == []
    goals = {g["name"]: g for g in body["goals"]}
    # Today (28 Oct) M1 is next: Growth's M1 target is 20, Activation's 40%.
    assert (goals["Growth"]["measured"], goals["Growth"]["on_track"]) == (
        "30 weekly active teams",
        True,
    )
    assert (goals["Activation"]["measured"], goals["Activation"]["on_track"]) == ("31%", False)
