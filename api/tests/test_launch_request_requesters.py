"""H10 Reasoned no, lane 1 (API): H6's request lookup, so launch notes reach the people
who filed requests for what shipped.

Test card: protects=criterion 8 (a launch whose item's feature matches a Qualified request
lists that asker and the asker of a request merged into it in list_requesters, and
sync_notes drafts a note for each); fails_when=the lookup is not registered, misses the
merged asker, lists a New or disqualified request, or a note is missing; no_claim=the
notes' text and how they are sent (H6). Made-up names only.
"""

import uuid

from sqlalchemy import select

from oracle.baseline.models import Entity
from oracle.launches import requesters
from oracle.launches.models import Launch, RequesterNote
from oracle.tenancy import tenant_session
from tests.launch_helpers import launched_world
from tests.test_roadmap import owner, runtime  # noqa: F401 - fixtures


async def _post(client, auth, path: str, body: dict) -> dict:
    resp = await client.post(path, json=body, headers=auth)
    assert resp.status_code in (200, 201), resp.text
    return resp.json()


async def test_requests_for_a_launched_feature_get_notes(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    by_item = await launched_world(client, auth, runtime, tenant_id)
    async with tenant_session(tenant_id) as s:
        pay = await s.scalar(select(Entity.id).where(Entity.key == "payment-step"))
        goal = await s.scalar(select(Entity.id).where(Entity.key == "activation"))
    asked = await _post(client, auth, "/v1/requests", {
        "title": "Keep my card for next time", "channel": "support",
        "requester_name": "Buyer at a pilot customer", "requester_kind": "customer",
    })  # fmt: skip
    resp = await client.patch(f"/v1/requests/{asked['id']}", json={
        "lock_version": asked["lock_version"], "feature_id": str(pay)}, headers=auth)  # fmt: skip
    assert resp.status_code == 200, resp.text
    await _post(client, auth, f"/v1/requests/{asked['id']}/qualify",
                {"lock_version": resp.json()["lock_version"], "goal_ids": [str(goal)]})  # fmt: skip
    merged = await _post(client, auth, "/v1/requests", {
        "title": "Saved cards", "channel": "sales"})  # fmt: skip
    await _post(client, auth, f"/v1/requests/{merged['id']}/merge",
                {"lock_version": merged["lock_version"], "into_id": asked["id"]})  # fmt: skip
    # A New request for the same feature is no requester yet.
    stray = await _post(client, auth, "/v1/requests", {"title": "Card wallet", "channel": "team"})
    resp = await client.patch(f"/v1/requests/{stray['id']}", json={
        "lock_version": stray["lock_version"], "feature_id": str(pay)}, headers=auth)  # fmt: skip
    assert resp.status_code == 200, resp.text

    async with tenant_session(tenant_id) as s:
        launch = await s.get(Launch, uuid.UUID(by_item["payment-step"]["id"]))
        found = await requesters.list_requesters(s, launch)
        from_requests = [r for r in found if r.kind == "request"]
        assert {(r.request_id, r.display_name) for r in from_requests} == {
            (uuid.UUID(asked["id"]), "Buyer at a pilot customer"),
            (uuid.UUID(merged["id"]), "Unnamed asker"),
        }
        assert next(r for r in from_requests if r.display_name == "Unnamed asker").asked == (
            "Saved cards"
        )
        await requesters.sync_notes(s, launch)
        await s.commit()
        notes = list(
            await s.scalars(
                select(RequesterNote).where(
                    RequesterNote.launch_id == launch.id, RequesterNote.requester_kind == "request"
                )
            )
        )
    assert {n.request_id for n in notes} == {uuid.UUID(asked["id"]), uuid.UUID(merged["id"])}
