"""A run-written PRD's own new features sit in their milestones in its plan (CLD's walk B,
2026-11-01). No database; invented PRD tables.

Test cards (protects / fails_when / no_claim):

- test_features_table_names_a_milestone_once_per_group: protects=a Goal-traced PRD's
  "Features by milestone" table names a milestone only on the first row of its group
  ("[M1 Pilot](#milestone-m1)", then empty cells), as the template says; every row under it
  is a feature of that milestone, a cell naming a milestone by its name ("[Rollout](...)")
  too; fails_when=a feature after the first of its group is dropped, so a milestone reads
  "nothing planned yet" or lists only one feature; no_claim=the job's reading.
- test_job_answer_keeps_the_prds_features: protects=a plan Oracle's job read (a PRD with no
  milestones table) keeps every feature the PRD's features table places in a milestone the
  answer has, even when the answer left it out; fails_when=a new feature is missing from
  its milestone; no_claim=dates.
"""

# ruff: noqa: E501 - the fixture tables keep their long lines
from datetime import date

from oracle.simple import plan

PRD = """\
# Onboarding pace PRD

## Features by milestone {#brief-items}

| Milestone | Feature | Goal | Outcome |
|---|---|---|---|
| [M1 Pilot](#milestone-m1) | [F-01 Pacing plan](#f-01) | Faster onboarding | Every account has a pace |
| | [F-02 Late alerts](#f-02) | Faster onboarding | Managers hear first |
| [Rollout](#milestone-m2) | [F-03 Pace report](#f-03) | Fewer churned accounts | Owners see the pace |
| | [F-04 Pace templates](#f-04) | Fewer churned accounts | A pace in one click |

## Milestones {#milestones}

| Milestone | Name | Start | End |
|---|---|---|---|
| M1 | Pilot | Nov 2, 2026 | Dec 18, 2026 |
| M2 | Rollout | Jan 4, 2027 | Feb 26, 2027 |
"""


def test_features_table_names_a_milestone_once_per_group():
    data = plan.parse(PRD, date(2026, 11, 1))
    assert data is not None
    placed = {f["code"]: f["milestones"] for f in data["features"]}
    assert placed == {"F-01": ["M1"], "F-02": ["M1"], "F-03": ["M2"], "F-04": ["M2"]}
    view = plan.compute(data)
    assert {m.code: m.feature_codes for m in view.milestones} == {
        "M1": ["F-01", "F-02"],
        "M2": ["F-03", "F-04"],
    }


def test_job_answer_keeps_the_prds_features():
    text = PRD.split("## Milestones")[0]
    answer = {
        "milestones": [
            {"code": "M1", "name": "Pilot", "start": "2026-11-02", "end": "2026-12-18"},
            {"code": "M2", "name": "Rollout", "start": "2027-01-04", "end": "2027-02-26"},
        ],
        # The job named only an older feature.
        "features": [{"code": "F-01", "name": "Pacing plan", "milestones": ["M1"]}],
    }
    data = plan.with_prd_features(plan.clean(answer), text)
    assert {f["code"]: f["milestones"] for f in data["features"]} == {
        "F-01": ["M1"], "F-02": ["M1"], "F-03": ["M2"], "F-04": ["M2"],
    }  # fmt: skip
    assert next(f for f in data["features"] if f["code"] == "F-02")["name"] == "Late alerts"


def test_accepted_engineering_dates_date_the_plan():
    data = plan.parse(
        PRD.replace("Dec 18, 2026", "").replace("Jan 4, 2027", "").replace("Feb 26, 2027", ""),
        date(2026, 11, 1),
    )
    assert data is not None and not plan.compute(data).dated
    accepted = [
        plan.Accepted("M1", "F-01", date(2026, 12, 11)),
        # The lead changed M1's other item to a later day: the milestone ends on it.
        plan.Accepted("M1", "F-02", date(2026, 12, 23)),
        # An item that names its milestone by name only, and one by its feature only.
        plan.Accepted("Rollout", None, date(2027, 2, 12)),
        plan.Accepted(None, "F-04", date(2027, 3, 5)),
    ]
    view = plan.compute(plan.with_accepted(data, accepted))
    assert [(m.code, m.start_date, m.end_date) for m in view.milestones] == [
        ("M1", date(2026, 11, 2), date(2026, 12, 23)),
        ("M2", date(2026, 12, 24), date(2027, 3, 5)),
    ]
    assert view.dated
    # With none accepted, the PRD's own (missing) dates stay.
    assert plan.with_accepted(data, []) == data


# The query behind it, against Postgres: the date the lead changed to at a run's Engineering
# dates stop is the one the plan reads, never the proposed one.
from tests.test_eng_dates_stop import (  # noqa: E402
    _act,
    _approve,
    _at_dates,
    derivations_start,  # noqa: F401 - autouse
    owner,  # noqa: F401 - fixture
    runtime,  # noqa: F401 - fixture
)


async def test_accepted_dates_reads_the_leads_changed_day(client, owner, runtime):  # noqa: F811
    import uuid

    from oracle.tenancy import tenant_session

    tenant_id, auth = owner
    run = await _at_dates(client, auth)
    value = {"kind": "commitment", "reference": "ENG-412", "supports_date": "2026-12-04"}
    body = {"item_key": "price-early", "kind": "edit", "field": "estimate", "value": value}
    assert (await _act(client, auth, run, body)).status_code in (200, 201)
    assert (await _approve(client, auth, run)).status_code == 200
    async with tenant_session(tenant_id) as s:
        got = await plan.accepted_dates(s, uuid.UUID(run["document_id"]))
    assert [a.day for a in got] == [date(2026, 12, 4)]
