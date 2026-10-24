"""H3 Predicted versus actual, the owner's side of an assessment: every assessment keeps
the learnings Oracle drafted from it, and the owner keeps or skips each one in the
inspector (Keep makes it an active learning; Skip drops it, and both stay decided); the
owner changes a verdict Oracle recorded by assessing again. Against Postgres with the
FakeRuntime. Made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.day_helpers import company_today
from tests.launch_helpers import ticker_pass
from tests.outcome_helpers import days_ago, goal_history, outcome_world, set_record
from tests.roadmap_helpers import other_company
from tests.test_roadmap import (  # noqa: F401 - fixtures
    as_user,
    owner,
    runtime,
)


async def _assessed(client, auth, runtime, tenant_id) -> str:  # noqa: F811
    """payment-step shipped, with two question categories and a module behind it,
    assessed partly held by a person: its id."""
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    await set_record(
        tenant_id, pay["id"], status="tracking",
        gap_categories=["success_metric", "pain_evidence"], module_keys=["M-12"],
    )  # fmt: skip
    resp = await client.post(
        f"/v1/outcomes/{pay['id']}/assessments",
        json={"verdict": "partially_held", "observed": "41%", "actual_value": 41},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    return pay["id"]


async def test_an_assessment_keeps_its_drafted_learnings(client, owner, runtime):  # noqa: F811
    """protects=the inspector's drafted learnings outlive the assess call: the latest
    assessment lists them, each drafted; fails_when=they exist only in the POST's response,
    so a reload or an Oracle-recorded verdict shows none; no_claim=the drafts' wording."""
    tenant_id, auth = owner
    outcome_id = await _assessed(client, auth, runtime, tenant_id)
    got = (await client.get(f"/v1/outcomes/{outcome_id}", headers=auth)).json()
    learnings = got["assessments"][-1]["learnings"]
    assert [(x["applies_to"], x["target"], x["state"]) for x in learnings] == [
        ("question_category", "success_metric", "drafted"),
        ("question_category", "pain_evidence", "drafted"),
        ("module", "M-12", "drafted"),
    ]
    assert all(x["outcome_id"] == outcome_id for x in learnings)


async def test_keep_makes_a_learning_and_skip_drops_it(client, owner, runtime):  # noqa: F811
    """protects=Keep and Skip: Keep creates an active learning tied to the outcome and
    marks the draft kept; Skip creates none and marks it skipped; both are audited and
    decided once; fails_when=Skip creates a learning, Keep creates two, or a decided draft
    can be decided again; no_claim=the learnings signal (unchanged)."""
    tenant_id, auth = owner
    outcome_id = await _assessed(client, auth, runtime, tenant_id)
    url = f"/v1/outcomes/{outcome_id}/learnings"

    resp = await client.post(f"{url}/0", json={"decision": "keep"}, headers=auth)
    assert resp.status_code == 200, resp.text
    first = resp.json()["assessments"][-1]["learnings"][0]
    assert first["state"] == "kept" and first["learning_id"]
    kept = (await client.get("/v1/learnings", headers=auth)).json()
    assert [(x["id"], x["target"], x["outcome_id"], x["status"]) for x in kept] == [
        (first["learning_id"], "success_metric", outcome_id, "active")
    ]

    resp = await client.post(f"{url}/1", json={"decision": "skip"}, headers=auth)
    assert resp.status_code == 200, resp.text
    states = [x["state"] for x in resp.json()["assessments"][-1]["learnings"]]
    assert states == ["kept", "skipped", "drafted"]
    assert len((await client.get("/v1/learnings", headers=auth)).json()) == 1

    for index, decision in ((0, "skip"), (1, "keep")):
        resp = await client.post(f"{url}/{index}", json={"decision": decision}, headers=auth)
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == "Already decided"
    resp = await client.post(f"{url}/7", json={"decision": "keep"}, headers=auth)
    assert resp.status_code == 404

    async with tenant_session(tenant_id) as s:
        actions = list(
            await s.scalars(
                select(AuditEvent.action).where(AuditEvent.action.like("outcome.learning_%"))
            )
        )
    assert sorted(actions) == ["outcome.learning_kept", "outcome.learning_skipped"]


async def test_viewers_and_other_companies_cannot_decide(client, owner, runtime):  # noqa: F811
    """protects=Keep and Skip are an approver's, inside the company; fails_when=a viewer
    decides, or another company's id answers anything but 404; no_claim=run tokens (the
    route is not in their read areas)."""
    tenant_id, auth = owner
    outcome_id = await _assessed(client, auth, runtime, tenant_id)
    url = f"/v1/outcomes/{outcome_id}/learnings/0"
    viewer = await as_user(tenant_id, "viewer")
    assert (await client.post(url, json={"decision": "keep"}, headers=viewer)).status_code == 403
    other = await other_company()
    assert (await client.post(url, json={"decision": "keep"}, headers=other)).status_code == 404


async def test_nothing_to_decide_before_an_assessment(client, owner, runtime):  # noqa: F811
    """protects=drafts come only from an assessment; fails_when=a predicted record offers
    Keep; no_claim=older assessments' drafts (only the latest is decided)."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    resp = await client.post(
        f"/v1/outcomes/{pay['id']}/learnings/0", json={"decision": "keep"}, headers=auth
    )
    assert resp.status_code == 404


async def test_the_owner_changes_what_oracle_recorded(client, owner, runtime):  # noqa: F811
    """protects=the Inbox's "Oracle recorded" Change: Oracle's own verdict carries its drafts,
    and the owner's new assessment replaces the verdict with fresh drafts and clears the
    row; fails_when=Oracle's verdict cannot be changed, or its row stays after the change;
    no_claim=the 14-day window of the row."""
    tenant_id, auth = owner
    pay = (await outcome_world(client, auth, runtime, tenant_id))["payment-step"]
    prediction = {**pay["prediction"], "threshold_value": 40, "by": days_ago(10).isoformat()}
    await set_record(
        tenant_id, pay["id"], status="tracking", prediction=prediction,
        assess_due_on=company_today(), gap_categories=["success_metric"],
    )  # fmt: skip
    await goal_history(tenant_id, ("41%", days_ago(5)))
    async with tenant_session(tenant_id) as s:
        s.add(TenantSetting(key="autonomy", value={"outcomes": {"level": "act"}}))
        await s.commit()
    await ticker_pass(tenant_id)
    url = f"/v1/outcomes/{pay['id']}"
    got = (await client.get(url, headers=auth)).json()
    assert got["assessments"][-1]["actor"] == "oracle"
    assert [x["state"] for x in got["assessments"][-1]["learnings"]] == ["drafted"]

    resp = await client.post(
        f"{url}/assessments",
        json={"verdict": "not_held", "observed": "39%", "actual_value": 39,
              "note": "The 41% reading counted test accounts"},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    got = (await client.get(url, headers=auth)).json()
    assert got["status"] == "not_held"
    assert [a["actor"] for a in got["assessments"]] == ["oracle", "person"]
    assert got["assessments"][-1]["learnings"][0]["direction"] == "recommend_more"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert [r for r in inbox["outcomes"] if r["reason"] == "oracle_recorded"] == []
