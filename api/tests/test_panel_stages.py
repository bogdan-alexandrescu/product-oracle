"""panel-stages (#1815, #1879): the feature panel's Code and Status rules. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_a_slice_code_is_set_as_the_roadmap_shows_it: protects=``set_code`` takes ``f-29a``
  and stores F-29a; fails_when=the letter is upper-cased and the code refused; no_claim=web.
- test_a_refused_code_says_why_in_plain_words: protects=a malformed code reads "A code looks
  like F-31 or F-31a"; fails_when=a field path ("after.code: ...") is shown; no_claim=web.
- test_a_rename_of_an_item_with_its_features_code_is_checked: protects=a rename leading with
  a code another item reads is refused for an item whose code comes from its feature;
  fails_when=two items share one code; no_claim=PRD codes.
- test_a_planned_item_moves_back_to_draft_with_a_reason_and_keeps_its_plan: protects=Draft
  sets draft, keeps the dates, needs a reason, reads in history; planned restores;
  fails_when=no way back, a backward move without a reason lands, or dates are lost;
  no_claim=the flags of its dependants.
- test_planned_on_a_draft_confirms_it: protects=Planned on a draft is no silent no-op;
  fails_when=the item stays a draft; no_claim=keep_both.
- test_planned_on_a_shipped_item_reopens_it: protects=a shipped mark from elsewhere is
  reopened by Planned or Draft (with a reason), and the mark stays in the change's
  ``before``; fails_when=the item still reads done; no_claim=the tracker's records.
"""

import uuid

import pytest

from oracle import company_time
from oracle.roadmap.models import RoadmapItem, TrackerRecord
from oracle.simple import change_words
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import make_people
from tests.test_simple_goal_milestones_api import CHANGES
from tests.test_simple_panel_fields import Panel
from tests.test_simple_roadmap_api import NOW, Seed, by_key, get
from tests.test_unique_item_codes import one_feature_two_items, set_code

pytestmark = pytest.mark.asyncio(loop_scope="session")


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_a_slice_code_is_set_as_the_roadmap_shows_it(client):
    """A slice code typed in either case is stored as the roadmap shows it (#1815 1)."""
    ctx = await make_people()
    _, b = await one_feature_two_items(ctx)
    r = await set_code(client, ctx, b, "F-64", "f-29A")
    assert r.status_code == 201, r.text
    assert by_key(await get(client, ctx, "owner"))["b"]["code"] == "F-29a"


async def test_a_refused_code_says_why_in_plain_words(client):
    """A malformed code is refused in plain words, no field path (#1815 2)."""
    ctx = await make_people()
    _, b = await one_feature_two_items(ctx)
    for bad in ("F29", "F-2b9", "Alerts"):
        r = await set_code(client, ctx, b, "F-64", bad)
        assert r.status_code == 422, r.text
        assert r.json()["detail"] == "A code looks like F-31 or F-31a"


