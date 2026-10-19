"""CR-06 review fixes, round 4 (PR #16 / #27 / #38 / #45), after the owner's C2
follow-ups (2026-10-19): a disable ends every session and a restored member signs in
fresh; a member-management request re-reads its caller under the gate; approvals by
people demoted before the disable change are lapsed by the migration; revoking an MCP
OAuth grant voids the approvals made through it. Synthetic placeholders only."""

import uuid

import httpx
import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.auth.models import User
from oracle.config import get_settings
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, person, setup
from tests.test_review_v2_security_3 import disable, restore


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


async def email_of(ctx, user_id) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(User, user_id)).email


async def sign_in(client, email: str, password: str = "pw") -> httpx.Response:
    resp = await client.post("/v1/auth/login", json={"email": email, "password": password})
    # The test client keeps cookies; each test passes the one it means explicitly.
    client.cookies.clear()
    return resp


def cookie_headers(resp: httpx.Response) -> dict[str, str]:
    name = get_settings().session_cookie_name
    return {"Cookie": f"{name}={resp.cookies[name]}"}


# --- MAJOR 1: a disable ends every session ----------------------------------------------


async def test_a_session_signed_before_a_disable_stays_dead_after_restore(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    email = await email_of(ctx, pm.user_id)
    login = await sign_in(client, email)
    assert login.status_code == 200
    signed_in = cookie_headers(login)
    for headers in (pm.headers, signed_in):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 200

    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    # Every cookie signed before the disable is refused, on every cookie path.
    for headers in (pm.headers, signed_in):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401
        assert (await client.get("/v1/me", headers=headers)).status_code == 401
    # A fresh sign-in after the restore works.
    fresh = await sign_in(client, email)
    assert fresh.status_code == 200
    resp = await client.get(f"/v1/documents/{DOC}", headers=cookie_headers(fresh))
    assert resp.status_code == 200


async def test_a_session_signed_while_disabled_is_dead_after_restore(client, monkeypatch):
    """A cookie minted during a disable (a sign-in racing it) is older than the restore."""
    from oracle.auth.service import make_session_cookie

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        racing = make_session_cookie(await s.get(User, pm.user_id))
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    headers = {"Cookie": f"{get_settings().session_cookie_name}={racing}"}
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401


async def test_an_oauth_code_issued_before_a_disable_is_void_after_restore(client):
    from oracle.mcp.oauth import service as oauth
    from oracle.mcp.oauth.models import OAuthClient
    from tests.test_oauth import REDIRECT, pkce

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    verifier, challenge = pkce()
    async with tenant_session(ctx.tenant_id) as s:
        oc = OAuthClient(client_id=uuid.uuid4().hex, name="Desk client", redirect_uris=[REDIRECT])
        s.add(oc)
        await s.flush()
        req = oauth.AuthorizationRequest(oc.client_id, REDIRECT, "oracle:read", challenge, None)
        code = await oauth.issue_code(s, oc, pm.user_id, req)
        await s.commit()
        client_id = oc.client_id
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    resp = await client.post(
        "/oauth/token",
        data={
            "grant_type": "authorization_code",
            "client_id": client_id,
            "code": code,
            "redirect_uri": REDIRECT,
            "code_verifier": verifier,
        },
    )
    assert resp.status_code == 400 and resp.json()["error"] == "invalid_grant", resp.text


# --- MAJOR 2: a member-management request re-reads its caller under the gate ----------


async def admin_id(ctx) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(User.id).where(User.email == "admin@example.com"))


async def test_a_queued_request_of_an_owner_being_disabled_is_refused(client, monkeypatch):
    """Rogue owner B loops restore-self; owner A disables B. B's request, queued on the
    gate while A holds it, runs after A commits: it is refused, B stays disabled."""
    import asyncio

    from oracle.review import publish

    ctx = await setup(client)
    rogue = await person(ctx.tenant_id, "owner", "rogue")
    real = publish.gate_lock
    a_holds, b_waits = asyncio.Event(), asyncio.Event()
    calls = 0

    async def spy(db, *, shared):
        nonlocal calls
        calls += 1
        if calls == 1:  # A's disable: hold the gate until B queues on it
            await real(db, shared=shared)
            a_holds.set()
            await b_waits.wait()
            await asyncio.sleep(0.3)
            return
        b_waits.set()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    a = asyncio.create_task(disable(client, ctx, rogue.user_id))
    await a_holds.wait()
    b = asyncio.create_task(restore(client, ctx, rogue.user_id, rogue.headers))
    ra, rb = await asyncio.gather(a, b)
    assert ra.status_code == 200, ra.text
    assert rb.status_code == 403, rb.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, rogue.user_id)).disabled_at is not None


async def _lose_standing(ctx, how: str, user_id, token_id=None) -> None:
    from datetime import UTC, datetime

    from oracle.auth.models import ApiToken

    async with tenant_session(ctx.tenant_id) as s:
        if how == "disabled":
            (await s.get(User, user_id)).disabled_at = datetime.now(UTC)
        elif how == "demoted":
            (await s.get(User, user_id)).role = "approver"
        else:
            (await s.get(ApiToken, token_id)).revoked_at = datetime.now(UTC)
        await s.commit()


ROUTES = ["set_role", "disable", "restore", "revoke_token", "create_invite", "revoke_invite"]


