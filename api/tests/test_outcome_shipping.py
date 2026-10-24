"""H3 Predicted versus actual, shipping and the proposed actual: the ticker notices a
predicted item shipped (tracker records, milestones, a person), sets the due date, and on
it proposes a verdict from the goal's own values; a person confirms it, unless H11
Autonomy lets Oracle record it. Against Postgres with the FakeRuntime.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

from datetime import date, datetime, timedelta

import pytest

from oracle.quality.shipping import verdict
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.day_helpers import company_today
from tests.launch_helpers import ticker_pass, tracker_done
from tests.outcome_helpers import days_ago, goal_history, outcome_world, set_record
from tests.test_roadmap import (  # noqa: F401 - fixtures
    owner,
    runtime,
)

UP = {"direction": "increase", "baseline_value": 38, "predicted_value": 42}
DOWN = {"direction": "decrease", "baseline_value": 12, "predicted_value": 8}

# --------------------------------------------------------------------------- unit


@pytest.mark.parametrize(
    "prediction, actual, want",
    [
        (UP, 42, "held"),
        (UP, 45, "held"),
        ({**UP, "threshold_value": 40}, 41, "partially_held"),
        ({**UP, "threshold_value": 40}, 39, "not_held"),
        # No line: at least half the predicted change (38 -> 42: 40) is partly held.
        (UP, 40, "partially_held"),
        (UP, 39.5, "not_held"),
        (DOWN, 7, "held"),
        ({**DOWN, "threshold_value": 10}, 9, "partially_held"),
        (DOWN, 12, "not_held"),
        (UP, None, "inconclusive"),
        ({**UP, "predicted_value": None}, 41, "inconclusive"),
    ],
)
def test_verdict_rule(prediction, actual, want):
    """protects=the proposed-verdict rule both ways; fails_when=a decrease is read as an
    increase, the half-way rule or the line is off by one side, or a missing value gets
    a verdict; no_claim=where the actual comes from."""
    assert verdict(prediction, actual) == want


# --------------------------------------------------------------------------- integration


async def test_ships_when_every_tracker_record_is_done(client, owner, runtime):  # noqa: F811
    """protects=criterion 4: all matched records done ships the item on the next ticker
    pass, with the tracker signal, the latest observed_at and the due date; fails_when=one
    record in progress still ships it, or the due date ignores the 30 days;
    no_claim=the hourly schedule."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    url = f"/v1/outcomes/{pay['id']}"
    await tracker_done(client, auth, pay["track_id"], "payment-step", "GH-1")
    await tracker_done(client, auth, pay["track_id"], "payment-step", "GH-2", state="in_progress")
    await ticker_pass(tenant_id)
    assert (await client.get(url, headers=auth)).json()["status"] == "predicted"

    await tracker_done(client, auth, pay["track_id"], "payment-step", "GH-2")
    await ticker_pass(tenant_id)
    got = (await client.get(url, headers=auth)).json()
    assert got["status"] == "tracking"
    assert got["ship_signal"]["kind"] == "tracker"
    shipped_at = datetime.fromisoformat(got["shipped_at"])
    by = date.fromisoformat(got["prediction"]["by"])
    want = max(by, shipped_at.date() + timedelta(days=30))
    assert got["assess_due_on"] == want.isoformat()
    assert got["proposed_assessment"] is None


