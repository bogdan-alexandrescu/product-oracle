"""Simple chat-latest-card (the owner, Nov 4): in a chat only the latest card acts.

Once a card in a chat is applied or declined, every earlier card in it is replaced; among
the open cards only the newest per topic (the item or other target it changes) is
actionable. The API refuses a replaced card and Apply all applies only active cards.
Against Postgres; the worlds are test_simple_chat_api's and test_simple_chat_join's.

Test cards (protects / fails_when / no_claim):

- test_two_cards_on_one_item_only_the_newest_acts: protects=an older open card on the
  same item reads replaced_by the newer one, may nothing, and its Apply and Discard are
  409 with a plain message; the newer one applies; fails_when=the older card applies or
  still offers Apply; no_claim=the web's link (Playwright).
- test_cards_on_two_items_each_stay_active: protects=a chat about two items keeps one
  active card per item; fails_when=a card on another item replaces it.
- test_acting_on_a_card_replaces_every_earlier_card: protects=applying (or discarding) a
  card replaces every earlier card in the chat, whatever its item, and leaves later ones
  active; an applied earlier card keeps its Undo; the state is read again the same
  (a reload); fails_when=an earlier card still applies or an applied one loses Undo.
- test_meeting_chat_follows_the_same_rule: protects=the meeting chat replaces as the Ask
  panel does; fails_when=a meeting's older card applies.
- test_apply_all_applies_only_active_cards: protects=Apply all on a reply whose card on one
  item a newer card replaced applies only its other card; fails_when=Apply all applies the
  replaced card.
"""

from __future__ import annotations

from oracle.simple import card_order
from tests.test_simple_chat_api import (
    CARDS,
    World,
    _meeting,
    card_as,
    make_people,
    meetings,  # noqa: F401
    say,
)
from tests.test_simple_chat_join import ASK, act, actions, last, post, read
from tests.test_simple_meetings_api import start, world


async def test_two_cards_on_one_item_only_the_newest_acts(client):
    ctx = await make_people()
    w = await World(ctx).build()
    old = (await say(client, ctx, "owner", "move Ledger v2 to Q2"))["cards"][0]
    new = (await say(client, ctx, "owner", "move Ledger v2 to March 3"))["cards"][0]
    old = await card_as(client, ctx, "owner", old["id"])
    assert old["replaced_by"] == new["id"]
    assert old["may"] is None and old["status"] == "open"
    assert new["replaced_by"] is None and new["may"] == "apply"
    for verb in ("apply", "discard"):
        r = await client.post(f"{CARDS}/{old['id']}/{verb}", headers=ctx.as_("owner"))
        assert r.status_code == 409, r.text
        assert r.json()["detail"] == card_order.REPLACED
    r = await client.post(f"{CARDS}/{new['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert str((await w.item("Ledger v2")).start_date) == "2027-03-03"


async def test_cards_on_two_items_each_stay_active(client):
    ctx = await make_people()
    await World(ctx).build()
    a1 = (await say(client, ctx, "owner", "rename Alert digest to Alert digest A"))["cards"][0]
    b1 = (await say(client, ctx, "owner", "rename Alert export to Alert export A"))["cards"][0]
    a2 = (await say(client, ctx, "owner", "rename Alert digest to Alert digest B"))["cards"][0]
    b2 = (await say(client, ctx, "owner", "rename Alert export to Alert export B"))["cards"][0]
    got = {k: await card_as(client, ctx, "owner", c["id"]) for k, c in
           {"a1": a1, "b1": b1, "a2": a2, "b2": b2}.items()}  # fmt: skip
    assert got["a1"]["replaced_by"] == a2["id"] and got["b1"]["replaced_by"] == b2["id"]
    assert got["a2"]["replaced_by"] is None and got["b2"]["replaced_by"] is None
    assert [got[k]["may"] for k in ("a1", "b1", "a2", "b2")] == [None, None, "apply", "apply"]


async def test_acting_on_a_card_replaces_every_earlier_card(client):
    ctx = await make_people()
    w = await World(ctx).build()
    a = (await say(client, ctx, "owner", "rename Alert digest to Alert digest A"))["cards"][0]
    b = (await say(client, ctx, "owner", "rename Alert export to Alert export A"))["cards"][0]
    c = (await say(client, ctx, "owner", "rename Partner API to Partner API A"))["cards"][0]
    r = await client.post(f"{CARDS}/{b['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    # Read again (a reload): the earlier card is replaced by the applied one, the later stays.
    ga, gb, gc = [await card_as(client, ctx, "owner", x["id"]) for x in (a, b, c)]
    assert ga["replaced_by"] == b["id"] and ga["may"] is None
    assert gb["replaced_by"] is None and gb["can_undo"] is True
    assert gc["replaced_by"] is None and gc["may"] == "apply"
    r = await client.post(f"{CARDS}/{a['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 409 and r.json()["detail"] == card_order.REPLACED
    assert (await w.item("Alert digest")).title == "Alert digest"
    # Discarding the newest replaces the applied one before it; it keeps its Undo.
    r = await client.post(f"{CARDS}/{c['id']}/discard", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    gb = await card_as(client, ctx, "owner", b["id"])
    assert gb["replaced_by"] == c["id"] and gb["status"] == "applied" and gb["can_undo"] is True
    r = await client.post(f"{CARDS}/{b['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert (await w.item("Alert export")).title == "Alert export"


async def test_meeting_chat_follows_the_same_rule(client, meetings):  # noqa: F811
    ctx = await make_people()
    await World(ctx).build()
    mid = _meeting(ctx, meetings, "everyone")
    old = (await say(client, ctx, "owner", "cut Alert export", mid))["cards"][0]
    new = (await say(client, ctx, "decider", "rename Alert export to Alert export B", mid))[
        "cards"
    ][0]
    got = await card_as(client, ctx, "decider", old["id"], mid)
    assert got["replaced_by"] == new["id"] and got["may"] is None
    r = await client.post(f"{CARDS}/{old['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 409 and r.json()["detail"] == card_order.REPLACED
    assert meetings.decisions == []


async def test_apply_all_applies_only_active_cards(client):
    w = await world()
    mid = (await start(client, w))["id"]
    a, b = str(w.ids["move_dates-a"]), str(w.ids["move_dates-b"])
    await post(client, w, "decider", "push A and B to next quarter", mid)
    assert await read(w, actions(act("move_dates", item=a, when="next quarter"),
                                 act("move_dates", item=b, when="next quarter"))) == 1  # fmt: skip
    first = await last(client, w, "decider", mid)
    assert [c["item_id"] for c in first["cards"]] == [a, b]
    await post(client, w, "decider", "push A to Q3 instead", mid)
    assert await read(w, actions(act("move_dates", item=a, when="Q3"))) == 1
    newer = await last(client, w, "decider", mid)
    assert newer["cards"] and newer["cards"][0]["item_id"] == a
    r = await client.post(f"{ASK}/{first['id']}/apply-all", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["applied"] == [first["cards"][1]["id"]] and out["stopped"] is None
    msgs = {m["id"]: m for m in out["thread"]["messages"]}
    left = msgs[first["id"]]["cards"][0]
    assert left["status"] == "open" and left["replaced_by"] == newer["cards"][0]["id"]
