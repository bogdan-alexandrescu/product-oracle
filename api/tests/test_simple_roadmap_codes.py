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
- test_a_goal_milestone_named_in_brackets_folds_into_its_track_milestone: protects=a name
  in brackets ("[Launch (beta)]") matches the track's "M2 · Launch (beta)", as Home read it.
- test_a_goal_milestone_joins_its_track_milestone_beside_another_goals_of_the_code:
  protects=join whenever names match (the owner, Nov 9); fails_when=another goal's milestone
  of the old code keeps them split.
- test_a_goal_milestone_joins_a_prd_milestone_whose_name_it_leads: protects=a goal's and a
  PRD's milestone of one code and matching names are one.
- test_a_goal_milestone_joins_its_twin_prd_milestone_of_another_code (goal map twins,
  Nov 10): protects=a goal's own "M4 Agents onboarded" and a PRD's undated milestone of the
  same name (the PRD's own code, its goal set) are one milestone with one code; a PRD
  milestone with no goal joins too; fails_when=the twin keeps a code of its own.
- test_a_goal_milestone_does_not_join_another_goals_prd_milestone ("Join only within the same
  goal", the owner, Nov 11): protects=Goal 1's "Beta" (Nov 1) and Goal 2's PRD "Beta launch"
  (Mar 2027) keep two codes, so Goal 2's "Pilot" (Dec 1) reads between them; fails_when=the
  join dates "Beta" by the PRD's later date and "Pilot" reads M1.
- test_a_joined_group_is_dated_by_the_goals_own_milestone: protects=a goal's "Beta" (Nov 1)
  joined to its own PRD's "Beta launch" (Mar 2027) still reads before a Dec 1 milestone;
  fails_when=the group goes by the PRD's date.
- test_two_goals_own_milestones_do_not_share_one_prd_twin: protects=two goals' own "Beta"
  and a PRD's "Beta" of no goal: at most one joins it, so two codes; fails_when=both read one.
- test_a_goal_milestone_does_not_join_a_group_holding_another_goals_milestone (review of
  797e41166, "Join only within the same goal", the owner, Nov 11): protects=a PRD's "M2 Beta"
  of no goal (Dec 1) that Goal 1's PRD "M2 Beta" (Nov 1) and Goal 1's own "Beta" (Nov 1) joined
  is Goal 1's: Goal 2's own "Beta" (Dec 1) keeps a code of its own; fails_when=all four read M1.
- test_a_goal_milestone_joins_a_group_of_its_own_goal: protects=the same three without Goal
  2's still read one code (same-goal joins still join); fails_when=Goal 1's own splits off.
- test_of_two_matching_prd_milestones_the_closest_date_joins: protects=a goal's "Beta" joins
  the matching PRD milestone closest in date, then the one of its exact name, not the first by
  id; fails_when=the exact name wins over the closer date.
- test_no_name_is_hidden_by_a_join: protects=a name that matches neither keeps its own code.
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


def test_a_goal_milestone_named_in_brackets_folds_into_its_track_milestone():
    track = tm("M2 · Launch (beta)", None, [])
    own = gm("M2", "[Launch (beta)]", None)
    assign([own], [track], [item(track.id)], RANK)
    assert own.roadmap_code == track.roadmap_code == "M1"


def test_a_goal_milestone_joins_its_track_milestone_beside_another_goals_of_the_code():
    """Join whenever names match (the owner, Nov 9): another goal's M1 on the roadmap no longer
    keeps a goal's "M1 Measured" apart from the track's "M1 Measured and mapped"."""
    track = tm("M1 Measured and mapped", "2026-11-27", [])
    own = gm("M1", "Measured", "2026-11-25")
    other = gm("M1", "Daily scoreboard", "2026-11-20", goal=G2)
    assign([own, other], [track], [item(track.id)], RANK)
    assert own.roadmap_code == track.roadmap_code == "M2"
    assert other.roadmap_code == "M1"


def test_a_goal_milestone_joins_a_prd_milestone_whose_name_it_leads():
    """A goal's "M1 Measured" and a PRD's "M1 Measured and mapped" on one roadmap are one."""
    prd = gm("M1", "Measured and mapped", "2026-11-27", goal=None, prd=True)
    own = gm("M1", "Measured", "2026-11-25")
    assign([own, prd], [], [], RANK)
    assert own.roadmap_code == prd.roadmap_code == "M1"


@pytest.mark.parametrize("prd_goal", [G1, None])
def test_a_goal_milestone_joins_its_twin_prd_milestone_of_another_code(prd_goal):
    """Join whenever names match (the owner, Nov 9): the PRD's code (its plan's "M1") is not
    the goal's ("M4"), and the PRD's milestone carries a goal of its own; still one."""
    own = gm("M4", "Agents onboarded", "2026-12-31")
    twin = gm("M1", "Agents onboarded", None, goal=prd_goal, prd=True)
    other = gm("M2", "Pilot live", "2026-11-30", goal=G2)
    assign([twin, own, other], [], [], RANK)
    assert own.roadmap_code == twin.roadmap_code == "M2"
    assert other.roadmap_code == "M1"


def test_a_goal_milestone_does_not_join_another_goals_prd_milestone():
    """Join only within the same goal (the owner, Nov 11)."""
    beta = gm("M1", "Beta", "2026-11-01")
    launch = gm("M1", "Beta launch", "2027-03-01", goal=G2, prd=True)
    pilot = gm("M2", "Pilot", "2026-12-01", goal=G2)
    assign([beta, launch, pilot], [], [], RANK)
    assert [m.roadmap_code for m in (beta, pilot, launch)] == ["M1", "M2", "M3"]


def test_a_joined_group_is_dated_by_the_goals_own_milestone():
    beta = gm("M1", "Beta", "2026-11-01")
    launch = gm("M1", "Beta launch", "2027-03-01", prd=True)
    pilot = gm("M2", "Pilot", "2026-12-01", goal=G2)
    assign([launch, beta, pilot], [], [], RANK)
    assert beta.roadmap_code == launch.roadmap_code == "M1"
    assert pilot.roadmap_code == "M2"


def test_two_goals_own_milestones_do_not_share_one_prd_twin():
    """At most one goal's own milestone joins a given PRD milestone; the other keeps its code."""
    a = gm("M1", "Beta", "2026-11-01")
    b = gm("M1", "Beta", "2026-11-01", goal=G2)
    twin = gm("M3", "Beta", None, goal=None, prd=True)
    assign([twin, b, a], [], [], RANK)
    assert a.roadmap_code != b.roadmap_code
    assert twin.roadmap_code == a.roadmap_code  # Goal 1 comes first in goal order


def test_a_goal_milestone_does_not_join_a_group_holding_another_goals_milestone():
    """Join only within the same goal, by the group a PRD milestone joined (review of 797e41166)."""
    plain = gm("M2", "Beta", "2026-12-01", goal=None, prd=True)
    prd1 = gm("M2", "Beta", "2026-11-01", prd=True)
    own1 = gm("M1", "Beta", "2026-11-01")
    own2 = gm("M1", "Beta", "2026-12-01", goal=G2)
    assign([plain, prd1, own1, own2], [], [], RANK)
    assert plain.roadmap_code == prd1.roadmap_code == own1.roadmap_code == "M1"
    assert own2.roadmap_code == "M2"


def test_a_goal_milestone_joins_a_group_of_its_own_goal():
    plain = gm("M2", "Beta", "2026-12-01", goal=None, prd=True)
    prd1 = gm("M2", "Beta", "2026-11-01", prd=True)
    own1 = gm("M1", "Beta", "2026-11-01")
    pilot = gm("M3", "Pilot", "2026-11-15", goal=G2)
    assign([plain, prd1, own1, pilot], [], [], RANK)
    assert plain.roadmap_code == prd1.roadmap_code == own1.roadmap_code == "M1"
    assert pilot.roadmap_code == "M2"


def test_of_two_matching_prd_milestones_the_closest_date_joins():
    own = gm("M1", "Beta", "2026-11-01")
    exact = gm("M2", "Beta", "2027-03-01", prd=True)
    near = gm("M3", "Beta launch", "2026-11-05", prd=True)
    assign([exact, near, own], [], [], RANK)
    assert own.roadmap_code == near.roadmap_code == "M1"
    assert exact.roadmap_code == "M2"


def test_two_prd_milestones_of_one_name_are_not_joined_to_each_other():
    """Only a goal's own milestone joins a PRD's: two PRDs' milestones keep their codes."""
    a = gm("M1", "Beta", "2026-11-20", prd=True)
    b = gm("M1", "Beta", "2026-11-25", goal=G2, prd=True)
    assign([a, b], [], [], RANK)
    assert {a.roadmap_code, b.roadmap_code} == {"M1", "M2"}


def test_no_name_is_hidden_by_a_join():
    """No name hidden: a goal milestone whose name neither leads nor follows the track's keeps
    its own code, whatever joins beside it; two goals' that both match join the one track."""
    track = tm("M1 Measured and mapped", "2026-11-27", [])
    a = gm("M1", "Measured", "2026-11-25")
    b = gm("M1", "measured and MAPPED", None, goal=G2)
    c = gm("M1", "Mapped", "2026-11-20", goal=G2)
    assign([a, b, c], [track], [item(track.id)], RANK)
    assert a.roadmap_code == b.roadmap_code == track.roadmap_code == "M2"
    assert c.roadmap_code == "M1"


def test_a_milestone_of_no_name_joins_only_as_its_roadmaps_only_one_of_its_code():
    """A bare "M3" is no name to lead another: two goals' nameless M3 beside the track's
    "M3 Prices live" keep their own codes; one goal's alone joins it."""
    track = tm("M3 Prices live", "2026-12-01", [])
    a, b = gm("M3", "", "2026-11-20"), gm("M3", "", "2026-11-22", goal=G2)
    assign([a, b], [track], [item(track.id)], RANK)
    assert len({a.roadmap_code, b.roadmap_code, track.roadmap_code}) == 3
    assign([a], [track], [item(track.id)], RANK)
    assert a.roadmap_code == track.roadmap_code


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


async def test_a_filtered_read_keeps_the_unfiltered_codes(client, clock):
    """protects=a read with ?roadmap=, ?prd= or a date range gives each shown milestone the
    code the whole roadmap gives it (Home and the Goal map read it unfiltered); fails_when=the
    codes are numbered from the filtered read, so a roadmap's milestones shift down or a folded
    track milestone splits into two codes."""
    from oracle.roadmap.models import TrackMilestone
    from tests.test_simple_roadmap_api import get

    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, launch, rv = await seed.roadmap("launch")
        _, gpv, growth, grv = await seed.roadmap("growth")
        track = await seed.track(pv, launch, title="Alerts")
        await seed.item(rv, pv, "f-01", track_id=track.id)
        await seed.item(grv, gpv, "g-01", track_id=None)
        s.add(TrackMilestone(track_id=track.id, name="M1 Beta", horizon="now", item_keys=["f-01"]))
        await s.commit()
        ids = {"launch": str(launch.id), "growth": str(growth.id)}
    for rm, name, when in [("launch", "Beta", "2026-11-25"), ("growth", "Kickoff", "2026-11-10"),
                           ("launch", "Scale", "2026-12-18")]:  # fmt: skip
        body = {"roadmap_id": ids[rm], "name": name, "date": when}
        r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
        assert r.status_code == 201, r.text

    def codes(body: dict) -> dict[str, str]:
        out = {m["id"]: m["roadmap_code"] for m in body["goal_milestones"]}
        return out | {m["id"]: m["roadmap_code"] for m in body["milestones"] if m["roadmap_code"]}

    whole = codes(await get(client, ctx))
    assert sorted(whole.values()) == ["M1", "M2", "M2", "M3"], whole
    for params in ({"roadmap": "launch"}, {"prd": "growth-prd"}, {"from": "2027-06-01"},
                   {"prd": "launch-prd", "from": "2026-01-01", "to": "2027-12-31"}):  # fmt: skip
        part = codes(await get(client, ctx, **params))
        assert part, params
        assert part == {k: whole[k] for k in part}, (params, part, whole)
