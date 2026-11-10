"""milestone-kinds (owner): every roadmap milestone is one of six kinds (sub_goal, goal,
delivery, decision, outside, handoff) with a status (on_track, at_risk, hit, missed).
Against Postgres; the company's clock is fixed to Mon Nov 2, 2026.

Test cards (protects / fails_when):

- test_each_kind_round_trips: every kind's fields are written on create and patch and read
  back on the roadmap (a sub-goal names its goal, the goal lists its sub-goals, a hand-off
  names its tracks); fails_when=a field is lost or misread.
- test_status_from_items_measure_and_date: on_track, at_risk (an item ends after the
  date), hit (the measure reached its target), missed (the date passed short of it), each
  with a short reason, dates month first; fails_when=a status or reason is wrong.
- test_a_person_sets_and_clears_the_status: an override wins with its reason and who set
  it; null clears it; fails_when=it does not win or does not clear.
- test_a_proposal_carries_kind_and_tracks: a non-decider's proposal carrying kind, from and
  to tracks is accepted by the decider and written; fails_when=a field is dropped.
- test_a_goal_target_shows_and_hides_with_on_roadmap: a goal with a target date shows as a
  goal milestone, and on_roadmap false (the goal edit) takes it off; fails_when=it does not.
- test_codes_unique_and_by_date_with_goal_targets: codes stay one per milestone, by date;
  fails_when=a code repeats or goes out of date order.
- test_a_milestone_has_its_own_track: the panel's Track (tb-mk fidelity, the pick's Track field)
  is written on create and patch, read back with its name, cleared by null, and an unknown
  track is a 422; fails_when=the track is lost, misnamed or not cleared.
- test_tracks_served_in_order_with_health: the read's track bands, in the Tracks order,
  each with its health and reason; fails_when=order, health or reason is wrong.
"""

import uuid
from datetime import UTC, date, datetime

import pytest

from oracle import company_time
from oracle.simple.goal_milestones import status_of
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_goal_milestones_api import CHANGES, MILESTONES, ROADMAP
from tests.test_simple_roadmap_api import NOW, Seed

GOALS = "/v1/simple/goal-buckets/goals"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed(ctx: Ctx, due: str | None = None) -> dict:
    """A roadmap with two tracks (Checkout, then Search) and two items: one ending Nov 20 on
    Checkout, one ending Dec 4 on Search; a goal (with a target date when ``due``)."""
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        _, pv, rm, rv = await sd.roadmap("launch")
        prd2, pv2, _, _ = await sd.roadmap("search")
        attrs = {"metric": "Teams set up", "target": 10, "unit": "teams"}
        if due:
            attrs["due"] = due
        goal = await sd.entity("goal", "activation", **attrs)
        # Tracks read oldest first; one transaction would give both the same created_at.
        checkout = await sd.track(pv, rm, title="Checkout", goal_id=goal.id,
                                  monitored_at=datetime(2026, 10, 15, 18, tzinfo=UTC),
                                  created_at=datetime(2026, 10, 1, tzinfo=UTC))  # fmt: skip
        search = await sd.track(pv2, rm, title="Search", monitored_at=NOW,
                                created_at=datetime(2026, 10, 2, tzinfo=UTC))  # fmt: skip
        early = await sd.item(rv, pv, "f-01", title="Saved carts", track_id=checkout.id,
                              start_date=date(2026, 11, 2), end_date=date(2026, 11, 20),
                              date_source="typed")  # fmt: skip
        late = await sd.item(rv, pv, "f-02", title="Quick search", track_id=search.id,
                             start_date=date(2026, 11, 2), end_date=date(2026, 12, 4),
                             date_source="typed", position=1)  # fmt: skip
        await s.commit()
        return {"roadmap_id": str(rm.id), "goal_id": str(goal.id), "checkout": str(checkout.id),
                "search": str(search.id), "early": str(early.id), "late": str(late.id),
                "prd2": str(prd2.id)}  # fmt: skip


async def read(client, ctx: Ctx, role: str = "owner") -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


def by_id(body: dict) -> dict[str, dict]:
    return {m["id"]: m for m in body["goal_milestones"]}


async def make(client, ctx: Ctx, ids: dict, **kw) -> dict:
    body = {"roadmap_id": ids["roadmap_id"], "name": "Prove it", "date": "2026-11-27",
            "goal_id": ids["goal_id"], **kw}  # fmt: skip
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    return r.json()


