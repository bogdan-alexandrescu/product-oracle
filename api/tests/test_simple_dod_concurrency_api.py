"""Simple Definition of Done, item 5 (docs/simple-dod-ops.md): the plan's open concurrency
points, against Postgres.

Test cards (protects / fails_when / no_claim):

- test_two_sessions_on_one_item: protects=two people change the same item from their own
  sessions: changes to different fields both land (nothing lost); the later change of the
  same field, made on what it saw, answers a conflict with the current value and who made
  it, and writes nothing; fails_when=the later one silently overwrites or a change is
  lost; no_claim=the conflict's screen.
- test_two_sessions_at_once: protects=two changes of the same field sent at the same
  moment make exactly one change; the other is a conflict; fails_when=both land or
  neither; no_claim=more than two at once.
- test_stale_chat_card: protects=a chat card applied after its item changed is refused
  with a reason naming who changed it, stays open, and is offered again on the new state
  (its before is the item's current value), so a second Apply lands the card's change;
  fails_when=the stale card lands, is lost, or keeps failing; no_claim=the card's words.
- test_two_proposals_on_one_field: protects=two proposals of the same field: once the
  first is accepted, the second is refused as outdated (never silently overwrites); once
  the first is declined instead, the second is accepted; fails_when=the second overwrites
  the first; no_claim=re-basing a proposal by its author.
- test_undo_after_someone_else_changed_the_item: protects=an undo after someone else
  changed another field of the same item restores only the undone field and keeps theirs;
  after someone else changed the same field, the undo is refused with the current value
  and nothing is lost; fails_when=an undo wipes another person's change; no_claim=undo
  of a fix.
"""

import asyncio
from datetime import date

from tests.test_simple_chat_api import CARDS, n_changes
from tests.test_simple_chat_api import World as ChatWorld
from tests.test_simple_chat_api import make_people as chat_people
from tests.test_simple_chat_reader import act, actions, last, post, read
from tests.test_simple_chat_reader import clock as clock  # noqa: F401
from tests.test_simple_dod_changes_api import world

CHANGES = "/v1/simple/changes"
TITLE = "Edit_Title A"


