"""CR-06 review fixes, round 3 (PR #16 / #27 / #38), after the owner's C2 decision:
removing a member disables them (sign-in refused on every path, sources and
connections revoked, approvals void, history keeps the row, an owner can restore), a
lapsed approval lapses for good, approvals record the API token that gave them, an
unclosed fence never swallows a section, and a UUID citation ref is also an external
id. Synthetic placeholders only."""

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.audit import AuditEvent
from oracle.auth.models import ApiToken, User
from oracle.auth.service import create_api_token
from oracle.config import get_settings
from oracle.connections.models import Connection
from oracle.docs.models import Document, DocumentVersion
from oracle.members.models import Invite
from oracle.review.models import SectionReview
from oracle.runs.models import Run
from oracle.runtokens import RunToken, mint_run_token
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.connection_helpers import clear_provider_http, use_provider_http
from tests.review_v2_helpers import (
    DOC,
    DRAFT,
    approve_all,
    import_md,
    person,
    replace,
    setup,
    states,
    verdict,
)
from tests.test_review_v2_security_2 import approved, blocker, check, codes, policy, set_role


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


@pytest.fixture
def provider():
    """Provider calls (the revoke at disconnect) go to a mock; returns the requests."""
    seen = use_provider_http(lambda request: httpx.Response(200, json={"ok": True}))
    yield seen
    clear_provider_http()


async def disable(client, ctx, user_id, headers=None):
    return await client.post(f"/v1/members/{user_id}/disable", headers=headers or ctx.auth)


async def restore(client, ctx, user_id, headers=None):
    return await client.post(f"/v1/members/{user_id}/restore", headers=headers or ctx.auth)


async def member_token(ctx, user_id, name="agent") -> tuple[uuid.UUID, dict[str, str]]:
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, name, user_id=user_id)
        await s.commit()
        return token.id, {"Authorization": f"Bearer {raw}"}


async def oauth_token(ctx, user_id) -> str:
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
        return issued.access_token


async def lapsed_reviews(ctx, user_id) -> list[SectionReview]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            await s.scalars(
                select(SectionReview).where(
                    SectionReview.reviewer_id == user_id, SectionReview.verdict == "approved"
                )
            )
        )


# --- BLOCKER 1: removing a member disables them ---------------------------------------


async def test_a_disabled_member_keeps_their_row_and_cannot_sign_in_anywhere(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        email = (await s.get(User, pm.user_id)).email
    _, bearer = await member_token(ctx, pm.user_id)
    access = await oauth_token(ctx, pm.user_id)
    oauth = {"Authorization": f"Bearer {access}"}
    for headers in (pm.headers, bearer, oauth):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 200
    login = {"email": email, "password": "pw"}
    assert (await client.post("/v1/auth/login", json=login)).status_code == 200

    other = await person(ctx.tenant_id, "approver", "other")
    assert (await disable(client, ctx, pm.user_id, other.headers)).status_code == 403
    resp = await disable(client, ctx, pm.user_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "disabled" and body["disabled_at"] and body["email"] == email
    # Disabling twice is a no-op.
    assert (await disable(client, ctx, pm.user_id)).status_code == 200

    for headers in (pm.headers, bearer, oauth):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401
    assert (await client.post("/v1/auth/login", json=login)).status_code == 401

    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, pm.user_id)
        assert user is not None and user.email == email and user.disabled_at is not None
        assert user.disabled_by is not None
        tokens = (await s.scalars(select(ApiToken).where(ApiToken.user_id == pm.user_id))).all()
        assert tokens and all(t.revoked_at is not None for t in tokens)
        [event] = (
            await s.scalars(
                select(ChangeEvent).where(
                    ChangeEvent.subject_kind == "member", ChangeEvent.cause == "member_disabled"
                )
            )
        ).all()
        assert event.subject_id == pm.user_id
        [audit] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "member.disable"))
        ).all()
        assert audit.entity_id == pm.user_id and audit.data["role"] == "approver"
    members = (await client.get("/v1/members", headers=ctx.auth)).json()
    [row] = [m for m in members if m["id"] == str(pm.user_id)]
    assert row["status"] == "disabled" and row["email"] == email


async def test_a_disabled_member_cannot_act_through_mcp_or_a_run(client):
    from oracle.mcp.auth import verify

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "pm-mcp", user_id=pm.user_id)
        run = Run(flow="baseline_to_prd", created_by=pm.user_id, status="running")
        s.add(run)
        await s.flush()
        run_token = await mint_run_token(s, run.id, ["read:documents"], 600)
        await s.commit()
        run_id = run.id
    access = await oauth_token(ctx, pm.user_id)
    for credential in (raw, run_token, access):
        assert await verify(credential) is not None
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    for credential in (raw, run_token, access):
        assert await verify(credential) is None
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
        assert run.status == "cancelled"
        assert all(t.revoked_at for t in await s.scalars(select(RunToken)))


