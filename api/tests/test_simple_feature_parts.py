"""feature-parts: a feature made part of another (``set_parent``, one level) and any open
feature merged into another (``merge_item`` with ``target.into_id``), through Simple's change
engine (``POST /v1/simple/changes``). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_set_parent_applies_reads_and_undoes: protects=a decider makes an item part of
  another: the read shows the part's parent_key and part_of and the parent's parts, a part
  with no dates of its own reads its parent's dates (a dated part keeps its own); Undo
  takes it out again; fails_when=the op is refused, the read misses a field, the undated
  part keeps its window estimate, or Undo leaves it in; no_claim=the web.
- test_set_parent_stale_roles_and_bad_parents: protects=a stale ``before`` is 409 with the
  stored key, a commenter's is a proposal (nothing changes), a viewer is refused (403),
  and the item itself, an item of another roadmap, an unknown or cut key and nesting (the
  parent is a part, or the item has parts) are 422; fails_when=any of these is let
  through; no_claim=meetings.
- test_a_part_is_never_a_broken_link_against_its_parent: protects=no dependency_order flag
  between a part and its parent, either way; fails_when=the flag is raised;
  no_claim=other flags.
- test_merge_any_open_item: protects=a published (non-draft) item merges into another open
  item of its roadmap: it reads merged into the kept item, its dependents depend on the
  kept item, the kept item takes its dependencies, its parts move to the kept item (the
  kept item, once its part, is a part no more), and Undo puts every field back; a
  commenter's merge is a proposal; fails_when=the merge is refused, a link or part is left
  on the merged item, or Undo misses a field; no_claim=the feature_id variant (draft only).
- test_a_merged_part_leaves_its_parent: protects=a part merged away drops its own
  parent_key, so its parent lists it no more; fails_when=the parent still lists it;
  no_claim=Undo (above).
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


def _dated(start: date, end: date) -> dict:
    return {"start_date": start, "end_date": end, "date_source": "typed"}


class Parts:
    """One roadmap: ``a`` (Oct 1 - Oct 30), ``b`` (Nov 2 - Nov 30), ``c`` and ``p`` (no
    dates), ``own`` (Dec 1 - Dec 10), ``d`` (Oct 10 - Oct 20) that depends on ``a``; another
    roadmap with ``z``."""

    async def build(self, ctx) -> "Parts":
        self.ctx = ctx
        async with tenant_session(ctx.tenant_id) as s:
            seed = Seed(s)
            _, pv, _, rv = await seed.roadmap("payments")
            rows = {
                "a": _dated(date(2026, 10, 1), date(2026, 10, 30)),
                "b": _dated(date(2026, 11, 2), date(2026, 11, 30)),
                "c": {},
                "p": {},
                "own": _dated(date(2026, 12, 1), date(2026, 12, 10)),
                "d": {**_dated(date(2026, 10, 10), date(2026, 10, 20)), "depends_on": ["a"]},
            }
            self.ids: dict[str, str] = {}
            for i, (key, kw) in enumerate(rows.items()):
                self.ids[key] = str((await seed.item(rv, pv, key, position=i, **kw)).id)
            _, opv, _, orv = await seed.roadmap("ledger")
            self.ids["z"] = str((await seed.item(orv, opv, "z")).id)
            await s.commit()
        return self

    async def read(self, client, role="owner") -> dict[str, dict]:
        return by_key(await get(client, self.ctx, role))

    async def parent(self, client, key, before, after, who="owner"):
        body = {"op": "set_parent", "target": {"item_id": self.ids[key]},
                "before": {"parent_key": before}, "after": {"parent_key": after}}  # fmt: skip
        return await client.post(CHANGES, json=body, headers=self.ctx.as_(who))

    async def merge(self, client, key, into, who="owner"):
        body = {"op": "merge_item", "target": {"item_id": self.ids[key], "into_id": self.ids[into]},
                "before": {}, "after": {}}  # fmt: skip
        return await client.post(CHANGES, json=body, headers=self.ctx.as_(who))

    async def undo(self, client, change):
        r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=self.ctx.as_("owner"))
        assert r.status_code == 201, r.text

    def ref(self, key: str) -> dict:
        return {"id": self.ids[key], "code": "", "title": key.title()}


async def test_set_parent_applies_reads_and_undoes(client):
    w = await Parts().build(await make_people())
    items = await w.read(client)
    assert items["p"]["parent_key"] is None and items["p"]["part_of"] is None
    assert items["a"]["parts"] == []
    assert items["p"]["estimated"] is True

    r = await w.parent(client, "p", None, "a")
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied"
    assert change["before"] == {"parent_key": None} and change["after"] == {"parent_key": "a"}
    r = await w.parent(client, "own", None, "a")
    assert r.status_code == 201, r.text

    items = await w.read(client)
    p, a = items["p"], items["a"]
    assert p["parent_key"] == "a"
    assert p["part_of"] == w.ref("a")
    assert a["parts"] == [w.ref("p"), w.ref("own")]
    # The undated part reads its parent's dates; the dated one keeps its own.
    assert p["start"] == a["start"] and p["end"] == a["end"]
    assert p["start"]["date"] == "2026-10-01" and p["end"]["date"] == "2026-10-30"
    assert p["estimated"] is False and p["source"] == a["source"]
    assert items["own"]["start"]["date"] == "2026-12-01"

    await w.undo(client, change)
    items = await w.read(client)
    assert items["p"]["parent_key"] is None and items["p"]["part_of"] is None
    assert items["a"]["parts"] == [w.ref("own")]
    assert items["p"]["estimated"] is True


async def test_set_parent_stale_roles_and_bad_parents(client):
    w = await Parts().build(await make_people())
    stale = await w.parent(client, "p", "b", "a")
    assert stale.status_code == 409, stale.text
    assert stale.json()["detail"]["current"] == {"parent_key": None}

    r = await w.parent(client, "p", None, "a", who="commenter")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    r = await w.parent(client, "p", None, "a", who="viewer")
    assert r.status_code == 403, r.text
    assert (await w.read(client))["p"]["parent_key"] is None

    for key, parent in (("p", "p"), ("p", "z"), ("p", "nope")):
        r = await w.parent(client, key, None, parent)
        assert r.status_code == 422, (key, parent, r.text)
    # Nesting: one level only.
    assert (await w.parent(client, "p", None, "a")).status_code == 201
    r = await w.parent(client, "c", None, "p")
    assert r.status_code == 422, r.text
    assert "part" in r.json()["detail"]
    r = await w.parent(client, "a", None, "b")
    assert r.status_code == 422, r.text
    # A cut item is no parent.
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "set_status", "target": {"item_id": w.ids["b"]}, "before": {"status": "planned"},
        "after": {"status": "cut"}})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await w.parent(client, "c", None, "b")
    assert r.status_code == 422, r.text
    # Back out: null is always allowed.
    r = await w.parent(client, "p", "a", None)
    assert r.status_code == 201, r.text
    assert (await w.read(client))["a"]["parts"] == []


async def test_a_part_is_never_a_broken_link_against_its_parent(client):
    w = await Parts().build(await make_people())
    items = await w.read(client)
    # d starts Oct 10, but a, which it depends on, ends Oct 30.
    assert [f["kind"] for f in items["d"]["flags"]] == ["dependency_order"]
    r = await w.parent(client, "d", None, "a")
    assert r.status_code == 201, r.text
    assert (await w.read(client))["d"]["flags"] == []
    # The other way: the parent depends on its part.
    r = await w.parent(client, "d", "a", None)
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "set_depends", "target": {"item_id": w.ids["d"]}, "before": {"depends_on": ["a"]},
        "after": {"depends_on": []}})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "set_depends", "target": {"item_id": w.ids["a"]}, "before": {"depends_on": []},
        "after": {"depends_on": ["d"]}})  # fmt: skip
    assert r.status_code == 201, r.text
    assert [f["kind"] for f in (await w.read(client))["a"]["flags"]] == ["dependency_order"]
    r = await w.parent(client, "d", None, "a")
    assert r.status_code == 201, r.text
    assert (await w.read(client))["a"]["flags"] == []


async def test_merge_any_open_item(client):
    w = await Parts().build(await make_people())
    # c depends on b, d on a and c; p and own are parts of c. c merges into p, its own part.
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "set_depends", "target": {"item_id": w.ids["c"]}, "before": {"depends_on": []},
        "after": {"depends_on": ["b"]}})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "set_depends", "target": {"item_id": w.ids["d"]}, "before": {"depends_on": ["a"]},
        "after": {"depends_on": ["a", "c"]}})  # fmt: skip
    assert r.status_code == 201, r.text
    for key in ("p", "own"):
        assert (await w.parent(client, key, None, "c")).status_code == 201
    before = await w.read(client)
    assert before["c"]["draft"] is False

    r = await w.merge(client, "c", "p", who="commenter")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    assert (await w.read(client))["c"]["status"] == "planned"

    r = await w.merge(client, "c", "p")
    assert r.status_code == 201, r.text
    merge = r.json()["change"]
    assert merge["status"] == "applied"
    items = await w.read(client)
    c, p, own, d = items["c"], items["p"], items["own"], items["d"]
    assert c["status"] == "merged" and c["merged_into"] == w.ref("p")
    assert c["parent_key"] is None and c["parts"] == []
    # The kept item was c's part: it is a part no more, and takes c's other part.
    assert p["parent_key"] is None and p["part_of"] is None
    assert own["parent_key"] == "p" and own["part_of"] == w.ref("p")
    assert p["parts"] == [w.ref("own")]
    assert w.ids["b"] in p["depends_on"]
    assert w.ids["p"] in d["depends_on"] and w.ids["c"] not in d["depends_on"]

    await w.undo(client, merge)
    items = await w.read(client)
    for key in ("c", "p", "own", "d"):
        for f in ("status", "parent_key", "part_of", "parts", "depends_on", "depends_keys"):
            assert items[key][f] == before[key][f], (key, f)
    assert items["c"]["merged_into"] is None
    # The feature_id variant stays for drafts only.
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "merge_item", "target": {"item_id": w.ids["c"], "feature_id": w.ids["a"]},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 422, r.text


async def test_a_merged_part_leaves_its_parent(client):
    w = await Parts().build(await make_people())
    assert (await w.parent(client, "p", None, "a")).status_code == 201
    r = await w.merge(client, "p", "b")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["after"][w.ids["p"]]["parent_key"] is None
    items = await w.read(client)
    assert items["p"]["status"] == "merged" and items["p"]["parent_key"] is None
    assert items["a"]["parts"] == []
    # Into another roadmap's item: refused.
    r = await w.merge(client, "c", "z")
    assert r.status_code == 422, r.text
