"""Visual QA pass F, F-7: the Inbox's webhook rows (paused, address changed) count in its
total, so the header, the tabs and the rail badge match the rows shown."""

from __future__ import annotations

import pytest

from oracle.review import collab
from oracle.tenancy import tenant_session
from tests.connection_helpers import make_person


@pytest.fixture
async def owner(tenant_id):
    return await make_person(tenant_id, "owner@example.com", "owner")


async def _total(client, owner) -> dict:
    resp = await client.get("/v1/inbox", headers=owner.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_an_unread_webhook_notice_counts_in_the_inbox_total_until_read(
    client, tenant_id, owner
):
    """protects=F-7: a webhook paused or moved notice is a counted Inbox row while unread;
    fails_when=the total leaves it out (the header said 11 with 13 rows shown) or still
    counts it once read."""
    before = await _total(client, owner)
    async with tenant_session(tenant_id) as s:
        await collab.notify(
            s,
            [owner.user.id],
            kind="webhook_paused",
            title="Webhook Deploy bot paused: failing for 3 days",
            actor="system",
            data={"webhook_id": "00000000-0000-0000-0000-000000000001", "reason": "failing"},
        )
        await collab.notify(
            s,
            [owner.user.id],
            kind="webhook_url_changed",
            title="Sam Lee changed where webhook Deploy bot sends",
            actor="system",
            data={"webhook_id": "00000000-0000-0000-0000-000000000001"},
        )
        await s.commit()
    after = await _total(client, owner)
    assert after["webhooks"] == 2
    assert after["total"] == before["total"] + 2

    notes = (await client.get("/v1/me/notifications", headers=owner.headers)).json()
    paused = next(n for n in notes if n["kind"] == "webhook_paused")
    read = await client.post(f"/v1/notifications/{paused['id']}/read", headers=owner.headers)
    assert read.status_code in (200, 204), read.text
    done = await _total(client, owner)
    assert done["webhooks"] == 1
    assert done["total"] == before["total"] + 1