async def test_a_person_marks_it_shipped(client, owner, runtime):  # noqa: F811
    """protects=POST /shipped (manual signal) moves predicted to tracking once; fails_when=
    a second call ships it again or the signal kind is not manual; no_claim=launch signals."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    url = f"/v1/outcomes/{pay['id']}/shipped"
    resp = await client.post(url, json={"note": "Out to everyone"}, headers=auth)
    assert resp.status_code == 200, resp.text
    got = resp.json()
    assert got["status"] == "tracking" and got["ship_signal"]["kind"] == "manual"
    assert got["assess_due_on"]
    assert (await client.post(url, json={}, headers=auth)).status_code == 409


async def test_due_record_gets_a_proposal_a_person_confirms(client, owner, runtime):  # noqa: F811
    """protects=criterion 5: on the due date the goal's history (38% then 41% after by)
    proposes partly held at 41, writes no assessment, shows a counted "Outcome check due"
    row; confirming records it; fails_when=Oracle records the verdict itself at the default
    level, reads the value before by, or the row stays; no_claim=goal measurements."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    url = f"/v1/outcomes/{pay['id']}"
    prediction = {**pay["prediction"], "threshold_value": 40, "by": days_ago(10).isoformat()}
    await set_record(
        tenant_id,
        pay["id"],
        status="tracking",
        prediction=prediction,
        assess_due_on=company_today(),
    )
    await goal_history(tenant_id, ("38%", days_ago(20)), ("41%", days_ago(5)))
    await ticker_pass(tenant_id)
    got = (await client.get(url, headers=auth)).json()
    proposal = got["proposed_assessment"]
    assert proposal["verdict"] == "partially_held"
    assert proposal["actual_value"] == 41
    assert proposal["source"] == "goal_history"
    assert got["assessments"] == [] and got["status"] == "tracking"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    rows = [r for r in inbox["outcomes"] if r["reason"] == "check_due"]
    assert len(rows) == 1 and rows[0]["counts"] is True
    assert rows[0]["title"] == "Outcome check due · Payment step · predicted 38% → 42%, now 41%"
    total = inbox["total"]

    resp = await client.post(
        f"{url}/assessments",
        json={"verdict": "partially_held", "observed": "41%", "actual_value": 41,
              "measured_at": proposal["measured_at"]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["outcome"]["status"] == "partially_held"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [r for r in inbox["outcomes"] if r["reason"] == "check_due"] == []
    assert inbox["total"] == total - 1


async def test_no_parseable_value_is_inconclusive(client, owner, runtime):  # noqa: F811
    """protects=criterion 5's inconclusive case; fails_when=an unreadable value gets a
    verdict; no_claim=other unparseable spellings."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    await set_record(tenant_id, pay["id"], status="tracking", assess_due_on=company_today())
    await goal_history(tenant_id, ("not measured yet", days_ago(2)))
    async with tenant_session(tenant_id) as s:
        from sqlalchemy import select

        from oracle.baseline.models import Entity

        goal = await s.scalar(select(Entity).where(Entity.type == "goal"))
        goal.attrs = {**goal.attrs, "current": None}
        await s.commit()
    await ticker_pass(tenant_id)
    got = (await client.get(f"/v1/outcomes/{pay['id']}", headers=auth)).json()
    assert got["proposed_assessment"]["verdict"] == "inconclusive"
    assert got["proposed_assessment"]["actual_value"] is None


async def test_oracle_records_the_verdict_when_autonomy_acts(client, owner, runtime):  # noqa: F811
    """protects=criterion 5's exception: at "Act within limits" Oracle records the verdict
    as itself and the owner sees "Oracle recorded"; fails_when=it waits for a person, or
    the assessment names a person; no_claim=the Autonomy screen."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    prediction = {**pay["prediction"], "threshold_value": 40, "by": days_ago(10).isoformat()}
    await set_record(
        tenant_id,
        pay["id"],
        status="tracking",
        prediction=prediction,
        assess_due_on=company_today(),
    )
    await goal_history(tenant_id, ("41%", days_ago(5)))
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="autonomy", value={"outcomes": {"level": "act"}}))
        await s.commit()
    await ticker_pass(tenant_id)
    got = (await client.get(f"/v1/outcomes/{pay['id']}", headers=auth)).json()
    assert got["status"] == "partially_held"
    assert [a["actor"] for a in got["assessments"]] == ["oracle"]
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    rows = [r for r in inbox["outcomes"] if r["reason"] == "oracle_recorded"]
    assert [r["title"] for r in rows] == ["Oracle recorded: partly held · Payment step"]
