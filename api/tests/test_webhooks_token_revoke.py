"""I1: revoking a user-less API token pauses the webhooks it created, as a disabled member's
pause (owner decision, 2026-10-26): ``creator_disabled``, an audit event, and one Inbox row
per owner naming the webhook, with Resume and Take over. Invented data only."""

import uuid

import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.auth.service import create_api_token
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from oracle.webhooks.models import Webhook
from tests.connection_helpers import make_person


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


async def _token(tenant_id, name: str, role: str = "owner") -> tuple[str, dict[str, str]]:
    async with tenant_session(tenant_id) as s:
        token, raw = await create_api_token(s, name)
        token.role = role
        await s.commit()
        return str(token.id), {"authorization": f"Bearer {raw}"}


async def _hook(client, headers, name: str = "Bot") -> str:
    resp = await client.post(
        "/v1/webhooks",
        json={"name": name, "url": "https://hooks.example.test/in", "event_types": ["run.started"]},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["webhook"]["id"]


async def _revoke(client, headers, token_id: str) -> None:
    resp = await client.delete(f"/v1/api-tokens/{token_id}", headers=headers)
    assert resp.status_code == 204, resp.text


async def _status(tenant_id, hook_id: str) -> tuple[str, str | None]:
    async with tenant_session(tenant_id) as s:
        hook = await s.get(Webhook, uuid.UUID(hook_id))
        return hook.status, hook.paused_reason


async def _paused_rows(client, headers) -> list[dict]:
    inbox = (await client.get("/v1/me/notifications", headers=headers)).json()
    return [n for n in inbox if n["kind"] == "webhook_paused"]


async def test_a_revoke_pauses_only_that_tokens_webhooks(client, tenant_id):
    """protects=owner decision 2026-10-26: the revoked token's own webhooks pause
    (creator_disabled, audited); another token's, a member's and one made through a
    member's personal token keep sending; fails_when=the revoked token's webhook stays
    active, or another one pauses."""
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    ci, ci_headers = await _token(tenant_id, "ci-export")
    _, other_headers = await _token(tenant_id, "nightly-sync")
    async with tenant_session(tenant_id) as s:
        personal, raw = await create_api_token(s, "laptop", user_id=owner.user.id)
        await s.commit()
    mine = await _hook(client, ci_headers, "Export bot")
    theirs = await _hook(client, other_headers, "Sync bot")
    members = await _hook(client, owner.headers, "Owner bot")
    through_personal = await _hook(client, {"authorization": f"Bearer {raw}"}, "Laptop bot")

    await _revoke(client, owner.headers, ci)

    assert await _status(tenant_id, mine) == ("paused", "creator_disabled")
    for other in (theirs, members, through_personal):
        assert await _status(tenant_id, other) == ("active", None)
    async with tenant_session(tenant_id) as s:
        (row,) = await s.scalars(
            select(AuditEvent).where(
                AuditEvent.action == "webhook.pause", AuditEvent.entity_id == uuid.UUID(mine)
            )
        )
    assert row.data == {"name": "Export bot", "reason": "creator_disabled"}
    # The list names the creator as a token, so Settings › Webhooks can say why in words.
    listed = {h["id"]: h for h in (await client.get("/v1/webhooks", headers=owner.headers)).json()}
    assert listed[mine]["created_by"] == {"name": "ci-export"}
    assert listed[mine]["created_by_kind"] == "api_token"
    assert listed[members]["created_by_kind"] == "member"
    assert listed[through_personal]["created_by_kind"] == "member"


async def test_every_owner_gets_one_row_and_a_second_revoke_writes_none(client, tenant_id):
    """protects=owner decision 2026-10-26: each owner, the one who revoked included, gets
    one Inbox row naming the webhook, with Resume and Take over; a webhook already paused
    does not pause again, and revoking twice writes no second row; fails_when=an owner
    gets none or two, a non-owner gets one, or a paused webhook's reason changes."""
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    second = await make_person(tenant_id, "second.owner@example.com", "owner")
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    ci, ci_headers = await _token(tenant_id, "ci-export")
    active = await _hook(client, ci_headers, "Export bot")
    already = await _hook(client, ci_headers, "Paused bot")
    resp = await client.patch(
        f"/v1/webhooks/{already}", json={"status": "paused"}, headers=ci_headers
    )
    assert resp.status_code == 200, resp.text

    await _revoke(client, owner.headers, ci)
    await _revoke(client, owner.headers, ci)

    for person in (owner, second):
        (row,) = await _paused_rows(client, person.headers)
        assert row["title"] == "Webhook Export bot paused: its API token was revoked"
        assert row["data"]["webhook_id"] == active
        assert row["data"]["reason"] == "creator_disabled"
        assert row["data"]["actions"] == ["resume", "take_over"]
        assert row["data"]["href"] == "/settings/webhooks"
    assert await _paused_rows(client, approver.headers) == []
    assert await _status(tenant_id, already) == ("paused", "manual")


async def test_an_owner_resumes_one_and_takes_over_another_after_the_revoke(client, tenant_id):
    """protects=owner decision 2026-10-26 (the row's Resume and Take over): after the
    revoke an owner may resume a paused webhook of the token's, and take one over, which
    makes it theirs; fails_when=either is refused."""
    owner = await make_person(tenant_id, "owner@example.com", "owner")
    ci, ci_headers = await _token(tenant_id, "ci-export")
    first = await _hook(client, ci_headers, "Export bot")
    second = await _hook(client, ci_headers, "Backup bot")
    await _revoke(client, owner.headers, ci)

    listed = {h["id"]: h for h in (await client.get("/v1/webhooks", headers=owner.headers)).json()}
    assert listed[first]["can_take_over"] is True
    resp = await client.patch(
        f"/v1/webhooks/{first}", json={"status": "active"}, headers=owner.headers
    )
    assert resp.status_code == 200, resp.text
    assert (resp.json()["status"], resp.json()["paused_reason"]) == ("active", None)

    resp = await client.post(f"/v1/webhooks/{second}/take-over", headers=owner.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["created_by"]["name"] == "Owner"
    assert resp.json()["created_by_kind"] == "member"
    async with tenant_session(tenant_id) as s:
        assert (await s.get(Webhook, uuid.UUID(second))).created_by == owner.user.id
