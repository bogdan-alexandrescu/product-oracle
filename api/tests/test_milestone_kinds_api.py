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
- test_a_falling_goal_reads_its_start_and_direction: a company goal's target milestone reads
  the goal's ``start`` as its baseline and its ``comparison`` as its direction (at most:
  lower is better); fails_when=a falling goal above its target reads hit, or the start is lost.
- test_a_measured_milestone_with_no_reading_past_its_date_is_missed: no reading by its date
  is missed, "No reading came in by its date."; fails_when=it reads on track.
- test_numbers_fit_the_column: a baseline, target or current of 1e20, NaN or infinity is a
  422 (on create, patch and in a proposal); fails_when=it is stored or a 500.
- test_refs_checked_on_create_patch_and_proposal: a sub-goal of itself, of a non-goal or of
  a missing milestone, a hand-off from a track to itself, and a missing home, from or to
  track are 422 on create, patch and a proposal; a proposal whose refs went bad meanwhile
  is refused on accept (422, not a 500); fails_when=any is stored or a 500.
- test_a_goal_is_not_its_own_sub_goal: a goal milestone set as its own sub_goal_of_id is a
  422 (the goal-kind check alone lets it through); fails_when=the self guard goes.
- test_a_sub_goal_shares_its_goals_roadmap: a sub-goal on another roadmap than its goal
  milestone is a 422 on create and patch; fails_when=it is stored.
- test_a_goal_with_sub_goals_keeps_its_kind: a goal milestone sub-goals build toward cannot
  change kind (422 naming them) until none does; fails_when=the kind changes under them.
- test_a_history_track_is_no_milestone_track: a replaced PRD's track (history) is a 422 as a
  home, from or to track; fails_when=it is stored.
- test_goals_read_once_per_roadmap_read: one roadmap read selects the company's goals from
  entities once; fails_when=a part of the read reads them again.
- test_tracks_served_in_order_with_health: the read's track bands, in the Tracks order,
  each with its health and reason; fails_when=order, health or reason is wrong.
