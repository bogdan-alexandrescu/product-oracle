"""#349: what Plan › Outcomes sends when a person tracks an outcome, adds a learning and
retires one by hand: an approved roadmap item without a record, tracked with the expected
effect, a metric and a check date; a learning created and retired with a reason. Against
Postgres with the FakeRuntime. Made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

from tests.outcome_helpers import outcome_world
from tests.test_roadmap import (  # noqa: F401 - fixtures
    as_user,
    owner,
    runtime,
)


async def test_an_approver_tracks_an_untracked_roadmap_item(client, owner, runtime):  # noqa: F811
    """protects=Track outcome's body (item, goal, expected effect, metric, check date)
    makes a record linked to the item and its track, listed with the others; the item
    cannot be tracked twice; a viewer cannot track; fails_when=the link is lost, a second
    record is made, or a viewer gets one; no_claim=the UI's item list."""
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    tracked = {r["roadmap_item_id"] for r in by_item.values()}
    plan = (await client.get("/v1/plan?scope=approved", headers=auth)).json()
    item = next(i for i in plan["items"] if i["id"] not in tracked)
    goal_id = by_item["payment-step"]["goal_id"]
    body = {
        "title": item["title"],
        "goal_id": goal_id,
        "roadmap_item_id": item["id"],
        "prediction": {
            "metric": "Weekly active teams",
            "predicted": "+5 weekly active teams",
            "by": "2027-02-01",
        },
    }
    viewer = await as_user(tenant_id, "viewer")
    assert (await client.post("/v1/outcomes", json=body, headers=viewer)).status_code == 403

    resp = await client.post("/v1/outcomes", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    made = resp.json()
    assert made["roadmap_item_id"] == item["id"]
    assert made["track_id"] == item["track_id"]
    assert made["goal_id"] == goal_id
    assert made["prediction"]["metric"] == "Weekly active teams"
    assert made["prediction"]["predicted"] == "+5 weekly active teams"
    assert made["prediction"]["by"] == "2027-02-01"
    listed = (await client.get("/v1/outcomes", headers=auth)).json()
    assert made["id"] in {r["id"] for r in listed}

    again = await client.post("/v1/outcomes", json=body, headers=auth)
    assert again.status_code == 409


async def test_an_approver_adds_and_retires_a_learning_by_hand(client, owner, runtime):  # noqa: F811
    """protects=Add learning makes an active learning with no outcome; Retire with a
    reason makes it retired with the reason, out of the active list; a viewer can do
    neither; fails_when=the reason is lost, it stays active, or a viewer changes it;
    no_claim=the signal's weights."""
    tenant_id, auth = owner
    viewer = await as_user(tenant_id, "viewer")
    body = {
        "statement": "Ask who owns the rollout before the plan is approved",
        "applies_to": "question_category",
        "target": "ownership",
        "direction": "recommend_more",
    }
    assert (await client.post("/v1/learnings", json=body, headers=viewer)).status_code == 403
    resp = await client.post("/v1/learnings", json=body, headers=auth)
    assert resp.status_code == 201, resp.text
    made = resp.json()
    assert made["status"] == "active" and made["outcome_id"] is None and made["weight"] == 1

    url = f"/v1/learnings/{made['id']}/retire"
    reason = {"reason": "Every template asks for it now"}
    assert (await client.post(url, json=reason, headers=viewer)).status_code == 403
    resp = await client.post(url, json=reason, headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "retired"
    assert resp.json()["retired_reason"] == "Every template asks for it now"
    active = (await client.get("/v1/learnings?status=active", headers=auth)).json()
    assert made["id"] not in {x["id"] for x in active}
