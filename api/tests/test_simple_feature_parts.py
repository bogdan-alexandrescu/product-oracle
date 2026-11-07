"""feature-parts: a feature made part of another (``set_parent``, any depth) and any open
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
  and the item itself, an item of another roadmap, an unknown or cut key are 422; a part
  of a part, and a feature with parts made a part, are fine (any depth, owner's answer
  Nov 5); fails_when=any of these is let through or refused; no_claim=meetings.
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
- test_parts_at_any_depth: protects=a three-level tree reads each part's ``part_of``, its
  ``part_path`` (top first) and each parent's ``parts``; an undated part reads its nearest
  dated ancestor's dates; no dependency_order flag against any ancestor;
  fails_when=a level is refused or dropped, the path is short, or the part keeps its
  window estimate; no_claim=the web's tree.
- test_never_its_own_ancestor: protects=making a feature part of itself, its part or its
  part's part is 422 in plain words; fails_when=a cycle is stored; no_claim=restore.
- test_a_loop_names_each_feature_by_code_and_name: protects=a refused loop, and a feature
  made part of itself, name each feature by its code and name ("F-02 Alert routing by
  team"); fails_when=a code is left out or the words name a field; no_claim=the web.
- test_merge_into_a_part_keeps_every_part: protects=a feature with parts merged into a
  feature that is itself a part: its parts move under the kept feature, which stays where
  it was; merged into its own part's part, the kept feature takes the merged one's place
  (no cycle); Undo puts every field back; fails_when=a part is left under the closed
  feature, a cycle is stored, or Undo misses a field; no_claim=the web's fallback.
- test_restore_a_part_keeps_its_live_parent: protects=a part restored from Trash is a
  part of its parent again when the parent is still live (even moved meanwhile), else
  (merged meanwhile) a feature of its own, and a restore that would close a loop clears
  the restored feature's parent; fails_when=a part points at a closed parent or a cycle is
  stored; no_claim=the Trash page.
- test_cut_parts_stay_parts: protects=a cut part stays a part: its parent lists it as cut,
  its own read keeps ``part_of``, and a cut feature can be taken out of its parent (and
  is listed no more); fails_when=the cut part drops from its parent's list or cannot be
  taken out; no_claim=the web.
- test_a_part_of_a_feature_in_trash: protects=a part whose parent is in Trash reads that
  parent as ``in_trash`` with its name and keeps the dates it read from it;
  fails_when=``part_of`` is null or the dates fall back to the window's estimate;
  no_claim=the Trash page.
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

    def ref(self, key: str, **kw) -> dict:
        return {"id": self.ids[key], "code": "", "title": key.title(), "cut": False,
                "in_trash": False} | kw  # fmt: skip


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
    r = await w.parent(client, "p", None, "p")
    assert r.json()["detail"] == "P cannot be a part of itself"
    # Any depth: a part of a part, and a feature with parts made a part.
    assert (await w.parent(client, "p", None, "a")).status_code == 201
    r = await w.parent(client, "c", None, "p")
    assert r.status_code == 201, r.text
    r = await w.parent(client, "a", None, "b")
    assert r.status_code == 201, r.text
    assert (await w.parent(client, "a", "b", None)).status_code == 201
    assert (await w.parent(client, "c", "p", None)).status_code == 201
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
    # merged_into keeps its key as the code when the item has none (S7, as before).
    assert c["status"] == "merged"
    assert c["merged_into"] == {"id": w.ids["p"], "code": "p", "title": "P"}
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


ITEMS = "/v1/simple/roadmap/items"


async def test_parts_at_any_depth(client):
    w = await Parts().build(await make_people())
    # a (dated) > p (undated) > c (undated) > d (dated, depends on a).
    for key, parent in (("p", "a"), ("c", "p"), ("d", "c")):
        r = await w.parent(client, key, None, parent)
        assert r.status_code == 201, (key, r.text)
    items = await w.read(client)
    a, p, c, d = items["a"], items["p"], items["c"], items["d"]
    assert a["parts"] == [w.ref("p")] and p["parts"] == [w.ref("c")]
    assert c["parts"] == [w.ref("d")]
    assert c["part_of"] == w.ref("p")
    assert c["part_path"] == [w.ref("a"), w.ref("p")]
    assert d["part_path"] == [w.ref("a"), w.ref("p"), w.ref("c")]
    assert a["part_path"] == [] and a["part_of"] is None
    # c has no dates and neither has p: c reads a's, its nearest dated ancestor's.
    assert c["start"] == a["start"] and c["end"] == a["end"] and c["estimated"] is False
    assert d["start"]["date"] == "2026-10-10"
    # d depends on a, three levels up: never a broken link against an ancestor.
    assert d["flags"] == []


async def test_never_its_own_ancestor(client):
    w = await Parts().build(await make_people())
    assert (await w.parent(client, "p", None, "a")).status_code == 201
    assert (await w.parent(client, "c", None, "p")).status_code == 201
    for key, parent, before in (("a", "c", None), ("a", "p", None), ("p", "c", "a")):
        r = await w.parent(client, key, before, parent)
        assert r.status_code == 422, (key, parent, r.text)
        assert r.json()["detail"] == (
            f"{key.title()} cannot be part of {parent.title()}: "
            f"{parent.title()} is already one of its parts"
        )
    items = await w.read(client)
    assert items["a"]["parent_key"] is None and items["p"]["parent_key"] == "a"


async def test_a_loop_names_each_feature_by_code_and_name(client):
    """A refused loop names both features by code and name, the self case too."""
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("alerts")
        ids = {}
        for i, (key, code, title) in enumerate(
            (("route", "f-02", "Alert routing by team"), ("push", "f-05", "Alert push"))
        ):
            row = await seed.item(rv, pv, key, position=i, prd_section_key=code, title=title)
            ids[key] = str(row.id)
        await s.commit()

    async def parent(key, before, after):
        body = {"op": "set_parent", "target": {"item_id": ids[key]},
                "before": {"parent_key": before}, "after": {"parent_key": after}}  # fmt: skip
        return await client.post(CHANGES, json=body, headers=ctx.as_("owner"))

    assert (await parent("push", None, "route")).status_code == 201
    r = await parent("route", None, "push")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == (
        "F-02 Alert routing by team cannot be part of F-05 Alert push: "
        "F-05 Alert push is already one of its parts"
    )
    r = await parent("route", None, "route")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-02 Alert routing by team cannot be a part of itself"


async def test_merge_into_a_part_keeps_every_part(client):
    w = await Parts().build(await make_people())
    # a > b; c > p, own. c merges into b, itself a part.
    for key, parent in (("b", "a"), ("p", "c"), ("own", "c")):
        assert (await w.parent(client, key, None, parent)).status_code == 201
    before = await w.read(client)
    r = await w.merge(client, "c", "b")
    assert r.status_code == 201, r.text
    merge = r.json()["change"]
    items = await w.read(client)
    assert items["b"]["parent_key"] == "a" and items["b"]["part_path"] == [w.ref("a")]
    assert items["b"]["parts"] == [w.ref("p"), w.ref("own")]
    assert items["p"]["part_path"] == [w.ref("a"), w.ref("b")]
    assert items["c"]["parts"] == [] and items["c"]["status"] == "merged"
    await w.undo(client, merge)
    items = await w.read(client)
    for key in ("a", "b", "c", "p", "own"):
        for f in ("status", "parent_key", "part_of", "parts", "part_path"):
            assert items[key][f] == before[key][f], (key, f)

    # Into its own part's part: a > b > own; a merges into own, which takes a's place.
    w = await Parts().build(await make_people())
    for key, parent in (("b", "a"), ("own", "b"), ("p", "a")):
        assert (await w.parent(client, key, None, parent)).status_code == 201
    r = await w.merge(client, "a", "own")
    assert r.status_code == 201, r.text
    items = await w.read(client)
    assert items["own"]["parent_key"] is None and items["own"]["part_path"] == []
    assert items["own"]["parts"] == [w.ref("b"), w.ref("p")]
    assert items["b"]["parent_key"] == "own" and items["p"]["parent_key"] == "own"
    assert items["b"]["parts"] == []


async def test_restore_a_part_keeps_its_live_parent(client):
    w = await Parts().build(await make_people())
    owner = w.ctx.as_("owner")
    # p is part of a; p goes to Trash; a moves under b meanwhile: p comes back under a.
    assert (await w.parent(client, "p", None, "a")).status_code == 201
    assert (await client.delete(f"{ITEMS}/{w.ids['p']}", headers=owner)).status_code == 200
    assert (await w.read(client))["a"]["parts"] == []
    assert (await w.parent(client, "a", None, "b")).status_code == 201
    r = await client.post(f"{ITEMS}/{w.ids['p']}/restore", headers=owner)
    assert r.status_code == 200, r.text
    items = await w.read(client)
    assert items["p"]["parent_key"] == "a"
    assert items["p"]["part_path"] == [w.ref("b"), w.ref("a")]

    # c is part of p; c goes to Trash; p is merged into own meanwhile: c comes back on its own.
    assert (await w.parent(client, "c", None, "p")).status_code == 201
    assert (await client.delete(f"{ITEMS}/{w.ids['c']}", headers=owner)).status_code == 200
    assert (await w.merge(client, "p", "own")).status_code == 201
    r = await client.post(f"{ITEMS}/{w.ids['c']}/restore", headers=owner)
    assert r.status_code == 200, r.text
    items = await w.read(client)
    assert items["c"]["parent_key"] is None and items["c"]["part_of"] is None
    assert w.ref("c") not in items["own"]["parts"]

    # b > a > d; a goes to Trash; b is made part of d meanwhile. Restoring a under b would
    # close a loop (a > d > b > a): a comes back on its own.
    w = await Parts().build(await make_people())
    owner = w.ctx.as_("owner")
    assert (await w.parent(client, "a", None, "b")).status_code == 201
    assert (await w.parent(client, "d", None, "a")).status_code == 201
    assert (await client.delete(f"{ITEMS}/{w.ids['a']}", headers=owner)).status_code == 200
    # a is in Trash, so b may be made part of d (d's parent is not on the roadmap).
    assert (await w.parent(client, "b", None, "d")).status_code == 201
    r = await client.post(f"{ITEMS}/{w.ids['a']}/restore", headers=owner)
    assert r.status_code == 200, r.text
    items = await w.read(client)
    assert items["a"]["parent_key"] is None
    assert items["d"]["parent_key"] == "a" and items["b"]["parent_key"] == "d"
    assert items["b"]["part_path"] == [w.ref("a"), w.ref("d")]


async def test_cut_parts_stay_parts(client):
    w = await Parts().build(await make_people())
    for key in ("p", "c"):
        assert (await w.parent(client, key, None, "a")).status_code == 201
    r = await client.post(CHANGES, headers=w.ctx.as_("owner"), json={
        "op": "set_status", "target": {"item_id": w.ids["p"]}, "before": {"status": "planned"},
        "after": {"status": "cut"}})  # fmt: skip
    assert r.status_code == 201, r.text
    items = await w.read(client)
    assert items["p"]["status"] == "cut" and items["p"]["part_of"] == w.ref("a")
    # The cut part sits below the line, so after the open one.
    assert items["a"]["parts"] == [w.ref("c"), w.ref("p", cut=True)]
    # A cut feature's panel can still take it out of its parent.
    r = await w.parent(client, "p", "a", None)
    assert r.status_code == 201, r.text
    items = await w.read(client)
    assert items["p"]["part_of"] is None and items["a"]["parts"] == [w.ref("c")]


async def test_a_part_of_a_feature_in_trash(client):
    w = await Parts().build(await make_people())
    assert (await w.parent(client, "p", None, "a")).status_code == 201
    shown = (await w.read(client))["p"]
    assert shown["start"]["date"] == "2026-10-01"
    r = await client.delete(f"{ITEMS}/{w.ids['a']}", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    p = (await w.read(client))["p"]
    assert p["parent_key"] == "a"
    assert p["part_of"] == w.ref("a", in_trash=True)
    assert p["part_path"] == [w.ref("a", in_trash=True)]
    assert p["start"] == shown["start"] and p["end"] == shown["end"]
    assert p["estimated"] is False


async def test_priorities_rows_name_the_parent(client):
    """Priorities' ranked list and Goal buckets read a part's parent off its row (part_of, by
    its display code and name); a feature of its own reads none."""
    from tests.test_simple_priorities_api import World, rows_by_code

    w = await World(await make_people()).build()
    r = await w.change(client, "decider", "set_parent", "pay-2", {"parent_key": None},
                       {"parent_key": "pay-1"})  # fmt: skip
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    rows = rows_by_code(await w.read(client))
    assert rows["pay-2"]["part_of"] == {"id": w.ids["pay-1"], "code": "", "title": "Pay 1",
                                        "cut": False, "in_trash": False}  # fmt: skip
    assert rows["pay-1"]["part_of"] is None
    # Its parts, from the roadmap's data (not only the rows this list shows): Delete counts them.
    assert rows["pay-1"]["parts"] == [{"id": w.ids["pay-2"], "code": "", "title": "Pay 2",
                                       "cut": False, "in_trash": False}]  # fmt: skip
    assert rows["pay-2"]["parts"] == []
