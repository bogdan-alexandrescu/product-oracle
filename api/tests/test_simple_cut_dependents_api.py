"""fix5-cut-dependents (qa-simple-roadmap-24, the owner's 2026-10-30 pick): a cut card on an
item others depend on offers "Cut it and its dependents" beside "Cut it, keep the
dependents". The second cuts the item and every item that waits on it, transitively, as ONE
change (``cut_with_dependents``): one entry in the change list, undone as one, its words
naming every item it cut. Against Postgres.

The roadmap (tests.test_simple_chat_api.World, a decider): Ledger v2 <- Bulk import <- Bulk
export, and Shared report, which waits on Bulk import and on Alert digest (kept).

Test cards (protects / fails_when / no_claim):

- test_cut_with_dependents_is_one_change_undone_as_one: protects=the cut card names the
  dependents (``dependents``: Bulk import, Bulk export, Shared report); its apply with
  ``with_dependents`` makes one change that cuts all four and keeps Alert digest (shared
  with Shared report) and every other item; the card, the change's words and the draft's
  change list name every item it cut; one Undo puts all four back; fails_when=the
  dependents stay, a kept item is cut, the cut is several changes or the undo leaves one
  cut; no_claim=the web.
- test_cut_keeping_the_dependents_and_an_item_without_any: protects=the plain apply still
  cuts only the item (op cut); an item no one depends on has no dependents and refuses
  ``with_dependents``; fails_when=the plain cut takes the dependents or the flag is let
  through; no_claim=the flags' words.
- test_cut_with_dependents_follows_roles: protects=a commenter's apply proposes the one
  change to the decider (nothing is cut until they accept, then all four are); a viewer is
  refused; a stale ``before`` is 409; fails_when=a commenter cuts or a viewer gets in;
  no_claim=meeting modes (the cut card's own rules, tests.test_simple_chat_api).
- test_cut_with_dependents_needs_rights_on_every_item (review major): protects=a person who
  decides the item but not its dependents applies the plain cut, but the cut with its
  dependents is a proposal (``may_with_dependents``), routed to the company's owners; only
  someone who decides every item accepts it; fails_when=the cut applies on the item's
  rights alone or a decider of some items accepts it; no_claim=the web.
- test_cut_with_dependents_refuses_dependents_the_card_never_listed (review minor):
  protects=the apply sends the card's ``dependent_ids``; an item waiting on it since is 409;
  fails_when=the cut takes an item the card never listed; no_claim=the 409's words.
- test_a_meeting_decision_names_every_item_cut (review minor): protects=meetings.describe
  names and makes subjects of every item cut; fails_when=only the item is named;
  no_claim=the decision's other fields.
"""

from datetime import date

import pytest
from sqlalchemy import func, select

from oracle import company_time
from oracle.roadmap.models import RoadmapItem
from oracle.simple.models import SimpleChange
from oracle.tenancy import tenant_session
from tests.test_simple_chat_api import CARDS, NOW, World, make_people, say

CHANGES = "/v1/simple/changes"
DRAFTS = "/v1/simple/drafts"
FOUR = ["Ledger v2", "Bulk import", "Bulk export", "Shared report"]


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def world():
    ctx = await make_people()
    w = await World(ctx).build()
    async with tenant_session(ctx.tenant_id) as s:
        led = await s.get(RoadmapItem, w.ids["Ledger v2"])
        for i, (key, title, deps) in enumerate(
            [
                ("bulk-export", "Bulk export", ["bulk-import"]),
                ("shared-report", "Shared report", ["bulk-import", "alert-digest"]),
            ]
        ):
            row = RoadmapItem(roadmap_document_id=led.roadmap_document_id,
                              roadmap_version_id=led.roadmap_version_id, item_key=key,
                              position=10 + i, title=title, horizon="now",
                              track_id=led.track_id, start_date=date(2027, 1, 4),
                              end_date=date(2027, 1, 29), date_source="typed",
                              depends_on=deps)  # fmt: skip
            s.add(row)
            await s.flush()
            w.ids[title] = str(row.id)
        await s.commit()
    return ctx, w


async def cut_titles(w: World) -> set[str]:
    return {t for t in w.ids if (await w.item(t)).cut}


async def n_changes(ctx) -> int:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(SimpleChange)) or 0