"""

import json
import math
import uuid
from datetime import UTC, date, datetime

import pytest

from oracle import company_time
from oracle.docs.models import Document
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
        prd2, pv2, rm2, _ = await sd.roadmap("search")
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
                "prd2": str(prd2.id), "roadmap2": str(rm2.id)}  # fmt: skip


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
    # milestone-rename: its name is the roadmap decider's to change (the rest is the goal's).
    assert (g["can_change"], g["measure"], g["target"]) == (True, "Teams set up", 10.0)
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
    m = await make(client, ctx, ids, name="Checkout beta", home_track_id=ids["checkout"])
    assert (m["home_track_id"], m["home_track_name"]) == (ids["checkout"], "Checkout")
    r = await client.patch(f"{MILESTONES}/{m['id']}", headers=ctx.as_("owner"),
                           json={"home_track_id": ids["search"]})  # fmt: skip
    assert r.status_code == 200, r.text
    assert (r.json()["home_track_id"], r.json()["home_track_name"]) == (ids["search"], "Search")
    assert by_id(await read(client, ctx))[m["id"]]["home_track_name"] == "Search"
    r = await client.patch(f"{MILESTONES}/{m['id']}", headers=ctx.as_("owner"),
                           json={"home_track_id": None})  # fmt: skip
    assert r.status_code == 200, r.text
    assert (r.json()["home_track_id"], r.json()["home_track_name"]) == (None, None)
    r = await client.patch(f"{MILESTONES}/{m['id']}", headers=ctx.as_("owner"),
                           json={"home_track_id": str(uuid.uuid4())})  # fmt: skip
    assert r.status_code == 422, r.text


async def test_a_falling_goal_reads_its_start_and_direction(client):
    ctx = await make_ctx()
    ids = await seed(ctx, due="2026-12-15")
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.baseline.models import Entity

        g = await s.get(Entity, uuid.UUID(ids["goal_id"]))
        g.attrs = {**g.attrs, "metric": "Refunds", "unit": "%", "comparison": "at_most",
                   "start": 9, "current": 8, "target": 5}  # fmt: skip
        await s.commit()
    [m] = targets(await read(client, ctx))
    assert (m["baseline"], m["target"], m["current"]) == (9.0, 5.0, 8.0)
    assert m["status"] == "on_track", m["status_reason"]
    async with tenant_session(ctx.tenant_id) as s:
        g = await s.get(Entity, uuid.UUID(ids["goal_id"]))
        g.attrs = {**g.attrs, "current": 4}
        await s.commit()
    [m] = targets(await read(client, ctx))
    assert m["status"] == "hit", m["status_reason"]
    # Pure: the direction given wins over the numbers' order.
    s_, _ = status_of("goal", date(2026, 12, 1), None, None, None, 9, 5, 8, [],
                      date(2026, 11, 2), down=True)  # fmt: skip
    assert s_ == "on_track"
    s_, _ = status_of("goal", date(2026, 12, 1), None, None, None, 9, 5, 4, [],
                      date(2026, 11, 2), down=True)  # fmt: skip
    assert s_ == "hit"


async def test_a_measured_milestone_with_no_reading_past_its_date_is_missed(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    m = await make(client, ctx, ids, name="Five teams", kind="sub_goal", baseline=2, target=5,
                   date="2026-10-30")  # fmt: skip
    got = by_id(await read(client, ctx))[m["id"]]
    assert (got["status"], got["status_reason"]) == ("missed", "No reading came in by its date.")
    later = await make(client, ctx, ids, name="Six teams", kind="sub_goal", target=6,
                       date="2026-12-30")  # fmt: skip
    assert by_id(await read(client, ctx))[later["id"]]["status"] == "on_track"


async def send(client, ctx: Ctx, method: str, url: str, role: str, body: dict):
    """JSON as sent, NaN and Infinity as their literals (json.dumps writes them)."""
    headers = {**ctx.as_(role), "content-type": "application/json"}
    return await client.request(method, url, content=json.dumps(body), headers=headers)


@pytest.mark.parametrize("bad", [1e20, -1e20, 1e14, math.nan, math.inf, -math.inf])
async def test_numbers_fit_the_column(client, bad):
    ctx = await make_ctx()
    ids = await seed(ctx)
    for k in ("baseline", "target", "current"):
        body = {"roadmap_id": ids["roadmap_id"], "name": "Big", "date": "2026-11-27",
                "kind": "goal", k: bad}  # fmt: skip
        r = await send(client, ctx, "POST", MILESTONES, "owner", body)
        assert r.status_code == 422, r.text
    m = await make(client, ctx, ids, name="Fits", kind="goal", target=99999999999999.5)
    assert m["target"] == 99999999999999.5
    r = await send(client, ctx, "PATCH", f"{MILESTONES}/{m['id']}", "owner", {"current": bad})
    assert r.status_code == 422, r.text
    seen = {k: m[k] for k in ("name", "date", "goal_id", "item_ids", "counts_when")}
    ask = {"op": "edit_goal_milestone", "target": {"milestone_id": m["id"]},
           "before": {"milestone": seen},
           "after": {"milestone": {**seen, "current": bad}}}  # fmt: skip
    r = await send(client, ctx, "POST", CHANGES, "approver", ask)
    assert r.status_code == 422, r.text


async def test_refs_checked_on_create_patch_and_proposal(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    goal = await make(client, ctx, ids, name="Activation doubles", kind="goal")
    plain = await make(client, ctx, ids, name="Carts ready")
    nobody = str(uuid.uuid4())
    bad = [
        {"kind": "sub_goal", "sub_goal_of_id": nobody},
        {"kind": "sub_goal", "sub_goal_of_id": plain["id"]},
        {"kind": "handoff", "from_track_id": ids["checkout"], "to_track_id": ids["checkout"]},
        {"kind": "handoff", "from_track_id": nobody},
        {"kind": "handoff", "to_track_id": nobody},
        {"home_track_id": nobody},
    ]
    for kw in bad:
        body = {"roadmap_id": ids["roadmap_id"], "name": "Bad", "date": "2026-11-27", **kw}
        r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
        assert r.status_code == 422, (kw, r.text)
    sub = await make(client, ctx, ids, name="Eight teams", kind="sub_goal",
                     sub_goal_of_id=goal["id"])  # fmt: skip
    hand = await make(client, ctx, ids, name="Search takes over", kind="handoff",
                      from_track_id=ids["checkout"])  # fmt: skip
    for mid, kw in ((sub["id"], {"sub_goal_of_id": sub["id"]}),
                    (sub["id"], {"sub_goal_of_id": plain["id"]}),
                    (hand["id"], {"to_track_id": ids["checkout"]}),
                    (hand["id"], {"home_track_id": nobody})):  # fmt: skip
        r = await client.patch(f"{MILESTONES}/{mid}", json=kw, headers=ctx.as_("owner"))
        assert r.status_code == 422, (kw, r.text)
    # A proposal (by who may not change it directly) is checked as it is made.
    seen = {k: plain[k] for k in ("name", "date", "goal_id", "item_ids", "counts_when")}
    for kw in bad:
        ask = {"op": "edit_goal_milestone", "target": {"milestone_id": plain["id"]},
               "before": {"milestone": seen}, "after": {"milestone": {**seen, **kw}}}  # fmt: skip
        r = await client.post(CHANGES, json=ask, headers=ctx.as_("approver"))
        assert r.status_code == 422, (kw, r.text)
    # A proposal whose goal milestone is removed meanwhile is refused on accept, not a 500.
    ask = {"op": "edit_goal_milestone", "target": {"milestone_id": plain["id"]},
           "before": {"milestone": seen},
           "after": {"milestone": {**seen, "kind": "sub_goal",
                                   "sub_goal_of_id": goal["id"]}}}  # fmt: skip
    r = await client.post(CHANGES, json=ask, headers=ctx.as_("approver"))
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    r = await client.delete(f"{MILESTONES}/{goal['id']}", headers=ctx.as_("owner"))
    assert r.status_code in (200, 204), r.text
    r = await client.post(f"{CHANGES}/{c['id']}/accept", headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    assert by_id(await read(client, ctx))[plain["id"]]["kind"] == "delivery"


async def test_a_goal_is_not_its_own_sub_goal(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    goal = await make(client, ctx, ids, name="Activation doubles", kind="goal")
    for kw in ({"sub_goal_of_id": goal["id"]}, {"kind": "sub_goal", "sub_goal_of_id": goal["id"]}):
        r = await client.patch(f"{MILESTONES}/{goal['id']}", json=kw, headers=ctx.as_("owner"))
        assert r.status_code == 422, (kw, r.text)
        assert "another milestone" in r.text
    assert by_id(await read(client, ctx))[goal["id"]]["sub_goal_of_id"] is None


async def test_a_sub_goal_shares_its_goals_roadmap(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    goal = await make(client, ctx, ids, name="Activation doubles", kind="goal")
    other = {**ids, "roadmap_id": ids["roadmap2"]}
    body = {"roadmap_id": ids["roadmap2"], "name": "Eight teams", "date": "2026-11-27",
            "kind": "sub_goal", "sub_goal_of_id": goal["id"]}  # fmt: skip
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    assert "same roadmap" in r.text
    there = await make(client, ctx, other, name="Eight teams", kind="sub_goal")
    r = await client.patch(f"{MILESTONES}/{there['id']}", headers=ctx.as_("owner"),
                           json={"sub_goal_of_id": goal["id"]})  # fmt: skip
    assert r.status_code == 422, r.text
    assert "same roadmap" in r.text
    here = await make(client, ctx, ids, name="Nine teams", kind="sub_goal",
                      sub_goal_of_id=goal["id"])  # fmt: skip
    assert here["sub_goal_of_id"] == goal["id"]


async def test_a_goal_with_sub_goals_keeps_its_kind(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    goal = await make(client, ctx, ids, name="Activation doubles", kind="goal")
    sub = await make(client, ctx, ids, name="Eight teams", kind="sub_goal",
                     sub_goal_of_id=goal["id"])  # fmt: skip
    r = await client.patch(f"{MILESTONES}/{goal['id']}", json={"kind": "delivery"},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 422, r.text
    assert "Eight teams" in r.text
    assert by_id(await read(client, ctx))[goal["id"]]["kind"] == "goal"
    # Still a goal: a write of the same kind, or of anything else, goes through.
    r = await client.patch(f"{MILESTONES}/{goal['id']}", json={"kind": "goal", "name": "Doubled"},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.patch(f"{MILESTONES}/{sub['id']}", json={"sub_goal_of_id": None},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.patch(f"{MILESTONES}/{goal['id']}", json={"kind": "delivery"},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text


async def test_a_history_track_is_no_milestone_track(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        rm = await s.get(Document, uuid.UUID(ids["roadmap_id"]))
        new = await sd.doc("ledger-prd")
        old = await sd.doc("old-ledger-prd")
        old.replaced_by = [new.id]
        past = await sd.track(await sd.version(old), rm, title="Old ledger")
        await s.commit()
        past_id = str(past.id)
    search = ids["search"]
    for kw in ({"home_track_id": past_id},
               {"kind": "handoff", "from_track_id": past_id, "to_track_id": search},
               {"kind": "handoff", "from_track_id": search, "to_track_id": past_id}):  # fmt: skip
        body = {"roadmap_id": ids["roadmap_id"], "name": "Bad", "date": "2026-11-27", **kw}
        r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
        assert r.status_code == 422, (kw, r.text)
        assert "replaced PRD" in r.text, r.text
    m = await make(client, ctx, ids, name="Checkout beta", home_track_id=ids["checkout"])
    r = await client.patch(f"{MILESTONES}/{m['id']}", json={"home_track_id": past_id},
                           headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 422, r.text


async def test_goals_read_once_per_roadmap_read(client):
    from sqlalchemy import event

    from oracle.db import get_engine

    ctx = await make_ctx()
    ids = await seed(ctx, due="2026-12-18")
    goal = await make(client, ctx, ids, name="Activation doubles", kind="goal")
    await make(client, ctx, ids, name="Eight teams", kind="sub_goal", sub_goal_of_id=goal["id"])
    await read(client, ctx)  # warm: the first read may seed what later reads find
    seen: list[str] = []

    def count(conn, cursor, statement, params, context, executemany) -> None:
        # A read of goals: a select on entities for type goal, or of entities by id alone
        # (the goals a part of the read already had).
        s = " ".join(statement.split()).lower()
        if not s.startswith("select") or "entities" not in s:
            return
        where = s.split(" where ", 1)[-1]
        by_id = " from entities where " in s and "entities.type" not in where
        if "goal" in (params or ()) or by_id:
            seen.append(f"{s.split(' from ', 1)[1]} {params!r}")

    engine = get_engine().sync_engine
    event.listen(engine, "before_cursor_execute", count)
    try:
        body = await read(client, ctx)
    finally:
        event.remove(engine, "before_cursor_execute", count)
    assert any(m["goal_target"] for m in body["goal_milestones"])
    assert len(seen) == 1, "\n".join(seen)