async def test_a_disabled_creators_run_token_header_is_refused(client):
    """The in-process REST call for a run carries the creator's session and the run
    token; a disabled creator's is refused even with a session minted earlier."""
    from oracle.auth.deps import RUN_TOKEN_HEADER

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", created_by=pm.user_id, status="running")
        s.add(run)
        await s.flush()
        raw = await mint_run_token(s, run.id, ["read:documents"], 600)
        await s.commit()
    headers = {**pm.headers, RUN_TOKEN_HEADER: raw}
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 200
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401


async def test_iap_refuses_a_disabled_email_and_never_provisions_it_again(client, monkeypatch):
    from oracle.auth import iap
    from oracle.config import get_settings
    from tests import test_iap
    from tests.test_iap import HEADER, assertion

    settings = get_settings()
    monkeypatch.setattr(settings, "iap_audiences", [test_iap.AUDIENCE])
    monkeypatch.setattr(settings, "iap_allowed_domains", ["example.com"])
    monkeypatch.setattr(settings, "iap_auto_provision", True)

    async def fake_fetch():
        return test_iap._jwks()

    monkeypatch.setattr(iap, "_fetch_jwks", fake_fetch)
    iap._keys.clear()
    try:
        ctx = await setup(client)
        email = "iap-pm@example.com"
        signed = {HEADER: assertion(email)}
        assert (await client.get("/v1/me", headers=signed)).status_code == 200
        async with tenant_session(ctx.tenant_id) as s:
            user_id = await s.scalar(select(User.id).where(User.email == email))
        assert (await disable(client, ctx, user_id)).status_code == 200
        assert (await client.get("/v1/me", headers=signed)).status_code == 401
        async with tenant_session(ctx.tenant_id) as s:
            users = (await s.scalars(select(User).where(User.email == email))).all()
            assert [u.id for u in users] == [user_id]
        # Restored: IAP signs them in again, as the same user.
        assert (await restore(client, ctx, user_id)).status_code == 200
        me = await client.get("/v1/me", headers=signed)
        assert me.status_code == 200 and me.json()["user_id"] == str(user_id)
    finally:
        iap._keys.clear()


async def test_disabling_revokes_connections_at_the_provider_and_records_sources(client, provider):
    from oracle import crypto

    ctx = await setup(client)
    await approved(client, ctx)
    analyst = await person(ctx.tenant_id, "commenter", "analyst")
    async with tenant_session(ctx.tenant_id) as s:
        conn = Connection(
            user_id=analyst.user_id,
            provider="notion",
            auth_mode="token",
            account_id="ws-1",
            account_label="Workspace",
            ciphertext=crypto.encrypt(b'{"access_token": "placeholder"}'),
            key_version=crypto.KEY_VERSION,
        )
        s.add(conn)
        await s.flush()
        synced = Source(
            owner_user_id=analyst.user_id, kind="notion", name="Notes", connection_id=conn.id
        )
        upload = Source(owner_user_id=analyst.user_id, kind="upload", name="Survey")
        s.add_all([synced, upload])
        await s.flush()
        s.add(
            SourceItem(
                source_id=upload.id,
                external_id="survey.md",
                kind="file",
                url="https://example.com/calendar-survey",
            )
        )
        s.add(Invite(email="later@example.com", role="viewer"))
        await s.commit()
        conn_id, synced_id, upload_id = conn.id, synced.id, upload.id
        analyst_email = (await s.get(User, analyst.user_id)).email
    async with tenant_session(ctx.tenant_id) as s:
        # An open invite for the same email (made before they joined) is revoked too.
        s.add(Invite(email=analyst_email, role="approver"))
        await s.commit()
    assert (await check(client, ctx))["can_publish"] is True

    assert (await disable(client, ctx, analyst.user_id)).status_code == 200
    assert codes(await check(client, ctx)) == ["source_permission_revoked"]
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(Connection, conn_id) is None
        [audit] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "connection.disconnect"))
        ).all()
        assert audit.entity_id == conn_id and "provider_revoke" in audit.data
        events = (
            await s.scalars(
                select(ChangeEvent).where(ChangeEvent.subject_kind == "source_permission")
            )
        ).all()
        assert {e.subject_id for e in events} == {synced_id, upload_id}
        # The sources stay (history), paused.
        assert {x.status for x in await s.scalars(select(Source))} == {"paused"}
        invites = {i.email: i for i in await s.scalars(select(Invite))}
        assert invites[analyst_email].revoked_at is not None
        assert invites["later@example.com"].revoked_at is None

    # Restored: they sign in again (fresh), but nothing is reconnected or un-revoked.
    assert (await restore(client, ctx, analyst.user_id)).status_code == 200
    assert (await client.get(f"/v1/documents/{DOC}", headers=analyst.headers)).status_code == 401
    assert codes(await check(client, ctx)) == ["source_permission_revoked"]
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(Connection, conn_id) is None


