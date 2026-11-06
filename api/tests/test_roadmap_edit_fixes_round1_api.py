"""roadmap-edit-fixes, round 1: what applying the owner's roadmap answers through Simple's
panel met after the first seven fixes. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_dependency_by_code_is_read_and_removable: protects=a dependency stored as the item's
  code in any case ("f-03", as set_depends accepts it) names that item: the item lists it in
  depends_on (with the key that names it) and the other lists it in needed_by; removing it
  as the panel sends it leaves nothing; fails_when=the read leaves it a loose key, the other
  item reads "Needed by: None", or it stays after the removal.
- test_dependency_by_a_title_code_is_read: protects=an item whose title carries its code
  ("F-19 Pipeline") is named by that code; fails_when=it is not.
- test_two_keys_for_one_dependency_both_go: protects=an item whose stored dependencies name
  one item twice (its key and its feature's key, as Oracle's old draft and the panel each
  wrote) loses both when the panel removes the one it was read with; fails_when=the other
  key keeps the dependency after a reload.
- test_done_dependency_is_no_broken_link: protects=a dependency that is done (shipped) is
  satisfied whatever its dates: no dependency_order flag; fails_when=it is flagged.
- test_cut_item_link_does_not_count: protects=a cut item's own dependency is no broken link;
  fails_when=the cut item carries a dependency_order flag.
- test_priorities_read_the_items_dependencies: protects=a Priorities row lists what its
  roadmap item depends on (the panel's dependencies), not only the baseline's feature
  edges; fails_when=the row lists none.
"""

from datetime import date

import pytest

from oracle import company_time
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, make_people
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get

pytestmark = pytest.mark.asyncio(loop_scope="session")

PRIORITIES = "/v1/simple/priorities"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def _world(**c_kw):
    """Items ``b`` (feature ``ledger-sync``, PRD section f-03) and ``c`` on one roadmap."""
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        f = await seed.entity("feature", "ledger-sync")
        b_kw = c_kw.pop("b", {})
        b_kw.setdefault("prd_section_key", "f-03")
        b_kw.setdefault("title", "Ledger")
        b = await seed.item(rv, pv, "b", position=0, feature_id=f.id, **b_kw)
        c_kw.setdefault("title", "Checkout")
        c = await seed.item(rv, pv, "c", position=1, **c_kw)
        await s.commit()
        return ctx, str(b.id), str(c.id)


async def _post(client, ctx, item, before, after):
    body = {"op": "set_depends", "target": {"item_id": item}, "before": before, "after": after}
    return await client.post(CHANGES, json=body, headers=ctx.as_("owner"))


async def _remove(client, ctx, c: dict, dep: str):
    """What the panel's x sends: the stored keys less the one the read names it by."""
    key = c["depends_key_of"][dep]
    keys = [k for k in c["depends_keys"] if k != key]
    r = await _post(client, ctx, c["id"], {"depends_on": c["depends_keys"]}, {"depends_on": keys})
    assert r.status_code == 201, r.text


async def test_dependency_by_code_is_read_and_removable(client):
    ctx, b, c = await _world(depends_on=["f-03"])
    items = by_key(await get(client, ctx, "owner"))
    assert items["c"]["depends_on"] == [b]
    assert items["c"]["depends_key_of"] == {b: "f-03"}
    assert items["b"]["needed_by"] == [c]
    await _remove(client, ctx, items["c"], b)
    items = by_key(await get(client, ctx, "owner"))
    assert items["c"]["depends_on"] == [] and items["c"]["depends_keys"] == []
    assert items["b"]["needed_by"] == []


async def test_dependency_by_a_title_code_is_read(client):
    ctx, b, c = await _world(depends_on=["F-19"], b={"title": "F-19 Pipeline",
                                                     "prd_section_key": None})  # fmt: skip
    items = by_key(await get(client, ctx, "owner"))
    assert items["c"]["depends_on"] == [b]
    assert items["b"]["needed_by"] == [c]


async def test_two_keys_for_one_dependency_both_go(client):
    ctx, b, c = await _world(depends_on=["b", "ledger-sync"])
    items = by_key(await get(client, ctx, "owner"))
    assert items["c"]["depends_on"] == [b]
    await _remove(client, ctx, items["c"], b)
    items = by_key(await get(client, ctx, "owner"))
    assert items["c"]["depends_on"] == [], items["c"]["depends_keys"]
    assert items["b"]["needed_by"] == []


def _typed(start: date, end: date) -> dict:
    return {"start_date": start, "end_date": end, "date_source": "typed"}


async def test_done_dependency_is_no_broken_link(client):
    late = {**_typed(date(2026, 10, 1), date(2026, 12, 15)), "shipped": True}
    ctx, b, c = await _world(depends_on=["b"], b=late,
                             **_typed(date(2026, 11, 10), date(2026, 12, 20)))  # fmt: skip
    items = by_key(await get(client, ctx, "owner"))
    assert items["b"]["status"] == "done"
    assert [f["kind"] for f in items["c"]["flags"] if f["kind"] == "dependency_order"] == []


async def test_cut_item_link_does_not_count(client):
    late = _typed(date(2026, 10, 1), date(2026, 12, 15))
    ctx, b, c = await _world(depends_on=["b"], b=late, cut=True,
                             **_typed(date(2026, 11, 10), date(2026, 12, 20)))  # fmt: skip
    items = by_key(await get(client, ctx, "owner"))
    assert items["c"]["status"] == "cut"
    assert [f["kind"] for f in items["c"]["flags"] if f["kind"] == "dependency_order"] == []


async def test_priorities_read_the_items_dependencies(client):
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, _, rv = await seed.roadmap("payments")
        fa = await seed.entity("feature", "fa")
        fb = await seed.entity("feature", "fb")
        await seed.item(rv, pv, "pay-1", position=0, feature_id=fa.id, depends_on=["pay-2"])
        await seed.item(rv, pv, "pay-2", position=1, feature_id=fb.id)
        await s.commit()
    r = await client.get(PRIORITIES, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    rows = {x["code"]: x for x in r.json()["rows"]}
    assert rows["pay-1"]["depends_on"] == ["pay-2"]
    assert rows["pay-2"]["depends_on"] == []
