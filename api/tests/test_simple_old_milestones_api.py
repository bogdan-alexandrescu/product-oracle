"""old-milestones-to-company-roadmap (the owner, Nov 4: "Move them over"): goal milestones
still on the older per-PRD roadmaps (history while the company roadmap exists) are carried
onto the company roadmap by an owner, once (``POST
/v1/simple/roadmap/milestones/carry-over``), never on a read or a deploy. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_carry_over_copies_milestones_with_their_items_re_pointed: protects=the roadmap read
  previews what moves and what needs a call (``old_milestones``) and carries nothing by
  itself; the carry-over copies each old milestone with its name, date and goal, its items
  re-pointed to the company roadmap's items (feature first, else item key), and links the
  old one to the new one; a milestone none of whose items are left is listed, not copied;
  fails_when=a read carries, an item is not re-pointed, the link is missing, or the
  no-items one is copied; no_claim=the web.
- test_a_second_carry_over_copies_nothing: protects=idempotency; fails_when=a second run
  copies again.
- test_keep_copies_and_drop_does_not: protects=Keep copies the no-items milestone (no
  items, linked) and Drop leaves it behind; both take it off the list; fails_when=either
  stays listed, Drop copies, or Keep does not.
- test_only_an_owner_acts: protects=an approver or viewer sees nothing to act on and is
  refused every action; fails_when=they see the preview or get through.
"""

import uuid
from datetime import date

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.roadmap.models import TrackMilestone
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_simple_roadmap_api import NOW, Seed

ROADMAP = "/v1/simple/roadmap"
CARRY = f"{ROADMAP}/milestones/carry-over"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def seed(ctx: Ctx) -> dict:
    """An older roadmap "trail-app" with three items and three of its own milestones, and
    the company roadmap holding two of those items again (one under a new item key, the
    same feature):

    - "Beta ready" (Dec 4) gates f-01 and f-02: both still on the company roadmap.
    - "Old pilot" (Nov 20) gates f-09 only: gone from the company roadmap.
    - "Launch party" (Dec 18) gates f-02 and f-09: only f-02 is left.
    """
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        prd, pv, old, ov = await sd.roadmap("trail-app")
        goal = await sd.entity("goal", "more-hikers")
        feature = await sd.entity("feature", "trail-maps")
        o1 = await sd.item(ov, pv, "f-01", feature_id=feature.id, title="Trail maps")
        o2 = await sd.item(ov, pv, "f-02", position=1, title="Offline mode")
        o9 = await sd.item(ov, pv, "f-09", position=2, title="Paper map export")
        company = await sd.doc("product-roadmap", "roadmap")
        company.company_roadmap = True
        cv = await sd.version(company)
        c1 = await sd.item(cv, pv, "c-01", feature_id=feature.id, title="Trail maps")
        c2 = await sd.item(cv, pv, "f-02", position=1, title="Offline mode")
        made = {}
        for name, day, items in (
            ("Beta ready", "2026-12-04", [o1.id, o2.id]),
            ("Old pilot", "2026-11-20", [o9.id]),
            ("Launch party", "2026-12-18", [o2.id, o9.id]),
        ):
            row = TrackMilestone(
                track_id=None, roadmap_id=old.id, goal_id=goal.id, code=f"M{len(made) + 1}",
                name=name, target_date=date.fromisoformat(day),
                item_ids=items, counts_when="Fifty hikers a week",
            )  # fmt: skip
            s.add(row)
            await s.flush()
            made[name] = row.id
        await s.commit()
        return {
            "old": old.id, "company": company.id, "goal": goal.id, "c1": c1.id, "c2": c2.id,
            "milestones": made,
        }  # fmt: skip


async def read(client, ctx: Ctx, role: str = "owner") -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


async def company_rows(ctx: Ctx, company_id: uuid.UUID) -> list[TrackMilestone]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(TrackMilestone)
                .where(TrackMilestone.roadmap_id == company_id)
                .order_by(TrackMilestone.target_date)
            )
        )


