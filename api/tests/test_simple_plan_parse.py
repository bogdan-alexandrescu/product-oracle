"""Simple plan-model: a PRD's plan read from its tables (oracle.simple.plan), no database.

Test cards (protects / fails_when / no_claim):

- test_invented_prd_tables_parse_into_the_plan: protects=the invented PRD's milestones
  table (codes, names, start and end, engineer-weeks, done when), its no-work week, its
  targets table and its features table (milestone, effort, goals, order words) become the
  plan; fails_when=a column, the holiday or a target is dropped; no_claim=PRDs without
  tables (the job's test).
- test_slices_are_placed_inside_their_milestones: protects=one slice per milestone a
  feature spans (F-03a in M1, F-03b in M2), placed by the PRD's order words ("weeks 1-2",
  "then", "last", "first", "in parallel", "weeks 3-4" counted in work weeks past the
  holiday), every slice inside its milestone; estimated only where Oracle placed it (a
  slice the PRD places by its weeks is not, review); the PM-owned item has
  no engineer-weeks; fails_when=a slice leaves its milestone or the order is ignored;
  no_claim=dates the PRD gives a slice itself.
- test_weeks_per_goal_and_span_label: protects=engineer-weeks per goal per milestone count
  each slice once under its feature's first goal, planned vs capacity per milestone, and
  the span's label "2 Nov - 12 Feb"; fails_when=a feature is counted twice or under its
  second goal; no_claim=the web's charts.
- test_undated_milestones_say_so: protects=a milestones table with no dates gives an
  undated plan that says so plainly; fails_when=dates are invented; no_claim=the job.
- test_part_fields_pass_through: protects=prd-timeline's milestone part reads, when the
  plan's data gives them, each slice's kind, "what it does" and flow steps, and each
  milestone's open decisions and risks; a plan without them reads empty; fails_when=one of
  them is dropped on the way to the API; no_claim=how the reader finds them in a PRD.
- test_features_table_with_a_risk_column_stays_features: protects=a features table with a
  "Risk" column (| Feature | Name | Milestone | Effort | Goals | Risk |) is read as features
  (codes, names, milestones), its Risk column no milestone's risk, while a questions table
  (its first column the question) and a risks table still give decisions and risks;
  fails_when=a Risk column makes the features table a risks table (no features, names filed
  as risks); no_claim=a feature's own risk on the page.
"""

from datetime import date
from pathlib import Path

from oracle.simple import plan

FIXTURE = (Path(__file__).parent / "fixtures" / "prd_plan_invented.md").read_text()


def test_invented_prd_tables_parse_into_the_plan():
    data = plan.parse(FIXTURE, date(2026, 10, 28))
    assert data is not None
    ms = data["milestones"]
    assert [(m["code"], m["name"], m["start"], m["end"], m["effort_weeks"]) for m in ms] == [
        ("M1", "Prove it", "2026-11-02", "2026-11-27", 8.0),
        ("M2", "Scale volume", "2026-11-30", "2026-12-25", 8.0),
        ("M3", "Open to all", "2026-12-28", "2027-02-12", 12.0),
    ]
    assert ms[0]["done_when"] == ["Ten teams finish setup", "the checklist is live"]
    assert ms[1]["targets"] == [
        {"goal": "Activation", "target": "55% of new teams finish setup"},
        {"goal": "Growth", "target": "100 weekly active teams"},
    ]
    assert data["holidays"] == [
        {"start": "2026-12-28", "end": "2027-01-01", "label": "year-end break"}
    ]
    assert data["goals"] == ["Activation", "Growth"]
    f = {x["code"]: x for x in data["features"]}
    assert f["F-03"]["milestones"] == ["M1", "M2"] and f["F-03"]["effort"] == [2.0, 3.0]
    assert f["F-03"]["order"] == ["last", "first"]
    assert f["F-01"]["goals"] == ["Activation", "Growth"]
    assert f["F-04"]["pm_owned"] is True and f["F-04"]["effort"] == [None]


def test_slices_are_placed_inside_their_milestones():
    view = plan.compute(plan.parse(FIXTURE, date(2026, 10, 28)))
    s = {x.code: x for x in view.slices}
    assert sorted(s) == ["F-01", "F-02", "F-03a", "F-03b", "F-04", "F-05"]
    got = {k: (v.milestone, v.start_date.isoformat(), v.end_date.isoformat()) for k, v in s.items()}
    assert got == {
        "F-01": ("M1", "2026-11-02", "2026-11-13"),
        "F-02": ("M1", "2026-11-16", "2026-11-27"),
        "F-03a": ("M1", "2026-11-16", "2026-11-27"),
        "F-03b": ("M2", "2026-11-30", "2026-12-18"),
        "F-04": ("M2", "2026-11-30", "2026-12-25"),
        # Weeks 3-4 of M3 count work weeks: the year-end week is not one.
        "F-05": ("M3", "2027-01-18", "2027-01-29"),
    }
    ms = {m.code: m for m in view.milestones}
    for x in view.slices:
        m = ms[x.milestone]
        assert m.start_date <= x.start_date <= x.end_date <= m.end_date
        assert x.feature_code == x.code[:4]
    # review: only Oracle's own placement is estimated; "weeks 1-2" is the PRD's.
    weeks = {k for k, v in s.items() if v.estimated is False}
    assert weeks == {"F-01", "F-05"}
    assert s["F-03a"].name == "Invite teammates, part 1 of 2"
    assert s["F-03b"].effort_weeks == 3.0 and s["F-03b"].goal == "Growth"
    assert s["F-04"].pm_owned is True and s["F-04"].effort_weeks is None
    assert s["F-01"].goal == "Activation"


