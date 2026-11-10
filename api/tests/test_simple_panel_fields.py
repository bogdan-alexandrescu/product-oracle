"""one-feature-panel: every field of a roadmap item, edited in its panel through Simple's
change engine (``POST /v1/simple/changes``). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_panel_fields_apply_and_read: protects=an owner sets an item's confidence, track,
  PRD, goal (over its feature's goal), what it depends on and its status, and the roadmap
  read shows each, with the item's own owner and its stored dependency keys; fails_when=an
  op is refused, writes nothing or the read does not show it; no_claim=the web.
- test_panel_fields_before_is_what_the_read_shows: protects=``before`` is the shown track,
  PRD and goal (a track from the item's PRD, a goal from its feature): it passes, and a
  stale one is 409 with the shown values; fails_when=a stale change lands or a shown
  value is refused; no_claim=other ops.
- test_panel_fields_roles_and_undo: protects=a commenter's edit is a proposal (nothing
  changes), a viewer is refused, an undo puts the goal and dependencies back;
  fails_when=any of these is let through; no_claim=meetings.
- test_panel_goal_measure_edit: protects=the item's goal carries its measure, target and
  date, so the panel edits how it is measured through the goal's own edit
  (``PATCH /v1/simple/goal-buckets/goals/{id}``) and the item's read shows the new measure;
  fails_when=the goal's target or date is missing from the read, or the edit is not shown;
  no_claim=the goal bucket page.
- test_panel_goal_measure_change: protects=``set_goal_measure`` changes the measure, target
  and date of the goal the item serves through the change engine (Undo puts them back, a
  stale ``before`` is 409 "changed by", a commenter's is a proposal an owner accepts, a goal
  with no target or date still takes a measure); fails_when=the measure is written over a
  change the caller did not see, or a commenter's lands; no_claim=the goal bucket page.
- test_goal_measure_conflict_names_the_last_in_one_instant: protects=two people set a
  goal's measure in the same instant; a stale change then names the later one, in the order
  made; fails_when=it names the first (a tie kept in storage order); no_claim=priorities.
- test_panel_depends_keys_must_name_something: protects=``set_depends`` takes an item's key
  or a feature's key and refuses (422) a key nothing has; fails_when=a typo is stored as a
  dependency; no_claim=dependencies across companies.
- test_panel_status_planned_keeps_other_shipped: protects=planned clears only the panel's
  own done mark: a shipped mark made elsewhere stays; fails_when=planned wipes it;
  no_claim=the tracker's records.
- test_cut_restore_cut_again_reads_the_tracker_each_time: protects=an in-progress item cut,
  restored (plain ``cut``/``restore`` or the panel's ``set_status``), cut again and restored
  again reads In progress after each restore; fails_when=a restore reads planned (the
  tracker's status lost); no_claim=the web (web/e2e/mock-matches-api-roadmap.spec.ts).
- test_a_stale_cut_names_another_person_s_latest_change: protects=a cut over a restore
  another person made since is 409 naming them, the latest; fails_when=it lands or names
  the first cut's person; no_claim=proposals.
- test_panel_fields_bad_values: protects=an unknown confidence, track, PRD, goal, status, or
  the item depending on itself, is 422; fails_when=a bad value is stored; no_claim=the web.
"""

import uuid
from datetime import date

import pytest

from oracle import company_time
from oracle.auth.models import User
from oracle.roadmap.models import RoadmapItem, TrackerRecord
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, make_people
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


