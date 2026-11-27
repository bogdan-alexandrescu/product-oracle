"""home-3 (#1900): Home's "Since your last visit" names every change's item by its code and
name, even when the change's row stores only the id of the item as an older version of its
roadmap had it (each approved version copies its items under new ids). Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_changes_on_an_older_versions_item_name_it_as_it_is_now: protects=changes of kinds
  owner changed, dates accepted, status changed and added, each with only an item id of the
  roadmap's older version, read in words with the item's code and name as it is now, and
  their target points at the item as it is now (so Home links it); an item the newer version
  dropped keeps its last known name and no current id; fails_when=a change reads "an item"
  or its target keeps the old id; no_claim=the web (home-since-names-items.spec.ts).
"""

import uuid
from datetime import timedelta

from oracle.simple.models import SimpleChange
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, make_people
from tests.test_simple_roadmap_api import NOW, Seed

KEYS = ("owner-a", "dates-a", "status-a", "added-a")
OPS = {
    "owner-a": ("set_owner", {"owner_id": None}, {"owner_id": None}),
    "dates-a": ("accept_date_suggestion", {"start_date": None, "end_date": None}, {}),
    "status-a": ("set_status", {"shipped": False}, {"shipped": True}),
    "added-a": ("add_item", {}, {}),
}


async def test_changes_on_an_older_versions_item_name_it_as_it_is_now(client):
    """Live rows store an older version's item id: every entry still names its item."""
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        seed = Seed(s)
        _, pv, rm, v1 = await seed.roadmap("example")
        old = {k: await seed.item(v1, pv, k, position=i) for i, k in enumerate((*KEYS, "gone-a"))}
        v2 = await seed.version(rm, 2)
        new = {k: await seed.item(v2, pv, k, position=i) for i, k in enumerate(KEYS)}
        by = ctx.users["decider"].id
        for i, k in enumerate((*KEYS, "gone-a")):
            op, before, after = OPS.get(k, ("set_owner", {"owner_id": None}, {"owner_id": None}))
            s.add(SimpleChange(document_id=rm.id, op=op, target={"item_id": str(old[k].id)},
                               before=before, after=after, status="applied", by=by,
                               at=NOW - timedelta(minutes=i)))  # fmt: skip
        await s.commit()
        ids = {k: str(r.id) for k, r in new.items()}
        gone = str(old["gone-a"].id)

    rm_read = (await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))).json()
    now = {i["id"]: i for i in rm_read["items"]}
    assert set(ids.values()) <= set(now), "the read is the newer version"
    rows = (await client.get(CHANGES, headers=ctx.as_("owner"))).json()
    assert len(rows) == 5
    for c in rows:
        assert "an item" not in c["words"], c["words"]
    by_target = {c["target"]["item_id"]: c for c in rows}
    for k, i in ids.items():
        assert i in by_target, f"{k}: the change points at the item as it is now"
        item = now[i]
        label = f"{item['code']} {item['title']}" if item["code"] else item["title"]
        assert label in by_target[i]["words"], (k, by_target[i]["words"])
    # The dropped item: its last known name, and no id of the read (no link).
    left = [c for c in rows if c["target"]["item_id"] not in now]
    assert [c["target"]["item_id"] for c in left] == [gone]
    assert "Gone A" in left[0]["words"]
    assert uuid.UUID(gone)
