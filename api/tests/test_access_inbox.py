"""#245 (A5 follow-up): an access change still failing after 24 hours becomes an owner
Inbox item with Retry. A revoke (or a restore's grant) of someone's Google IAP access
that keeps failing is retried by the tick for 24 hours, then once a day; past the 24
hours owners see it in the Inbox (``access_failures``) until it succeeds or is no
longer needed. Retry is owner-only, same-origin, refused for run and read-only tokens,
and audited.

Against a fake IAP policy client and a fake mailer: no Google or mail calls.
"""

import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select

from oracle.members import iap_access
from oracle.members.models import MemberFollowUp
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests import test_invite_delivery as invites
from tests.review_v2_helpers import person
from tests.test_invite_delivery import (
    BACKENDS,
    GOOGLE_BODY,
    FakeAuth,
    _audit,
    _follow_ups,
    _invite,
    _tick,
)

# The fake IAP client, the fake mailer and the seeded owner of #242's tests.
iap, mail, owner = invites.iap, invites.mail, invites.owner

ADDRESS = "pat@example.com"


async def _failing_revoke(
    client, tenant_id, headers, iap, reason="Google returned 403 (permission denied)"
):
    """Invite pat, then revoke the invite while Google refuses: an owed iap_revoke."""
    body = await _invite(client, headers, ADDRESS)
    iap.fail = reason
    assert (await client.delete(f"/v1/invites/{body['id']}", headers=headers)).status_code == 204
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    return row.id


async def _age(tenant_id, hours: int = 25) -> None:
    async with tenant_session(tenant_id) as s:
        for row in await s.scalars(select(MemberFollowUp)):
            row.created_at = datetime.now(UTC) - timedelta(hours=hours)
        await s.commit()


