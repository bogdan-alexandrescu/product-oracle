"""fidelity prd (the owner's picks D "Timeline first" and B "Goal lanes", 2026-10-28): the
words the PRD page's mock-up frames show, read from the PRD: each milestone's "Why now",
each decision's recommendation and due day (the decision row on the timeline), each risk's
code, how likely, its impact and "What we do", and the PRD's summary lines above the
timeline. Invented PRD; the company's clock is Wed Oct 28, 2026.

Test cards (protects / fails_when / no_claim):

- test_tables_give_why_decisions_risks_and_summary: protects=a milestones table's "Why now"
  column, an open questions table's Recommendation and Due columns, a risks table's Code,
  Likelihood, Impact and "What we do" columns and the bullets under a Summary heading reach
  the plan's view; fails_when=any of them reads empty on a PRD that states it, or the
  "What we do" column becomes the risk's words; no_claim=the web.
- test_older_plans_and_job_answers_still_read: protects=a plan stored before risks had
  fields (each risk its words only) and a job answer with either shape still read, the
  words becoming the risk's title; fails_when=an old plan fails to read or loses its
  risks; no_claim=the live model.
- test_plan_takes_the_prds_questions: protects=the plan endpoint gives a milestone's
  decisions the PRD question's recommendation and due day as Oracle reads them, adds an
  open question that blocks the milestone but is not in the plan's table, and drops one
  that is decided; fails_when=the decision row on the timeline has no days, a blocking
  question is missing or a decided one is still listed as needed; no_claim=how a question
  is decided (test_simple_prd_questions).
"""

from datetime import date

from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.simple import plan, questions
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_plan_api import (
    FIXTURE,
    clock,  # noqa: F401 - the autouse clock
    seed,
    url,
)

PRD = """# Team space

## Summary

- **Goal: setup in a day.** This quarter builds what new teams need to start alone.
- **M1** proves setup; **M2** scales invites.

## Milestones

| Milestone | Name | Start | End | Engineer-weeks | Why now |
|---|---|---|---|---|---|
| M1 | Prove it | 2 Nov 2026 | 27 Nov 2026 | 8 | No team sets up without help yet. |
| M2 | Scale volume | 30 Nov 2026 | 25 Dec 2026 | 8 | |

## Open questions

| Question | Title | Milestone | Recommendation | Due |
|---|---|---|---|---|
| Q7 | Legal input on the sample data | M1 | Ask legal in week 1 | 6 Nov 2026 |
| Q9 | Which plans get bulk import | M2 | | |

## Risks

| Code | Risk | Likelihood | Impact | What we do | Milestone |
|---|---|---|---|---|---|
| R-1 | Pilot teams may be too busy to try it | medium | high | Book a setup hour with each | M1 |
| | Big files may time out | | | | M2 |
"""


def test_tables_give_why_decisions_risks_and_summary():
    view = plan.compute(plan.parse(PRD, date(2026, 10, 28)))
    m1, m2 = view.milestones
    assert m1.why == "No team sets up without help yet." and m2.why is None
    (q7,) = m1.decisions
    assert (q7.code, q7.recommendation, q7.due_on) == (
        "Q7",
        "Ask legal in week 1",
        date(2026, 11, 6),
    )
    (q9,) = m2.decisions
    assert (q9.recommendation, q9.due_on) == (None, None)
    (r1,) = m1.risks
    assert (r1.code, r1.title, r1.likelihood, r1.impact, r1.what_we_do) == (
        "R-1",
        "Pilot teams may be too busy to try it",
        "medium",
        "high",
        "Book a setup hour with each",
    )
    (r2,) = m2.risks
    assert (r2.code, r2.title, r2.what_we_do) == (None, "Big files may time out", None)
    assert view.summary == [
        "**Goal: setup in a day.** This quarter builds what new teams need to start alone.",
        "**M1** proves setup; **M2** scales invites.",
    ]


def test_older_plans_and_job_answers_still_read():
    stored = plan.parse(PRD, date(2026, 10, 28))
    stored["milestones"][0]["risks"] = ["Pilot teams may be busy"]
    stored.pop("summary")
    view = plan.compute(stored)
    assert [(r.code, r.title) for r in view.milestones[0].risks] == [
        (None, "Pilot teams may be busy")
    ]
    assert view.summary == []
    answer = {
        "milestones": [
            {"code": "M1", "name": "Prove it", "start": "2026-11-02", "end": "2026-11-27",
             "why": "Nobody sets up alone yet.",
             "decisions": [{"code": "Q7", "title": "Legal input", "recommendation": "Ask legal",
                            "due": "2026-11-06"}],
             "risks": ["Pilot teams may be busy",
                       {"code": "R-2", "title": "Imports time out", "impact": "high",
                        "what_we_do": "Queue big imports"}, {"title": ""}]},
        ],
        "summary": ["**Goal:** setup in a day.", ""],
    }  # fmt: skip
    view = plan.compute(plan.clean(answer))
    (m1,) = view.milestones
    assert m1.why == "Nobody sets up alone yet."
    assert (m1.decisions[0].recommendation, m1.decisions[0].due_on) == (
        "Ask legal",
        date(2026, 11, 6),
    )
    assert [(r.code, r.title, r.impact, r.what_we_do) for r in m1.risks] == [
        (None, "Pilot teams may be busy", None, None),
        ("R-2", "Imports time out", "high", "Queue big imports"),
    ]
    assert view.summary == ["**Goal:** setup in a day."]


QUESTIONS = """

## Open questions

| Code | Question | Recommendation | Alternatives | Blocks | Due | Status |
|---|---|---|---|---|---|---|
| Q1 | Which sample data to ship | Three sample projects | One project | M1 | 6 Nov 2026 | Open |
| Q2 | Who signs off the checklist | The PM | | M1 | | Decided on 27 Oct 2026 by Rae: The PM |
| Q3 | The import row limit | 1,000 rows | 10,000 rows | M2 | | Open |
"""


async def test_plan_takes_the_prds_questions(client):
    ctx = await make_ctx()
    ids = await seed(ctx, FIXTURE + QUESTIONS)
    async with tenant_session(ctx.tenant_id) as s:
        await questions.ensure(s, await s.get(Document, ids["prd"]))
        await s.commit()
        assert len(list(await s.scalars(select(Decision).where(Decision.origin == "prd")))) == 3
    body = (await client.get(url("guided-setup"), headers=ctx.as_("viewer"))).json()
    by = {m["code"]: m for m in body["milestones"]}
    m1 = {d["code"]: d for d in by["M1"]["decisions"]}
    assert set(m1) == {"Q1"}, m1
    assert (m1["Q1"]["title"], m1["Q1"]["recommendation"], m1["Q1"]["due_on"]) == (
        "Which sample data to ship",
        "Three sample projects",
        "2026-11-06",
    )
    (q3,) = by["M2"]["decisions"]
    # Q3 blocks M2, the next milestone after the one running: due when M2 starts.
    assert (q3["code"], q3["recommendation"], q3["due_on"]) == ("Q3", "1,000 rows", "2026-11-30")
    assert by["M3"]["decisions"] == []
