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
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-07 is already the code of F-07 Billing"
    r = await post({"code": None}, {"code": "f-12"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-12 is already the code of a Ground Truth feature"
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


async def coded_pair(ctx: Ctx, first: str = "Alerts") -> tuple[str, str]:
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        a = await seed.item(rv, pv, "a", position=0, title=first)
        b = await seed.item(rv, pv, "b", position=1, title="Billing")
        await s.commit()
    return str(a.id), str(b.id)


def propose_code(client, ctx: Ctx, item: str, code: str, who: str = "commenter"):
    body = {"op": "set_code", "target": {"item_id": item}, "before": {"code": None},
            "after": {"code": code}}  # fmt: skip
    return client.post(CHANGES, json=body, headers=ctx.as_(who))


async def test_accepting_a_code_another_item_took_since_is_refused(client):
    ctx = await make_people()
    a, b = await coded_pair(ctx)
    made = []
    for item in (a, b):
        r = await propose_code(client, ctx, item, "F-31")
        assert r.status_code == 201, r.text
        assert r.json()["change"]["status"] == "proposed"
        made.append(r.json()["change"]["id"])
    r = await client.post(f"{CHANGES}/{made[0]}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{CHANGES}/{made[1]}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "F-31 is already the code of F-31 Alerts"
    shown = by_key(await get(client, ctx, "owner"))
    assert (shown["a"]["code"], shown["b"]["code"]) == ("F-31", None)
    # The proposal stays open, to decline.
    r = await client.post(f"{CHANGES}/{made[1]}/decline", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "declined"


async def test_accepting_a_code_a_ground_truth_feature_took_since_is_refused(client):
    ctx = await make_people()
    a, _ = await coded_pair(ctx)
    r = await propose_code(client, ctx, a, "F-33")
    assert r.status_code == 201, r.text
    cid = r.json()["change"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        await Seed(s).entity("feature", "F-33")
        await s.commit()
    r = await client.post(f"{CHANGES}/{cid}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "F-33 is already the code of a Ground Truth feature"
    assert by_key(await get(client, ctx, "owner"))["a"]["code"] is None


async def test_a_code_never_cuts_the_name(client):
    ctx = await make_people()
    long = "Alerts " + "x" * 190  # 197 characters: no room for "F-31 " in 200
    a, _ = await coded_pair(ctx, first=long)
    r = await propose_code(client, ctx, a, "F-31", who="owner")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == (
        "The name is too long to carry the code F-31: shorten it to 195 characters first"
    )
    assert by_key(await get(client, ctx, "owner"))["a"]["title"] == long


async def test_the_read_says_where_a_code_comes_from(client):
    # protects=an item whose code comes from its PRD reads code_from "prd" (the panel shows it
    # read-only); its own code (set_code's) and no code read null; fails_when=the read gives no
    # way to tell them apart; no_claim=a Ground Truth feature's code (priorities' short codes).
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        await seed.item(rv, pv, "a", position=0, title="Alerts")
        await seed.item(rv, pv, "b", position=1, title="F-07 Billing")
        await seed.item(rv, pv, "c", position=2, title="Exports", prd_section_key="f-06")
        await s.commit()
    shown = by_key(await get(client, ctx, "owner"))
    got = {k: (shown[k]["code"], shown[k]["code_from"]) for k in "abc"}
    assert got == {"a": (None, None), "b": ("F-07", None), "c": ("F-06", "prd")}


async def test_undoing_a_code_change_never_gives_its_old_code_to_two_items(client):
    # protects=Undo of a set_code that would write back a code another item took since is
    # refused (409) in the words of propose and accept, and nothing changes; fails_when=both
    # items read F-30 after the undo; no_claim=a Ground Truth feature taking the code.
    ctx = await make_people()
    a, b = await coded_pair(ctx, first="F-30 Alerts")
    body = {"op": "set_code", "target": {"item_id": a}, "before": {"code": "F-30"},
            "after": {"code": "F-32"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    first = r.json()["change"]
    assert first["status"] == "applied"
    r = await propose_code(client, ctx, b, "F-30", who="owner")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    r = await client.post(f"{CHANGES}/{first['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "F-30 is already the code of F-30 Billing"
    shown = by_key(await get(client, ctx, "owner"))
    assert (shown["a"]["code"], shown["b"]["code"]) == ("F-32", "F-30")


def rename(client, ctx: Ctx, item: str, seen: str, title: str, who: str = "owner"):
    body = {"op": "edit_title", "target": {"item_id": item}, "before": {"title": seen},
            "after": {"title": title}}  # fmt: skip
    return client.post(CHANGES, json=body, headers=ctx.as_(who))


async def test_a_rename_never_takes_a_code_another_item_or_feature_has(client):
    # protects=a new title leading with a code other than the item's own is checked as
    # set_code checks it, in its words; a free code is kept; fails_when=a rename gives an item
    # a code another item or a Ground Truth feature has; no_claim=an item coded by its feature.
    ctx = await make_people()
    a, b = await coded_pair(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        await Seed(s).entity("feature", "F-12")
        await s.commit()
    r = await propose_code(client, ctx, b, "F-31", who="owner")
    assert r.status_code == 201, r.text
    r = await rename(client, ctx, a, "Alerts", "F-31 Alerts")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-31 is already the code of F-31 Billing"
    r = await rename(client, ctx, a, "Alerts", "F-12 Alerts")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-12 is already the code of a Ground Truth feature"
    assert by_key(await get(client, ctx, "owner"))["a"]["code"] is None
    r = await rename(client, ctx, a, "Alerts", "F-35 Alerts")
    assert r.status_code == 201, r.text
    shown = by_key(await get(client, ctx, "owner"))["a"]
    assert (shown["code"], shown["title"]) == ("F-35", "Alerts")
    # Its own code kept in a rename is no clash.
    r = await rename(client, ctx, a, "Alerts", "F-35 Smart alerts")
    assert r.status_code == 201, r.text
    assert by_key(await get(client, ctx, "owner"))["a"]["title"] == "Smart alerts"


async def test_merging_into_a_feature_never_gives_its_code_to_two_items(client):
    # protects=merge_item into a Ground Truth feature whose code another item shows as its own
    # is refused in set_code's words; fails_when=two items read the feature's code;
    # no_claim=items linked to the same feature (its slices).
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        c = await seed.item(rv, pv, "c", position=0, title="Alerts", draft=True)
        await seed.item(rv, pv, "b", position=1, title="F-34 Billing")
        feature = await seed.entity("feature", "F-34")
        await s.commit()
    body = {"op": "merge_item", "target": {"item_id": str(c.id), "feature_id": str(feature.id)},
            "before": {}, "after": {}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-34 is already the code of F-34 Billing"
    assert by_key(await get(client, ctx, "owner"))["c"]["code"] is None


def add(client, ctx: Ctx, roadmap: str, title: str, who: str = "owner"):
    where = {"kind": "horizon", "value": "next"}
    body = {"op": "add_item", "target": {"roadmap_id": roadmap, "where": where},
            "before": {}, "after": {"title": title}}  # fmt: skip
    return client.post(CHANGES, json=body, headers=ctx.as_(who))


async def coded_roadmap(ctx: Ctx) -> tuple[str, str]:
    """A roadmap with items a "F-30 Alerts" and b "Billing", and the feature F-12."""
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, rv = await seed.roadmap("payments")
        await seed.item(rv, pv, "a", position=0, title="F-30 Alerts")
        b = await seed.item(rv, pv, "b", position=1, title="Billing")
        await seed.entity("feature", "F-12")
        await s.commit()
    return str(rm.id), str(b.id)


async def test_adding_an_item_never_takes_a_code_another_item_or_feature_has(client):
    # protects=add_item whose title leads with a code another item or a Ground Truth feature
    # has is refused in set_code's words, and no item is made; a free code is kept;
    # fails_when=two items read F-30 after the add; no_claim=Oracle's drafting.
    ctx = await make_people()
    roadmap, _ = await coded_roadmap(ctx)
    r = await add(client, ctx, roadmap, "F-30 Night digest")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-30 is already the code of F-30 Alerts"
    r = await add(client, ctx, roadmap, "F-12 Night digest")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-12 is already the code of a Ground Truth feature"
    titles = [i["title"] for i in (await get(client, ctx, "owner"))["items"]]
    assert "Night digest" not in titles and "F-30 Night digest" not in titles
    r = await add(client, ctx, roadmap, "F-37 Night digest")
    assert r.status_code == 201, r.text
    shown = {i["title"]: i["code"] for i in (await get(client, ctx, "owner"))["items"]}
    assert shown["Night digest"] == "F-37"


async def test_accepting_an_added_item_whose_code_was_taken_since_is_refused(client):
    # protects=a proposed add_item whose code another item took since is refused on accept
    # (409) in set_code's words, the proposal open to decline; fails_when=the accept makes a
    # second F-36; no_claim=a decider's own add (checked on create).
    ctx = await make_people()
    roadmap, b = await coded_roadmap(ctx)
    r = await add(client, ctx, roadmap, "F-36 Night digest", who="commenter")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    cid = r.json()["change"]["id"]
    r = await rename(client, ctx, b, "Billing", "F-36 Billing")
    assert r.status_code == 201, r.text
    r = await client.post(f"{CHANGES}/{cid}/accept", headers=ctx.as_("owner"), json={})
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "F-36 is already the code of F-36 Billing"
    assert len((await get(client, ctx, "owner"))["items"]) == 2
    r = await client.post(f"{CHANGES}/{cid}/decline", headers=ctx.as_("owner"), json={})
    assert r.status_code == 200, r.text


async def test_a_rename_checks_any_leading_code_the_read_sees(client):
    # protects=a leading code the read takes as the item's code ("ABCD-1 Alerts", wider than a
    # feature code) is checked in a rename too; fails_when=two items read ABCD-1;
    # no_claim=set_code (feature codes only).
    ctx = await make_people()
    a, b = await coded_pair(ctx)
    r = await rename(client, ctx, b, "Billing", "ABCD-1 Billing")
    assert r.status_code == 201, r.text
    r = await rename(client, ctx, a, "Alerts", "ABCD-1 Alerts")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "ABCD-1 is already the code of ABCD-1 Billing"