async def test_cut_with_dependents_is_one_change_undone_as_one(client):
    ctx, w = await world()
    card = (await say(client, ctx, "owner", "cut Ledger v2"))["cards"][0]
    assert card["op"] == "cut"
    assert card["dependents"] == ["Bulk import", "Bulk export", "Shared report"]
    r = await client.post(f"{CARDS}/{card['id']}/apply", json={"with_dependents": True},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["card"]["status"] == "applied"
    for t in FOUR:
        assert t in out["card"]["summary"]
    change = out["result"]["change"]
    assert change["op"] == "cut_with_dependents"
    assert change["status"] == "applied"
    assert set(change["after"]) == {w.ids[t] for t in FOUR}
    assert await n_changes(ctx) == 1
    # Alert digest, which Shared report also waits on, is kept; so is every other item.
    assert await cut_titles(w) == set(FOUR)
    # The change's words and the draft's change list name every item it cut.
    words = change["words"]
    assert "and its dependents" in words
    for t in FOUR:
        assert t in words
    r = await client.get(DRAFTS, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    [log] = [d["change_log"] for d in r.json()]
    assert [c["op"] for c in log] == ["cut_with_dependents"]
    assert log[0]["titles"] == FOUR
    # One Undo puts all four back.
    r = await client.post(f"{CARDS}/{card['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "undone"
    assert await cut_titles(w) == set()
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(SimpleChange).order_by(SimpleChange.at)))
    assert sorted(c.status for c in rows) == ["applied", "undone"]


async def test_cut_keeping_the_dependents_and_an_item_without_any(client):
    ctx, w = await world()
    card = (await say(client, ctx, "owner", "cut Ledger v2"))["cards"][0]
    r = await client.post(f"{CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["result"]["change"]["op"] == "cut"
    assert await cut_titles(w) == {"Ledger v2"}
    lone = (await say(client, ctx, "owner", "cut Alert export"))["cards"][0]
    assert lone["dependents"] == []
    r = await client.post(f"{CARDS}/{lone['id']}/apply", json={"with_dependents": True},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 422, r.text
    assert await cut_titles(w) == {"Ledger v2"}
    # Bulk import's dependents, once Ledger v2 is cut: Bulk export and Shared report.
    bulk = (await say(client, ctx, "owner", "cut Bulk import"))["cards"][0]
    assert bulk["dependents"] == ["Bulk export", "Shared report"]


async def test_cut_with_dependents_follows_roles(client):
    ctx, w = await world()
    card = (await say(client, ctx, "commenter", "cut Ledger v2"))["cards"][0]
    assert card["may"] == "propose"
    assert card["dependents"] == ["Bulk import", "Bulk export", "Shared report"]
    r = await client.post(f"{CARDS}/{card['id']}/apply", json={"with_dependents": True},
                          headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 200, r.text
    change = r.json()["result"]["change"]
    assert (change["op"], change["status"]) == ("cut_with_dependents", "proposed")
    assert change["routed_to"] == [str(ctx.users["decider"].id)]
    assert r.json()["card"]["status"] == "proposed"
    assert await cut_titles(w) == set()
    r = await client.post(f"{CHANGES}/{change['id']}/accept", json={},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert await cut_titles(w) == set(FOUR)
    # A viewer reads the card; its apply is refused.
    v = (await say(client, ctx, "viewer", "cut Alert digest"))["cards"][0]
    assert v["may"] is None and v["why_not"]
    r = await client.post(f"{CARDS}/{v['id']}/apply", json={"with_dependents": True},
                          headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 403
    # Straight through the engine: a stale before is 409 and cuts nothing.
    body = {"op": "cut_with_dependents", "target": {"item_id": w.ids["Ledger v2"]},
            "before": {"cut": False}, "after": {}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 409, r.text


async def test_cut_with_dependents_needs_rights_on_every_item(client):
    """Review major: the approver decides Ledger v2 (its own decider); the roadmap's decider
    decides its dependents. Cutting Ledger v2 alone applies; cutting it with its dependents
    is a proposal (the card says so), routed to the company's owners, who alone decide every
    item it cuts: neither the approver nor the roadmap's decider accepts it."""
    ctx, w = await world()
    async with tenant_session(ctx.tenant_id) as s:
        led = await s.get(RoadmapItem, w.ids["Ledger v2"])
        led.decider_id = ctx.users["approver"].id
        await s.commit()
    card = (await say(client, ctx, "approver", "cut Ledger v2"))["cards"][0]
    assert card["may"] == "apply"
    assert card["may_with_dependents"] == "propose"
    r = await client.post(f"{CARDS}/{card['id']}/apply", json={"with_dependents": True},
                          headers=ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 200, r.text
    change = r.json()["result"]["change"]
    assert (change["op"], change["status"]) == ("cut_with_dependents", "proposed")
    assert change["routed_to"] == [str(ctx.users["owner"].id)]
    assert await cut_titles(w) == set()
    for who in ("approver", "decider"):
        r = await client.post(f"{CHANGES}/{change['id']}/accept", json={}, headers=ctx.as_(who))
        assert r.status_code == 403, r.text
    assert await cut_titles(w) == set()
    r = await client.post(f"{CHANGES}/{change['id']}/accept", json={}, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await cut_titles(w) == set(FOUR)


async def test_cut_with_dependents_refuses_dependents_the_card_never_listed(client):
    """Review minor: the card lists the dependents it read; an item that came to wait on the
    item since is not cut unseen: 409, nothing cut."""
    ctx, w = await world()
    card = (await say(client, ctx, "owner", "cut Ledger v2"))["cards"][0]
    assert len(card["dependent_ids"]) == 3
    async with tenant_session(ctx.tenant_id) as s:
        alert = await s.get(RoadmapItem, w.ids["Alert export"])
        alert.depends_on = ["bulk-export"]
        await s.commit()
    r = await client.post(f"{CARDS}/{card['id']}/apply",
                          json={"with_dependents": True, "dependents": card["dependent_ids"]},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 409, r.text
    assert await cut_titles(w) == set()
    # As seen, it cuts.
    card = (await say(client, ctx, "owner", "cut Ledger v2"))["cards"][-1]
    assert len(card["dependent_ids"]) == 4
    r = await client.post(f"{CARDS}/{card['id']}/apply",
                          json={"with_dependents": True, "dependents": card["dependent_ids"]},
                          headers=ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert await cut_titles(w) == {*FOUR, "Alert export"}


async def test_a_meeting_decision_names_every_item_cut(client):
    """Review minor: meetings.describe names every item a cut with its dependents cut."""
    from oracle.simple import meetings

    ctx, w = await world()
    c = SimpleChange(op="cut_with_dependents",
                     target={"item_id": w.ids["Ledger v2"], "titles": FOUR},
                     before={w.ids[t]: {"cut": False} for t in FOUR},
                     after={w.ids[t]: {"cut": True} for t in FOUR})  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        words, subjects = await meetings.describe(s, c)
    assert words == "Cut with its dependents: Ledger v2, Bulk import, Bulk export and Shared report"
    assert {x["id"] for x in subjects} == {w.ids[t] for t in FOUR}
