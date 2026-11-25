"""#1817: a meeting's action item reaches its owner's Inbox and can be marked done.
Against Postgres, over REST, in S8's world (tests.test_simple_meetings_api).

Test cards (protects / fails_when / no_claim):

- test_action_item_reaches_its_owner_and_is_done_once: protects=the minutes editor keeps
  an action item's linked item; Send records it under that item; its owner's Inbox lists
  it ("Needs you": counted in ``total``) with its due date, linked item and meeting, as
  does their Home waiting list (``action:<id>``); its owner (an approver who does not
  decide the item) marks it done directly, which takes it off both, and one Undo puts it
  back; someone else who does not decide the item only proposes; fails_when=the link is
  dropped, the row never reaches its owner, the count misses it, or its owner can only
  propose; no_claim=the web (web/e2e/inbox-action-items.spec.ts).
"""

from sqlalchemy import select

from oracle.simple.models import SimpleActionItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_drafts_api import inbox
from tests.test_simple_meetings_api import MEETINGS, edit_title, end, get, start, uid, world


async def waiting_keys(client, w, who: str) -> set[str]:
    r = await client.get("/v1/simple/decisions/waiting", headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return {i["key"] for i in r.json()["items"]}


async def test_action_item_reaches_its_owner_and_is_done_once(client):
    """A sent action item reaches its owner's Inbox and Home, and its owner closes it."""
    w = await world()
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    await end(client, w, m["id"])
    feature = next(i for i in (await get(client, w, m["id"]))["agenda"]["items"]
                   if i["feature_id"])  # fmt: skip
    item_id = feature["feature_id"]
    before_total = (await inbox(client, w, "approver"))["total"]
    body = {"summary": "Short", "open_questions": [],
            "action_items": [{"title": "Write the QA plan", "owner_id": uid(w, "approver"),
                              "due_date": "2026-12-01", "item_id": item_id}]}  # fmt: skip
    r = await client.put(f"{MEETINGS}/{m['id']}/minutes", json=body, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    [a] = (await get(client, w, m["id"]))["minutes"]["action_items"]
    assert a["item_id"] == item_id
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={"email": True},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.scalar(select(SimpleActionItem))
        assert row is not None and str(row.item_id) == item_id
        aid = str(row.id)

    got = await inbox(client, w, "approver")
    [mine] = got["simple_action_items"]
    assert (mine["id"], mine["title"], mine["due_date"], mine["item_id"]) == (
        aid, "Write the QA plan", "2026-12-01", item_id)  # fmt: skip
    assert mine["item_title"] and mine["meeting_id"] == m["id"]
    assert mine["meeting_title"] == m["title"]
    assert got["total"] == before_total + 1
    assert f"action:{aid}" in await waiting_keys(client, w, "approver")
    assert (await inbox(client, w, "commenter"))["simple_action_items"] == []

    done = {"op": "set_action_item_status", "target": {"item_id": item_id, "action_item_id": aid},
            "before": {"status": "open"}, "after": {"status": "done"}}  # fmt: skip
    # Not its owner and not the item's decider: a proposal, nothing written.
    r = await client.post(CHANGES, json=done, headers=w.ctx.as_("commenter"))
    assert r.status_code == 201 and r.json()["change"]["status"] == "proposed", r.text
    # Its owner marks it done.
    r = await client.post(CHANGES, json=done, headers=w.ctx.as_("approver"))
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied"
    assert (await inbox(client, w, "approver"))["simple_action_items"] == []
    assert f"action:{aid}" not in await waiting_keys(client, w, "approver")
    # One Undo puts it back.
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=w.ctx.as_("approver"))
    assert r.status_code == 201, r.text
    [back] = (await inbox(client, w, "approver"))["simple_action_items"]
    assert back["id"] == aid
    # Its owner changes its due date.
    edit = {"op": "edit_action_item", "target": {"item_id": item_id, "action_item_id": aid},
            "before": {"due_date": "2026-12-01"}, "after": {"due_date": "2026-12-04"}}  # fmt: skip
    r = await client.post(CHANGES, json=edit, headers=w.ctx.as_("approver"))
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    [moved] = (await inbox(client, w, "approver"))["simple_action_items"]
    assert moved["due_date"] == "2026-12-04"
