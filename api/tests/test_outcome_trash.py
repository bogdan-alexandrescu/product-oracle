"""Outcomes edits (Nov 13), Move to Trash: an approver moves an outcome to Trash from its
inspector; it leaves the list, the goal's track record and every count, and Trash's
Restore brings it back as it was. Made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

from datetime import UTC, datetime

from tests.outcome_helpers import outcome_world, set_record
from tests.test_roadmap import (  # noqa: F401 - fixtures
    as_user,
    owner,
    runtime,
)


async def test_an_approver_moves_an_outcome_to_trash_and_restores_it(client, owner, runtime):  # noqa: F811
    """protects=DELETE /v1/outcomes/{id} makes a Trash entry (type outcome, its title),
    the outcome leaves the list, its own read, the track record's counts and the Inbox;
    whoever deleted it restores it and it is back with its prediction; a viewer cannot
    delete; fails_when=it stays listed or counted, a viewer deletes it, or the restore loses
    it; no_claim=the 30-day purge."""
    tenant_id, auth = owner
    by_item = await outcome_world(client, auth, runtime, tenant_id)
    pay = by_item["payment-step"]
    await set_record(tenant_id, pay["id"], status="held", assessed_at=datetime.now(UTC))
    before = (await client.get("/v1/priorities/calibration", headers=auth)).json()
    assert before["company"]["n"] == 1

    viewer = await as_user(tenant_id, "viewer")
    url = f"/v1/outcomes/{pay['id']}"
    assert (await client.delete(url, headers=viewer)).status_code == 403
    approver = await as_user(tenant_id, "approver")
    resp = await client.delete(url, headers=approver)
    assert resp.status_code == 200, resp.text
    entry = resp.json()
    assert entry["root"]["type"] == "outcome" and entry["root"]["kind"] == "outcome"
    assert entry["root"]["title"] == pay["title"] and entry["can_restore"] is True

    listed = (await client.get("/v1/outcomes", headers=auth)).json()
    assert pay["id"] not in {r["id"] for r in listed}
    assert (await client.get(url, headers=auth)).status_code == 404
    after = (await client.get("/v1/priorities/calibration", headers=auth)).json()
    assert after["company"]["n"] == 0
    trash = (await client.get("/v1/trash", headers=approver)).json()
    assert [e["root"]["type"] for e in trash] == ["outcome"] and trash[0]["can_restore"]

    r = await client.post(f"/v1/trash/{entry['id']}/restore", headers=approver)
    assert r.status_code == 200, r.text
    back = (await client.get(url, headers=auth)).json()
    assert back["prediction"] == pay["prediction"] and back["status"] == "held"
    assert (await client.get("/v1/priorities/calibration", headers=auth)).json()["company"][
        "n"
    ] == 1
    assert (await client.get("/v1/trash", headers=auth)).json() == []