async def test_the_last_active_owner_cannot_be_disabled(client):
    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        [owner] = (await s.scalars(select(User).where(User.role == "owner"))).all()
    second = await person(ctx.tenant_id, "owner", "second")
    assert (await disable(client, ctx, second.user_id)).status_code == 200
    # A disabled owner is not "another owner".
    assert (await disable(client, ctx, owner.id)).status_code == 409
    resp = await client.patch(
        f"/v1/members/{owner.id}", json={"role": "approver"}, headers=ctx.auth
    )
    assert resp.status_code == 409
    assert (await client.delete(f"/v1/members/{uuid.uuid4()}", headers=ctx.auth)).status_code == 404


async def test_delete_is_kept_as_disable(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await client.delete(f"/v1/members/{pm.user_id}", headers=ctx.auth)).status_code == 204
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, pm.user_id)).disabled_at is not None


async def test_restore_is_owner_only_and_audited(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    other = await person(ctx.tenant_id, "approver", "other")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id, other.headers)).status_code == 403
    # Their email cannot be invited again: they are restored instead.
    async with tenant_session(ctx.tenant_id) as s:
        email = (await s.get(User, pm.user_id)).email
    resp = await client.post(
        "/v1/invites", json={"email": email, "role": "viewer"}, headers=ctx.auth
    )
    assert resp.status_code == 409 and "restore" in resp.json()["detail"]
    resp = await restore(client, ctx, pm.user_id)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "active" and resp.json()["disabled_at"] is None
    # A session signed before the disable stays dead (round 4); they sign in fresh.
    assert (await client.get(f"/v1/documents/{DOC}", headers=pm.headers)).status_code == 401
    login = await client.post("/v1/auth/login", json={"email": email, "password": "pw"})
    assert login.status_code == 200
    client.cookies.clear()
    fresh = {
        "Cookie": f"{get_settings().session_cookie_name}={login.cookies[get_settings().session_cookie_name]}"
    }
    assert (await client.get(f"/v1/documents/{DOC}", headers=fresh)).status_code == 200
    assert (await restore(client, ctx, uuid.uuid4())).status_code == 404
    async with tenant_session(ctx.tenant_id) as s:
        assert (
            await s.scalar(select(AuditEvent.id).where(AuditEvent.action == "member.restore"))
        ) is not None
        causes = list(
            await s.scalars(
                select(ChangeEvent.cause)
                .where(ChangeEvent.subject_kind == "member")
                .order_by(ChangeEvent.created_at)
            )
        )
        assert causes == ["member_disabled", "member_restored"]


async def test_a_disabled_member_is_not_a_valid_decider(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"decider_id": str(pm.user_id)},
        headers=ctx.auth,
    )
    assert resp.status_code in (400, 422), resp.text


# --- BLOCKER 2: a lapsed approval lapses for good ---------------------------------------


