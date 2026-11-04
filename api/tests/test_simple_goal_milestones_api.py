"""build-milestones-on-roadmap: milestones per goal on the Simple roadmap
(``GET /v1/simple/roadmap`` ``goal_milestones``, ``POST/PATCH/DELETE
/v1/simple/roadmap/milestones``), reusing Oracle's track milestone model. Against
Postgres. The company's clock is fixed to Mon Nov 2, 2026 (tests.test_simple_roadmap_api).

Test cards (protects / fails_when / no_claim):

- test_create_list_patch_delete_restore_own_milestone: protects=an owner creates a goal
  milestone (coded the next "M<n>" in that goal on that roadmap), it is listed on the
  roadmap read, its date/items/counts_when are edited, it is deleted and restored, and a
  viewer is refused every write; fails_when=the code does not increment, an edit or the
  delete/restore does not round-trip, or a viewer gets through; no_claim=the web.
- test_prd_milestones_appear_dated_and_propose_through_the_change_engine: protects=a
  roadmap built from a PRD shows that PRD's own milestones as goal milestones, each dated
  from the PRD's approved plan (null when the plan has no date for it), materialised as
  rows; editing one proposes a change to the PRD's owner (the milestone's date stays,
  ``pending`` filled) through the existing change engine, and accepting it through
  ``POST /v1/simple/changes/{id}/accept`` writes the date and clears ``pending``;
  fails_when=the PRD's milestones are absent, a date is wrong, an edit changes the
  milestone directly, or accepting it does not write the date; no_claim=declining (same
  shape as accept, exercised by the change engine's own tests).
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.auth.models import User
from oracle.members.names import display_name
from oracle.roadmap.models import TrackMilestone
from oracle.simple.models import SimpleChange, SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

ROADMAP = "/v1/simple/roadmap"
MILESTONES = f"{ROADMAP}/milestones"
CHANGES = "/v1/simple/changes"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed_roadmap(ctx: Ctx) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, _, rm, _ = await seed.roadmap("launch")
        goal = await seed.entity("goal", "activation")
        await s.commit()
        return {"roadmap_id": str(rm.id), "goal_id": str(goal.id)}


async def seed_prd_roadmap(ctx: Ctx, owner_id: uuid.UUID) -> dict:
    """A roadmap with one item from a PRD whose plan has two milestones: M1 dated, M2
    with no date anywhere."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        prd, pv, rm, rv = await seed.roadmap("setup")
        await seed.track(pv, rm, title="Guided setup", owner_id=owner_id)
        await seed.item(rv, pv, "f-03", track_id=None)
        data = {
            "milestones": [
                {"code": "M1", "name": "Prove it", "start": "2026-11-02", "end": "2026-11-27",
                 "effort_weeks": 4, "done_when": [], "targets": []},
                {"code": "M2", "name": "Scale volume", "effort_weeks": None, "done_when": [],
                 "targets": []},
            ],
            "features": [], "goals": [], "holidays": [],
        }  # fmt: skip
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data=data))  # fmt: skip
        await s.commit()
        return {"roadmap_id": str(rm.id), "prd_id": str(prd.id)}


def by_code(body: dict) -> dict[str, dict]:
    return {m["code"]: m for m in body["goal_milestones"]}


async def get_roadmap(client, ctx: Ctx, role: str) -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


async def test_create_list_patch_delete_restore_own_milestone(client):
    ctx = await make_ctx()
    ids = await seed_roadmap(ctx)
    body = {"roadmap_id": ids["roadmap_id"], "name": "Prove it", "date": "2026-11-27",
            "goal_id": ids["goal_id"], "counts_when": "Ten teams finish setup"}  # fmt: skip
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    m1 = r.json()
    assert (m1["code"], m1["date"], m1["can_change"]) == ("M1", "2026-11-27", True)
    body2 = {**body, "name": "Scale volume", "date": "2026-12-11"}
    r = await client.post(MILESTONES, json=body2, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    m2 = r.json()
    assert m2["code"] == "M2"
    listed = by_code(await get_roadmap(client, ctx, "owner"))
    assert {"M1", "M2"} <= set(listed)
    assert listed["M1"]["name"] == "Prove it"
    item_id = str(uuid.uuid4())
    patch = {"date": "2026-12-04", "counts_when": "Half the teams active",
             "item_ids": [item_id]}  # fmt: skip
    r = await client.patch(f"{MILESTONES}/{m1['id']}", json=patch, headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.patch(f"{MILESTONES}/{m1['id']}", json=patch, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    patched = r.json()
    assert patched["date"] == "2026-12-04"
    assert patched["counts_when"] == "Half the teams active"
    assert patched["item_ids"] == [item_id]
    r = await client.delete(f"{MILESTONES}/{m1['id']}", headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.delete(f"{MILESTONES}/{m1['id']}", headers=ctx.as_("owner"))
    assert r.status_code == 204, r.text
    listed = by_code(await get_roadmap(client, ctx, "owner"))
    assert "M1" not in listed and "M2" in listed
    r = await client.post(f"{MILESTONES}/{m1['id']}/restore", headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{MILESTONES}/{m1['id']}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["date"] == "2026-12-04"
    listed = by_code(await get_roadmap(client, ctx, "owner"))
    assert {"M1", "M2"} <= set(listed)
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(TrackMilestone)))
        assert len(rows) == 2 and all(r.roadmap_id is not None for r in rows)


async def test_prd_milestones_appear_dated_and_propose_through_the_change_engine(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        owner = User(email="prdowner@example.com", name="Priya Owner", password_hash="x",
                     role="approver")  # fmt: skip
        s.add(owner)
        await s.commit()
        ctx.users["prdowner"] = owner
    ids = await seed_prd_roadmap(ctx, owner.id)
    out = await get_roadmap(client, ctx, "viewer")
    listed = by_code(out)
    assert listed["M1"]["date"] == "2026-11-27"
    assert listed["M1"]["prd"]["id"] == ids["prd_id"]
    assert listed["M1"]["prd_owner"] == display_name(owner.email, owner.name)
    assert listed["M1"]["can_change"] is False
    assert listed["M2"]["date"] is None
    m1_id = listed["M1"]["id"]
    r = await client.patch(f"{MILESTONES}/{m1_id}", json={"name": "Renamed"},
                           headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 422, r.text
    r = await client.patch(f"{MILESTONES}/{m1_id}", json={"date": "2026-12-04"},
                           headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 403, r.text
    r = await client.patch(f"{MILESTONES}/{m1_id}", json={"date": "2026-12-04"},
                           headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    proposed = r.json()
    assert proposed["date"] == "2026-11-27"  # unchanged
    assert proposed["pending"]["date"] == "2026-12-04"
    assert proposed["pending"]["asked_of"] == display_name(owner.email, owner.name)
    change_id = proposed["pending"]["change_id"]
    async with tenant_session(ctx.tenant_id) as s:
        c = await s.get(SimpleChange, uuid.UUID(change_id))
        assert c is not None
        assert (c.op, c.status, str(c.document_id)) == (
            "edit_goal_milestone",
            "proposed",
            ids["prd_id"],
        )
        assert c.routed_to == [owner.id]
    still = by_code(await get_roadmap(client, ctx, "viewer"))
    assert still["M1"]["date"] == "2026-11-27"
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("commenter"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("prdowner"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    after = by_code(await get_roadmap(client, ctx, "viewer"))
    assert after["M1"]["date"] == "2026-12-04"
    assert after["M1"]["pending"] is None
