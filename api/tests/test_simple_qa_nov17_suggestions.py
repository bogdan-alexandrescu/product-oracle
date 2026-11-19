"""qa-nov17: an open date suggestion leaves the roadmap read once it no longer fits the item.

- test_dates_set_here_close_the_suggestion: protects=a person sets an undated item's dates
  (move_dates): the read drops its open suggestion, Needs a decision's count
  (/v1/simple/roadmap/waiting) and the Inbox's dates to confirm drop it too; fails_when=the
  item still carries Oracle's old suggestion (Accept would only answer "outdated").
- test_a_new_dependency_closes_a_suggestion_it_moves: protects=a dependency added to an
  undated item moves its estimate past Oracle's suggestion: the read shows one estimate, the
  suggestion is left out; fails_when=the panel would show the moved estimate and the old
  suggestion side by side.
- test_a_dependency_outdated_suggestion_is_no_estimate_basis: protects=once a new dependency
  outdates an item's open suggestion, its estimate_basis no longer reads "suggestion" (the
  Dates (i) would say the dates were accepted into a draft) and its column stays the one its
  moved estimate puts it in; fails_when=estimate_basis still reads "suggestion".

Invented data (the payments roadmap of tests.test_simple_roadmap_api).
"""

from __future__ import annotations

from datetime import date, timedelta

from tests.test_simple_changes_api import CHANGES, World, make_people
from tests.test_simple_roadmap_api import by_key, get

WAITING = "/v1/simple/roadmap/waiting"
INBOX = "/v1/inbox"


async def waiting(client, ctx) -> int:
    r = await client.get(WAITING, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return r.json()["dates_to_confirm"]


async def inbox_items(client, ctx) -> set[str]:
    r = await client.get(INBOX, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return {x["item_id"] for x in r.json().get("simple_date_suggestions", [])}


async def test_dates_set_here_close_the_suggestion(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=False, ops=["move_dates"])
    u = w.ids["move_dates-u"]
    assert by_key(await get(client, ctx))["move_dates-u"]["suggestion"] is not None
    count = await waiting(client, ctx)
    assert count >= 1
    assert u in await inbox_items(client, ctx)

    body = {
        "op": "move_dates",
        "target": {"item_id": u},
        "before": {"start_date": None, "end_date": None},
        "after": {"start_date": "2027-01-11", "end_date": "2027-02-12"},
    }
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"

    item = by_key(await get(client, ctx))["move_dates-u"]
    assert (item["start"]["date"], item["end"]["date"]) == ("2027-01-11", "2027-02-12")
    assert item["suggestion"] is None
    assert await waiting(client, ctx) == count - 1
    assert u not in await inbox_items(client, ctx)


async def test_a_new_dependency_closes_a_suggestion_it_moves(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=False, ops=["move_dates"])
    a, u = w.ids["move_dates-a"], w.ids["move_dates-u"]
    before = by_key(await get(client, ctx))["move_dates-u"]
    sug = before["suggestion"]
    assert sug is not None
    count = await waiting(client, ctx)

    # The item it will depend on ends well after Oracle's suggested start.
    r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
        "op": "move_dates", "target": {"item_id": a},
        "before": {"start_date": "2026-10-01", "end_date": "2026-11-15"},
        "after": {"start_date": "2027-03-01", "end_date": "2027-09-30"},
    })  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
        "op": "set_depends", "target": {"item_id": u},
        "before": {"depends_on": before["depends_keys"]},
        "after": {"depends_on": [*before["depends_keys"], "move_dates-a"]},
    })  # fmt: skip
    assert r.status_code == 201, r.text

    item = by_key(await get(client, ctx))["move_dates-u"]
    assert item["estimated"] is True
    assert item["start"]["date"] == "2027-10-01"
    assert item["start"]["date"] != sug["start_date"]
    assert item["suggestion"] is None
    assert await waiting(client, ctx) == count - 1


async def test_a_dependency_outdated_suggestion_is_no_estimate_basis(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=False, ops=["move_dates"])
    a, u = w.ids["move_dates-a"], w.ids["move_dates-u"]
    before = by_key(await get(client, ctx))["move_dates-u"]
    sug = before["suggestion"]
    assert sug is not None
    assert before["picked_quarter"] is None
    assert before["estimate_basis"] == "suggestion"

    # The item it will depend on ends on Oracle's suggested start: the estimate moves one day.
    starts = date.fromisoformat(sug["start_date"])
    r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
        "op": "move_dates", "target": {"item_id": a},
        "before": {"start_date": "2026-10-01", "end_date": "2026-11-15"},
        "after": {"start_date": str(starts - timedelta(days=30)), "end_date": str(starts)},
    })  # fmt: skip
    assert r.status_code == 201, r.text
    r = await client.post(CHANGES, headers=ctx.as_("owner"), json={
        "op": "set_depends", "target": {"item_id": u},
        "before": {"depends_on": before["depends_keys"]},
        "after": {"depends_on": [*before["depends_keys"], "move_dates-a"]},
    })  # fmt: skip
    assert r.status_code == 201, r.text

    item = by_key(await get(client, ctx))["move_dates-u"]
    assert item["start"]["date"] == str(starts + timedelta(days=1))
    assert item["suggestion"] is None
    assert item["estimated"] is True
    assert item["estimate_basis"] != "suggestion"
    # Its column is the one its moved estimate puts it in, as before.
    assert item["horizon"] == before["horizon"]
