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


# --- OAUTH GRANTS: revoking an MCP OAuth grant voids the approvals made through it -----


async def oauth_grant(ctx, user_id) -> tuple[str, str, str, uuid.UUID]:
    """An MCP client's grant for ``user_id``: (client_id, access, refresh, grant id)."""
    from oracle.mcp.oauth.models import OAuthClient
    from oracle.mcp.oauth.service import _new_token_row

    async with tenant_session(ctx.tenant_id) as s:
        oc = OAuthClient(
            client_id=uuid.uuid4().hex, name="Desk client", redirect_uris=["http://127.0.0.1/cb"]
        )
        s.add(oc)
        await s.flush()
        row, issued = _new_token_row(
            client_id=oc.id, user_id=user_id, scope="oracle:read oracle:write", family_id=None
        )
        s.add(row)
        await s.commit()
        return oc.client_id, issued.access_token, issued.refresh_token, row.family_id


async def test_approvals_through_an_oauth_grant_record_it(client):
    from oracle.audit import AuditEvent
    from oracle.docs.models import DocumentVersion
    from oracle.review.models import SectionReview
    from tests.review_v2_helpers import approve_all
    from tests.test_review_v2_security_2 import approved, check, policy

    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    _, access, _, grant_id = await oauth_grant(ctx, pm.user_id)
    agent = {"Authorization": f"Bearer {access}"}
    await approve_all(client, agent, 1)
    await approved(client, ctx, headers=agent)
    assert (await check(client, ctx))["can_publish"] is True
    async with tenant_session(ctx.tenant_id) as s:
        reviews = (await s.scalars(select(SectionReview))).all()
        assert reviews and {r.grant_id for r in reviews} == {grant_id}
        assert {r.reviewer_id for r in reviews} == {pm.user_id}
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_grant_id == grant_id and v1.approved_by == pm.user_id
        events = (
            await s.scalars(
                select(AuditEvent).where(
                    AuditEvent.action.in_(("version.approve", "section.review"))
                )
            )
        ).all()
        assert events and {e.actor_grant_id for e in events} == {grant_id}


@pytest.mark.parametrize("how", ["revoke_access", "revoke_refresh", "refresh_reuse"])
async def test_revoking_an_oauth_grant_voids_its_approvals(client, how):
    from oracle.docs.models import DocumentVersion
    from oracle.review.models import SectionReview
    from tests.review_v2_helpers import approve_all, states, verdict
    from tests.test_review_v2_security_2 import approved, check, codes, policy

    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    client_id, access, refresh, grant_id = await oauth_grant(ctx, pm.user_id)
    agent = {"Authorization": f"Bearer {access}"}
    await approve_all(client, agent, 1)
    await approved(client, ctx, headers=agent)
    # One approval by the person directly stands.
    async with tenant_session(ctx.tenant_id) as s:
        own = await s.scalar(select(SectionReview.id).where(SectionReview.section_key == "risks"))
    assert (await verdict(client, pm.headers, 1, "risks")).status_code == 200
    assert (await check(client, ctx))["can_publish"] is True

    if how == "refresh_reuse":
        form = {"grant_type": "refresh_token", "client_id": client_id, "refresh_token": refresh}
        assert (await client.post("/oauth/token", data=form)).status_code == 200
        reused = await client.post("/oauth/token", data=form)
        assert reused.status_code == 400 and "reused" in reused.text
    else:
        token = access if how == "revoke_access" else refresh
        resp = await client.post("/oauth/revoke", data={"client_id": client_id, "token": token})
        assert resp.status_code == 200
    # Lapsed for good, in the revocation's own transaction.
    async with tenant_session(ctx.tenant_id) as s:
        reviews = (
            await s.scalars(select(SectionReview).where(SectionReview.grant_id == grant_id))
        ).all()
        assert reviews and all(r.lapsed_at is not None for r in reviews)
        assert all("OAuth grant" in r.lapse_reason for r in reviews)
        assert own is not None
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_at is None and v1.approval_lapsed_at is not None
        assert v1.approved_grant_id == grant_id
    body = await check(client, ctx)
    assert {"version_approval_lapsed", "missing_approval"} <= set(codes(body))
    s1 = await states(client, ctx.auth, 1)
    assert s1["risks"]["status"] == "approved"
    assert s1["problem"]["status"] == "unreviewed"
    # The person still signs in; only the grant is gone.
    assert (await client.get(f"/v1/documents/{DOC}", headers=pm.headers)).status_code == 200


