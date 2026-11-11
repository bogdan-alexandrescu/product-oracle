"""milestone-rename (the owner, Nov 10): every milestone's name changes in place. A goal's
own milestone on the roadmap (``goal_target``: a goal with a date) takes a name of its own,
the goal keeping its title (the Ground Truth is not renamed by it); who decides the roadmap
renames it directly (``can_change``), anyone else who may propose (``can_propose``) sends
``edit_goal_milestone`` to the roadmap's decider, and the milestone reads ``pending`` (with the
name asked for and who it waits for) until it is decided. A PRD's milestone takes a name
proposal to the PRD's owner, who renames it directly. A viewer reads only. Against Postgres;
the company's clock is fixed to Mon Nov 2, 2026.

Test cards (protects / fails_when / no_claim):

- test_the_roadmap_decider_renames_a_goal_target_and_the_goal_keeps_its_title:
  protects=PATCH name on a goal target's id renames the milestone on the roadmap and keeps
  its code; the goal's title stays; date, goal and items are refused (they are the goal's);
  a viewer and an approver who does not decide are 403; fails_when=it 404s, renames the
  goal, or lets anyone through.
- test_a_non_decider_proposes_a_goal_target_rename_and_the_owner_accepts_it:
  protects=can_propose for the approver; the proposal leaves the name, shows pending with
  the name and who it waits for; the decider accepts it and the name changes;
  fails_when=the proposal is refused, applies at once, or shows no pending state.
- test_a_proposal_on_a_roadmap_milestone_shows_pending: protects=a roadmap's own
  milestone's open proposal reads as pending (name, asked_of, can_decide for the decider);
  fails_when=the milestone shows no sign of it.
- test_a_rename_proposal_reads_as_a_rename: protects=the Inbox's words for a proposed name
  name the old and new names; fails_when=it reads "changed the milestone" alone.
- test_a_prd_milestone_takes_a_name_proposal_and_its_owner_renames_directly:
  protects=a commenter's name proposal routes to the PRD's owner and applies on accept; the
  PRD's owner renames it directly; fails_when=the name is refused or applied at once.
"""

import uuid

import pytest

from oracle import company_time
from oracle.baseline.models import Entity
from oracle.models import User
from oracle.simple import change_words
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_milestone_kinds_api import make, read, seed, targets
from tests.test_simple_goal_milestones_api import CHANGES, MILESTONES, by_code, seed_prd_roadmap
from tests.test_simple_roadmap_api import NOW


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def rename(m: dict, name: str) -> dict:
    return {"op": "edit_goal_milestone", "target": {"milestone_id": m["id"]},
            "before": {"milestone": {"name": m["name"]}},
            "after": {"milestone": {"name": name}}}  # fmt: skip


async def goal_title(ctx, goal_id: str) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(Entity, uuid.UUID(goal_id))).title


