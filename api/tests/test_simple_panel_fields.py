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
- test_panel_fields_bad_values: protects=an unknown confidence, track, PRD, goal, status, or
  the item depending on itself, is 422; fails_when=a bad value is stored; no_claim=the web.
"""

from datetime import date

import pytest

from oracle import company_time
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
