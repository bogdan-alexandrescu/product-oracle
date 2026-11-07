"""G-4: each Settings › Trash entry says what Restore brings back. A goal's entry counts the
features that served it (``root.features``), whether the delete moved them to another goal or
left them; a removed agenda item names its meeting (``root.meeting``).

Each test's card is one line: protects / fails_when. Synthetic placeholders only.
"""

import pytest

from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_goal_buckets_api import URL as BUCKETS
from tests.test_simple_goal_buckets_api import World as Buckets
from tests.test_simple_meeting_agenda_edit import live, op
from tests.test_simple_meetings_api import get, world


async def _listed(client, as_: dict) -> list[dict]:
    r = await client.get("/v1/trash", headers=as_)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.asyncio
@pytest.mark.parametrize("move", [True, False])
async def test_a_deleted_goal_counts_the_features_that_come_back_with_it(client, move):
    """protects=a goal served by solo and both lists in Trash with features 2, moved to
    another goal or not; a feature has no count; fails_when=the entry reads as a bare goal."""
    w = await Buckets().build()
    grow, quiet = w.goals["grow"], w.goals["quiet"]
    params = {"to_goal_id": quiet} if move else {}
    r = await client.delete(f"{BUCKETS}/goals/{grow}", params=params, headers=w.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["entry"]["root"]["features"] == 2

    (e,) = await _listed(client, w.as_("owner"))
    assert (e["root"]["title"], e["root"]["features"], e["root"]["meeting"]) == ("Grow", 2, None)


@pytest.mark.asyncio
async def test_a_removed_agenda_item_names_its_meeting(client):
    """protects=a removed agenda item lists in Trash with its meeting's title;
    fails_when=the entry does not say which meeting Restore puts it back on."""
    w = await world()
    mid = await live(client, w)
    m = await get(client, w, mid, "owner")
    item = m["agenda"]["items"][-1]["id"]
    r = await op(client, w, "owner", mid, op="remove", item_id=item, batch="t1")
    assert r.status_code == 200, r.text

    listed = await _listed(client, w.ctx.as_("owner"))
    e = next(x for x in listed if x["root"]["type"] == "agenda_item")
    assert e["root"]["meeting"] == m["title"] and e["root"]["features"] is None
