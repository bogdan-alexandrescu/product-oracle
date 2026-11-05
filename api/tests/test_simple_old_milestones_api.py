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
- test_a_prd_milestone_moves_only_when_its_prd_is_off_the_company_roadmap: protects=a PRD's
  own milestone is carried only while its PRD has no item on the company roadmap, once for
  twins; fails_when=a feeding PRD's is copied, or twins are copied twice.
- test_only_an_owner_acts: protects=an approver or viewer sees nothing to act on and is
  refused every action; fails_when=they see the preview or get through.
"""

import uuid
from datetime import date

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import Document
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
    assert shown["Beta ready"]["carried_from"]["title"] == "Trail App"
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


async def test_a_prd_milestone_moves_only_when_its_prd_is_off_the_company_roadmap(client):
    """A PRD's own milestone on an older roadmap is read onto the company roadmap from its
    plan while the PRD has items there; a replaced PRD's (no items there) is carried, once
    even when two older roadmaps hold it, both linked to the copy."""
    ctx = await make_ctx()
    ids = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        feeding = await s.scalar(select(Document).where(Document.slug == "trail-app-prd"))
        gone = await sd.doc("paper-maps-prd")
        other = await sd.doc("paper-maps", "roadmap")
        rows = [
            TrackMilestone(track_id=None, roadmap_id=ids["old"], origin_prd_id=feeding.id,
                           code="M1", name="Read from its plan", target_date=date(2026, 12, 1)),
            TrackMilestone(track_id=None, roadmap_id=ids["old"], origin_prd_id=gone.id,
                           code="M1", name="Paper maps printed", target_date=date(2026, 12, 9)),
            TrackMilestone(track_id=None, roadmap_id=other.id, origin_prd_id=gone.id,
                           code="M1", name="Paper maps printed", target_date=date(2026, 12, 9)),
        ]  # fmt: skip
        s.add_all(rows)
        await s.commit()
        twin_ids = [rows[1].id, rows[2].id]
    moves = [m["name"] for m in (await read(client, ctx))["old_milestones"]["moves"]]
    assert moves.count("Paper maps printed") == 1
    assert "Read from its plan" not in moves
    r = await client.post(CARRY, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    copies = [r for r in await company_rows(ctx, ids["company"]) if r.name == "Paper maps printed"]
    assert len(copies) == 1 and copies[0].origin_prd_id is None
    async with tenant_session(ctx.tenant_id) as s:
        for i in twin_ids:
            assert (await s.get(TrackMilestone, i)).carried_to_id == copies[0].id
    names = {r.name for r in await company_rows(ctx, ids["company"])}
    assert "Read from its plan" not in names


async def test_a_twin_is_kept_through_its_first_copy(client):
    """The same PRD milestone on a second older roadmap, none of its items left: Keep or Drop
    by either copy's id answers both (the web may send either)."""
    ctx = await make_ctx()
    ids = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        sd = Seed(s)
        gone = await sd.doc("paper-maps-prd")
        other = await sd.doc("paper-maps", "roadmap")
        rows = [
            TrackMilestone(track_id=None, roadmap_id=rid, origin_prd_id=gone.id, code="M1",
                           name="Posters out", target_date=date(2026, 12, 11),
                           item_ids=[uuid.uuid4()])
            for rid in (ids["old"], other.id)
        ]  # fmt: skip
        s.add_all(rows)
        await s.commit()
        first, twin = sorted((r.id for r in rows), key=str)
    listed = [m["id"] for m in (await read(client, ctx))["old_milestones"]["needs_call"]]
    waiting = next(i for i in (first, twin) if str(i) in listed)
    other_id = twin if waiting == first else first
    r = await client.post(f"{ROADMAP}/milestones/{other_id}/keep", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert "Posters out" not in [m["name"] for m in r.json()["old_milestones"]["needs_call"]]
    copies = [r for r in await company_rows(ctx, ids["company"]) if r.name == "Posters out"]
    assert len(copies) == 1
    async with tenant_session(ctx.tenant_id) as s:
        for i in (first, twin):
            assert (await s.get(TrackMilestone, i)).carried_to_id == copies[0].id


class _Reads:
    """Counts the statements run while it is open."""

    def __enter__(self):
        from sqlalchemy import event
        from sqlalchemy.engine import Engine

        self.n = 0
        self._event, self._engine = event, Engine
        event.listen(Engine, "before_cursor_execute", self._count)
        return self

    def _count(self, *args, **kwargs):
        self.n += 1

    def __exit__(self, *exc):
        self._event.remove(self._engine, "before_cursor_execute", self._count)


async def test_the_preview_is_a_bounded_read(client):
    """The roadmap read previews old milestones in a few statements however many there are,
    and in fewer once nothing is left to bring (a feeding PRD's milestone, read from its
    plan, never is)."""
    from types import SimpleNamespace

    from oracle.simple import old_milestones

    owner = SimpleNamespace(role="owner", user_id=None)
    ctx = await make_ctx()
    ids = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        with _Reads() as few:
            await old_milestones.preview(s, owner)
    async with tenant_session(ctx.tenant_id) as s:
        s.add_all(
            TrackMilestone(track_id=None, roadmap_id=ids["old"], goal_id=ids["goal"],
                           code=f"M{9 + n}", name=f"Extra {n}", target_date=date(2026, 12, 20),
                           item_ids=[uuid.uuid4()])
            for n in range(5)
        )  # fmt: skip
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        with _Reads() as many:
            view = await old_milestones.preview(s, owner)
    assert len(view.needs_call) == 6
    assert many.n == few.n <= 8, (few.n, many.n)

    async with tenant_session(ctx.tenant_id) as s:
        feeding = await s.scalar(select(Document).where(Document.slug == "trail-app-prd"))
        s.add(
            TrackMilestone(track_id=None, roadmap_id=ids["old"], origin_prd_id=feeding.id,
                           code="M1", name="Read from its plan", target_date=date(2026, 12, 1))
        )  # fmt: skip
        await s.commit()
    r = await client.post(CARRY, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    for m in r.json()["old_milestones"]["needs_call"]:
        r = await client.post(f"{ROADMAP}/milestones/{m['id']}/drop", headers=ctx.as_("owner"))
        assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        with _Reads() as none_left:
            view = await old_milestones.preview(s, owner)
    assert view.moves == [] and view.needs_call == []
    assert none_left.n <= 3, none_left.n