class Panel:
    """Two items ``a`` and ``b`` on a roadmap of the PRD ``payments-prd`` (track ``Track``),
    a feature of ``a`` that supports goal G-1, another goal G-2, track ``Second`` and the
    PRD ``ledger-prd``."""

    async def build(self, ctx) -> "Panel":
        self.ctx = ctx
        async with tenant_session(ctx.tenant_id) as s:
            seed = Seed(s)
            prd, pv, rm, rv = await seed.roadmap("payments")
            track = await seed.track(pv, rm)
            self.ledger = await seed.doc("ledger-prd")
            self.second = await seed.track(await seed.version(self.ledger), rm, title="Second")
            g1 = await seed.entity("goal", "G-1")
            self.g2 = await seed.entity("goal", "G-2")
            f = await seed.entity("feature", "F-1")
            await seed.supports(f, g1)
            self.g1 = g1
            self.prd, self.track = prd, track
            a = await seed.item(rv, pv, "a", position=0, feature_id=f.id,
                                start_date=date(2026, 10, 1), end_date=date(2026, 10, 30),
                                date_source="typed")  # fmt: skip
            b = await seed.item(rv, pv, "b", position=1,
                                start_date=date(2026, 11, 2), end_date=date(2026, 11, 30),
                                date_source="typed")  # fmt: skip
            self.a, self.b = str(a.id), str(b.id)
            await s.commit()
        return self

    async def read(self, client, role="owner") -> dict[str, dict]:
        return by_key(await get(client, self.ctx, role))

    async def post(self, client, op, before, after, who="owner", item=None):
        body = {"op": op, "target": {"item_id": item or self.a}, "before": before, "after": after}
        return await client.post(CHANGES, json=body, headers=self.ctx.as_(who))


async def test_panel_fields_apply_and_read(client):
    p = await Panel().build(await make_people())
    items = await p.read(client)
    a = items["a"]
    assert a["goal"]["key"] == "G-1"
    assert a["track"]["id"] == str(p.track.id)
    assert a["own_owner_id"] is None and a["depends_keys"] == []

    r = await p.post(client, "set_confidence", {"confidence": None}, {"confidence": "high"})
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    r = await p.post(client, "set_track", {"track_id": str(p.track.id)},
                     {"track_id": str(p.second.id)})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await p.post(client, "set_prd", {"prd_document_id": str(p.prd.id)},
                     {"prd_document_id": str(p.ledger.id)})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await p.post(client, "set_goal", {"goal_id": str(p.g1.id)}, {"goal_id": str(p.g2.id)})
    assert r.status_code == 201, r.text
    r = await p.post(client, "set_depends", {"depends_on": []}, {"depends_on": ["a"]}, item=p.b)
    assert r.status_code == 201, r.text
    owner = str(p.ctx.users["approver"].id)
    r = await p.post(client, "set_owner", {"owner_id": None}, {"owner_id": owner})
    assert r.status_code == 201, r.text

    items = await p.read(client)
    a, b = items["a"], items["b"]
    assert a["confidence"] == "high"
    assert a["track"]["id"] == str(p.second.id)
    assert a["prd"]["id"] == str(p.ledger.id)
    assert a["goal"]["key"] == "G-2"
    assert b["depends_on"] == [p.a] and b["depends_keys"] == ["a"]
    assert a["needed_by"] == [p.b]
    assert a["own_owner_id"] == owner and a["owner"]["id"] == owner

    for status in ("done", "cut", "planned"):
        r = await p.post(client, "set_status", {"status": a["status"]}, {"status": status})
        assert r.status_code == 201, r.text
        a = (await p.read(client))["a"]
        assert a["status"] == status


async def test_panel_fields_before_is_what_the_read_shows(client):
    p = await Panel().build(await make_people())
    # The items name no track of their own: the read shows their PRD's.
    assert (await p.read(client))["a"]["track"]["id"] == str(p.track.id)
    stale = await p.post(client, "set_goal", {"goal_id": str(p.g2.id)}, {"goal_id": None})
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["current"] == {"goal_id": str(p.g1.id)}
    stale = await p.post(client, "set_track", {"track_id": None}, {"track_id": str(p.second.id)})
    assert stale.status_code == 409, stale.text
    stale = await p.post(client, "set_status", {"status": "done"}, {"status": "cut"})
    assert stale.status_code == 409, stale.text
    assert (await p.read(client))["a"]["status"] == "planned"


