"""edit-goals-prds EG1 (owner's pick a, "Owner in the form"): a goal's owner set in its
form, archived goals listed with Restore, and Ask to archive / Ask to delete for who may
not archive or delete a goal, through the change engine. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_goal_owner_in_the_form: protects=a goal's owner is saved with its other fields
  (create and edit), listed with their name, and cleared with null; an owner who is not
  a member is 422; fails_when=the owner is dropped or a stranger saved;
  no_claim=Baseline's own goal form.
- test_archived_goals_listed_and_restored: protects=an archived goal lists under
  ``archived`` with its owner and the day it was archived; Restore puts it back in the
  buckets (approver and up; a commenter 403) and Undo archives it again;
  fails_when=an archived goal is lost or a commenter restores; no_claim=Trash.
- test_ask_to_archive_and_delete_goes_to_the_decider: protects=a commenter's archive or
  delete of a goal is a proposal (ops ``archive_goal``, ``delete_goal``) routed to the
  company's owners, named in ``asks_to``; the goal stays until an owner accepts, then it
  is archived (its features moved as asked) or in Trash; a declined ask leaves it; an
  approver's change applies at once; a viewer is 403; fails_when=an ask applies at once,
  goes to no one, or an accept does nothing; no_claim=the feature delete ask.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.models import User
from oracle.tenancy import tenant_session
from tests.test_simple_goal_buckets_api import GOAL, URL, World

CHANGES = "/v1/simple/changes"


async def _named(w: World) -> None:
    async with tenant_session(w.ctx.tenant_id) as s:
        for who, name in (("owner", "Avery Stone"), ("approver", "Hana Sato")):
            u = await s.scalar(select(User).where(User.id == w.ctx.users[who].id))
            u.name = name
        await s.commit()


def _goal(out: dict, goal_id: str) -> dict | None:
    return next((g for g in out["goals"] if g["id"] == goal_id), None)


@pytest.mark.asyncio
async def test_goal_owner_in_the_form(client):
    w = await World().build()
    await _named(w)
    hana = str(w.ctx.users["approver"].id)
    r = await client.post(f"{URL}/goals", headers=w.as_("owner"), json={**GOAL, "owner_id": hana})
    assert r.status_code == 201, r.text
    assert r.json()["goal"]["owner_id"] == hana
    assert r.json()["goal"]["owner_name"] == "Hana Sato"

    grow = w.goals["grow"]
    body = {"title": "Grow", "measure": "Shops live", "target": "40 shops", "due": "2027-03-31"}
    r = await client.patch(f"{URL}/goals/{grow}", headers=w.as_("approver"),
                           json={**body, "owner_id": hana})  # fmt: skip
    assert r.status_code == 200, r.text
    listed = _goal(await w.read(client, "viewer"), grow)
    assert (listed["owner_id"], listed["owner_name"]) == (hana, "Hana Sato")

    r = await client.patch(f"{URL}/goals/{grow}", headers=w.as_("owner"),
                           json={**body, "owner_id": str(uuid.uuid4())})  # fmt: skip
    assert r.status_code == 422
    assert _goal(await w.read(client), grow)["owner_id"] == hana

    # Left out, the owner stays; null clears it.
    r = await client.patch(f"{URL}/goals/{grow}", headers=w.as_("owner"), json=body)
    assert r.status_code == 200, r.text
    assert _goal(await w.read(client), grow)["owner_id"] == hana
    r = await client.patch(f"{URL}/goals/{grow}", headers=w.as_("owner"),
                           json={**body, "owner_id": None})  # fmt: skip
    assert r.status_code == 200, r.text
    assert _goal(await w.read(client), grow)["owner_id"] is None


@pytest.mark.asyncio
async def test_archived_goals_listed_and_restored(client):
    w = await World().build()
    await _named(w)
    grow, quiet = w.goals["grow"], w.goals["quiet"]
    hana = str(w.ctx.users["approver"].id)
    body = {"title": "Grow", "measure": "Shops live", "target": "40 shops",
            "due": "2027-03-31", "owner_id": hana}  # fmt: skip
    assert (await client.patch(f"{URL}/goals/{grow}", headers=w.as_("owner"),
                               json=body)).status_code == 200  # fmt: skip
    assert (await w.read(client))["archived"] == []
    r = await client.post(f"{URL}/goals/{grow}/archive", headers=w.as_("owner"),
                          json={"to_goal_id": quiet})  # fmt: skip
    assert r.status_code == 200, r.text
    out = await w.read(client, "viewer")
    assert _goal(out, grow) is None
    (archived,) = out["archived"]
    assert (archived["id"], archived["title"], archived["owner_name"]) == (grow, "Grow", "Hana Sato")
    assert archived["archived_at"]

    r = await client.post(f"{URL}/goals/{grow}/unarchive", headers=w.as_("commenter"))
    assert r.status_code == 403
    r = await client.post(f"{URL}/goals/{grow}/unarchive", headers=w.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["goal"]["id"] == grow
    out = await w.read(client)
    assert _goal(out, grow) is not None and out["archived"] == []

    r = await client.post(f"{URL}/undo", headers=w.as_("approver"), json=r.json()["undo"])
    assert r.status_code == 200, r.text
    assert [a["id"] for a in r.json()["archived"]] == [grow]


@pytest.mark.asyncio
async def test_ask_to_archive_and_delete_goes_to_the_decider(client):
    w = await World().build()
    await _named(w)
    grow, quiet = w.goals["grow"], w.goals["quiet"]
    owner = str(w.ctx.users["owner"].id)
    assert (await w.read(client, "commenter"))["asks_to"] == ["Avery Stone"]

    ask = {"op": "archive_goal", "target": {"goal_id": grow, "to_goal_id": quiet},
           "before": {}, "after": {}}  # fmt: skip
    r = await client.post(CHANGES, headers=w.as_("viewer"), json=ask)
    assert r.status_code == 403
    r = await client.post(CHANGES, headers=w.as_("commenter"), json=ask)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "proposed" and change["routed_to"] == [owner]
    assert "proposed: archive the goal Grow" in change["words"]
    assert _goal(await w.read(client), grow) is not None
    r = await client.post(CHANGES, headers=w.as_("commenter"), json=ask)
    assert r.status_code == 409

    r = await client.post(f"{CHANGES}/{change['id']}/accept", headers=w.as_("commenter"), json={})
    assert r.status_code == 403
    r = await client.post(f"{CHANGES}/{change['id']}/accept", headers=w.as_("owner"), json={})
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "accepted"
    out = await w.read(client)
    assert _goal(out, grow) is None and [a["id"] for a in out["archived"]] == [grow]
    assert (await w.links(client))["solo"] == ["quiet"]

    # Delete: declined leaves the goal; accepted, it goes to Trash.
    dele = {"op": "delete_goal", "target": {"goal_id": quiet}, "before": {}, "after": {}}
    r = await client.post(CHANGES, headers=w.as_("commenter"), json=dele)
    assert r.status_code == 201, r.text
    cid = r.json()["change"]["id"]
    assert "proposed: move the goal Quiet to Trash" in r.json()["change"]["words"]
    r = await client.post(f"{CHANGES}/{cid}/decline", headers=w.as_("owner"), json={"reason": "No"})
    assert r.status_code == 200, r.text
    assert _goal(await w.read(client), quiet) is not None
    r = await client.post(CHANGES, headers=w.as_("commenter"), json=dele)
    cid = r.json()["change"]["id"]
    r = await client.post(f"{CHANGES}/{cid}/accept", headers=w.as_("owner"), json={})
    assert r.status_code == 200, r.text
    assert _goal(await w.read(client), quiet) is None
    listed = (await client.get("/v1/trash", headers=w.as_("owner"))).json()
    assert [e["root"]["id"] for e in listed] == [quiet]

    # An approver's own change applies at once.
    r = await client.post(f"{URL}/goals", headers=w.as_("owner"), json=GOAL)
    made = r.json()["goal"]["id"]
    r = await client.post(CHANGES, headers=w.as_("approver"),
                          json={**ask, "target": {"goal_id": made}})  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    assert _goal(await w.read(client), made) is None