async def test_the_roadmap_decider_renames_a_goal_target_and_the_goal_keeps_its_title(client):
    ctx = await make_ctx()
    ids = await seed(ctx, due="2026-12-15")
    await make(client, ctx, ids, name="Carts ready", date="2026-11-27")
    [g] = targets(await read(client, ctx))
    assert (g["roadmap_code"], g["can_change"], g["can_propose"]) == ("M2", True, False)
    [v] = targets(await read(client, ctx, "viewer"))
    assert (v["can_change"], v["can_propose"]) == (False, False)
    url = f"{MILESTONES}/{g['id']}"
    for role in ("viewer", "approver"):
        r = await client.patch(url, json={"name": "Ten teams live"}, headers=ctx.as_(role))
        assert r.status_code == 403, (role, r.text)
    r = await client.patch(url, json={"date": "2026-12-20"}, headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    r = await client.patch(url, json={"name": "Ten teams live"}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["goal_target"]) == ("Ten teams live", True)
    [g] = targets(await read(client, ctx))
    assert (g["name"], g["roadmap_code"], g["date"]) == ("Ten teams live", "M2", "2026-12-15")
    assert await goal_title(ctx, ids["goal_id"]) == "Activation"


async def test_a_non_decider_proposes_a_goal_target_rename_and_the_owner_accepts_it(client):
    ctx = await make_ctx()
    ids = await seed(ctx, due="2026-12-15")
    [g] = targets(await read(client, ctx, "approver"))
    assert (g["can_change"], g["can_propose"], g["pending"]) == (False, True, None)
    r = await client.post(CHANGES, json=rename(g, "Ten teams live"), headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(CHANGES, json=rename(g, "Ten teams live"), headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    r = await client.post(CHANGES, json=rename(g, "Ten teams live"), headers=ctx.as_("approver"))
    assert r.status_code in (200, 201), r.text
    change_id = r.json()["change"]["id"]
    [g] = targets(await read(client, ctx, "approver"))
    assert g["name"] == "Activation"
    assert g["pending"]["name"] == "Ten teams live"
    assert g["pending"]["asked_of"]
    assert g["pending"]["can_decide"] is False
    [o] = targets(await read(client, ctx, "owner"))
    assert (o["pending"]["change_id"], o["pending"]["can_decide"]) == (change_id, True)
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("approver"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    [g] = targets(await read(client, ctx))
    assert (g["name"], g["pending"]) == ("Ten teams live", None)
    assert await goal_title(ctx, ids["goal_id"]) == "Activation"


async def test_a_proposal_on_a_roadmap_milestone_shows_pending(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    m = await make(client, ctx, ids, name="Carts ready", date="2026-11-27")
    r = await client.post(CHANGES, json=rename(m, "Carts live"), headers=ctx.as_("approver"))
    assert r.status_code in (200, 201), r.text
    change_id = r.json()["change"]["id"]
    got = {x["id"]: x for x in (await read(client, ctx))["goal_milestones"]}[m["id"]]
    assert got["name"] == "Carts ready"
    assert (got["pending"]["name"], got["pending"]["change_id"]) == ("Carts live", change_id)
    assert got["pending"]["can_decide"] is True
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    got = {x["id"]: x for x in (await read(client, ctx))["goal_milestones"]}[m["id"]]
    assert (got["name"], got["pending"]) == ("Carts live", None)


async def test_a_prd_milestone_takes_a_name_proposal_and_its_owner_renames_directly(client):
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        owner = User(email="prdowner@example.com", name="Priya Owner", password_hash="x",
                     role="approver")  # fmt: skip
        s.add(owner)
        await s.commit()
        ctx.users["prdowner"] = owner
    await seed_prd_roadmap(ctx, owner.id)
    m1 = by_code(await read(client, ctx, "commenter"))["M1"]
    url = f"{MILESTONES}/{m1['id']}"
    r = await client.patch(url, json={"name": "Prove it works"}, headers=ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["pending"]["name"]) == ("Prove it", "Prove it works")
    change_id = r.json()["pending"]["change_id"]
    r = await client.post(f"{CHANGES}/{change_id}/accept", headers=ctx.as_("prdowner"))
    assert r.status_code == 200, r.text
    m1 = by_code(await read(client, ctx, "viewer"))["M1"]
    assert (m1["name"], m1["pending"]) == ("Prove it works", None)
    r = await client.patch(url, json={"name": "Proven"}, headers=ctx.as_("prdowner"))
    assert r.status_code == 200, r.text
    assert (r.json()["name"], r.json()["pending"]) == ("Proven", None)
    assert by_code(await read(client, ctx, "viewer"))["M1"]["name"] == "Proven"


def test_a_rename_proposal_reads_as_a_rename():
    target = {"milestone_id": "x", "name": "Activation"}
    own = change_words.phrase("edit_goal_milestone", target, {"milestone": {"name": "Activation"}},
                              {"milestone": {"name": "Ten teams live"}}, None)  # fmt: skip
    assert own == "renamed the milestone “Activation” to “Ten teams live”"
    prd = change_words.phrase("edit_goal_milestone", target, {"name": "Activation"},
                              {"name": "Ten teams live", "date": None}, None)  # fmt: skip
    assert prd == own
    same = {"name": "Activation"}
    moved = change_words.phrase("edit_goal_milestone", target, {"milestone": same},
                                {"milestone": {**same, "date": "2026-12-01"}}, None)  # fmt: skip
    assert moved == "changed the milestone “Activation”"