@pytest.mark.parametrize(
    "route,how",
    [(r, "disabled") for r in ROUTES]
    + [("set_role", "demoted"), ("create_invite", "demoted"), ("disable", "token_revoked")],
)
async def test_a_caller_who_lost_standing_while_waiting_on_the_gate_is_refused(
    client, monkeypatch, route, how
):
    from datetime import UTC, datetime

    from oracle.auth.service import create_api_token
    from oracle.members.models import Invite
    from oracle.review import publish
    from tests.test_review_v2_security_3 import member_token

    ctx = await setup(client)
    caller = await person(ctx.tenant_id, "owner", "caller")
    token_id, bearer = await member_token(ctx, caller.user_id, "caller-agent")
    headers = bearer if how == "token_revoked" else caller.headers
    target = await person(ctx.tenant_id, "approver", "target")
    async with tenant_session(ctx.tenant_id) as s:
        other_token, _ = await create_api_token(s, "other", user_id=target.user_id)
        invite = Invite(email="queued@example.com", role="viewer")
        s.add(invite)
        if route == "restore":
            (await s.get(User, target.user_id)).disabled_at = datetime.now(UTC)
        await s.commit()
        other_token_id, invite_id = other_token.id, invite.id

    real = publish.gate_lock
    fired = False

    async def spy(db, *, shared):
        # The caller loses standing while their request waits on the gate.
        nonlocal fired
        if not fired:
            fired = True
            await _lose_standing(ctx, how, caller.user_id, token_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    t = target.user_id
    if route == "set_role":
        resp = await client.patch(f"/v1/members/{t}", json={"role": "viewer"}, headers=headers)
    elif route == "disable":
        resp = await disable(client, ctx, t, headers)
    elif route == "restore":
        resp = await restore(client, ctx, t, headers)
    elif route == "revoke_token":
        resp = await client.delete(f"/v1/api-tokens/{other_token_id}", headers=headers)
    elif route == "create_invite":
        body = {"email": "new@example.com", "role": "viewer"}
        resp = await client.post("/v1/invites", json=body, headers=headers)
    else:
        resp = await client.delete(f"/v1/invites/{invite_id}", headers=headers)
    assert fired, "the route did not take the gate"
    assert resp.status_code == 403, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, t)
        assert user.role == "approver"
        assert (user.disabled_at is not None) == (route == "restore")
        assert await s.scalar(select(Invite.id).where(Invite.email == "new@example.com")) is None
        assert (await s.get(Invite, invite_id)).revoked_at is None


@pytest.fixture
def provider():
    from tests.connection_helpers import clear_provider_http, use_provider_http

    seen = use_provider_http(lambda request: httpx.Response(200, json={"ok": True}))
    yield seen
    clear_provider_http()


async def add_oauth_connection(ctx, user_id):
    from oracle import crypto
    from oracle.connections.models import Connection

    async with tenant_session(ctx.tenant_id) as s:
        conn = Connection(
            user_id=user_id,
            provider="github",
            auth_mode="oauth",
            account_id="gh-1",
            account_label="octo",
            ciphertext=crypto.encrypt(b'{"access_token": "placeholder"}'),
            key_version=crypto.KEY_VERSION,
        )
        s.add(conn)
        await s.commit()
        return conn.id


async def test_a_disable_calls_providers_after_it_commits_outside_the_gate(
    client, monkeypatch, provider
):
    from sqlalchemy import text

    from oracle.connections import service as connections

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    conn_id = await add_oauth_connection(ctx, pm.user_id)
    seen: list[tuple[bool, bool]] = []

    async def revoke(http, conn):
        async with tenant_session(ctx.tenant_id) as s:
            free = await s.scalar(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"),
                {"k": f"oracle-review-gate:{ctx.tenant_id}"},
            )
            disabled = (await s.get(User, pm.user_id)).disabled_at is not None
            await s.rollback()
        seen.append((free, disabled))
        return "revoked"

    monkeypatch.setattr(connections, "revoke_at_provider", revoke)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    # Called once, with the disable committed and the company-wide gate free.
    assert seen == [(True, True)]
    from oracle.audit import AuditEvent

    async with tenant_session(ctx.tenant_id) as s:
        events = {
            e.action: e
            for e in await s.scalars(select(AuditEvent).where(AuditEvent.entity_id == conn_id))
        }
        assert events["connection.provider_revoke"].data["outcome"] == "revoked"


async def test_a_failed_provider_revoke_is_retried_from_the_tick(client, monkeypatch, provider):
    from oracle.connections import service as connections
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_oauth_connection(ctx, pm.user_id)
    outcomes = ["failed", "revoked"]
    calls: list[str] = []

    async def revoke(http, conn):
        calls.append(conn.provider)
        return outcomes.pop(0)

    monkeypatch.setattr(connections, "revoke_at_provider", revoke)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        [row] = (await s.scalars(select(MemberFollowUp))).all()
        assert row.status == "pending" and row.attempts == 1 and row.outcome == "failed"
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert calls == ["github", "github"]
    async with tenant_session(ctx.tenant_id) as s:
        [row] = (await s.scalars(select(MemberFollowUp))).all()
        assert row.status == "done" and row.outcome == "revoked" and row.ciphertext is None