async def test_carry_over_copies_milestones_with_their_items_re_pointed(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    body = await read(client, ctx)
    old = body["old_milestones"]
    assert old["can_act"] is True
    moves = {m["name"]: m for m in old["moves"]}
    assert set(moves) == {"Beta ready", "Launch party"}
    assert moves["Beta ready"]["items"] == ["Trail maps", "Offline mode"]
    assert moves["Beta ready"]["date"] == "2026-12-04"
    assert moves["Beta ready"]["goal_title"] == "More Hikers"
    assert moves["Beta ready"]["from_roadmap"]["title"] == "Trail App"
    assert moves["Launch party"]["items"] == ["Offline mode"]
    assert [m["name"] for m in old["needs_call"]] == ["Old pilot"]
    # A read carries nothing.
    assert await company_rows(ctx, ids["company"]) == []

    r = await client.post(CARRY, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert len(out["carried"]) == 2
    assert out["old_milestones"]["moves"] == []
    assert [m["name"] for m in out["old_milestones"]["needs_call"]] == ["Old pilot"]

    rows = {r.name: r for r in await company_rows(ctx, ids["company"])}
    assert set(rows) == {"Beta ready", "Launch party"}
    beta = rows["Beta ready"]
    assert str(beta.target_date) == "2026-12-04"
    assert beta.goal_id == ids["goal"]
    assert beta.item_ids == [ids["c1"], ids["c2"]]
    assert beta.counts_when == "Fifty hikers a week"
    assert rows["Launch party"].item_ids == [ids["c2"]]
    async with tenant_session(ctx.tenant_id) as s:
        old_beta = await s.get(TrackMilestone, ids["milestones"]["Beta ready"])
        assert old_beta.carried_to_id == beta.id
        pilot = await s.get(TrackMilestone, ids["milestones"]["Old pilot"])
        assert pilot.carried_to_id is None

    shown = {m["name"]: m for m in (await read(client, ctx))["goal_milestones"]}
    assert shown["Beta ready"]["roadmap_id"] == str(ids["company"])
    assert shown["Beta ready"]["item_ids"] == [str(ids["c1"]), str(ids["c2"])]
    assert "Old pilot" not in shown


async def test_a_second_carry_over_copies_nothing(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    r = await client.post(CARRY, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    first = [r.id for r in await company_rows(ctx, ids["company"])]
    r = await client.post(CARRY, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["carried"] == []
    assert [r.id for r in await company_rows(ctx, ids["company"])] == first


async def test_keep_copies_and_drop_does_not(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    pilot = ids["milestones"]["Old pilot"]
    r = await client.post(f"{ROADMAP}/milestones/{pilot}/keep", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["old_milestones"]["needs_call"] == []
    kept = [r for r in await company_rows(ctx, ids["company"]) if r.name == "Old pilot"]
    assert len(kept) == 1 and kept[0].item_ids == [] and str(kept[0].target_date) == "2026-11-20"
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(TrackMilestone, pilot)).carried_to_id == kept[0].id
    # Kept already: a second answer is refused.
    r = await client.post(f"{ROADMAP}/milestones/{pilot}/drop", headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text

    # Drop: on a fresh company, the no-items milestone stays behind and leaves the list.
    ctx2 = await make_ctx()
    ids2 = await seed(ctx2)
    pilot2 = ids2["milestones"]["Old pilot"]
    r = await client.post(f"{ROADMAP}/milestones/{pilot2}/drop", headers=ctx2.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["old_milestones"]["needs_call"] == []
    assert await company_rows(ctx2, ids2["company"]) == []
    assert (await read(client, ctx2))["old_milestones"]["needs_call"] == []
    async with tenant_session(ctx2.tenant_id) as s:
        row = await s.get(TrackMilestone, pilot2)
        assert row.carry_dropped_at is not None and row.carried_to_id is None
    # A milestone that still has items to bring is not dropped or kept one by one.
    beta = ids2["milestones"]["Beta ready"]
    r = await client.post(f"{ROADMAP}/milestones/{beta}/drop", headers=ctx2.as_("owner"))
    assert r.status_code == 409, r.text


async def test_only_an_owner_acts(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    pilot = ids["milestones"]["Old pilot"]
    for role in ("approver", "viewer"):
        old = (await read(client, ctx, role))["old_milestones"]
        assert old == {"can_act": False, "moves": [], "needs_call": []}
        for path in (CARRY, f"{ROADMAP}/milestones/{pilot}/keep",
                     f"{ROADMAP}/milestones/{pilot}/drop"):  # fmt: skip
            r = await client.post(path, headers=ctx.as_(role))
            assert r.status_code == 403, (role, path, r.text)
    assert await company_rows(ctx, ids["company"]) == []
