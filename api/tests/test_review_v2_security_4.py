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