def test_weeks_per_goal_and_span_label():
    view = plan.compute(plan.parse(FIXTURE, date(2026, 10, 28)))
    weeks = {(w.goal, w.milestone): w.weeks for w in view.goal_weeks}
    assert weeks == {
        ("Activation", "M1"): 5.0,
        ("Growth", "M1"): 2.0,
        ("Growth", "M2"): 3.0,
        ("Growth", "M3"): 4.0,
    }
    planned = {m.code: (m.planned_weeks, m.effort_weeks) for m in view.milestones}
    assert planned == {"M1": (7.0, 8.0), "M2": (3.0, 8.0), "M3": (4.0, 12.0)}
    assert view.milestones[0].feature_codes == ["F-01", "F-02", "F-03"]
    assert view.span is not None and view.span.label == "2 Nov - 12 Feb"
    assert (view.span.start, view.span.end) == (date(2026, 11, 2), date(2027, 2, 12))
    assert view.dated is True and view.message is None
    goals = {g.name: g.targets for g in view.goals}
    assert goals["Growth"][1].milestone == "M2"
    assert goals["Growth"][1].target == "100 weekly active teams"


def test_undated_milestones_say_so():
    text = (
        "## Milestones\n\n| Milestone | Name | Done when |\n|---|---|---|\n"
        "| M1 | Prove it | Ten teams |\n| M2 | Scale volume | 1,000 rows |\n"
    )
    view = plan.compute(plan.parse(text, date(2026, 10, 28)))
    assert [m.code for m in view.milestones] == ["M1", "M2"]
    assert all(m.start_date is None and m.end_date is None for m in view.milestones)
    assert view.dated is False and view.span is None
    assert view.message == "This PRD's milestones have no dates."


def test_part_fields_pass_through():
    data = {
        "milestones": [
            {
                "code": "M1",
                "name": "Prove it",
                "start": "2026-11-02",
                "end": "2026-11-27",
                "decisions": [{"code": "Q7", "title": "Legal input"}],
                "risks": ["Pilot teams may not finish setup"],
            },
            {"code": "M2", "name": "Scale volume", "start": "2026-11-30", "end": "2026-12-25"},
        ],
        "features": [
            {
                "code": "F-01",
                "name": "Setup checklist",
                "milestones": ["M1"],
                "effort": [2],
                "kind": "New for people",
                "what": "Shows each setup step and ticks it off",
                "flow_steps": ["Open setup", "Tick a step"],
            },
            {"code": "F-02", "name": "Bulk import", "milestones": ["M2"], "effort": [2]},
        ],
        "goals": ["Activation"],
    }
    view = plan.compute(data)
    m1, m2 = view.milestones
    assert [(d.code, d.title) for d in m1.decisions] == [("Q7", "Legal input")]
    assert m1.risks == ["Pilot teams may not finish setup"]
    assert m2.decisions == [] and m2.risks == []
    f1, f2 = view.slices
    assert (f1.kind, f1.what, f1.flow_steps) == (
        "New for people",
        "Shows each setup step and ticks it off",
        ["Open setup", "Tick a step"],
    )
    assert (f2.kind, f2.what, f2.flow_steps) == (None, None, [])
    assert all(g.measured is None and g.on_track is None for g in view.goals)


def test_features_table_with_a_risk_column_stays_features():
    text = (
        "| Milestone | Name | Start | End |\n|---|---|---|---|\n"
        "| M1 | Prove it | 2 Nov 2026 | 27 Nov 2026 |\n"
        "| M2 | Scale volume | 30 Nov 2026 | 25 Dec 2026 |\n\n"
        "| Feature | Name | Milestone | Effort | Goals | Risk |\n|---|---|---|---|---|---|\n"
        "| F-01 | Setup checklist | M1 | 3 | Activation | Teams skip setup |\n"
        "| F-02 | Faster import | M2 | 2 | Growth | Big files time out |\n\n"
        "| Question | Title | Milestone |\n|---|---|---|\n"
        "| Q7 | Legal input on the sample data | M1 |\n\n"
        "| Milestone | Risk |\n|---|---|\n| M2 | Pilot teams may be busy |\n"
    )
    data = plan.parse(text, date(2026, 10, 28))
    assert data is not None
    assert [(f["code"], f["name"], f["milestones"]) for f in data["features"]] == [
        ("F-01", "Setup checklist", ["M1"]),
        ("F-02", "Faster import", ["M2"]),
    ]
    m1, m2 = plan.compute(data).milestones
    assert [(d.code, d.title) for d in m1.decisions] == [("Q7", "Legal input on the sample data")]
    assert m1.risks == []
    assert m2.risks == ["Pilot teams may be busy"]