async def test_panel_fields_roles_and_undo(client):
    p = await Panel().build(await make_people())
    r = await p.post(client, "set_goal", {"goal_id": str(p.g1.id)}, {"goal_id": str(p.g2.id)},
                     who="commenter")  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    r = await p.post(client, "set_depends", {"depends_on": []}, {"depends_on": ["a"]},
                     who="viewer", item=p.b)  # fmt: skip
    assert r.status_code == 403, r.text
    assert (await p.read(client))["a"]["goal"]["key"] == "G-1"

    r = await p.post(client, "set_goal", {"goal_id": str(p.g1.id)}, {"goal_id": str(p.g2.id)})
    goal = r.json()["change"]
    r = await p.post(client, "set_depends", {"depends_on": []}, {"depends_on": ["a"]}, item=p.b)
    deps = r.json()["change"]
    assert (await p.read(client))["b"]["depends_on"] == [p.a]
    for c in (deps, goal):
        u = await client.post(f"{CHANGES}/{c['id']}/undo", headers=p.ctx.as_("owner"))
        assert u.status_code == 201, u.text
    items = await p.read(client)
    assert items["a"]["goal"]["key"] == "G-1"
    assert items["b"]["depends_on"] == [] and items["b"]["depends_keys"] == []


async def test_panel_fields_bad_values(client):
    p = await Panel().build(await make_people())
    bad = [
        ("set_confidence", {"confidence": None}, {"confidence": "sure"}),
        ("set_track", {"track_id": str(p.track.id)}, {"track_id": str(p.g2.id)}),
        ("set_prd", {"prd_document_id": str(p.prd.id)}, {"prd_document_id": str(p.g2.id)}),
        ("set_goal", {"goal_id": str(p.g1.id)}, {"goal_id": str(p.track.id)}),
        ("set_status", {"status": "planned"}, {"status": "in_progress"}),
        ("set_depends", {"depends_on": []}, {"depends_on": ["a"]}),
    ]
    for op, before, after in bad:
        r = await p.post(client, op, before, after)
        assert r.status_code == 422, (op, r.text)
    assert (await p.read(client))["a"]["confidence"] is None


async def test_panel_goal_measure_edit(client):
    p = await Panel().build(await make_people())
    async with tenant_session(p.ctx.tenant_id) as s:
        g = await s.get(type(p.g1), p.g1.id)
        g.attrs = {"metric": "Weekly payers", "target_text": "500 payers", "due": "2027-03-31"}
        await s.commit()
    goal = (await p.read(client))["a"]["goal"]
    assert goal["metric"] == "Weekly payers"
    assert goal["target"] == "500 payers" and goal["due"] == "2027-03-31"
    body = {
        "title": goal["title"],
        "measure": "Monthly payers",
        "target": goal["target"],
        "due": goal["due"],
    }
    r = await client.patch(
        f"/v1/simple/goal-buckets/goals/{goal['id']}", json=body, headers=p.ctx.as_("owner")
    )
    assert r.status_code == 200, r.text
    goal = (await p.read(client))["a"]["goal"]
    assert goal["metric"] == "Monthly payers"
    assert goal["target"] == "500 payers" and goal["due"] == "2027-03-31"


