"""qa4-settings-39: Settings > API tokens removes an expired API token from the list.

Owners only, as Revoke; an active or revoked token is refused. The row is kept (hidden),
so what was done with the token keeps its name.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from oracle.auth.models import ApiToken
from oracle.models import AuditEvent
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import person, setup, verdict
from tests.test_review_v2_security_3 import member_token


def remove_url(token_id: uuid.UUID | str) -> str:
    return f"/v1/api-tokens/{token_id}/remove"


async def expire(tenant_id: uuid.UUID, token_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as s:
        token = await s.get(ApiToken, token_id)
        token.expires_at = datetime.now(UTC) - timedelta(days=1)
        await s.commit()


async def listed(client, headers, **params) -> set[str]:
    resp = await client.get("/v1/api-tokens", headers=headers, params=params)
    assert resp.status_code == 200, resp.text
    return {t["id"] for t in resp.json()}


async def test_an_expired_token_is_removed(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, _ = await member_token(ctx, pm.user_id, "laptop-cli")
    await expire(ctx.tenant_id, token_id)
    assert str(token_id) in await listed(client, ctx.auth)

    resp = await client.post(remove_url(token_id), headers=ctx.auth)
    assert resp.status_code == 204, resp.text
    assert str(token_id) not in await listed(client, ctx.auth)
    assert str(token_id) not in await listed(client, ctx.auth, kind="personal")
    assert str(token_id) not in await listed(client, ctx.auth, user_id=str(pm.user_id))
    # Gone from its member's My account too.
    mine = (await client.get("/v1/me/tokens", headers=pm.headers)).json()
    assert str(token_id) not in {t["id"] for t in mine}
    # Twice: it is no longer there.
    assert (await client.post(remove_url(token_id), headers=ctx.auth)).status_code == 404
    async with tenant_session(ctx.tenant_id) as s:
        [event] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "api_token.remove"))
        ).all()
    assert event.data["name"] == "laptop-cli"


async def test_an_active_or_revoked_token_is_refused(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    active, _ = await member_token(ctx, pm.user_id, "still-on")
    revoked, _ = await member_token(ctx, pm.user_id, "turned-off")
    assert (await client.delete(f"/v1/api-tokens/{revoked}", headers=ctx.auth)).status_code == 204
    # Revoked, then past its expiry too: still revoked, still refused.
    gone_by, _ = await member_token(ctx, pm.user_id, "revoked-then-expired")
    assert (await client.delete(f"/v1/api-tokens/{gone_by}", headers=ctx.auth)).status_code == 204
    await expire(ctx.tenant_id, gone_by)

    for token_id in (active, revoked, gone_by):
        resp = await client.post(remove_url(token_id), headers=ctx.auth)
        assert resp.status_code == 409, resp.text
        assert "expired" in resp.json()["detail"]
    assert {str(active), str(revoked), str(gone_by)} <= await listed(client, ctx.auth)
    assert (await client.post(remove_url(uuid.uuid4()), headers=ctx.auth)).status_code == 404


async def test_another_persons_token_is_refused(client):
    """The same rule as Revoke: owners only. An approver removes neither another
    member's expired token nor their own here."""
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    other = await person(ctx.tenant_id, "approver", "lead")
    theirs, _ = await member_token(ctx, other.user_id, "lead-cli")
    mine, _ = await member_token(ctx, pm.user_id, "pm-cli")
    for token_id in (theirs, mine):
        await expire(ctx.tenant_id, token_id)
        resp = await client.post(remove_url(token_id), headers=pm.headers)
        assert resp.status_code == 403, resp.text
    assert {str(theirs), str(mine)} <= await listed(client, ctx.auth)


async def test_approvals_made_with_a_removed_token_keep_it(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, agent = await member_token(ctx, pm.user_id, "pm-agent")
    assert (await verdict(client, agent, 1, "problem")).status_code == 200
    await expire(ctx.tenant_id, token_id)
    assert (await client.post(remove_url(token_id), headers=ctx.auth)).status_code == 204
    rows = (await client.get(f"/v1/api-tokens/{token_id}/approvals", headers=ctx.auth)).json()
    [section] = [r for r in rows if r["kind"] == "section"]
    assert section["section_key"] == "problem" and section["approver_id"] == str(pm.user_id)


async def removed_and_active(ctx, user_id: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """One of the member's tokens expired and removed, one still on."""
    gone, _ = await member_token(ctx, user_id, "old-laptop")
    await expire(ctx.tenant_id, gone)
    active, _ = await member_token(ctx, user_id, "new-laptop")
    return gone, active


async def revoked_at(tenant_id: uuid.UUID, token_id: uuid.UUID) -> datetime | None:
    async with tenant_session(tenant_id) as s:
        return (await s.get(ApiToken, token_id)).revoked_at


async def test_a_password_change_leaves_a_removed_token_alone(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    gone, active = await removed_and_active(ctx, pm.user_id)
    assert (await client.post(remove_url(gone), headers=ctx.auth)).status_code == 204

    resp = await client.post(
        "/v1/me/password",
        json={"current_password": "pw", "new_password": "a-new-passphrase-" + "x" * 8},
        headers=pm.headers,
    )
    assert resp.status_code == 204, resp.text
    assert await revoked_at(ctx.tenant_id, active) is not None
    assert await revoked_at(ctx.tenant_id, gone) is None
    async with tenant_session(ctx.tenant_id) as s:
        [event] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "password.change"))
        ).all()
        revokes = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "api_token.revoke"))
        ).all()
    assert event.data["api_tokens"] == [str(active)]
    assert [e.subject_id for e in revokes] == [active]


async def test_removing_a_member_leaves_a_removed_token_alone(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    gone, active = await removed_and_active(ctx, pm.user_id)
    assert (await client.post(remove_url(gone), headers=ctx.auth)).status_code == 204

    # The remove dialog counts only the token that is still on.
    impact = await client.get(
        f"/v1/members/{pm.user_id}/impact", params={"change": "remove"}, headers=ctx.auth
    )
    assert impact.status_code == 200, impact.text
    assert impact.json()["ends"]["api_tokens"] == 1
    resp = await client.post(f"/v1/members/{pm.user_id}/disable", headers=ctx.auth)
    assert resp.status_code in (200, 204), resp.text
    assert await revoked_at(ctx.tenant_id, active) is not None
    assert await revoked_at(ctx.tenant_id, gone) is None


async def test_the_service_token_list_skips_a_removed_token(client):
    from oracle.members import service

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    gone, active = await removed_and_active(ctx, pm.user_id)
    assert (await client.post(remove_url(gone), headers=ctx.auth)).status_code == 204
    async with tenant_session(ctx.tenant_id) as s:
        ids = {t.id for t in await service.list_api_tokens(s)}
    assert active in ids and gone not in ids
