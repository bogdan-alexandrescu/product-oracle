"""goal-map-link-asks: a commenter (who may propose but not edit the Goal map) who drops a
feature onto a milestone suggests it through the change engine: ``POST /v1/simple/changes``
op ``link_goal_map``, ``target`` ``{feature, milestone, from_milestone?}`` (null or absent:
put it on the milestone; else move its link from ``from_milestone``), routed to the
feature's roadmap's decider. The world is the Goal map's
(tests.test_simple_goal_map_api.world). Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_a_commenter_suggests_putting_a_feature_on_a_milestone: protects=the commenter's drop
  is a proposal routed to the roadmap's decider, the map unchanged, listed for the decider
  with can_decide; accepting puts the feature on the milestone in the milestone's first
  area; fails_when=it is refused, applied at once, routed elsewhere or accept leaves it off.
- test_a_commenter_suggests_moving_a_feature: protects=with ``from_milestone`` accept moves
  the link (off the old milestone, on the new one); fails_when=both links stay.
- test_decline_and_withdraw_leave_the_map: protects=a declined or withdrawn suggestion
  changes nothing; fails_when=the link appears.
- test_who_may_suggest: protects=viewers 403; approvers and owners (who change the map
  directly) 409; fails_when=either may file it.
"""

import uuid
from datetime import UTC, datetime

import pytest

from oracle import company_time
from oracle.auth.models import User
from oracle.review.models import DocumentReviewPolicy
from oracle.tenancy import tenant_session
from tests.test_simple_goal_map_api import read, world

CHANGES = "/v1/simple/changes"
NOW = datetime(2026, 11, 3, 17, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def with_decider(ctx, ids) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        decider = User(email="decider@example.com", password_hash="x", role="approver")
        s.add(decider)
        await s.flush()
        s.add(DocumentReviewPolicy(document_id=uuid.UUID(ids["roadmap"]), decider_id=decider.id))
        await s.commit()
        ctx.users["decider"] = decider
    return str(decider.id)


def ask(feature: str, milestone: str, from_milestone: str | None = None) -> dict:
    return {
        "op": "link_goal_map",
        "target": {"feature": feature, "milestone": milestone, "from_milestone": from_milestone},
        "before": {},
        "after": {},
    }


def links(body: dict, feature: str) -> list[str]:
    f = next((f for f in body["features"] if f["id"] == feature), None)
    return sorted(f["milestones"]) if f else []


async def test_a_commenter_suggests_putting_a_feature_on_a_milestone(client):
    ctx, ids = await world()
    decider = await with_decider(ctx, ids)
    r = await client.post(CHANGES, json=ask(ids["f3"], ids["m1"]), headers=ctx.as_("commenter"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["status"] == "proposed" and c["op"] == "link_goal_map"
    assert c["routed_to"] == [decider]
    assert c["by"] == str(ctx.users["commenter"].id)
    assert "One-tap" not in c["words"] and "Rep leaderboard" in c["words"]
    assert links(await read(client, ctx), ids["f3"]) == []
    r = await client.get(CHANGES, params={"status": "proposed"}, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    [mine] = [x for x in r.json() if x["id"] == c["id"]]
    assert mine["can_decide"] is True
    r = await client.post(f"{CHANGES}/{c['id']}/accept", json={}, headers=ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    body = await read(client, ctx)
    assert links(body, ids["f3"]) == [ids["m1"]]
    f3 = next(f for f in body["features"] if f["id"] == ids["f3"])
    assert f3["area"] == ids["scale"]


async def test_a_commenter_suggests_moving_a_feature(client):
    ctx, ids = await world()
    decider = await with_decider(ctx, ids)
    r = await client.post(
        CHANGES, json=ask(ids["f1"], ids["m2"], ids["m1"]), headers=ctx.as_("commenter")
    )
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["status"] == "proposed" and c["routed_to"] == [decider]
    assert links(await read(client, ctx), ids["f1"]) == [ids["m1"]]
    r = await client.post(f"{CHANGES}/{c['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert links(await read(client, ctx), ids["f1"]) == [ids["m2"]]


async def test_decline_and_withdraw_leave_the_map(client):
    ctx, ids = await world()
    await with_decider(ctx, ids)
    h = ctx.as_("commenter")
    one = (await client.post(CHANGES, json=ask(ids["f3"], ids["m1"]), headers=h)).json()
    r = await client.post(
        f"{CHANGES}/{one['change']['id']}/decline", json={}, headers=ctx.as_("decider")
    )
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "declined"
    two = (await client.post(CHANGES, json=ask(ids["f3"], ids["m2"]), headers=h)).json()
    r = await client.post(f"{CHANGES}/{two['change']['id']}/withdraw", headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "declined"
    assert links(await read(client, ctx), ids["f3"]) == []


async def test_who_may_suggest(client):
    ctx, ids = await world()
    await with_decider(ctx, ids)
    r = await client.post(CHANGES, json=ask(ids["f3"], ids["m1"]), headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    for role in ("approver", "owner"):
        r = await client.post(CHANGES, json=ask(ids["f3"], ids["m1"]), headers=ctx.as_(role))
        assert r.status_code == 409, r.text
        assert "directly" in r.text
    assert links(await read(client, ctx), ids["f3"]) == []
