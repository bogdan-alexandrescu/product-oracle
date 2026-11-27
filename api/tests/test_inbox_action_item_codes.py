"""inbox-codes (#1786, reopened): a meeting action item's Inbox row carries its linked
feature's code (``item_code``), read at the source as the roadmap reads it, so the row names
the feature with its code. Against Postgres, in S8's world (tests.test_simple_meetings_api).

Test cards (protects / fails_when / no_claim):

- test_an_action_items_row_carries_its_features_code: protects=the owner's Inbox row of an
  action item linked to an item imported from PRD section f-77 carries ``item_code``, the
  same code the Simple roadmap read gives that item; fails_when=the row has no code, or
  another one; no_claim=the web (e2e/inbox-proposal-codes.spec.ts covers the shared name).
"""

import uuid

from sqlalchemy import update

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_drafts_api import inbox
from tests.test_simple_meetings_api import MEETINGS, edit_title, end, get, start, uid, world


async def test_an_action_items_row_carries_its_features_code(client):
    """A sent action item's Inbox row names its linked item's code."""
    w = await world()
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    await end(client, w, m["id"])
    feature = next(i for i in (await get(client, w, m["id"]))["agenda"]["items"]
                   if i["feature_id"])  # fmt: skip
    item_id = feature["feature_id"]
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.id == uuid.UUID(item_id))
            .values(prd_section_key="f-77")
        )
        await s.commit()
    body = {"summary": "Short", "open_questions": [],
            "action_items": [{"title": "Write the QA plan", "owner_id": uid(w, "approver"),
                              "due_date": "2026-12-01", "item_id": item_id}]}  # fmt: skip
    r = await client.put(f"{MEETINGS}/{m['id']}/minutes", json=body, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={"email": True},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    [mine] = (await inbox(client, w, "approver"))["simple_action_items"]
    r = await client.get("/v1/simple/roadmap", headers=w.ctx.as_("approver"))
    assert r.status_code == 200, r.text
    [read] = [i for i in r.json()["items"] if i["id"] == item_id]
    assert read["code"]
    assert mine["item_code"] == read["code"]
