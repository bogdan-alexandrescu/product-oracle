"""A merged item whose kept item is gone (words follow-ups, review of the words change).

Test card: protects=a draft merged into an item that is then deleted reads "Merged into a
deleted feature": merged_into's title is "a deleted feature" and its code and id are empty,
never the kept item's key; fails_when=the title is the raw key or empty (the board then says
"Merged into " with nothing after it); no_claim=the web (simple-merged-into-deleted.spec.ts).
"""

from tests.test_simple_additions_api import CHANGES, World, clock  # noqa: F401

ITEMS = "/v1/simple/roadmap/items"


async def test_merged_into_a_deleted_item_names_no_key(client):
    w = await World().build()
    added = await w.add(client, "owner", "Import from spreadsheets")
    draft = added["change"]["target"]["item_id"]
    r = await client.post(CHANGES, headers=w.as_("owner"), json={
        "op": "merge_item", "target": {"item_id": draft, "into_id": w.ids["import-a"]},
        "before": {}, "after": {}})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.delete(f"{ITEMS}/{w.ids['import-a']}", headers=w.as_("owner"))
    assert r.status_code == 200, r.text
    items = await w.items(client)
    assert w.ids["import-a"] not in items
    assert items[draft]["merged_into"] == {"id": "", "code": "", "title": "a deleted feature"}