async def _access_failures(client, headers) -> list[dict]:
    resp = await client.get("/v1/inbox", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["access_failures"]


async def test_a_revoke_failing_past_24_hours_becomes_an_inbox_item(client, owner, iap, mail):
    tenant_id, headers = owner
    follow_up_id = await _failing_revoke(client, tenant_id, headers, iap)
    # Within the 24 hours: retried by the tick, not in the Inbox yet.
    await _tick(tenant_id)
    assert await _access_failures(client, headers) == []

    await _age(tenant_id)
    await _tick(tenant_id)
    [item] = await _access_failures(client, headers)
    assert item["id"] == str(follow_up_id)
    assert item["email"] == ADDRESS
    assert item["kind"] == "iap_revoke"
    assert item["owed"] == "Access not removed"
    assert item["last_error"] == "oracle-api-be: Google returned 403 (permission denied)"
    assert item["attempts"] == 3
    assert item["created_at"]
    total = (await client.get("/v1/inbox", headers=headers)).json()["total"]
    assert total >= 1

    # Retries go on, once a day.
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    assert row.next_attempt_at is not None
    wait = row.next_attempt_at - datetime.now(UTC)
    assert timedelta(hours=23) < wait <= timedelta(days=1)
    await _tick(tenant_id)  # due again (the helper makes every follow-up due)
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    assert row.attempts == 4

    # A later success closes it.
    iap.fail = None
    await _tick(tenant_id)
    assert iap.bound(ADDRESS) == []
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    assert (row.status, row.outcome) == ("done", "removed")
    assert await _access_failures(client, headers) == []


async def test_no_longer_needed_closes_the_item(client, owner, iap, mail):
    tenant_id, headers = owner
    await _failing_revoke(client, tenant_id, headers, iap)
    await _age(tenant_id)
    await _tick(tenant_id)
    assert len(await _access_failures(client, headers)) == 1
    # Invited again: the person needs the access; the revoke is no longer owed.
    iap.fail = None
    await _invite(client, headers, ADDRESS)
    await _tick(tenant_id)
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    assert (row.status, row.outcome) == ("done", "kept")
    assert iap.bound(ADDRESS) == BACKENDS
    assert await _access_failures(client, headers) == []


async def test_owner_retry_runs_it_now_and_is_audited(client, owner, iap, mail):
    tenant_id, headers = owner
    follow_up_id = await _failing_revoke(client, tenant_id, headers, iap)
    await _age(tenant_id)
    await _tick(tenant_id)
    # Still failing: the item stays, the attempt is audited as the owner's.
    resp = await client.post(f"/v1/member-follow-ups/{follow_up_id}/retry", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "failed"
    assert len(await _access_failures(client, headers)) == 1

    iap.fail = None
    resp = await client.post(f"/v1/member-follow-ups/{follow_up_id}/retry", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "done"
    assert iap.bound(ADDRESS) == []
    assert await _access_failures(client, headers) == []
    events = await _audit(tenant_id, "invite_access.remove")
    manual = [e for e in events if e.get("retried_by_owner")]
    assert [e["outcome"] for e in manual] == ["failed", "removed"]
    assert all(e["email"] == ADDRESS for e in manual)


async def test_approvers_neither_see_nor_retry_it(client, owner, iap, mail):
    tenant_id, headers = owner
    follow_up_id = await _failing_revoke(client, tenant_id, headers, iap)
    await _age(tenant_id)
    await _tick(tenant_id)
    approver = await person(tenant_id, "approver", "sam")
    assert await _access_failures(client, approver.headers) == []
    iap.fail = None
    gets = iap.gets
    resp = await client.post(
        f"/v1/member-follow-ups/{follow_up_id}/retry", headers=approver.headers
    )
    assert resp.status_code == 403, resp.text
    assert iap.gets == gets
    assert len(await _access_failures(client, headers)) == 1


async def test_retry_refuses_another_origin(client, owner, iap, mail):
    tenant_id, headers = owner
    follow_up_id = await _failing_revoke(client, tenant_id, headers, iap)
    await _age(tenant_id)
    await _tick(tenant_id)
    iap.fail = None
    signed_in = await person(tenant_id, "owner", "kim")
    path = f"/v1/member-follow-ups/{follow_up_id}/retry"
    gets = iap.gets
    for extra in (
        {"Origin": "https://evil.example.net"},
        {"Origin": "null"},
        {"Sec-Fetch-Site": "cross-site"},
    ):
        resp = await client.post(path, headers={**signed_in.headers, **extra})
        assert resp.status_code == 403, (extra, resp.text)
        assert "Cross-site" in resp.json()["detail"]
    assert iap.gets == gets
    ok = await client.post(path, headers={**signed_in.headers, "Origin": "http://localhost:3000"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "done"


async def test_run_and_read_only_tokens_cannot_retry(client, iap):
    # No mail fixture: its public URL would move the OAuth issuer the bearer needs.
    from oracle.auth.deps import RUN_HEADER, RUN_TOKEN_HEADER
    from oracle.auth.service import sign_run_binding
    from tests.test_account import _admin_id, _run_token
    from tests.test_read_only_credentials import _bearer

    read_only = await _bearer(client, "oracle:read")
    r = await seed()
    headers = {"Authorization": f"Bearer {r.token}"}
    follow_up_id = await _failing_revoke(client, r.tenant_id, headers, iap)
    await _age(r.tenant_id)
    await _tick(r.tenant_id)
    iap.fail = None
    admin_id = await _admin_id(r.tenant_id)
    run = await _run_token(r.tenant_id, admin_id, ["read:documents"])
    gets = iap.gets
    for refused in (
        read_only,
        {**headers, RUN_TOKEN_HEADER: run},
        {**headers, RUN_HEADER: sign_run_binding(admin_id, uuid.uuid4())},
    ):
        resp = await client.post(f"/v1/member-follow-ups/{follow_up_id}/retry", headers=refused)
        assert resp.status_code == 403, resp.text
    assert iap.gets == gets
    assert len(await _access_failures(client, headers)) == 1


async def test_the_item_never_holds_googles_response_body(client, owner, iap, mail, monkeypatch):
    tenant_id, headers = owner
    await _invite(client, headers, ADDRESS)
    real = iap_access.GoogleIapClient("oracle-prod", FakeAuth())
    transport = httpx.MockTransport(lambda r: httpx.Response(403, json=GOOGLE_BODY))
    monkeypatch.setattr(iap_access, "get_client", lambda: real)
    opened = httpx.AsyncClient  # every client Oracle opens meanwhile answers 403
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: opened(transport=transport))
    invites = (await client.get("/v1/invites", headers=headers)).json()
    [invite] = [i for i in invites if i["email"] == ADDRESS]
    assert (await client.delete(f"/v1/invites/{invite['id']}", headers=headers)).status_code == 204
    await _age(tenant_id)
    await _tick(tenant_id)
    [item] = await _access_failures(client, headers)
    assert item["last_error"] == "oracle-api-be: Google returned 403 (permission denied)"
    assert "4815162342" not in json.dumps(item)