async def test_panel_goal_measure_change(client):
    p = await Panel().build(await make_people())
    async with tenant_session(p.ctx.tenant_id) as s:
        g = await s.get(type(p.g1), p.g1.id)
        g.attrs = {"metric": "Weekly payers", "target_text": "500 payers", "due": "2027-03-31"}
        await s.commit()
    goal = (await p.read(client))["a"]["goal"]
    seen = {"measure": goal["metric"], "target": goal["target"], "due": goal["due"]}
    new = {"measure": "Monthly payers", "target": "800 payers", "due": "2027-06-30"}

    async def post(before, after, who="owner"):
        body = {"op": "set_goal_measure", "target": {"item_id": p.a, "goal_id": goal["id"]},
                "before": before, "after": after}  # fmt: skip
        return await client.post(CHANGES, json=body, headers=p.ctx.as_(who))

    # A commenter's is a proposal: nothing changes until an owner accepts it.
    r = await post(seen, new, who="commenter")
    assert r.status_code == 201, r.text
    proposal = r.json()["change"]
    assert proposal["status"] == "proposed"
    assert (await p.read(client))["a"]["goal"]["metric"] == "Weekly payers"
    r = await post(seen, {"measure": "x"}, who="viewer")
    assert r.status_code == 403, r.text

    r = await post(seen, new)
    assert r.status_code == 201, r.text
    applied = r.json()["change"]
    assert applied["status"] == "applied"
    goal_now = (await p.read(client))["a"]["goal"]
    assert (goal_now["metric"], goal_now["target"], goal_now["due"]) == (
        "Monthly payers",
        "800 payers",
        "2027-06-30",
    )
    # As last read is stale now: 409, changed by whoever made it, nothing written.
    stale = await post(seen, {"measure": "Daily payers", "target": None, "due": None})
    assert stale.status_code == 409, stale.text
    assert "changed by" in stale.json()["detail"]["message"]
    assert stale.json()["detail"]["current"] == new
    r = await client.post(f"{CHANGES}/{proposal['id']}/accept", json={},
                          headers=p.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 409, r.text

    u = await client.post(f"{CHANGES}/{applied['id']}/undo", headers=p.ctx.as_("owner"))
    assert u.status_code == 201, u.text
    goal_now = (await p.read(client))["a"]["goal"]
    assert goal_now["metric"] == "Weekly payers" and goal_now["target"] == "500 payers"
    r = await client.post(f"{CHANGES}/{proposal['id']}/accept", json={},
                          headers=p.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert (await p.read(client))["a"]["goal"]["metric"] == "Monthly payers"

    # A goal with no target or date still takes a measure; only the item's goal is changed.
    async with tenant_session(p.ctx.tenant_id) as s:
        g = await s.get(type(p.g1), p.g1.id)
        g.attrs = {}
        await s.commit()
    r = await post({"measure": None, "target": None, "due": None},
                   {"measure": "Payers", "target": None, "due": None})  # fmt: skip
    assert r.status_code == 201, r.text
    goal_now = (await p.read(client))["a"]["goal"]
    assert goal_now["metric"] == "Payers" and goal_now["target"] is None
    body = {"op": "set_goal_measure", "target": {"item_id": p.a, "goal_id": str(p.g2.id)},
            "before": {"measure": None, "target": None, "due": None},
            "after": {"measure": "Other"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=p.ctx.as_("owner"))
    assert r.status_code == 422, r.text
    r = await post({"measure": "Payers", "target": None, "due": None}, {"measure": " "})
    assert r.status_code == 422, r.text


async def test_goal_measure_conflict_names_the_last_in_one_instant(client):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        ctx.users["second"] = User(email="second.owner@example.com", name="Sam Second",
                                   password_hash="x", role="owner")  # fmt: skip
        s.add(ctx.users["second"])
        await s.commit()
    p = await Panel().build(ctx)
    goal = (await p.read(client))["a"]["goal"]
    seen = {"measure": goal["metric"], "target": goal["target"], "due": goal["due"]}
    first = {"measure": "Monthly payers", "target": "800 payers", "due": "2027-06-30"}
    second = {"measure": "Weekly payers", "target": "900 payers", "due": "2027-06-30"}

    async def post(before, after, who):
        body = {"op": "set_goal_measure", "target": {"item_id": p.a, "goal_id": goal["id"]},
                "before": before, "after": after}  # fmt: skip
        return await client.post(CHANGES, json=body, headers=p.ctx.as_(who))

    # The clock is pinned: two owners set the measure, one after the other, in one instant.
    assert (await post(seen, first, "owner")).status_code == 201
    r = await post(first, second, "second")
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    stale = await post(seen, {"measure": "Daily payers", "target": None, "due": None}, "owner")
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["changed_by"]["id"] == str(p.ctx.users["second"].id)
    assert "changed by Sam Second" in stale.json()["detail"]["message"]


async def test_panel_depends_keys_must_name_something(client):
    p = await Panel().build(await make_people())
    r = await p.post(client, "set_depends", {"depends_on": []}, {"depends_on": ["F-404"]},
                     item=p.b)  # fmt: skip
    assert r.status_code == 422, r.text
    assert "F-404" in r.text
    assert (await p.read(client))["b"]["depends_keys"] == []
    # An item's key, or a feature's key (another PRD's feature), is taken.
    r = await p.post(client, "set_depends", {"depends_on": []}, {"depends_on": ["a", "F-1"]},
                     item=p.b)  # fmt: skip
    assert r.status_code == 201, r.text
    assert (await p.read(client))["b"]["depends_keys"] == ["a", "F-1"]


async def test_panel_status_planned_keeps_other_shipped(client):
    p = await Panel().build(await make_people())
    mark = {"note": "Runs in the partner app", "on": "2026-10-01"}
    async with tenant_session(p.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(p.a))
        row.shipped, row.cut = mark, True
        await s.commit()
    r = await p.post(client, "set_status", {"status": "cut"}, {"status": "planned"})
    assert r.status_code == 201, r.text
    a = (await p.read(client))["a"]
    assert a["status"] == "done"
    # The panel's own done mark is what planned clears.
    r = await p.post(client, "set_status", {"status": "planned"}, {"status": "done"}, item=p.b)
    assert r.status_code == 201, r.text
    r = await p.post(client, "set_status", {"status": "done"}, {"status": "planned"}, item=p.b)
    assert r.status_code == 201, r.text
    assert (await p.read(client))["b"]["status"] == "planned"


async def _in_progress(p: "Panel") -> None:
    """The tracker reads item ``a`` as in progress."""
    async with tenant_session(p.ctx.tenant_id) as s:
        s.add(TrackerRecord(tracker="linear", external_ref="ENG-7", track_id=p.track.id,
                            item_key="a", state="in_progress", observed_at=NOW))  # fmt: skip
        await s.commit()


@pytest.mark.parametrize("plain", [True, False])
async def test_cut_restore_cut_again_reads_the_tracker_each_time(client, plain):
    p = await Panel().build(await make_people())
    await _in_progress(p)
    assert (await p.read(client))["a"]["status"] == "in_progress"
    for _ in range(2):
        if plain:
            r = await p.post(client, "cut", {"cut": False}, {})
        else:
            r = await p.post(client, "set_status", {"status": "in_progress"}, {"status": "cut"})
        assert r.status_code == 201, r.text
        assert (await p.read(client))["a"]["status"] == "cut"
        if plain:
            r = await p.post(client, "restore", {"cut": True}, {})
        else:
            r = await p.post(client, "set_status", {"status": "cut"}, {"status": "planned"})
        assert r.status_code == 201, r.text
        assert (await p.read(client))["a"]["status"] == "in_progress"


async def test_a_stale_cut_names_another_person_s_latest_change(client):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        ctx.users["second"] = User(email="second.owner@example.com", name="Sam Second",
                                   password_hash="x", role="owner")  # fmt: skip
        s.add(ctx.users["second"])
        await s.commit()
    p = await Panel().build(ctx)
    await _in_progress(p)
    assert (await p.post(client, "set_status", {"status": "in_progress"},
                         {"status": "cut"})).status_code == 201  # fmt: skip
    r = await p.post(client, "set_status", {"status": "cut"}, {"status": "planned"}, who="second")
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    # The owner still sees it cut: their Restore then Cut meets the second owner's restore.
    stale = await p.post(client, "set_status", {"status": "cut"}, {"status": "planned"})
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["changed_by"]["id"] == str(ctx.users["second"].id)
    assert "changed by Sam Second" in stale.json()["detail"]["message"]
    assert (await p.read(client))["a"]["status"] == "in_progress"
