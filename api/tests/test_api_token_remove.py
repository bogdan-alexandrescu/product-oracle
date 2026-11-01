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