async def test_demote_then_promote_never_revives_approvals(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True

    assert (await set_role(client, ctx, pm.user_id, "commenter")).status_code == 200
    # Recorded in the role change's own transaction.
    assert all(r.lapsed_at is not None for r in await lapsed_reviews(ctx, pm.user_id))
    assert (await set_role(client, ctx, pm.user_id, "approver")).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    assert blocker(body, "version_approval_lapsed")["ids"] == [str(pm.user_id)]
    s1 = await states(client, ctx.auth, 1)
    assert {s["status"] for s in s1.values()} == {"unreviewed"}

    # A fresh approval after the promotion is a new approval, and counts.
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True


async def test_owner_to_approver_is_not_a_lapse(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "owner", "pm")
    await approved(client, ctx, headers=pm.headers)
    assert (await set_role(client, ctx, pm.user_id, "approver")).status_code == 200
    assert (await check(client, ctx))["can_publish"] is True


async def test_disable_then_restore_never_revives_approvals(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    body = await check(client, ctx)
    assert codes(body) == ["version_approval_lapsed", "missing_approval"]
    assert all(r.lapsed_at is not None for r in await lapsed_reviews(ctx, pm.user_id))


async def test_a_lapsed_version_approval_stops_showing_approved(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approved(client, ctx, headers=pm.headers)
    doc = (await client.get(f"/v1/documents/{DOC}", headers=ctx.auth)).json()
    assert doc["status"] == "approved"
    assert (await set_role(client, ctx, pm.user_id, "viewer")).status_code == 200
    doc = (await client.get(f"/v1/documents/{DOC}", headers=ctx.auth)).json()
    assert doc["status"] != "approved"
    version = (await client.get(ctx.v(1), headers=ctx.auth)).json()
    assert version["approved_at"] is None
    md = await client.get(ctx.v(1, "/export"), params={"format": "md"}, headers=ctx.auth)
    assert md.status_code == 200, md.text
    assert "status approved" not in md.text and "· approved " not in md.text


async def test_role_changes_and_disables_take_the_review_gate(client, monkeypatch):
    from oracle.review import publish

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    calls: list[bool] = []
    real = publish.gate_lock

    async def spy(db, *, shared):
        calls.append(shared)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    assert (await set_role(client, ctx, pm.user_id, "commenter")).status_code == 200
    assert calls == [False]
    calls.clear()
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert calls and calls[0] is False


# --- MAJOR: approvals record the API token that gave them -------------------------------


async def test_a_tokens_approvals_record_it_and_revoking_it_voids_them(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, agent = await member_token(ctx, pm.user_id, "pm-agent")
    await approve_all(client, agent, 1)
    await approved(client, ctx, headers=agent)
    assert (await check(client, ctx))["can_publish"] is True
    # One more approval by the person directly, not through the token.
    growth = replace(DRAFT, "Owner: product.", "Owner: growth.")
    assert (await import_md(client, ctx.auth, growth, base=1)).status_code == 201
    assert (await verdict(client, pm.headers, 2, "problem")).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        reviews = (await s.scalars(select(SectionReview))).all()
        assert {r.token_id for r in reviews if r.version_id is not None} == {token_id, None}
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_token_id == token_id and v1.approved_by == pm.user_id
        [audit] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "version.approve"))
        ).all()
        assert audit.actor == f"user:{pm.user_id}"
        assert audit.actor_token_id == token_id

    # Owners only.
    url = f"/v1/api-tokens/{token_id}"
    assert (await client.get(url + "/approvals", headers=pm.headers)).status_code == 403
    listed = await client.get(url + "/approvals", headers=ctx.auth)
    assert listed.status_code == 200, listed.text
    rows = listed.json()
    assert {r["kind"] for r in rows} == {"section", "version"}
    assert len([r for r in rows if r["kind"] == "section"]) == 6
    assert all(r["lapsed_at"] is None for r in rows)

    assert (await client.delete(url, headers=pm.headers)).status_code == 403
    assert (await client.delete(url, headers=ctx.auth)).status_code == 204
    body = await check(client, ctx)
    assert {"version_approval_lapsed", "missing_approval"} <= set(codes(body))
    rows = (await client.get(url + "/approvals", headers=ctx.auth)).json()
    assert rows and all(r["lapsed_at"] is not None for r in rows)
    # The person's own approval (not the token's) stands.
    s2 = await states(client, ctx.auth, 2)
    assert s2["problem"]["status"] == "approved"
    assert s2["solution"]["status"] == "unreviewed"
    # The person can still sign in; only the token is gone.
    assert (await client.get(f"/v1/documents/{DOC}", headers=agent)).status_code == 401
    assert (await client.get(f"/v1/documents/{DOC}", headers=pm.headers)).status_code == 200
    unknown = await client.delete(f"/v1/api-tokens/{uuid.uuid4()}", headers=ctx.auth)
    assert unknown.status_code == 404


async def test_a_token_revoked_outside_the_endpoint_still_voids_at_gate_time(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, agent = await member_token(ctx, pm.user_id)
    await approved(client, ctx, headers=agent)
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(ApiToken, token_id)).revoked_at = datetime.now(UTC) - timedelta(seconds=1)
        await s.commit()
    assert codes(await check(client, ctx)) == ["version_approval_lapsed"]


# --- MAJOR 2: an unclosed fence never swallows a section ---------------------------------


@pytest.mark.parametrize(
    "body",
    [
        "Intro.\n\n```text\ncode\n   ",
        "Intro.\n\n```text\ncode\n \t\n   ",
        "```\n   ",
        "Intro.\n\n```text\ncode\n\n\n",
        "```\n\n\n",
    ],
)
def test_unclosed_fence_ignores_trailing_whitespace_lines(body):
    from oracle.docs.parser import unclosed_fence

    assert unclosed_fence(body) == "```"


@pytest.mark.parametrize("body", ["```\ncode\n```\n  \n", "```\ncode\n```\n\n\n", "Text.\n\n  "])
def test_a_closed_fence_with_trailing_blanks_is_closed(body):
    from oracle.docs.parser import unclosed_fence

    assert unclosed_fence(body) is None


@pytest.mark.parametrize("body", ["Intro.\n\n```text\ncode\n   ", "Intro.\n\n```text\ncode\n\n\n"])
def test_compose_closes_a_fence_with_trailing_blank_lines(body):
    from types import SimpleNamespace

    from oracle.docs.parser import parse_draft
    from oracle.jobs.service import compose_markdown

    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md=body),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="Kept."),
    ]
    parsed = parse_draft(compose_markdown({"title": "T"}, sections, {}, []))
    assert [s.section_key for s in parsed.sections] == ["a", "b"]
    assert parsed.sections[1].body_md == "Kept."