async def test_two_sessions_on_one_item(client):
    w = await world(ops=["edit_title"])
    a = w.ids["edit_title-a"]
    dates = {"start_date": "2026-10-01", "end_date": "2026-11-15"}
    # Both saw the item as seeded. The decider edits its title, the owner its dates.
    r = await w.post(client, "decider", "edit_title")
    assert r.status_code == 201, r.text
    theirs = r.json()["change"]
    r = await client.post(CHANGES, json={"op": "move_dates", "target": {"item_id": a},
                          "before": dates, "after": {"start_date": "2026-10-05",
                          "end_date": "2026-11-20"}}, headers=w.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 201, r.text
    item = await w.item("edit_title-a")
    assert item.title == "Ledger v2" and item.start_date == date(2026, 10, 5)
    assert r.json()["change"]["session_id"] != theirs["session_id"]
    # The owner, on the title they saw, retitles too: a conflict, nothing written.
    n = len((await client.get(CHANGES, headers=w.ctx.as_("owner"))).json())
    r = await w.post(client, "owner", "edit_title", after={"title": "Ledger v3"})
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail["current"] == {"title": "Ledger v2"}
    assert detail["changed_by"]["id"] == str(w.ctx.users["decider"].id)
    assert (await w.item("edit_title-a")).title == "Ledger v2"
    assert len((await client.get(CHANGES, headers=w.ctx.as_("owner"))).json()) == n
    # On the new state, it lands.
    r = await w.post(client, "owner", "edit_title", before={"title": "Ledger v2"},
                     after={"title": "Ledger v3"})  # fmt: skip
    assert r.status_code == 201, r.text


async def test_two_sessions_at_once(client):
    w = await world(ops=["edit_title"])
    one, two = await asyncio.gather(
        w.post(client, "decider", "edit_title", after={"title": "From the decider"}),
        w.post(client, "owner", "edit_title", after={"title": "From the owner"}),
    )
    assert sorted([one.status_code, two.status_code]) == [201, 409], (one.text, two.text)
    won = one if one.status_code == 201 else two
    assert (await w.item("edit_title-a")).title == won.json()["change"]["after"]["title"]
    assert len((await client.get(CHANGES, headers=w.ctx.as_("owner"))).json()) == 1


async def test_stale_chat_card(client):
    ctx = await chat_people()
    w = await ChatWorld(ctx).build()
    ledger = w.ids["Ledger v2"]
    await post(client, ctx, "owner", "push Ledger v2 out a quarter")
    await read(ctx, actions(act("move_dates", item=ledger, shift="1 quarter")))
    [card] = (await last(client, ctx, "owner"))["cards"]
    assert card["before"] == {"start_date": "2026-10-01", "end_date": "2026-11-15"}
    # Meanwhile the decider moves the item from their own session.
    moved = {"start_date": "2026-10-10", "end_date": "2026-11-20"}
    r = await client.post(CHANGES, json={"op": "move_dates", "target": {"item_id": ledger},
                          "before": card["before"], "after": moved},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    n = await n_changes(ctx)
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert "Dee Cider" in r.json()["detail"]["message"]
    assert await n_changes(ctx) == n
    item = await w.item("Ledger v2")
    assert (str(item.start_date), str(item.end_date)) == tuple(moved.values())
    # Offered again on the new state: still open, before is what the item has now.
    [again] = (await last(client, ctx, "owner"))["cards"]
    assert again["status"] == "open" and again["before"] == moved
    assert again["after"] == card["after"]
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    item = await w.item("Ledger v2")
    assert str(item.start_date) == card["after"]["start_date"]


async def test_two_proposals_on_one_field(client):
    w = await world(ops=["edit_title"])
    first = (await w.post(client, "commenter", "edit_title", after={"title": "First"})).json()
    second = (await w.post(client, "approver", "edit_title", after={"title": "Second"})).json()
    first, second = first["change"], second["change"]
    assert first["status"] == second["status"] == "proposed"
    r = await client.post(f"{CHANGES}/{first['id']}/accept", json={},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.post(f"{CHANGES}/{second['id']}/accept", json={},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["current"] == {"title": "First"}
    assert (await w.item("edit_title-a")).title == "First"
    # The other way: the first declined, the second is accepted.
    w = await world(ops=["edit_title"])
    first = (await w.post(client, "commenter", "edit_title", after={"title": "First"})).json()
    second = (await w.post(client, "approver", "edit_title", after={"title": "Second"})).json()
    r = await client.post(f"{CHANGES}/{first['change']['id']}/decline",
                          json={"reason": "Not now"}, headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert (await w.item("edit_title-a")).title == TITLE
    r = await client.post(f"{CHANGES}/{second['change']['id']}/accept", json={},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert (await w.item("edit_title-a")).title == "Second"


async def test_undo_after_someone_else_changed_the_item(client):
    w = await world(ops=["edit_title"])
    a = w.ids["edit_title-a"]
    mine = (await w.post(client, "owner", "edit_title")).json()["change"]
    # The decider moves the same item's dates.
    r = await client.post(CHANGES, json={"op": "move_dates", "target": {"item_id": a},
                          "before": {"start_date": "2026-10-01", "end_date": "2026-11-15"},
                          "after": {"start_date": "2026-10-05", "end_date": "2026-11-20"}},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(f"{CHANGES}/{mine['id']}/undo", headers=w.ctx.as_("owner"))
    assert r.status_code == 201, r.text
    item = await w.item("edit_title-a")
    assert item.title == TITLE and item.start_date == date(2026, 10, 5)
    # The same field changed by someone else: the undo is refused, theirs kept.
    mine = (await w.post(client, "owner", "edit_title")).json()["change"]
    r = await w.post(client, "decider", "edit_title", before={"title": "Ledger v2"},
                     after={"title": "Ledger v3"})  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(f"{CHANGES}/{mine['id']}/undo", headers=w.ctx.as_("owner"))
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["current"] == {"title": "Ledger v3"}
    assert (await w.item("edit_title-a")).title == "Ledger v3"
