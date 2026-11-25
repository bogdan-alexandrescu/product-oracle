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
from oracle.roadmap.models import RoadmapItem
from oracle.simple import change_words
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import make_people
from tests.test_simple_roadmap_api import NOW, by_key, get
from tests.test_simple_panel_fields import Panel
from tests.test_unique_item_codes import one_feature_two_items, set_code
from tests.test_simple_goal_milestones_api import CHANGES

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
    """A rename leading with a taken code is refused for an item with its feature's code (#1815 4)."""
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
    async with tenant_session(p.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(p.a))
        assert row.draft is True
    # Planned again: a forward move, no reason; its dates are where they were.
    r = await p.post(client, "set_status", {"status": "draft"}, {"status": "planned"})
    assert r.status_code == 201, r.text
    a = (await p.read(client))["a"]
    assert a["status"] == "planned"
    assert (a["start"]["date"], a["end"]["date"]) == (before["start"]["date"], before["end"]["date"])


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