async def test_a_rename_of_an_item_with_its_features_code_is_checked(client):
    """A rename leading with a taken code is refused, code from a feature too (#1815 4)."""
    ctx = await make_people()
    a, _ = await one_feature_two_items(ctx)
    body = {"op": "edit_title", "target": {"item_id": a}, "before": {"title": "Alert routing"},
            "after": {"title": "F-64 Alert routing"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-64 is already the code of F-64 Routing by team"
    shown = by_key(await get(client, ctx, "owner"))
    assert (shown["a"]["code"], shown["b"]["code"]) == ("F-51", "F-64")


async def test_a_planned_item_moves_back_to_draft_with_a_reason_and_keeps_its_plan(client):
    """Plan to Draft needs a reason, keeps the dates and reads in history (#1879)."""
    p = await Panel().build(await make_people())
    before = (await p.read(client))["a"]
    assert before["status"] == "planned"
    r = await p.post(client, "set_status", {"status": "planned"}, {"status": "draft"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "Say why it moves back"
    r = await p.post(client, "set_status", {"status": "planned"},
                     {"status": "draft", "reason": "Planned too early"})  # fmt: skip
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    words = change_words.phrase(c["op"], c["target"], c["before"], c["after"], "Alpha")
    assert words == "moved Alpha back to Draft: Planned too early"
    a = (await p.read(client))["a"]
    assert a["status"] == "draft"
    # Planned again: a forward move, no reason; its dates are where they were.
    r = await p.post(client, "set_status", {"status": "draft"}, {"status": "planned"})
    assert r.status_code == 201, r.text
    a = (await p.read(client))["a"]
    assert a["status"] == "planned"
    assert (a["start"]["date"], a["end"]["date"]) == (
        before["start"]["date"],
        before["end"]["date"],
    )


async def test_planned_on_a_draft_confirms_it(client):
    """Planned on a draft confirms it, no silent no-op (#1879)."""
    p = await Panel().build(await make_people())
    async with tenant_session(p.ctx.tenant_id) as s:
        (await s.get(RoadmapItem, uuid.UUID(p.b))).draft = True
        await s.commit()
    assert (await p.read(client))["b"]["status"] == "draft"
    r = await p.post(client, "set_status", {"status": "draft"}, {"status": "planned"}, item=p.b)
    assert r.status_code == 201, r.text
    assert (await p.read(client))["b"]["status"] == "planned"


async def test_planned_on_a_shipped_item_reopens_it(client):
    """Planned on an item shipped elsewhere reopens it, with a reason (#1879)."""
    p = await Panel().build(await make_people())
    mark = {"note": "Shipped in the partner app", "on": "2026-10-01"}
    async with tenant_session(p.ctx.tenant_id) as s:
        (await s.get(RoadmapItem, uuid.UUID(p.a))).shipped = mark
        await s.commit()
    assert (await p.read(client))["a"]["status"] == "done"
    r = await p.post(client, "set_status", {"status": "done"}, {"status": "planned"})
    assert r.status_code == 422, r.text
    r = await p.post(client, "set_status", {"status": "done"},
                     {"status": "planned", "reason": "Not live yet"})  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["change"]["before"]["shipped"] == mark
    assert (await p.read(client))["a"]["status"] == "planned"


async def test_a_rename_of_an_item_with_its_features_code_takes_no_other_code(client):
    """A rename of an item whose code comes from its feature is checked like the Code field:
    a Ground Truth feature's code is refused (#1815 4)."""
    # protects=an item reading its feature's code cannot take another feature's code by a
    # rename; fails_when=the rename lands and the item reads F-83 as its own; no_claim=PRD codes
    # (the same _inherited path).
    ctx = await make_people()
    a, _ = await one_feature_two_items(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        (await Seed(s).entity("feature", "F-83")).title = "Example item"
        await s.commit()
    body = {"op": "edit_title", "target": {"item_id": a}, "before": {"title": "Alert routing"},
            "after": {"title": "F-83 Alert routing"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "F-83 is already the code of a Ground Truth feature"
    assert by_key(await get(client, ctx, "owner"))["a"]["code"] == "F-51"
    # Its own feature's code in front is no new code: the rename lands.
    body["after"] = {"title": "F-51 Alert routing"}
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text


async def test_a_move_back_of_an_item_done_in_its_tracker_says_why_it_cannot(client):
    """An item that reads Done from its tracker's records is not silently left Done (#1879)."""
    # protects=Planned on an item whose tracker records are all done is refused in plain words;
    # fails_when=the change applies and the item still reads Done; no_claim=the tracker.
    p = await Panel().build(await make_people())
    async with tenant_session(p.ctx.tenant_id) as s:
        s.add(TrackerRecord(tracker="linear", external_ref="ENG-9", track_id=p.track.id,
                            item_key="a", state="done", observed_at=NOW))  # fmt: skip
        await s.commit()
    assert (await p.read(client))["a"]["status"] == "done"
    r = await p.post(client, "set_status", {"status": "done"},
                     {"status": "planned", "reason": "Not live yet"})  # fmt: skip
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "Its tracker says it is done: reopen it there"
    assert (await p.read(client))["a"]["status"] == "done"


async def test_an_item_that_depends_on_a_draft_is_flagged(client):
    """Moved back to Draft, the items that depend on it are flagged; planned again, not (#1879)."""
    # protects=the depends_on_draft flag on a dependant; fails_when=no flag, or it stays after
    # planning again; no_claim=web.
    p = await Panel().build(await make_people())
    r = await p.post(client, "set_depends", {"depends_on": []}, {"depends_on": ["a"]}, item=p.b)
    assert r.status_code == 201, r.text
    r = await p.post(client, "set_status", {"status": "planned"},
                     {"status": "draft", "reason": "Planned too early"})  # fmt: skip
    assert r.status_code == 201, r.text
    b = (await p.read(client))["b"]
    flag = next(f for f in b["flags"] if f["kind"] == "depends_on_draft")
    assert flag["subject"] == p.a
    r = await p.post(client, "set_status", {"status": "draft"}, {"status": "planned"})
    assert r.status_code == 201, r.text
    assert "depends_on_draft" not in [f["kind"] for f in (await p.read(client))["b"]["flags"]]


def take(client, ctx, item: str, before: str, who: str = "owner"):
    body = {"op": "take_feature_code", "target": {"item_id": item}, "before": {"code": before},
            "after": {}}  # fmt: skip
    return client.post(CHANGES, json=body, headers=ctx.as_(who))


async def test_an_item_takes_its_features_code_and_the_other_a_new_number(client):
    """Give the feature's code to this item: the item that had it takes the next free number;
    one change, one Undo; a commenter's is a proposal (#1815 5)."""
    # protects=take_feature_code moves F-51 from a to b and numbers a; fails_when=both read
    # F-51, a keeps it, or an Undo leaves one of them changed; no_claim=web.
    ctx = await make_people()
    _, b = await one_feature_two_items(ctx)
    r = await take(client, ctx, b, "F-64", who="commenter")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    r = await take(client, ctx, b, "F-64")
    assert r.status_code == 201, r.text
    c = r.json()["change"]
    shown = by_key(await get(client, ctx, "owner"))
    assert (shown["b"]["code"], shown["b"]["code_from"]) == ("F-51", "feature")
    assert shown["a"]["code"] == "F-65" and shown["a"]["code_from"] is None
    words = change_words.phrase(c["op"], c["target"], c["before"], c["after"], "Routing by team")
    assert words == "gave Routing by team the code F-51; Alert routing is now F-65"
    u = await client.post(f"{CHANGES}/{c['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code == 201, u.text
    shown = by_key(await get(client, ctx, "owner"))
    assert (shown["a"]["code"], shown["b"]["code"]) == ("F-51", "F-64")
    # An item that already reads its feature's code has nothing to take.
    r = await take(client, ctx, shown["a"]["id"], "F-51")
    assert r.status_code == 422, r.text
    assert r.json()["detail"] == "It already has its feature's code"