def test_compose_refuses_to_lose_a_section(monkeypatch):
    from types import SimpleNamespace

    from oracle.docs import parser
    from oracle.docs.parser import DraftError
    from oracle.jobs.service import compose_markdown

    monkeypatch.setattr(parser, "unclosed_fence", lambda body: None)
    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md="```\nopen"),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="Kept."),
    ]
    with pytest.raises(DraftError) as raised:
        compose_markdown({"title": "T"}, sections, {}, [])
    [problem] = raised.value.problems
    assert problem.code == "section_lost" and problem.section_key == "b"


# --- MAJOR 3: a UUID citation ref is also an external id ---------------------------------


async def test_a_notion_page_id_citation_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    page_id = str(uuid.uuid4())
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="notion", name="Wiki")
        s.add(source)
        await s.flush()
        s.add(SourceItem(source_id=source.id, external_id=page_id, kind="page", title="Plan"))
        await s.commit()
        source_id = source.id
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {page_id}"),
        "source: web",
        "source: notion",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    assert (await check(client, ctx, 2))["can_publish"] is True
    resp = await client.delete(f"/v1/sources/{source_id}", headers=owner.headers)
    assert resp.status_code == 204, resp.text
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


# --- minors: URL matching ------------------------------------------------------------------


def test_google_docs_edit_view_and_usp_are_one_url():
    from oracle.review.publish import normalize_url

    base = "https://docs.google.com/document/d/AbC123/edit"
    for variant in (
        "https://docs.google.com/document/d/AbC123/view",
        "https://docs.google.com/document/d/AbC123/edit?usp=sharing",
        "https://docs.google.com/document/d/AbC123/",
        "http://docs.google.com/document/d/AbC123/edit#heading=h.1",
        "https://docs.google.com/document/u/0/d/AbC123/preview",
    ):
        assert normalize_url(variant) == normalize_url(base), variant
    assert normalize_url(base) != normalize_url("https://docs.google.com/document/d/Other/edit")


def test_percent_encoding_is_normalized():
    from oracle.review.publish import normalize_url

    assert normalize_url("https://example.com/a%7Eb") == normalize_url("https://example.com/a~b")
    assert normalize_url("https://example.com/a%2fb") == normalize_url("https://example.com/a%2Fb")
    assert normalize_url("https://example.com/caf%C3%A9") == normalize_url(
        "https://example.com/caf%c3%a9"
    )
    for url in ("https://example.com/a%7Eb", "https://example.com/a%2fb?q=a%20b"):
        assert normalize_url(normalize_url(url)) == normalize_url(url)


async def test_a_url_with_a_user_name_is_matched(client):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    url = "https://reader@example.com/private-survey"
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="upload", name="Private")
        s.add(source)
        await s.flush()
        s.add(SourceItem(source_id=source.id, external_id="p-1", kind="file", url=url))
        await s.commit()
        source_id = source.id
    draft = replace(DRAFT, "ref: https://example.com/calendar-survey", f"ref: {url}")
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    # Mark the item revoked without the tombstone naming it by URL: only the item lookup
    # (by its URL, through the host pre-filter) finds it.
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.scalar(select(SourceItem).where(SourceItem.source_id == source_id))
        item.deleted_at = datetime.now(UTC)
        await s.commit()
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]


async def test_documents_keep_working_for_a_disabled_members_history(client):
    """History keeps the name: the disabled member's verdict rows still resolve."""
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await verdict(client, pm.headers, 1, "problem", "changes_requested")).status_code == 200
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        [review] = (await s.scalars(select(SectionReview))).all()
        assert (await s.get(User, review.reviewer_id)) is not None
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        assert document is not None