async def test_each_kind_round_trips(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    goal = await make(client, ctx, ids, name="Activation doubles", kind="goal",
                      measure="Teams set up", baseline=5, target=10, current=6,
                      done_when_line="Ten teams finish setup")  # fmt: skip
    assert (goal["kind"], goal["measure"], goal["baseline"], goal["target"], goal["current"]) == (
        "goal", "Teams set up", 5.0, 10.0, 6.0)  # fmt: skip
    assert goal["done_when_line"] == "Ten teams finish setup"
    sub = await make(client, ctx, ids, name="Eight teams", kind="sub_goal",
                     sub_goal_of_id=goal["id"], measure="Teams set up", target=8)  # fmt: skip
    assert sub["sub_goal_of_id"] == goal["id"]
    hand = await make(client, ctx, ids, name="Search takes over", kind="handoff",
                      from_track_id=ids["checkout"], to_track_id=ids["search"])  # fmt: skip
    assert (hand["from_track_name"], hand["to_track_name"]) == ("Checkout", "Search")
    for kind in ("delivery", "decision", "outside"):
        m = await make(client, ctx, ids, name=f"A {kind}", kind=kind)
        assert m["kind"] == kind
    plain = await make(client, ctx, ids, name="No kind given")
    assert (plain["kind"], plain["done_when_line"]) == ("delivery", "")
    r = await client.post(MILESTONES, json={"roadmap_id": ids["roadmap_id"], "name": "Bad",
                          "date": "2026-11-27", "kind": "party"},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 422, r.text
    edit = {"kind": "decision", "done_when_line": "We pick a vendor"}
    r = await client.patch(f"{MILESTONES}/{plain['id']}", headers=ctx.as_("owner"), json=edit)
    assert r.status_code == 200, r.text
    assert (r.json()["kind"], r.json()["done_when_line"]) == ("decision", "We pick a vendor")
    r = await client.patch(f"{MILESTONES}/{hand['id']}", headers=ctx.as_("owner"),
                           json={"from_track_id": ids["search"], "to_track_id": None})  # fmt: skip
    assert r.status_code == 200, r.text
    assert (r.json()["from_track_name"], r.json()["to_track_id"]) == ("Search", None)
    listed = by_id(await read(client, ctx))
    assert listed[goal["id"]]["sub_goal_ids"] == [sub["id"]]
    assert listed[sub["id"]]["sub_goal_of_id"] == goal["id"]
    assert listed[plain["id"]]["kind"] == "decision"
    assert listed[hand["id"]]["from_track_id"] == ids["search"]
    assert listed[goal["id"]]["baseline"] == 5.0
    kd = await read(client, ctx)
    assert all(k["kind"] == "delivery" and k["status"] == "on_track" for k in kd["key_dates"])


async def test_status_from_items_measure_and_date(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    ok = await make(client, ctx, ids, name="Carts ready", item_ids=[ids["early"]])
    late = await make(client, ctx, ids, name="Search ready", item_ids=[ids["late"]])
    hit = await make(client, ctx, ids, name="Eight teams", kind="sub_goal", baseline=2,
                     target=8, current=9, date="2026-12-18")  # fmt: skip
    missed = await make(client, ctx, ids, name="Five teams", kind="sub_goal", baseline=2,
                        target=5, current=3, date="2026-10-30")  # fmt: skip
    got = by_id(await read(client, ctx))
    assert got[ok["id"]]["status"] == "on_track"
    assert got[ok["id"]]["status_reason"]
    assert got[late["id"]]["status"] == "at_risk"
    assert got[late["id"]]["status_reason"] == "Quick search ends Dec 4, after its date Nov 27"
    assert got[hit["id"]]["status"] == "hit"
    assert "9" in got[hit["id"]]["status_reason"] and "8" in got[hit["id"]]["status_reason"]
    assert got[missed["id"]]["status"] == "missed"
    # Pure: a falling measure is hit at or below its target.
    s, _ = status_of("goal", date(2026, 12, 1), None, None, None, 10, 4, 3, [], date(2026, 11, 2))
    assert s == "hit"
    s, _ = status_of("delivery", date(2026, 10, 1), None, None, None, None, None, None, [],
                     date(2026, 11, 2))  # fmt: skip
    assert s == "on_track"


async def test_a_person_sets_and_clears_the_status(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    m = await make(client, ctx, ids, name="Carts ready", item_ids=[ids["early"]])
    url = f"{MILESTONES}/{m['id']}"
    r = await client.patch(url, json={"status_set": "at_risk", "status_reason": "Vendor slips"},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    got = by_id(await read(client, ctx))[m["id"]]
    assert (got["status"], got["status_set"], got["status_reason"]) == (
        "at_risk", "at_risk", "Vendor slips")  # fmt: skip
    assert got["status_set_by_name"]
    r = await client.patch(url, json={"status_set": "missed", "status_reason": None},
                           headers=ctx.as_("owner"))  # fmt: skip
    got = by_id(await read(client, ctx))[m["id"]]
    assert got["status_reason"] == f"Set by {got['status_set_by_name']}"
    r = await client.patch(url, json={"status_set": None}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    got = by_id(await read(client, ctx))[m["id"]]
    assert (got["status"], got["status_set"], got["status_set_by_name"]) == (
        "on_track", None, None)  # fmt: skip


async def test_a_proposal_carries_kind_and_tracks(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    m = await make(client, ctx, ids, name="Search takes over")
    seen = {k: m[k] for k in ("name", "date", "goal_id", "item_ids", "counts_when")}
    ask = {"op": "edit_goal_milestone", "target": {"milestone_id": m["id"]},
           "before": {"milestone": seen},
           "after": {"milestone": {**seen, "kind": "handoff", "from_track_id": ids["checkout"],
                                   "to_track_id": ids["search"],
                                   "done_when_line": "Search owns the queue"}}}  # fmt: skip
    r = await client.post(CHANGES, json=ask, headers=ctx.as_("approver"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    assert by_id(await read(client, ctx))[m["id"]]["kind"] == "delivery"
    r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    got = by_id(await read(client, ctx))[m["id"]]
    assert (got["kind"], got["from_track_name"], got["to_track_name"], got["done_when_line"]) == (
        "handoff", "Checkout", "Search", "Search owns the queue")  # fmt: skip


def targets(body: dict) -> list[dict]:
    return [m for m in body["goal_milestones"] if m["goal_target"]]


async def test_a_goal_target_shows_and_hides_with_on_roadmap(client):
    ctx = await make_ctx()
    ids = await seed(ctx, due="2026-12-15")
    [g] = targets(await read(client, ctx))
    assert (g["id"], g["goal_id"], g["kind"], g["date"], g["name"]) == (
        ids["goal_id"], ids["goal_id"], "goal", "2026-12-15", "Activation")  # fmt: skip
    assert (g["can_change"], g["measure"], g["target"]) == (False, "Teams set up", 10.0)
    body = {"title": "Activation", "measure": "Teams set up", "target": "10 teams",
            "due": "2026-12-15", "on_roadmap": False}  # fmt: skip
    r = await client.patch(f"{GOALS}/{ids['goal_id']}", json=body, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["goal"]["on_roadmap"] is False
    assert targets(await read(client, ctx)) == []
    r = await client.get("/v1/simple/goal-buckets", headers=ctx.as_("owner"))
    assert [x["on_roadmap"] for x in r.json()["goals"]] == [False]
    r = await client.patch(f"{GOALS}/{ids['goal_id']}", json={**body, "on_roadmap": True},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert len(targets(await read(client, ctx))) == 1
    # Left out, on_roadmap stays as it was.
    del body["on_roadmap"]
    r = await client.patch(f"{GOALS}/{ids['goal_id']}", json=body, headers=ctx.as_("owner"))
    assert r.json()["goal"]["on_roadmap"] is True


async def test_codes_unique_and_by_date_with_goal_targets(client):
    ctx = await make_ctx()
    ids = await seed(ctx, due="2026-12-15")
    first = await make(client, ctx, ids, name="Carts ready", date="2026-11-27")
    last = await make(client, ctx, ids, name="Search ready", date="2027-01-08")
    body = await read(client, ctx)
    codes = {m["id"]: m["roadmap_code"] for m in body["goal_milestones"]}
    assert codes[first["id"]] == "M1"
    assert codes[ids["goal_id"]] == "M2"
    assert codes[last["id"]] == "M3"
    assert len(set(codes.values())) == len(codes)
    again = {m["id"]: m["roadmap_code"] for m in (await read(client, ctx))["goal_milestones"]}
    assert again == codes


async def test_tracks_served_in_order_with_health(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    await make(client, ctx, ids, name="Search ready", date="2026-11-27", item_ids=[ids["late"]])
    body = await read(client, ctx)
    tracks = body["tracks"]
    assert [t["title"] for t in tracks] == ["Checkout", "Search"]
    checkout, search = tracks
    assert (checkout["goal_id"], checkout["goal_name"]) == (ids["goal_id"], "Activation")
    assert checkout["prds"] and checkout["prds"][0]["title"]
    assert (checkout["health"], checkout["health_reason"]) == ("stale", "Not checked since Oct 15")
    code = next(m["roadmap_code"] for m in body["goal_milestones"] if m["name"] == "Search ready")
    assert search["health"] == "at_risk"
    assert search["health_reason"] == (
        f"At risk: Quick search ends Dec 4, after {code} Search ready on Nov 27"
    )
    uuid.UUID(search["id"])


async def test_a_milestone_has_its_own_track(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    m = await make(client, ctx, ids, name="Checkout beta", track_id=ids["checkout"])
    assert (m["track_id"], m["track_name"]) == (ids["checkout"], "Checkout")
    r = await client.patch(f"{MILESTONES}/{m['id']}", headers=ctx.as_("owner"),
                           json={"track_id": ids["search"]})  # fmt: skip
    assert r.status_code == 200, r.text
    assert (r.json()["track_id"], r.json()["track_name"]) == (ids["search"], "Search")
    assert by_id(await read(client, ctx))[m["id"]]["track_name"] == "Search"
    r = await client.patch(f"{MILESTONES}/{m['id']}", headers=ctx.as_("owner"),
                           json={"track_id": None})  # fmt: skip
    assert r.status_code == 200, r.text
    assert (r.json()["track_id"], r.json()["track_name"]) == (None, None)
    r = await client.patch(f"{MILESTONES}/{m['id']}", headers=ctx.as_("owner"),
                           json={"track_id": str(uuid.uuid4())})  # fmt: skip
    assert r.status_code == 422, r.text
