"""milestone-rights: who changes a roadmap's own goal milestone, and who proposes a change
to it. The roadmap's owner, its decider, or its owner acting as approver change it
(``drafts.can_edit``, ``can_change``); anyone else who may propose (an approver who is not
its owner, a commenter) is refused a PATCH or DELETE and proposes instead through the change
engine (``POST /v1/simple/changes`` op ``edit_goal_milestone``, ``can_propose``), routed to
who decides the roadmap; accepting it applies the change. A viewer reads only. Against
Postgres; the company's clock is fixed to Mon Nov 2, 2026 (tests.test_simple_roadmap_api).

Test cards (protects / fails_when / no_claim):

- test_an_approver_who_is_not_the_owner_is_refused_and_proposes: protects=can_change and
  can_propose on the roadmap read per role; the approver's PATCH and DELETE are 403; their
  edit_goal_milestone proposal leaves the milestone as it is, is routed to the company's
  owner, shows the owner Accept (can_decide) and not the approver; accepting it writes the
  name, date and counts_when; fails_when=the approver's PATCH goes through, the proposal is
  refused or applies at once, or accepting it does not change the milestone; no_claim=the web.
- test_a_proposal_to_remove_it_removes_it_when_accepted: protects=``after.milestone`` null
  proposes removing it; accepting it deletes the milestone; fails_when=it stays listed.
- test_a_proposal_checks_what_was_seen_and_who_sends_it: protects=a stale ``before`` is 409,
  a viewer is 403, who changes it directly is told to (409), a missing one is 404, and a
  proposal outdated by a later edit is 409 on accept; fails_when=any goes through.
"""

import uuid

import pytest

from oracle import company_time
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_goal_milestones_api import CHANGES, MILESTONES, by_code, get_roadmap
from tests.test_simple_roadmap_api import NOW, Seed


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed_roadmap(ctx: Ctx) -> dict:
    """A roadmap with one item (the proposals read covers the roadmaps it reads items of),
    its track owned by no one: only the company's owner changes its milestones."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("launch")
        await seed.item(rv, pv, "f-01", track_id=None)
        goal = await seed.entity("goal", "activation")
        await s.commit()
        return {"roadmap_id": str(rm.id), "goal_id": str(goal.id)}


async def own_milestone(client, ctx: Ctx) -> tuple[dict, dict]:
    ids = await seed_roadmap(ctx)
    body = {"roadmap_id": ids["roadmap_id"], "name": "Prove it", "date": "2026-11-27",
            "goal_id": ids["goal_id"], "counts_when": "Holds 7 days in a row"}  # fmt: skip
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    return ids, r.json()


def seen(m: dict) -> dict:
    return {k: m[k] for k in ("name", "date", "goal_id", "item_ids", "counts_when")}


def proposal(m: dict, after: dict | None) -> dict:
    return {"op": "edit_goal_milestone", "target": {"milestone_id": m["id"]},
            "before": {"milestone": seen(m)},
            "after": {"milestone": None if after is None else {**seen(m), **after}}}  # fmt: skip


async def test_an_approver_who_is_not_the_owner_is_refused_and_proposes(client):
    ctx = await make_ctx()
    _, m = await own_milestone(client, ctx)
    rights = [("owner", True, False), ("approver", False, True), ("commenter", False, True),
              ("viewer", False, False)]  # fmt: skip
    for role, change, propose in rights:
        got = by_code(await get_roadmap(client, ctx, role))["M1"]
        assert (got["can_change"], got["can_propose"]) == (change, propose), role
    url = f"{MILESTONES}/{m['id']}"
    r = await client.patch(url, json={"date": "2026-12-04"}, headers=ctx.as_("approver"))
    assert r.status_code == 403, r.text
    r = await client.delete(url, headers=ctx.as_("approver"))
    assert r.status_code == 403, r.text
    ask = proposal(m, {"name": "Prove it twice", "date": "2026-12-04",
                       "counts_when": "Holds 14 days in a row"})  # fmt: skip
    r = await client.post(CHANGES, json=ask, headers=ctx.as_("approver"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert (c["op"], c["status"]) == ("edit_goal_milestone", "proposed")
    assert c["routed_to"] == [str(ctx.users["owner"].id)]
    assert c["words"] and "Prove it" in c["words"]
    still = by_code(await get_roadmap(client, ctx, "owner"))["M1"]
    assert (still["name"], still["date"]) == ("Prove it", "2026-11-27")
    r = await client.get(CHANGES, params={"status": "proposed"}, headers=ctx.as_("owner"))
    assert [(x["id"], x["can_decide"]) for x in r.json()] == [(c["id"], True)]
    r = await client.get(CHANGES, params={"status": "proposed"}, headers=ctx.as_("approver"))
    assert [(x["id"], x["can_decide"]) for x in r.json()] == [(c["id"], False)]
    r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=ctx.as_("approver"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    after = by_code(await get_roadmap(client, ctx, "owner"))["M1"]
    assert (after["name"], after["date"], after["counts_when"]) == (
        "Prove it twice",
        "2026-12-04",
        "Holds 14 days in a row",
    )


async def test_a_proposal_to_remove_it_removes_it_when_accepted(client):
    ctx = await make_ctx()
    _, m = await own_milestone(client, ctx)
    r = await client.post(CHANGES, json=proposal(m, None), headers=ctx.as_("approver"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert "M1" in by_code(await get_roadmap(client, ctx, "owner"))
    r = await client.post(f"{CHANGES}/{c['id']}/decline", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert "M1" in by_code(await get_roadmap(client, ctx, "owner"))
    r = await client.post(CHANGES, json=proposal(m, None), headers=ctx.as_("approver"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert "M1" not in by_code(await get_roadmap(client, ctx, "owner"))


async def test_a_proposal_checks_what_was_seen_and_who_sends_it(client):
    ctx = await make_ctx()
    _, m = await own_milestone(client, ctx)
    stale = proposal({**m, "date": "2026-11-20"}, {"date": "2026-12-04"})
    r = await client.post(CHANGES, json=stale, headers=ctx.as_("approver"))
    assert r.status_code == 409, r.text
    ask = proposal(m, {"date": "2026-12-04"})
    r = await client.post(CHANGES, json=ask, headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(CHANGES, json=ask, headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    gone = {**ask, "target": {"milestone_id": str(uuid.uuid4())}}
    r = await client.post(CHANGES, json=gone, headers=ctx.as_("approver"))
    assert r.status_code == 404, r.text
    r = await client.post(CHANGES, json=ask, headers=ctx.as_("approver"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    r = await client.patch(f"{MILESTONES}/{m['id']}", json={"date": "2026-12-11"},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert by_code(await get_roadmap(client, ctx, "owner"))["M1"]["date"] == "2026-12-11"