async def test_a_grant_revoked_outside_the_endpoint_still_voids_at_gate_time(client):
    from datetime import UTC, datetime

    from sqlalchemy import update

    from oracle.mcp.oauth.models import OAuthToken
    from tests.test_review_v2_security_2 import approved, check, codes

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    _, access, _, grant_id = await oauth_grant(ctx, pm.user_id)
    await approved(client, ctx, headers={"Authorization": f"Bearer {access}"})
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(OAuthToken)
            .where(OAuthToken.family_id == grant_id)
            .values(revoked_at=datetime.now(UTC))
        )
        await s.commit()
    assert codes(await check(client, ctx)) == ["version_approval_lapsed"]


async def test_a_verdict_through_a_grant_revoked_while_waiting_is_refused(client, monkeypatch):
    from datetime import UTC, datetime

    from sqlalchemy import update

    from oracle.mcp.oauth.models import OAuthToken
    from oracle.review import publish
    from tests.review_v2_helpers import verdict

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    _, access, _, grant_id = await oauth_grant(ctx, pm.user_id)
    real = publish.gate_lock

    async def spy(db, *, shared):
        async with tenant_session(ctx.tenant_id) as s:
            await s.execute(
                update(OAuthToken)
                .where(OAuthToken.family_id == grant_id)
                .values(revoked_at=datetime.now(UTC))
            )
            await s.commit()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    resp = await verdict(client, {"Authorization": f"Bearer {access}"}, 1, "problem")
    assert resp.status_code == 403, resp.text


# --- minors -------------------------------------------------------------------------------


def _uuid_forms(page: uuid.UUID) -> list[str]:
    return [page.hex, page.hex.upper(), "{" + str(page) + "}", f"urn:uuid:{page}", str(page)]


@pytest.mark.parametrize("form", range(5))
@pytest.mark.parametrize("stored", ["dashed", "undashed"])
@pytest.mark.parametrize("revoke", ["delete_source", "disable_owner"])
async def test_a_notion_page_id_in_any_uuid_form_is_matched(client, form, stored, revoke):
    from oracle.sources.models import Source, SourceItem
    from tests.review_v2_helpers import DRAFT, import_md, replace
    from tests.test_review_v2_security_2 import approved, blocker, check, codes

    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "approver", "source-owner")
    page = uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="notion", name="Wiki")
        s.add(source)
        await s.flush()
        external = str(page) if stored == "dashed" else page.hex
        s.add(SourceItem(source_id=source.id, external_id=external, kind="page", title="Plan"))
        await s.commit()
        source_id = source.id
    ref = _uuid_forms(page)[form]
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f'ref: "{ref}"'),
        "source: web",
        "source: notion",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    assert (await check(client, ctx, 2))["can_publish"] is True
    if revoke == "delete_source":
        resp = await client.delete(f"/v1/sources/{source_id}", headers=owner.headers)
        assert resp.status_code == 204, resp.text
    else:
        assert (await disable(client, ctx, owner.user_id)).status_code == 200
    body = await check(client, ctx, 2)
    assert "source_permission_revoked" in codes(body), (ref, external)
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


async def test_an_unrelated_revoked_notion_source_does_not_block(client):
    """A revoked source's external ids match only citations of those ids (a loop
    variable once shadowed the matched section keys, so any match flagged them all)."""
    from oracle.sources.models import Source, SourceItem
    from tests.review_v2_helpers import DRAFT, import_md, replace
    from tests.test_review_v2_security_2 import approved, check

    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "approver", "source-owner")
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="notion", name="Other wiki")
        s.add(source)
        await s.flush()
        s.add(SourceItem(source_id=source.id, external_id=str(uuid.uuid4()), kind="page"))
        await s.commit()
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {uuid.uuid4()}"),
        "source: web",
        "source: notion",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    assert (await disable(client, ctx, owner.user_id)).status_code == 200
    assert (await check(client, ctx, 2))["can_publish"] is True
