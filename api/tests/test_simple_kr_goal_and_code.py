"""every-field-editable: a key result (a roadmap's own goal milestone) moved to another
goal, and a roadmap item given its feature code, through Simple's change engine. Against
Postgres; the company's clock is fixed to Mon Nov 2, 2026 (tests.test_simple_roadmap_api).

Test cards (protects / fails_when / no_claim):

- test_an_approver_proposes_moving_a_key_result_by_its_goal_alone: protects=an approver
  who is not the decider proposes a key result's new goal naming only what they saw of it
  (``before.milestone`` ``{goal_id}``); accepting it moves it, coded the next free M<n> of
  the new goal when that goal has its code; fails_when=a partial ``before`` is refused, the
  proposal applies at once, or the accept clashes with the other goal's M1; no_claim=the web.
- test_moving_a_key_result_to_a_goal_with_its_code_renumbers_it: protects=the owner's own
  move (PATCH goal_id) takes the next free code of the new goal; fails_when=it keeps a code
  the goal has (a unique clash); no_claim=dates.
- test_set_code_gives_an_item_its_feature_code: protects=``set_code`` gives an item with no
  code its code (the read shows it apart from its name), Undo takes it off, a commenter's is a
  proposal, a viewer is refused, a code another item or feature has is refused in plain words,
  and a code that is not a feature code is 422; fails_when=any of these is let through;
  no_claim=the Ground Truth page.
"""

import pytest

from oracle import company_time
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_changes_api import make_people
from tests.test_simple_goal_milestones_api import CHANGES, MILESTONES, get_roadmap
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def two_goals(client, ctx: Ctx) -> tuple[dict, dict, dict]:
    """A roadmap with goals Activation and Retention, each with its own key result M1."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("launch")
        await seed.item(rv, pv, "f-01", track_id=None)
        a = await seed.entity("goal", "activation")
        b = await seed.entity("goal", "retention")
        await s.commit()
        ids = {"roadmap_id": str(rm.id), "a": str(a.id), "b": str(b.id)}
    made = []
    for goal, name in ((ids["a"], "Prove it"), (ids["b"], "Keep them")):
        body = {"roadmap_id": ids["roadmap_id"], "name": name, "date": "2026-11-27",
                "goal_id": goal, "counts_when": "Holds 7 days in a row"}  # fmt: skip
        r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
        assert r.status_code == 201, r.text
        made.append(r.json())
    return ids, made[0], made[1]


def listed(roadmap: dict) -> dict[str, dict]:
    return {m["name"]: m for m in roadmap["goal_milestones"]}


async def test_an_approver_proposes_moving_a_key_result_by_its_goal_alone(client):
    ctx = await make_ctx()
    ids, m, _ = await two_goals(client, ctx)
    ask = {"op": "edit_goal_milestone", "target": {"milestone_id": m["id"]},
           "before": {"milestone": {"goal_id": ids["a"]}},
           "after": {"milestone": {"goal_id": ids["b"]}}}  # fmt: skip
    r = await client.post(CHANGES, json=ask, headers=ctx.as_("approver"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["status"] == "proposed"
    assert c["after"]["milestone"]["goal_id"] == ids["b"]
    assert listed(await get_roadmap(client, ctx, "owner"))["Prove it"]["goal_id"] == ids["a"]
    # A stale goal is "changed since".
    stale = {**ask, "before": {"milestone": {"goal_id": ids["b"]}}}
    r = await client.post(CHANGES, json=stale, headers=ctx.as_("approver"))
    assert r.status_code == 409, r.text
    # A field a milestone does not have is refused.
    odd = {**ask, "before": {"milestone": {"colour": "red"}}}
    r = await client.post(CHANGES, json=odd, headers=ctx.as_("approver"))
    assert r.status_code == 422, r.text
    r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    moved = listed(await get_roadmap(client, ctx, "owner"))
    assert (moved["Prove it"]["goal_id"], moved["Prove it"]["code"]) == (ids["b"], "M2")
    assert moved["Keep them"]["code"] == "M1"


async def test_moving_a_key_result_to_a_goal_with_its_code_renumbers_it(client):
    ctx = await make_ctx()
    ids, m, _ = await two_goals(client, ctx)
    url = f"{MILESTONES}/{m['id']}"
    r = await client.patch(url, json={"goal_id": ids["b"]}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert (r.json()["goal_id"], r.json()["code"]) == (ids["b"], "M2")
    # Undo (the old goal back): its code there is free again.
    r = await client.patch(url, json={"goal_id": ids["a"]}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert (r.json()["goal_id"], r.json()["code"]) == (ids["a"], "M1")


async def test_set_code_gives_an_item_its_feature_code(client):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        a = await seed.item(rv, pv, "a", position=0, title="Alerts")
        await seed.item(rv, pv, "b", position=1, title="F-07 Billing")
        await seed.entity("feature", "F-12")
        await s.commit()
    item = str(a.id)

    def post(before, after, who="owner"):
        body = {"op": "set_code", "target": {"item_id": item}, "before": before, "after": after}
        return client.post(CHANGES, json=body, headers=ctx.as_(who))

    shown = by_key(await get(client, ctx, "owner"))["a"]
    assert (shown["code"], shown["title"]) == (None, "Alerts")
    r = await post({"code": None}, {"code": "F-07"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"] == "F-07 is already the code of F-07 Billing"
    r = await post({"code": None}, {"code": "f-12"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["message"] == "F-12 is already the code of a Ground Truth feature"
    r = await post({"code": None}, {"code": "Alerts"})
    assert r.status_code == 422, r.text
    r = await post({"code": None}, {"code": "f-31"}, who="viewer")
    assert r.status_code == 403, r.text
    r = await post({"code": None}, {"code": "F-31"}, who="commenter")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    assert by_key(await get(client, ctx, "owner"))["a"]["code"] is None

    r = await post({"code": None}, {"code": "f-31"})
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert c["status"] == "applied"
    assert "F-31" in c["words"]
    shown = by_key(await get(client, ctx, "owner"))["a"]
    assert (shown["code"], shown["title"]) == ("F-31", "Alerts")
    # A stale ``before`` is "changed since".
    r = await post({"code": None}, {"code": "F-32"})
    assert r.status_code == 409, r.text
    r = await client.post(f"{CHANGES}/{c['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    shown = by_key(await get(client, ctx, "owner"))["a"]
    assert (shown["code"], shown["title"]) == (None, "Alerts")
