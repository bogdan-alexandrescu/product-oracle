"""Subgoals (#345): a goal with a parent goal. One level; the API refuses cycles. A
parent's progress is its own measurement when it has one, else the weighted progress of
its subgoals. Scoring credits the parent through the subgoal."""

import warnings
from datetime import date

import pytest

from oracle.baseline import goals
from oracle.baseline.rollup import own_progress, rollup
from tests.baseline_helpers import confirm, edge, entity, make_ctx

B = "/v1/baseline"
TODAY = date(2026, 10, 20)


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture(autouse=True)
def frozen_today(monkeypatch):
    monkeypatch.setattr(goals, "today", lambda: TODAY)


def _typed(**over) -> dict:
    attrs = {"metric": "Accounts that finish setup", "unit": "%", "comparison": "at_least",
             "target": 50, "start": 10}  # fmt: skip
    attrs.update(over)
    return {k: v for k, v in attrs.items() if v is not None}


async def _goal(client, ctx, key, parent=None, **attrs) -> dict:
    body = {"type": "goal", "key": key, "attrs": attrs}
    if parent is not None:
        body["parent_id"] = parent["id"]
    return await entity(client, ctx, **body)


async def _patch(client, ctx, ent, who="owner", **body):
    return await client.patch(f"{B}/entities/{ent['id']}", json=body, headers=ctx.as_(who))


