"""roadmap-milestone-codes (the owner, Nov 9): every milestone of a roadmap read has one code
M1, M2, M3 ... by date across the roadmap (``roadmap_code``), computed in one place
(``oracle.simple.roadmap_codes``).

Test cards (protects / fails_when / no_claim):

- test_codes_are_unique_by_date_undated_last: protects=codes go by date, undated last, with
  no repeats or suffixes; fails_when=two share a code or the order is not by date.
- test_same_date_goes_by_goal_order_then_name: protects=ties go by goal order, then name.
- test_a_prd_milestone_folded_into_its_track_milestone_counts_once: protects=a PRD's "M1
  Measured" and the track's "M1 Measured and mapped" holding items on its roadmap are one
  milestone with one code; fails_when=they get two codes.
- test_a_goal_milestone_of_another_name_keeps_its_own_code: protects=a goal's milestone whose
  name does not match the track's is its own milestone.
- test_roadmap_read_codes_and_renumber_on_move: protects=``GET /v1/simple/roadmap`` gives each
  goal milestone its roadmap code across goals, and moving one earlier renumbers the later
  ones; fails_when=codes stay per goal or do not follow a move; no_claim=the web.
"""

import uuid
from datetime import date
from types import SimpleNamespace

import pytest

from oracle import company_time
from oracle.simple.roadmap_codes import assign
from oracle.simple.schemas import (
    SimpleDocRef,
    SimpleGoalMilestone,
    SimpleItemMilestone,
    SimpleMilestone,
    SimpleRoadmapItem,
)
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.test_simple_goal_milestones_api import MILESTONES, get_roadmap, seed_roadmap
from tests.test_simple_roadmap_api import NOW, Seed

RM = uuid.uuid4()
G1, G2 = uuid.uuid4(), uuid.uuid4()


def gm(code: str, name: str, when: str | None, goal: uuid.UUID | None = G1, prd: bool = False):
    ref = SimpleDocRef.model_construct(id=uuid.uuid4(), slug="usage-alerts", title="Usage alerts")
    return SimpleGoalMilestone(
        id=uuid.uuid4(), roadmap_id=RM, code=code, name=name, goal_id=goal,
        date=date.fromisoformat(when) if when else None, prd=ref if prd else None,
    )  # fmt: skip


def tm(name: str, when: str | None, item_ids: list[uuid.UUID]):
    return SimpleMilestone(
        id=uuid.uuid4(), track_id=uuid.uuid4(), name=name, horizon="now", status="planned",
        date=date.fromisoformat(when) if when else None, item_ids=item_ids,
    )  # fmt: skip


def item(record: uuid.UUID | None = None):
    ms = SimpleItemMilestone(source="track", record_id=record) if record else None
    return SimpleRoadmapItem.model_construct(
        id=uuid.uuid4(), roadmap=SimpleNamespace(id=RM), milestone=ms
    )


RANK = {G1: 0, G2: 1}


def test_codes_are_unique_by_date_undated_last():
    a = gm("M1", "Prove it", "2026-12-10")
    b = gm("M2", "Scale", None)
    c = gm("M1", "Invite", "2026-11-20", goal=G2)
    d = gm("M2", "Retain", "2027-01-05", goal=G2)
    assign([a, b, c, d], [], [], RANK)
    assert [m.roadmap_code for m in (c, a, d, b)] == ["M1", "M2", "M3", "M4"]


def test_same_date_goes_by_goal_order_then_name():
    a = gm("M1", "Zeta", "2026-12-22", goal=G2)
    b = gm("M1", "Beta", "2026-12-22", goal=G1)
    c = gm("M2", "Alpha", "2026-12-22", goal=G1)
    e = gm("M1", "Plain", "2026-12-22", goal=None)
    assign([a, b, c, e], [], [], RANK)
    assert [m.roadmap_code for m in (c, b, a, e)] == ["M1", "M2", "M3", "M4"]


def test_a_prd_milestone_folded_into_its_track_milestone_counts_once():
    i = item()
    track = tm("M1 Measured and mapped", "2026-11-27", [i.id])
    prd = gm("M1", "Measured", "2026-11-25", goal=None, prd=True)
    later = gm("M2", "Scale", "2026-12-01")
    assign([prd, later], [track], [i], RANK)
    assert prd.roadmap_code == track.roadmap_code == "M1"
    assert later.roadmap_code == "M2"


def test_a_goal_milestone_of_another_name_keeps_its_own_code():
    i = item()
    track = tm("M1 Measured and mapped", "2026-11-27", [])
    own = gm("M1", "Daily scoreboard", "2026-11-20")
    assign([own], [track], [item(track.id), i], RANK)
    assert (own.roadmap_code, track.roadmap_code) == ("M1", "M2")


@pytest.fixture
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_roadmap_read_codes_and_renumber_on_move(client, clock):
    ctx = await make_ctx()
    ids = await seed_roadmap(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        other = await Seed(s).entity("goal", "retention")
        await s.commit()
        other_id = str(other.id)
    made = {}
    for name, when, goal in [
        ("Prove it", "2026-11-27", ids["goal_id"]),
        ("Scale volume", "2026-12-18", ids["goal_id"]),
        ("Keep teams", "2026-12-04", other_id),
    ]:
        body = {"roadmap_id": ids["roadmap_id"], "name": name, "date": when, "goal_id": goal}
        r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
        assert r.status_code == 201, r.text
        made[name] = r.json()["id"]

    async def codes() -> dict[str, str]:
        body = await get_roadmap(client, ctx, "owner")
        return {m["name"]: m["roadmap_code"] for m in body["goal_milestones"]}

    assert await codes() == {"Prove it": "M1", "Keep teams": "M2", "Scale volume": "M3"}
    r = await client.patch(
        f"{MILESTONES}/{made['Scale volume']}", json={"date": "2026-11-20"},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert r.status_code == 200, r.text
    assert await codes() == {"Scale volume": "M1", "Prove it": "M2", "Keep teams": "M3"}


async def test_an_items_picked_milestone_reads_its_roadmap_code(client):
    """protects=an item placed in a PRD's "M1 Prove it" reads it by its roadmap code ("M2 Prove
    it" once the roadmap's own milestone is dated before it); fails_when=the item's milestone
    keeps the PRD's own code."""
    from datetime import date as day

    from oracle.roadmap.models import RoadmapItem
    from oracle.simple.models import SimplePrdPlan
    from tests.test_simple_changes_api import World, make_people
    from tests.test_simple_item_milestone_api import _item, _plan, _post, _read

    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["im"])
    a = w.ids["im-a"]
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(a))
        s.add(SimplePrdPlan(document_id=row.prd_document_id, version_id=row.prd_version_id,
                            status="ready", source="prd",
                            data=_plan(("M1", "Prove it", "2026-11-27"))))  # fmt: skip
        await s.commit()
    body = {"roadmap_id": w.roadmap_id, "name": "Kickoff", "date": str(day(2026, 11, 10))}
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    read = await _read(client, ctx, "decider")
    prd = next(m for m in read["goal_milestones"] if m["prd"] and m["code"] == "M1")
    assert prd["roadmap_code"] == "M2", read["goal_milestones"]
    r = await _post(client, ctx, "decider", a, None, {"id": prd["id"], "name": "M1 Prove it"})
    assert r.status_code == 201, r.text
    it = _item(await _read(client, ctx, "decider"), a)
    assert it["milestone"]["name"] == "M2 Prove it"
