"""Simple Goal map (build-goal-map): ``GET /v1/simple/goal-map`` and its edits, against
Postgres. The world: three goals that build on each other (sign-ups -> paid conversions ->
revenue) with daily readings, a guardrail (complaints = 0), two areas in the owner's order,
three gated goal milestones on one roadmap (the same track_milestones records Simple
Roadmap draws) and two features linked to them, one serving two milestones. The company's clock is
Tue Nov 3, 2026. Invented example data only.

Test cards (protects / fails_when / no_claim):

- test_map_reads_goals_guardrail_areas_milestones_features (parametrized owner, approver,
  commenter, viewer): protects=every role reads the goals with today's reading, target,
  status and history, the guardrail with its 7 days, the areas in order, each gate's
  threshold, reading, 7 days, who confirmed it and its status, and each feature's links
  with expected and measured lift; fails_when=a field is missing or a role is refused;
  no_claim=the web's drawing (Playwright's simple-goal-map specs).
- test_milestone_status_follows_its_gate: protects=met when 7 days hold the threshold,
  missed when due before today and not met, not measured yet without a reading;
  fails_when=a stored status wins over the readings; no_claim=the roadmap's own status.
- test_add_and_reorder_areas: protects=a new area goes last; the order saved is the order
  read; fails_when=the order is lost or a viewer may change it; no_claim=other views.
- test_edit_goal_keeps_history: protects=a new target is saved and the old one is kept in
  the goal's history, by whom and when; fails_when=the history is lost; no_claim=the
  goal's other fields.
- test_propose_a_milestone: protects=a proposal is a track_milestones record (no second
  table) marked proposed, with the goal, threshold, areas, what it comes after and today's
  7 days read from the goal; fails_when=it is missing, unproposed or another table;
  no_claim=its approval.
- test_attach_a_feature: protects=attaching adds a link; the feature is listed once with
  both milestones; a second attach changes nothing; fails_when=a duplicate feature or
  link; no_claim=lift measurement.
- test_a_proposal_comes_after_the_goals_previous_milestone_by_default,
  test_comes_after_is_stored_edited_and_orders_the_columns: protects=the 'Comes after'
  picked is stored, editable and orders the columns; a loop is refused;
  fails_when=it is derived or ignored; no_claim=the web's picker (Playwright).
- test_deleted_and_ungated_milestones, test_a_threshold_must_be_above_zero: protects=a
  deleted milestone is off the map, one with no threshold reads no gate, a threshold of
  0 or less is refused; fails_when='Met' or '31 of 0' for no gate; no_claim=the roadmap.
- test_edits_need_approver: protects=commenters and viewers are refused every edit (403)
  and read can_edit false; fails_when=a commenter edits; no_claim=run tokens.
- test_only_the_company_roadmap_feeds_the_map (train review): protects=while the company
  roadmap exists the map shows only its goal milestones and a new one lands on it;
  fails_when=an older roadmap's milestones show or the proposal lands on the oldest roadmap.
- test_goals_come_in_priority_order (goal-map-no-arrows): protects=the goal cards follow the
  one goal order (attrs.position), not what each goal builds on; fails_when=a goal that
  builds on another is put after it against its priority; no_claim=the web's cards.
- test_a_guardrail_goal_is_never_a_goal_card (goal-map-no-arrows): protects=a goal marked
  as a guardrail is left out of the goals and read in the guardrail strip (with its 7
  days) when no guardrail constraint is set; fails_when=it is a goal card or missing from
  the strip; no_claim=the web's strip.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import event, func, select

from oracle import company_time
from oracle.baseline.models import Entity, GoalMeasurement
from oracle.docs.models import Document
from oracle.roadmap.models import TrackMilestone
from oracle.simple import goal_map
from oracle.simple.models import FocusArea, MilestoneFeature
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import Seed

URL = "/v1/simple/goal-map"
NOW = datetime(2026, 11, 3, 17, 0, tzinfo=UTC)
TODAY = date(2026, 11, 3)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def world() -> tuple[Ctx, dict[str, str]]:
    ctx = await make_ctx()
    ids: dict[str, str] = {}
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        signups = await seed.entity(
            "goal", "signups", metric="sign-ups per rep per day", target=40, unit="",
            math="Each rep's daily sign-ups", position=1,
            target_history=[
                {"date": "Oct 30, 2026", "text": "Target 30 → 40", "by": "Ann Example"}
            ],
        )  # fmt: skip
        conv = await seed.entity(
            "goal", "conversions", metric="paid conversions per rep per day", target=10,
            unit="", math="Sign-ups per rep × conversion rate", builds_on=[str(signups.id)],
            position=2,
        )  # fmt: skip
        revenue = await seed.entity(
            "goal", "revenue", metric="revenue per day", target=20000, unit="$",
            math="Reps × conversions per rep × value", builds_on=[str(conv.id)], position=3,
        )  # fmt: skip
        guard = await seed.entity(
            "constraint", "customer-complaints", guardrail=True, rule="= 0 every day"
        )
        for i in range(7):
            on = TODAY - timedelta(days=6 - i)
            s.add(GoalMeasurement(entity_id=signups.id, measured_on=on, value=Decimal(25 + i)))
            s.add(GoalMeasurement(entity_id=conv.id, measured_on=on, value=Decimal("5.6")))
            s.add(GoalMeasurement(entity_id=guard.id, measured_on=on, value=Decimal(0)))
        scale = await seed.add(
            FocusArea(name="Scale per rep", lever="Sign-ups per rep", position=0)
        )
        onboard = await seed.add(
            FocusArea(name="Onboarding", lever="Value per conversion", position=1)
        )
        _, pv, rm, rv = await seed.roadmap("growth")
        m1 = await seed.add(
            TrackMilestone(
                roadmap_id=rm.id, code="M1", name="25 sign-ups per rep", goal_id=signups.id,
                gate_threshold=Decimal(25), gate_confirmed_by="Ann Example",
                gate_confirmed_on=date(2026, 11, 2), gate_area_ids=[scale.id],
            )
        )  # fmt: skip
        m2 = await seed.add(
            TrackMilestone(
                roadmap_id=rm.id, code="M2", name="50 sign-ups per rep", goal_id=signups.id,
                gate_threshold=Decimal(50), gate_confirmed_by="Ann Example",
                gate_confirmed_on=date(2026, 11, 2), gate_area_ids=[scale.id, onboard.id],
                after_id=m1.id,
            )
        )  # fmt: skip
        m3 = await seed.add(
            TrackMilestone(
                roadmap_id=rm.id, code="M1", name="$12k revenue per day", goal_id=revenue.id,
                gate_threshold=Decimal(12000), gate_confirmed_by="Ann Example",
                gate_confirmed_on=date(2026, 11, 2), gate_area_ids=[onboard.id],
                after_id=m2.id,
            )
        )  # fmt: skip
        f1 = await seed.item(rv, pv, "one-tap-link", title="One-tap sign-up link")
        f2 = await seed.item(rv, pv, "guided-week", title="Guided first week", position=1)
        f3 = await seed.item(rv, pv, "rep-leaderboard", title="Rep leaderboard", position=2)
        s.add(MilestoneFeature(milestone_id=m1.id, item_id=f1.id, area_id=scale.id,
                               expected="+6 a day", confidence="high", released=True,
                               measured="+8 a day", lift="helping"))  # fmt: skip
        for m in (m2, m3):
            s.add(MilestoneFeature(milestone_id=m.id, item_id=f2.id, area_id=onboard.id,
                                   expected="+$40 each", confidence="medium"))  # fmt: skip
        await s.commit()
        ids |= {
            "signups": str(signups.id), "conv": str(conv.id), "revenue": str(revenue.id),
            "scale": str(scale.id), "onboard": str(onboard.id), "m1": str(m1.id),
            "m2": str(m2.id), "m3": str(m3.id), "f1": str(f1.id), "f2": str(f2.id),
            "f3": str(f3.id), "roadmap": str(rm.id),
        }  # fmt: skip
    return ctx, ids


async def read(client, ctx: Ctx, role: str = "owner") -> dict:
    r = await client.get(URL, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize("role", ["owner", "approver", "commenter", "viewer"])
async def test_map_reads_goals_guardrail_areas_milestones_features(client, role):
    ctx, ids = await world()
    body = await read(client, ctx, role)
    goals = {g["id"]: g for g in body["goals"]}
    assert [g["id"] for g in body["goals"]] == [ids["signups"], ids["conv"], ids["revenue"]]
    su = goals[ids["signups"]]
    assert su["current"] == 31 and su["target"] == 40 and su["status"] == "on_track"
    assert su["history"][0] == {
        "date": "Oct 30, 2026",
        "text": "Target 30 → 40",
        "by": "Ann Example",
    }
    assert goals[ids["conv"]]["builds_on"] == [ids["signups"]]
    assert goals[ids["conv"]]["status"] == "at_risk"
    rev = goals[ids["revenue"]]
    assert rev["current"] is None and rev["status"] == "not_measured" and rev["unit"] == "$"
    g = body["guardrail"]
    assert g["name"] == "Customer Complaints" and g["rule"] == "= 0 every day"
    assert g["days"] == [0] * 7 and g["held"] is True and g["current"] == 0
    assert [a["name"] for a in body["areas"]] == ["Scale per rep", "Onboarding"]
    ms = {m["id"]: m for m in body["milestones"]}
    m1 = ms[ids["m1"]]
    assert m1["threshold"] == 25 and m1["current"] == 31 and m1["status"] == "met"
    assert m1["days"] == [25, 26, 27, 28, 29, 30, 31] and m1["confirmed"] == "Ann Example"
    assert m1["confirmed_on"] == "Nov 2" and m1["due"] is None
    assert m1["goal"] == ids["signups"] and m1["areas"] == [ids["scale"]]
    assert m1["measure"] == "sign-ups per rep per day" and m1["proposed"] is False
    assert ms[ids["m2"]]["depends"] == [ids["m1"]] and ms[ids["m2"]]["status"] == "at_risk"
    feats = {f["id"]: f for f in body["features"]}
    assert len(body["features"]) == 2
    f1 = feats[ids["f1"]]
    assert f1["name"] == "One-tap sign-up link" and f1["area"] == ids["scale"]
    assert f1["expected"] == "+6 a day" and f1["confidence"] == "High"
    assert f1["measured"] == "+8 a day" and f1["lift"] == "helping" and f1["released"] is True
    assert f1["lever"] == "Sign-ups per rep"
    f2 = feats[ids["f2"]]
    assert sorted(f2["milestones"]) == sorted([ids["m2"], ids["m3"]])
    assert f2["lift"] == "not_measured" and f2["measured"] is None
    assert body["today"] == "Nov 3"
    assert body["can_edit"] is (role in ("owner", "approver"))


async def test_milestone_status_follows_its_gate(client):
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        m2 = await s.get(TrackMilestone, uuid.UUID(ids["m2"]))
        m2.target_date, m2.basis_ids = date(2026, 10, 31), [uuid.uuid4()]
        await s.commit()
    ms = {m["id"]: m for m in (await read(client, ctx))["milestones"]}
    assert ms[ids["m1"]]["status"] == "met"
    assert ms[ids["m2"]]["status"] == "missed" and ms[ids["m2"]]["month"] == "Oct"
    assert ms[ids["m2"]]["due"] == "Oct 31"
    assert ms[ids["m3"]]["status"] == "not_measured"
    assert ms[ids["m3"]]["days"] == [None] * 7


async def test_add_and_reorder_areas(client):
    ctx, ids = await world()
    r = await client.post(f"{URL}/areas", json={"name": "Rep hiring"}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    names = [a["name"] for a in r.json()["areas"]]
    assert names == ["Scale per rep", "Onboarding", "Rep hiring"]
    new = r.json()["areas"][2]["id"]
    order = [new, ids["scale"], ids["onboard"]]
    r = await client.put(f"{URL}/areas/order", json={"ids": order}, headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert [a["id"] for a in (await read(client, ctx, "viewer"))["areas"]] == order
    bad = await client.put(f"{URL}/areas/order", json={"ids": order[:2]}, headers=ctx.as_("owner"))
    assert bad.status_code == 422


async def test_edit_goal_keeps_history(client):
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        owner = ctx.users["owner"]
        (await s.merge(owner)).name = "Olive Owner"
        await s.commit()
    r = await client.patch(
        f"{URL}/goals/{ids['conv']}", json={"target": 12}, headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    goal = next(g for g in r.json()["goals"] if g["id"] == ids["conv"])
    assert goal["target"] == 12
    assert goal["history"][0] == {
        "date": "Nov 3, 2026",
        "text": "Target 10 → 12",
        "by": "Olive Owner",
    }
    r = await client.patch(
        f"{URL}/goals/{ids['conv']}", json={"target": 0}, headers=ctx.as_("owner")
    )
    assert r.status_code == 422


async def test_propose_a_milestone(client):
    ctx, ids = await world()
    before = await _count(ctx)
    r = await client.post(
        f"{URL}/milestones",
        json={"name": "40 sign-ups per rep", "goal": ids["signups"], "threshold": 40,
              "areas": [ids["scale"], ids["onboard"]], "after": ids["m1"]},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert r.status_code == 200, r.text
    m = next(x for x in r.json()["milestones"] if x["name"] == "40 sign-ups per rep")
    assert m["proposed"] is True and m["threshold"] == 40 and m["goal"] == ids["signups"]
    assert m["areas"] == [ids["scale"], ids["onboard"]] and m["depends"] == [ids["m1"]]
    assert m["current"] == 31 and m["days"] == [25, 26, 27, 28, 29, 30, 31]
    assert await _count(ctx) == before + 1
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(m["id"]))
        assert row.track_id is None and str(row.roadmap_id) == ids["roadmap"]
        assert row.code == "M3" and row.after_id == uuid.UUID(ids["m1"])
        assert row.gate_confirmed_by is None
    dup = await client.post(
        f"{URL}/milestones",
        json={"name": "40 sign-ups per rep", "goal": ids["signups"], "threshold": 40,
              "areas": [], "after": None},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert dup.status_code == 409


async def test_a_proposal_comes_after_the_goals_previous_milestone_by_default(client):
    """Sent without 'Comes after': it comes after the last milestone of the same goal."""
    ctx, ids = await world()
    r = await client.post(
        f"{URL}/milestones",
        json={"name": "60 sign-ups per rep", "goal": ids["signups"], "threshold": 60},
        headers=ctx.as_("owner"),
    )
    assert r.status_code == 200, r.text
    m = next(x for x in r.json()["milestones"] if x["name"] == "60 sign-ups per rep")
    assert m["depends"] == [ids["m2"]]
    first = await client.post(
        f"{URL}/milestones",
        json={"name": "$5k revenue per day", "goal": ids["revenue"], "threshold": 5000,
              "after": None},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    m = next(x for x in first.json()["milestones"] if x["name"] == "$5k revenue per day")
    assert m["depends"] == []


async def test_comes_after_is_stored_edited_and_orders_the_columns(client):
    ctx, ids = await world()
    r = await client.post(
        f"{URL}/milestones",
        json={"name": "30 sign-ups per rep", "goal": ids["signups"], "threshold": 30,
              "after": ids["m1"]},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    p = next(x for x in r.json()["milestones"] if x["name"] == "30 sign-ups per rep")
    assert p["depends"] == [ids["m1"]]
    r = await client.patch(
        f"{URL}/milestones/{ids['m2']}", json={"after": p["id"]}, headers=ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    order = [x["id"] for x in r.json()["milestones"]]
    assert order == [ids["m1"], p["id"], ids["m2"], ids["m3"]]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(ids["m2"]))
        assert str(row.after_id) == p["id"]
    loop = await client.patch(
        f"{URL}/milestones/{ids['m1']}", json={"after": ids["m3"]}, headers=ctx.as_("owner")
    )
    assert loop.status_code == 422
    r = await client.patch(
        f"{URL}/milestones/{ids['m3']}", json={"after": None}, headers=ctx.as_("owner")
    )
    assert next(x for x in r.json()["milestones"] if x["id"] == ids["m3"])["depends"] == []


async def test_deleted_and_ungated_milestones(client):
    """A milestone deleted on the roadmap is not on the map; one with no threshold reads
    'No gate yet', never met, proposed or '31 of 0'."""
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        gone = await s.get(TrackMilestone, uuid.UUID(ids["m3"]))
        gone.deleted_at = NOW
        m2 = await s.get(TrackMilestone, uuid.UUID(ids["m2"]))
        s.add(TrackMilestone(roadmap_id=m2.roadmap_id, code="M3", name="Sign-ups everywhere",
                             goal_id=uuid.UUID(ids["signups"])))  # fmt: skip
        await s.commit()
    ms = {m["name"]: m for m in (await read(client, ctx))["milestones"]}
    assert "$12k revenue per day" not in ms
    bare = ms["Sign-ups everywhere"]
    assert bare["threshold"] is None and bare["status"] == "no_gate"
    assert bare["proposed"] is False and bare["current"] == 31


@pytest.mark.parametrize("threshold", [0, -5])
async def test_a_threshold_must_be_above_zero(client, threshold):
    ctx, ids = await world()
    r = await client.post(
        f"{URL}/milestones",
        json={"name": "Nothing", "goal": ids["signups"], "threshold": threshold},
        headers=ctx.as_("owner"),
    )
    assert r.status_code == 422
    r = await client.patch(
        f"{URL}/milestones/{ids['m2']}", json={"threshold": threshold}, headers=ctx.as_("owner")
    )
    assert r.status_code == 422


async def test_gate_reading_follows_the_goal(client, monkeypatch):
    """The reading, the 7 days and met come from the goal's measurements, never a copy
    taken when the milestone was proposed."""
    ctx, ids = await world()
    r = await client.post(
        f"{URL}/milestones",
        json={"name": "40 sign-ups per rep", "goal": ids["signups"], "threshold": 40},
        headers=ctx.as_("owner"),
    )
    m = next(x for x in r.json()["milestones"] if x["name"] == "40 sign-ups per rep")
    assert m["current"] == 31 and m["status"] == "on_track"
    later = NOW + timedelta(days=7)
    monkeypatch.setattr(company_time, "now", lambda: later)
    async with tenant_session(ctx.tenant_id) as s:
        for i in range(7):
            on = TODAY + timedelta(days=1 + i)
            s.add(GoalMeasurement(entity_id=uuid.UUID(ids["signups"]), measured_on=on,
                                  value=Decimal(45)))  # fmt: skip
        await s.commit()
    ms = {x["id"]: x for x in (await read(client, ctx))["milestones"]}
    assert ms[m["id"]]["current"] == 45 and ms[m["id"]]["days"] == [45] * 7
    assert ms[m["id"]]["status"] == "met"
    assert ms[ids["m2"]]["current"] == 45 and ms[ids["m2"]]["status"] == "on_track"


async def test_readings_load_only_the_last_7_days_and_the_latest():
    ctx, ids = await world()
    signups = uuid.UUID(ids["signups"])
    async with tenant_session(ctx.tenant_id) as s:
        for i in range(30):
            on = TODAY - timedelta(days=40 + i)
            s.add(GoalMeasurement(entity_id=signups, measured_on=on, value=Decimal(1)))
        await s.commit()
        fetched: list[int] = []
        conn = await s.connection()

        def count(_conn, cursor, *_args):
            if cursor.description is not None:
                fetched.append(cursor.rowcount)

        event.listen(conn.sync_connection, "after_cursor_execute", count)
        try:
            out = await goal_map._readings(s, [signups], TODAY)
        finally:
            event.remove(conn.sync_connection, "after_cursor_execute", count)
    assert out[signups] == ([25, 26, 27, 28, 29, 30, 31], 31)
    assert sum(fetched) <= 8


async def test_set_and_confirm_a_gate(client):
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        (await s.merge(ctx.users["approver"])).name = "Abe Approver"
        await s.commit()
    r = await client.post(
        f"{URL}/milestones",
        json={"name": "40 sign-ups per rep", "goal": ids["signups"], "threshold": 40},
        headers=ctx.as_("owner"),
    )
    m = next(x for x in r.json()["milestones"] if x["name"] == "40 sign-ups per rep")
    assert m["proposed"] is True and m["confirmed"] is None
    r = await client.patch(
        f"{URL}/milestones/{m['id']}", json={"threshold": 30, "confirm": True},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert r.status_code == 200, r.text
    got = next(x for x in r.json()["milestones"] if x["id"] == m["id"])
    assert got["threshold"] == 30 and got["proposed"] is False
    assert got["confirmed"] == "Abe Approver" and got["confirmed_on"] == "Nov 3"
    bad = await client.patch(
        f"{URL}/milestones/{uuid.uuid4()}", json={"confirm": True}, headers=ctx.as_("owner")
    )
    assert bad.status_code == 404


async def _count(ctx: Ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(TrackMilestone))


async def test_attach_a_feature(client):
    ctx, ids = await world()
    body = {"feature": ids["f1"], "milestone": ids["m2"], "area": ids["onboard"]}
    r = await client.post(f"{URL}/links", json=body, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    feats = [f for f in r.json()["features"] if f["id"] == ids["f1"]]
    assert len(feats) == 1 and sorted(feats[0]["milestones"]) == sorted([ids["m1"], ids["m2"]])
    # Attached from the Onboarding cell: it moves there, never shown in a cell it is not in.
    assert feats[0]["area"] == ids["onboard"] and feats[0]["lever"] == "Value per conversion"
    again = await client.post(f"{URL}/links", json=body, headers=ctx.as_("owner"))
    assert again.status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(MilestoneFeature))
    assert n == 4


async def test_attach_a_feature_not_yet_on_the_map_to_its_cell(client):
    """A roadmap item with no link yet reaches the map, filed under the cell's area (not
    the milestone's first area)."""
    ctx, ids = await world()
    body = {"feature": ids["f3"], "milestone": ids["m2"], "area": ids["onboard"]}
    r = await client.post(f"{URL}/links", json=body, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    f3 = next(f for f in r.json()["features"] if f["id"] == ids["f3"])
    assert f3["name"] == "Rep leaderboard" and f3["milestones"] == [ids["m2"]]
    assert f3["area"] == ids["onboard"] and f3["lever"] == "Value per conversion"
    bad = await client.post(
        f"{URL}/links", json={**body, "area": str(uuid.uuid4())}, headers=ctx.as_("owner")
    )
    assert bad.status_code == 422


async def test_each_link_keeps_its_own_expected_lift(client):
    ctx, ids = await world()
    body = {"feature": ids["f1"], "milestone": ids["m2"], "area": ids["scale"],
            "expected": "+2 a day", "confidence": "low"}  # fmt: skip
    r = await client.post(f"{URL}/links", json=body, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    f1 = next(f for f in r.json()["features"] if f["id"] == ids["f1"])
    links = {x["milestone"]: x for x in f1["links"]}
    assert links[ids["m1"]]["expected"] == "+6 a day" and links[ids["m1"]]["confidence"] == "High"
    assert links[ids["m2"]]["expected"] == "+2 a day" and links[ids["m2"]]["confidence"] == "Low"
    assert links[ids["m2"]]["measured"] is None and links[ids["m2"]]["lift"] == "not_measured"


@pytest.mark.parametrize("role", ["commenter", "viewer"])
async def test_edits_need_approver(client, role):
    ctx, ids = await world()
    h = ctx.as_(role)
    calls = [
        client.post(f"{URL}/areas", json={"name": "X"}, headers=h),
        client.put(f"{URL}/areas/order", json={"ids": [ids["onboard"], ids["scale"]]}, headers=h),
        client.patch(f"{URL}/goals/{ids['conv']}", json={"target": 12}, headers=h),
        client.post(f"{URL}/milestones", json={"name": "Y", "goal": ids["conv"], "threshold": 1,
                                               "areas": [], "after": None}, headers=h),
        client.post(f"{URL}/links", json={"feature": ids["f1"], "milestone": ids["m2"],
                                          "area": ids["scale"]}, headers=h),
        client.patch(f"{URL}/milestones/{ids['m2']}", json={"confirm": True}, headers=h),
    ]  # fmt: skip
    for call in calls:
        assert (await call).status_code == 403


async def test_only_the_company_roadmap_feeds_the_map(client):
    """one-roadmap-many-prds (train review): while the company roadmap exists, the map reads
    its goal milestones alone (the older roadmap's are history) and a new milestone lands on
    it, never on the oldest roadmap."""
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        one = Document(slug="product-roadmap", title="Product roadmap", kind="roadmap",
                       status="draft", company_roadmap=True)  # fmt: skip
        s.add(one)
        await s.commit()
        company_id = str(one.id)
    assert (await read(client, ctx))["milestones"] == []
    r = await client.post(
        f"{URL}/milestones",
        json={"name": "35 sign-ups per rep", "goal": ids["signups"], "threshold": 35},
        headers=ctx.as_("owner"),
    )
    assert r.status_code == 200, r.text
    assert [m["name"] for m in r.json()["milestones"]] == ["35 sign-ups per rep"]
    m = r.json()["milestones"][0]
    assert m["depends"] == []
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(TrackMilestone, uuid.UUID(m["id"]))
        assert str(row.roadmap_id) == company_id and row.code == "M1"
    assert [m["name"] for m in (await read(client, ctx))["milestones"]] == ["35 sign-ups per rep"]


async def test_goals_come_in_priority_order(client):
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        for key, place in (("revenue", 1), ("signups", 2), ("conv", 3)):
            g = await s.get(Entity, uuid.UUID(ids[key]))
            g.attrs = {**g.attrs, "position": place}
        await s.commit()
    body = await read(client, ctx)
    assert [g["id"] for g in body["goals"]] == [ids["revenue"], ids["signups"], ids["conv"]]


async def test_a_guardrail_goal_is_never_a_goal_card(client):
    ctx, ids = await world()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        held = await seed.entity(
            "goal", "account-restrictions", metric="account restrictions", target=0, unit="",
            comparison="at_most", guardrail=True,
        )  # fmt: skip
        for i in range(7):
            on = TODAY - timedelta(days=6 - i)
            s.add(GoalMeasurement(entity_id=held.id, measured_on=on, value=Decimal(0)))
        await s.commit()
    body = await read(client, ctx)
    assert [g["id"] for g in body["goals"]] == [ids["signups"], ids["conv"], ids["revenue"]]
    assert body["guardrail"]["name"] == "Customer Complaints"
    # With no guardrail constraint, the strip reads the guardrail goal; still no card.
    async with tenant_session(ctx.tenant_id) as s:
        for c in (await s.scalars(select(Entity).where(Entity.type == "constraint"))).all():
            c.attrs = {**c.attrs, "guardrail": False}
        await s.commit()
    body = await read(client, ctx)
    assert str(held.id) not in [g["id"] for g in body["goals"]]
    g = body["guardrail"]
    assert g["name"] == "Account Restrictions" and g["rule"] == "= 0 every day"
    assert g["days"] == [0] * 7 and g["held"] is True and g["current"] == 0
