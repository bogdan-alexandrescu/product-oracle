"""port-an-decisions: a removed meeting agenda item and a deleted request wait in
Settings › Trash.

- An agenda item an owner or the PRD's decider removes from a live meeting's Agenda sheet
  goes to Trash (its row kept in the entry); the sheet's Undo takes it back out of Trash,
  and Trash's Restore puts the row back where it stood. Whoever removed it restores it; an
  ended meeting's agenda is closed (409).
- An owner deletes a request to Trash (``DELETE /v1/requests/{id}``); it leaves every read
  and Restore brings it back. Below owner it is a 403; a request others are merged into
  stays (409).
- Trash lists them as one list; people below owner see only what they deleted.

Each test's card is one line: protects / fails_when. Synthetic placeholders only.
"""

import pytest

from tests.baseline_helpers import Ctx, make_ctx
from tests.test_requests import act, add
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meeting_agenda_edit import live, op, titles
from tests.test_simple_meetings_api import MEETINGS, get, world


def name(user) -> str:
    """As Trash names the person: their name, else their email."""
    return user.name or user.email


async def trash(client, ctx, who: str = "owner") -> list[dict]:
    r = await client.get("/v1/trash", headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def restore(client, ctx, entry_id: str, who: str = "owner"):
    return await client.post(f"/v1/trash/{entry_id}/restore", headers=ctx.as_(who))


async def test_removed_agenda_item_goes_to_trash_and_restores(client):
    """protects=a removed agenda item is a Trash entry (kind agenda_item, its name, who
    removed it), the sheet says so (in_trash) and Restore puts it back where it stood;
    fails_when=the remove leaves nothing in Trash or Restore leaves the agenda without it."""
    w = await world()
    mid = await live(client, w)
    first = titles(await get(client, w, mid, "owner"))
    gone = first[-1]
    m = await get(client, w, mid, "owner")
    item = m["agenda"]["items"][-1]["id"]
    r = await op(client, w, "owner", mid, op="remove", item_id=item, batch="t1")
    assert r.status_code == 200, r.text
    assert gone not in titles(r.json()) and r.json()["agenda"]["in_trash"] is True
    entries = await trash(client, w.ctx)
    e = next(x for x in entries if x["root"]["type"] == "agenda_item")
    assert e["root"]["title"] == gone and e["root"]["kind"] == "agenda_item"
    assert e["deleted_by_name"] == name(w.ctx.users["owner"]) and e["can_restore"] is True

    r = await restore(client, w.ctx, e["id"])
    assert r.status_code == 200, r.text
    m = await get(client, w, mid, "owner")
    assert titles(m) == first and m["agenda"]["in_trash"] is False
    assert all(x["id"] != e["id"] for x in await trash(client, w.ctx))


async def test_undo_takes_the_removed_item_out_of_trash(client):
    """protects=the sheet's Undo of a batch that removed an item ends its Trash entry;
    fails_when=the item is back on the agenda and still waits in Trash."""
    w = await world()
    mid = await live(client, w)
    m = await get(client, w, mid, "owner")
    item = m["agenda"]["items"][-1]["id"]
    await op(client, w, "owner", mid, op="remove", item_id=item, batch="t2")
    assert any(x["root"]["type"] == "agenda_item" for x in await trash(client, w.ctx))
    r = await op(client, w, "owner", mid, op="undo", batch="t2")
    assert r.status_code == 200, r.text
    assert r.json()["agenda"]["in_trash"] is False
    assert not any(x["root"]["type"] == "agenda_item" for x in await trash(client, w.ctx))


async def test_decider_sees_and_restores_what_they_removed(client):
    """protects=below owner, the decider who removed an item sees it in Trash and restores
    it; another member does not see it; fails_when=the decider's Trash is empty or another
    member's lists it."""
    w = await world()
    mid = await live(client, w)
    m = await get(client, w, mid, "decider")
    item = m["agenda"]["items"][-1]["id"]
    r = await op(client, w, "decider", mid, op="remove", item_id=item, batch="t3")
    assert r.status_code == 200, r.text
    mine = await trash(client, w.ctx, "decider")
    assert [x["root"]["type"] for x in mine] == ["agenda_item"] and mine[0]["can_restore"]
    others = await trash(client, w.ctx, "approver")
    assert not any(x["root"]["type"] == "agenda_item" for x in others)
    r = await restore(client, w.ctx, mine[0]["id"], "decider")
    assert r.status_code == 200, r.text


async def test_ended_meeting_item_is_not_restored(client):
    """protects=an ended meeting's removed item stays in Trash with a reason (409);
    fails_when=Restore edits a closed agenda."""
    w = await world()
    mid = await live(client, w)
    m = await get(client, w, mid, "owner")
    item = m["agenda"]["items"][-1]["id"]
    await op(client, w, "owner", mid, op="remove", item_id=item, batch="t4")
    r = await client.post(f"{MEETINGS}/{mid}/end", json={}, headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    e = next(x for x in await trash(client, w.ctx) if x["root"]["type"] == "agenda_item")
    r = await restore(client, w.ctx, e["id"])
    assert r.status_code == 409 and "ended" in r.text


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


async def test_owner_deletes_a_request_to_trash_and_restores_it(client, ctx):
    """protects=an owner's delete takes the request out of the list and its page into Trash
    (kind request, the owner's name), and Restore brings it back; fails_when=it stays
    listed, is gone for good, or Trash names the owner by email."""
    r0 = await add(client, ctx, title="Export the weekly report")
    r = await client.request("DELETE", f"/v1/requests/{r0['id']}", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    e = r.json()
    assert e["root"]["type"] == "request" and e["root"]["title"] == "Export the weekly report"
    assert e["deleted_by_name"] == name(ctx.users["owner"])
    listed = await client.get("/v1/requests", headers=ctx.as_("viewer"))
    assert r0["id"] not in {x["id"] for x in listed.json()["items"]}
    assert (
        await client.get(f"/v1/requests/{r0['id']}", headers=ctx.as_("viewer"))
    ).status_code == 404
    assert [x["root"]["type"] for x in await trash(client, ctx)] == ["request"]

    r = await restore(client, ctx, e["id"])
    assert r.status_code == 200, r.text
    assert (
        await client.get(f"/v1/requests/{r0['id']}", headers=ctx.as_("viewer"))
    ).status_code == 200


async def test_below_owner_cannot_delete_a_request(client, ctx):
    """protects=a request's delete is an owner's; fails_when=an approver deletes one."""
    r0 = await add(client, ctx)
    r = await client.request("DELETE", f"/v1/requests/{r0['id']}", headers=ctx.as_("approver"))
    assert r.status_code == 403


async def test_request_others_are_merged_into_stays(client, ctx):
    """protects=a request others are merged into is refused (409) with what to do;
    fails_when=it goes to Trash and the merged ones point at nothing."""
    into = await add(client, ctx, title="Keep the delivery address")
    other = await add(client, ctx, title="Remember my address")
    assert (await act(client, ctx, other["id"], "merge", into_id=into["id"])).status_code == 200
    r = await client.request("DELETE", f"/v1/requests/{into['id']}", headers=ctx.as_("owner"))
    assert r.status_code == 409 and "merged into it" in r.text