async def _get(client, ctx, ent) -> dict:
    resp = await client.get(f"{B}/entities/{ent['id']}", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- the parent field --------------------------------------------------------------------


# protects=a subgoal is a goal with a parent and its own typed target; fails_when=parent_id
# is dropped, or the subgoal loses B5's checks; no_claim=roll-up (below).
async def test_subgoal_is_a_goal_with_a_parent(client, ctx):
    parent = await _goal(client, ctx, "activation")
    sub = await _goal(client, ctx, "activation-setup", parent, **_typed())
    assert sub["parent_id"] == parent["id"]
    assert sub["goal_check"]["missing"] == ["horizon", "owner"]
    assert (await _get(client, ctx, parent))["parent_id"] is None
    bad = await client.post(
        f"{B}/entities",
        json={
            "type": "goal",
            "key": "bad-target",
            "parent_id": parent["id"],
            "attrs": {"target": "45%"},
        },  # fmt: skip
        headers=ctx.as_("owner"),
    )
    assert bad.status_code == 422


# protects=only a goal has a parent, and the parent is a goal; fails_when=a feature gets a
# parent or a goal hangs under a feature; no_claim=cycles (next test).
async def test_parent_is_a_goal_and_only_goals_have_one(client, ctx):
    parent = await _goal(client, ctx, "activation")
    feature = await entity(client, ctx, type="feature", key="guided-setup")
    resp = await client.post(
        f"{B}/entities",
        json={"type": "goal", "key": "under-feature", "parent_id": feature["id"]},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422 and "parent" in resp.text
    resp = await client.post(
        f"{B}/entities",
        json={"type": "feature", "key": "child-feature", "parent_id": parent["id"]},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422 and "parent" in resp.text


# protects=the API refuses cycles: itself, its own subgoal, and a second level; fails_when=
# a goal ends up its own ancestor or a tree two levels deep; no_claim=the UI's choices.
async def test_cycles_and_second_levels_are_refused(client, ctx):
    a = await _goal(client, ctx, "activation")
    b = await _goal(client, ctx, "activation-setup", a)
    c = await _goal(client, ctx, "retention")
    assert (await _patch(client, ctx, a, parent_id=a["id"])).status_code == 422
    resp = await _patch(client, ctx, a, parent_id=b["id"])
    assert resp.status_code == 422 and "cycle" in resp.text
    # b is a subgoal: nothing goes under it (one level).
    assert (await _patch(client, ctx, c, parent_id=b["id"])).status_code == 422
    # a has subgoals: it cannot become one.
    assert (await _patch(client, ctx, a, parent_id=c["id"])).status_code == 422
    assert (await _get(client, ctx, a))["parent_id"] is None


# protects=move a subgoal to another parent and promote it to a goal; fails_when=the move
# does not stick or null does not clear the parent; no_claim=archive (status, below).
async def test_move_and_promote(client, ctx):
    a = await _goal(client, ctx, "activation")
    b = await _goal(client, ctx, "retention")
    sub = await _goal(client, ctx, "activation-setup", a)
    resp = await _patch(client, ctx, sub, parent_id=b["id"])
    assert resp.status_code == 200, resp.text
    assert resp.json()["entity"]["parent_id"] == b["id"]
    resp = await _patch(client, ctx, sub, parent_id=None)
    assert resp.status_code == 200, resp.text
    assert resp.json()["entity"]["parent_id"] is None
    # A title edit leaves the parent alone.
    await _patch(client, ctx, sub, parent_id=a["id"])
    resp = await _patch(client, ctx, sub, title="Setup finished")
    assert resp.json()["entity"]["parent_id"] == a["id"]
    # Viewers and commenters cannot move one.
    assert (await _patch(client, ctx, sub, "commenter", parent_id=None)).status_code == 403


# protects=an archived goal is not offered a new subgoal; fails_when=a subgoal is created
# under, or moved under, an archived goal; no_claim=what happens to subgoals already under
# a goal when it is archived (they stand as goals in the web tree).
async def test_archived_goal_is_refused_as_a_parent(client, ctx):
    archived = await _goal(client, ctx, "old-activation")
    resp = await client.post(
        f"{B}/entities/{archived['id']}/reject",
        json={"reason": "Replaced."},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        f"{B}/entities",
        json={"type": "goal", "key": "old-setup", "title": "Setup", "parent_id": archived["id"]},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 422 and "archived" in resp.text
    other = await _goal(client, ctx, "retention")
    resp = await _patch(client, ctx, other, parent_id=archived["id"])
    assert resp.status_code == 422 and "archived" in resp.text
    assert (await _get(client, ctx, other))["parent_id"] is None


# --- roll-up ------------------------------------------------------------------------------


# protects=a goal's own progress from start, current and target, either direction;
# fails_when=the fraction is off, unclamped or ignores the direction; no_claim=roll-up.
def test_own_progress():
    assert own_progress(_typed(current=30, current_as_of="2026-10-01")) == pytest.approx(0.5)
    assert own_progress(_typed(current=60, current_as_of="2026-10-01")) == 1.0
    assert own_progress(_typed(current=5, current_as_of="2026-10-01")) == 0.0
    down = _typed(comparison="at_most", start=20, target=10, current=12,
                  current_as_of="2026-10-01")  # fmt: skip
    assert own_progress(down) == pytest.approx(0.8)
    no_start = _typed(start=None, current=25, current_as_of="2026-10-01")
    assert own_progress(no_start) == pytest.approx(0.5)
    assert own_progress(_typed()) is None
    assert own_progress({"current": 3, "current_as_of": "2026-10-01"}) is None


# protects=the roll-up rule: own measurement first, else subgoals weighted by their weight
# (1 when unset), rejected subgoals left out; fails_when=a parent with a value reads its
# subgoals, the weights are ignored, or an archived subgoal counts; no_claim=the API shape.
def test_rollup_math():
    half = _typed(current=30, current_as_of="2026-10-01", weight=3)
    full = _typed(current=50, current_as_of="2026-10-01")
    out = rollup({}, [(half, "confirmed"), (full, "proposed")])
    assert out == {"value": pytest.approx((3 * 0.5 + 1 * 1.0) / 4), "source": "subgoals",
                   "subgoals": 2}  # fmt: skip
    own = rollup(_typed(current=20, current_as_of="2026-10-01"), [(full, "confirmed")])
    assert own == {"value": pytest.approx(0.25), "source": "own", "subgoals": 1}
    assert rollup({}, [(full, "rejected")]) == {"value": None, "source": None, "subgoals": 0}
    unmeasured = rollup({}, [(_typed(), "confirmed"), (half, "confirmed")])
    assert unmeasured == {"value": pytest.approx(0.5), "source": "subgoals", "subgoals": 2}


# protects=a parent's card reads its roll-up from the API, and measuring a subgoal moves
# it; fails_when=progress is missing, or a subgoal's measurement does not reach the parent;
# no_claim=the web's wording.
async def test_parent_rolls_up_through_the_api(client, ctx):
    parent = await _goal(client, ctx, "activation")
    s1 = await _goal(client, ctx, "activation-setup", parent, **_typed(weight=3))
    await _goal(client, ctx, "activation-invites", parent, **_typed())
    assert (await _get(client, ctx, parent))["progress"] == {
        "value": None,
        "source": None,
        "subgoals": 2,
    }
    resp = await client.post(
        f"{B}/entities/{s1['id']}/measurements",
        json={"value": 30, "measured_on": "2026-10-10"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    listed = await client.get(f"{B}/entities?type=goal", headers=ctx.as_("viewer"))
    by_key = {g["key"]: g for g in listed.json()}
    assert by_key["activation"]["progress"]["source"] == "subgoals"
    assert by_key["activation"]["progress"]["value"] == pytest.approx(0.5)
    assert by_key["activation-setup"]["progress"] == {
        "value": pytest.approx(0.5),
        "source": "own",
        "subgoals": 0,
    }


# protects=a goal's progress is served through its schema; fails_when=each goal listed
# logs a Pydantic serializer warning (progress handed over as a bare dict); no_claim=the
# roll-up maths (above).
async def test_progress_is_served_through_its_schema(client, ctx):
    parent = await _goal(client, ctx, "activation")
    await _goal(client, ctx, "activation-setup", parent, **_typed())
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        listed = await client.get(f"{B}/entities?type=goal", headers=ctx.as_("viewer"))
        one = await _get(client, ctx, parent)
    assert listed.status_code == 200, listed.text
    assert one["progress"]["subgoals"] == 1
    assert not [w for w in caught if "serializ" in str(w.message).lower()]


# --- scoring ---------------------------------------------------------------------------


# protects=a feature linked to a subgoal is credited to the parent: its term carries the
# parent's weight times the subgoal's share among its confirmed siblings, and names the
# parent; fails_when=a subgoal link scores nothing, scores the subgoal's own weight as a
# second top goal, or forgets the parent; no_claim=other methods.
async def test_scoring_credits_the_parent_through_the_subgoal(client, ctx):
    parent = await _goal(client, ctx, "activation", **{"weight": 4})
    s1 = await _goal(client, ctx, "activation-setup", parent, weight=3)
    s2 = await _goal(client, ctx, "activation-invites", parent, weight=1)
    for g in (parent, s1, s2):
        await confirm(client, ctx, g)
    feat = await entity(client, ctx, type="feature", key="guided-setup", attrs={"effort": 1})
    await edge(client, ctx, feat, s1, "supports", attrs={"contribution": 2})
    resp = await client.get("/v1/priorities", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    row = next(r for r in resp.json()["features"] if r["key"] == "guided-setup")
    assert "no_confirmed_goal" not in row["flags"]
    [term] = row["explanation"]["goals"]
    assert term["goal"] == "activation-setup"
    assert term["parent"] == "activation"
    # 4 x 3/4 = 3, times contribution 2.
    assert term["weight"] == pytest.approx(3)
    assert term["term"] == pytest.approx(6)
