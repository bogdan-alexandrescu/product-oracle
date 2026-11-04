"""Simple Goal map (build-goal-map): ``GET /v1/simple/goal-map`` and its edits, against
Postgres. The world: three goals that build on each other (sign-ups -> paid conversions ->
revenue) with daily readings, a guardrail (complaints = 0), two areas in the owner's order,
three gated milestones of one track (the same track_milestones records Simple Roadmap
draws) and two features linked to them, one serving two milestones. The company's clock is
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
- test_edits_need_approver: protects=commenters and viewers are refused every edit (403)
  and read can_edit false; fails_when=a commenter edits; no_claim=run tokens.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from oracle import company_time
from oracle.baseline.models import GoalMeasurement
from oracle.roadmap.models import TrackMilestone
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
            math="Each rep's daily sign-ups",
            target_history=[
                {"date": "Oct 30, 2026", "text": "Target 30 → 40", "by": "Ann Example"}
            ],
        )  # fmt: skip
        conv = await seed.entity(
            "goal", "conversions", metric="paid conversions per rep per day", target=10,
            unit="", math="Sign-ups per rep × conversion rate", builds_on=[str(signups.id)],
        )  # fmt: skip
        revenue = await seed.entity(
            "goal", "revenue", metric="revenue per day", target=20000, unit="$",
            math="Reps × conversions per rep × value", builds_on=[str(conv.id)],
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
        track = await seed.track(pv, rm, "Growth")
        m1 = await seed.add(
            TrackMilestone(
                track_id=track.id, name="25 sign-ups per rep", gate_goal_id=signups.id,
                gate_threshold=Decimal(25), gate_reading=Decimal(31),
                gate_days=[30, 29, 31, 30, 31, 30, 31], gate_confirmed_by="Ann Example",
                gate_confirmed_on=date(2026, 11, 2),
                gate_area_ids=[scale.id],
            )
        )  # fmt: skip
        m2 = await seed.add(
            TrackMilestone(
                track_id=track.id, name="50 sign-ups per rep", gate_goal_id=signups.id,
                gate_threshold=Decimal(50), gate_reading=Decimal(31), gate_status="at_risk",
                gate_days=[27, 28, 29, 29, 30, 30, 31], gate_area_ids=[scale.id, onboard.id],
                gate_after_ids=[m1.id],
            )
        )  # fmt: skip
        m3 = await seed.add(
            TrackMilestone(
                track_id=track.id, name="$12k revenue per day", gate_goal_id=revenue.id,
                gate_threshold=Decimal(12000), gate_area_ids=[onboard.id],
                gate_after_ids=[m2.id],
            )
        )  # fmt: skip
        f1 = await seed.item(rv, pv, "one-tap-link", title="One-tap sign-up link")
        f2 = await seed.item(rv, pv, "guided-week", title="Guided first week", position=1)
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
            "track": str(track.id),
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
    assert m1["days"] == [30, 29, 31, 30, 31, 30, 31] and m1["confirmed"] == "Ann Example"
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
        m1 = await s.get(TrackMilestone, uuid.UUID(ids["m1"]))
        m1.gate_status = "at_risk"  # the readings say met
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
        assert str(row.track_id) == ids["track"] and row.gate_proposed is True
    dup = await client.post(
        f"{URL}/milestones",
        json={"name": "40 sign-ups per rep", "goal": ids["signups"], "threshold": 40,
              "areas": [], "after": None},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert dup.status_code == 409


async def _count(ctx: Ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(TrackMilestone))


async def test_attach_a_feature(client):
    ctx, ids = await world()
    body = {"feature": ids["f1"], "milestone": ids["m2"]}
    r = await client.post(f"{URL}/links", json=body, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    feats = [f for f in r.json()["features"] if f["id"] == ids["f1"]]
    assert len(feats) == 1 and sorted(feats[0]["milestones"]) == sorted([ids["m1"], ids["m2"]])
    assert feats[0]["area"] == ids["scale"]
    again = await client.post(f"{URL}/links", json=body, headers=ctx.as_("owner"))
    assert again.status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(MilestoneFeature))
    assert n == 4


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
        client.post(f"{URL}/links", json={"feature": ids["f1"], "milestone": ids["m2"]}, headers=h),
    ]  # fmt: skip
    for call in calls:
        assert (await call).status_code == 403
