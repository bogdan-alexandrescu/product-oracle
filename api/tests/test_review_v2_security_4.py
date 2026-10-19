"""CR-06 review fixes, round 4 (PR #45, stacked on #38), after the owner's C2
follow-ups (2026-10-19): a disable ends every session and a restored member signs in
fresh; an owner's request queued behind a disable acts for no one; approvals by people
demoted before the disable change are lapsed too; revoking an MCP OAuth grant voids
the approvals made through it; and the minors. Synthetic placeholders only."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from sqlalchemy import select, text, update

from oracle import readiness
from oracle.audit import AuditEvent
from oracle.auth.models import User
from oracle.auth.service import create_user
from oracle.config import get_settings
from oracle.docs.models import DocumentVersion
from oracle.members.models import Invite
from oracle.review.models import SectionReview
from oracle.runs.models import Run, RunSegment
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session, unscoped_session
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
)
from tests.test_review_v2_security_2 import approved, blocker, check, codes, policy, set_role
from tests.test_review_v2_security_3 import disable, restore


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


@pytest.fixture
def provider():
    seen = use_provider_http(lambda request: httpx.Response(200, json={"ok": True}))
    yield seen
    clear_provider_http()


COOKIE = get_settings().session_cookie_name


async def email_of(ctx, user_id) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        return (await s.get(User, user_id)).email


async def sign_in(client, email: str) -> dict[str, str]:
    """A fresh password sign-in; returns the session cookie as a header (the client's
    own cookie jar is cleared so later calls carry only what a test passes)."""
    resp = await client.post("/v1/auth/login", json={"email": email, "password": "pw"})
    assert resp.status_code == 200, resp.text
    value = resp.cookies[COOKIE]
    client.cookies.clear()
    return {"Cookie": f"{COOKIE}={value}"}


async def oauth_grant(ctx, user_id, scope="oracle:read oracle:write"):
    """An MCP OAuth grant for ``user_id``: (client_id, access, refresh, grant id)."""
    from oracle.mcp.oauth.models import OAuthClient
    from oracle.mcp.oauth.service import _new_token_row

    async with tenant_session(ctx.tenant_id) as s:
        oc = OAuthClient(
            client_id=uuid.uuid4().hex, name="Desk client", redirect_uris=["http://127.0.0.1/cb"]
        )
        s.add(oc)
        await s.flush()
        row, issued = _new_token_row(client_id=oc.id, user_id=user_id, scope=scope, family_id=None)
        s.add(row)
        await s.commit()
        return oc.client_id, issued.access_token, issued.refresh_token, row.family_id


async def waiting_on_locks(n: int) -> None:
    """Until ``n`` sessions wait for a lock (the review gate or a row)."""
    for _ in range(400):
        async with unscoped_session() as s:
            waiting = await s.scalar(text("SELECT count(*) FROM pg_locks WHERE NOT granted"))
        if waiting >= n:
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"expected {n} waiting lock request(s)")


async def hold_gate(tenant_id):
    """A session that holds the company's review gate exclusively until it commits."""
    from oracle.review.publish import gate_lock

    s = tenant_session(tenant_id)
    session = await s.__aenter__()
    await gate_lock(session, shared=False)
    return s, session


# --- MAJOR 1: a disable ends every session; a restored member signs in fresh -------------


async def test_a_session_signed_before_a_disable_is_dead_after_the_restore(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    email = await email_of(ctx, pm.user_id)
    earlier = await sign_in(client, email)
    for headers in (pm.headers, earlier):
        assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 200
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    # Cookies are stateless and live 7 days: the ones signed before the disable stay dead.
    for headers in (pm.headers, earlier):
        resp = await client.get(f"/v1/documents/{DOC}", headers=headers)
        assert resp.status_code == 401, resp.text
        assert (await client.get("/v1/me", headers=headers)).status_code == 401
    # A fresh sign-in works, at once.
    fresh = await sign_in(client, email)
    assert (await client.get(f"/v1/documents/{DOC}", headers=fresh)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, pm.user_id)
        assert user.sessions_valid_after is not None


async def test_the_oauth_consent_screen_refuses_a_pre_disable_cookie(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    resp = await client.get("/oauth/authorize/request", params={"request": "x"}, headers=pm.headers)
    assert resp.status_code == 401


async def test_an_old_format_cookie_signed_before_the_disable_is_refused(client):
    """A cookie minted before this change (no precise issue time) falls back to its
    signer's whole-second timestamp, and is refused when that is before the cut-off."""
    from itsdangerous import URLSafeTimedSerializer

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    old = URLSafeTimedSerializer(get_settings().secret_key, salt="oracle-session").dumps(
        {"u": str(pm.user_id), "t": str(ctx.tenant_id)}
    )
    headers = {"Cookie": f"{COOKIE}={old}"}
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, pm.user_id)
        user.sessions_valid_after = datetime.now(UTC) + timedelta(seconds=1)
        await s.commit()
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401


async def test_an_unused_oauth_code_from_before_a_disable_is_dead_after_the_restore(client):
    from oracle.mcp.oauth.models import OAuthClient
    from oracle.mcp.oauth.service import (
        AuthorizationRequest,
        OAuthError,
        exchange_code,
        issue_code,
        s256,
    )

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    verifier = "v" * 64
    async with tenant_session(ctx.tenant_id) as s:
        oc = OAuthClient(
            client_id=uuid.uuid4().hex, name="Desk client", redirect_uris=["http://127.0.0.1/cb"]
        )
        s.add(oc)
        await s.flush()
        req = AuthorizationRequest(
            client_id=oc.client_id,
            redirect_uri="http://127.0.0.1/cb",
            scope="oracle:read",
            code_challenge=s256(verifier),
            state=None,
        )
        code = await issue_code(s, oc, pm.user_id, req)
        await s.commit()
        client_id = oc.client_id
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    with pytest.raises(OAuthError) as raised:
        await exchange_code(client_id, code, "http://127.0.0.1/cb", verifier)
    assert raised.value.error == "invalid_grant"


# --- MAJOR 2: an owner's request queued behind their own disable acts for no one ---------


async def test_a_restore_self_queued_behind_the_disable_is_refused(client):
    ctx = await setup(client)
    a = await person(ctx.tenant_id, "owner", "owner-a")
    b = await person(ctx.tenant_id, "owner", "owner-b")
    held, session = await hold_gate(ctx.tenant_id)
    try:
        # A disables B; B (authenticated before the disable) restores itself. Both wait
        # for the gate, A first.
        a_disables_b = asyncio.create_task(disable(client, ctx, b.user_id, a.headers))
        await waiting_on_locks(1)
        b_restores_b = asyncio.create_task(restore(client, ctx, b.user_id, b.headers))
        await waiting_on_locks(2)
    finally:
        await session.commit()
        await held.__aexit__(None, None, None)
    first, second = await a_disables_b, await b_restores_b
    assert first.status_code == 200, first.text
    assert second.status_code == 403, second.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, b.user_id)).disabled_at is not None


async def test_a_disabled_owners_queued_member_changes_are_refused(client):
    ctx = await setup(client)
    a = await person(ctx.tenant_id, "owner", "owner-a")
    b = await person(ctx.tenant_id, "owner", "owner-b")
    pm = await person(ctx.tenant_id, "approver", "pm")
    held, session = await hold_gate(ctx.tenant_id)
    try:
        a_disables_b = asyncio.create_task(disable(client, ctx, b.user_id, a.headers))
        await waiting_on_locks(1)
        queued = [
            asyncio.create_task(disable(client, ctx, a.user_id, b.headers)),
            asyncio.create_task(
                client.patch(f"/v1/members/{pm.user_id}", json={"role": "owner"}, headers=b.headers)
            ),
            asyncio.create_task(
                client.post(
                    "/v1/invites",
                    json={"email": "friend@example.com", "role": "owner"},
                    headers=b.headers,
                )
            ),
        ]
        await waiting_on_locks(4)
    finally:
        await session.commit()
        await held.__aexit__(None, None, None)
    assert (await a_disables_b).status_code == 200
    for resp in await asyncio.gather(*queued):
        assert resp.status_code == 403, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(User, a.user_id)).disabled_at is None
        assert (await s.get(User, pm.user_id)).role == "approver"
        assert (await s.scalars(select(Invite))).all() == []


async def test_an_owner_demoted_while_queued_cannot_act_as_owner(client):
    ctx = await setup(client)
    a = await person(ctx.tenant_id, "owner", "owner-a")
    b = await person(ctx.tenant_id, "owner", "owner-b")
    pm = await person(ctx.tenant_id, "approver", "pm")
    held, session = await hold_gate(ctx.tenant_id)
    try:
        demote_b = asyncio.create_task(set_role(client, ctx, b.user_id, "approver"))
        await waiting_on_locks(1)
        b_disables = asyncio.create_task(disable(client, ctx, pm.user_id, b.headers))
        await waiting_on_locks(2)
    finally:
        await session.commit()
        await held.__aexit__(None, None, None)
    assert (await demote_b).status_code == 200
    assert (await b_disables).status_code == 403
    assert a.user_id  # A stays an owner throughout


async def test_a_revoked_owner_token_queued_behind_its_revocation_is_refused(client):
    from tests.test_review_v2_security_3 import member_token

    ctx = await setup(client)
    b = await person(ctx.tenant_id, "owner", "owner-b")
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, bearer = await member_token(ctx, b.user_id, "b-agent")
    held, session = await hold_gate(ctx.tenant_id)
    try:
        revoke = asyncio.create_task(client.delete(f"/v1/api-tokens/{token_id}", headers=ctx.auth))
        await waiting_on_locks(1)
        queued = asyncio.create_task(disable(client, ctx, pm.user_id, bearer))
        await waiting_on_locks(2)
    finally:
        await session.commit()
        await held.__aexit__(None, None, None)
    assert (await revoke).status_code == 204
    assert (await queued).status_code == 403


async def test_provider_and_runtime_calls_run_after_the_disable_commits(client, monkeypatch):
    """The slow outbound calls never hold the company-wide gate: the disable commits,
    then Oracle calls the provider and SwarmCloud and records what happened."""
    from oracle import crypto
    from oracle.connections import service as connections_service
    from oracle.connections.models import Connection
    from oracle.members.models import DisableFollowup

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            Connection(
                user_id=pm.user_id,
                provider="github",
                auth_mode="oauth",
                account_id="gh-1",
                account_label="pm-gh",
                ciphertext=crypto.encrypt(b'{"access_token": "placeholder"}'),
                key_version=crypto.KEY_VERSION,
            )
        )
        run = Run(flow="baseline_to_prd", created_by=pm.user_id, status="running")
        s.add(run)
        await s.flush()
        s.add(
            RunSegment(
                run_id=run.id, seq=1, name="baseline", status="running", swarm_workflow_id="wf-1"
            )
        )
        await s.commit()
        tenant_id = ctx.tenant_id

    seen: list[tuple[str, bool, bool]] = []

    async def free_and_committed() -> tuple[bool, bool]:
        async with tenant_session(tenant_id) as s:
            free = await s.scalar(
                text("SELECT pg_try_advisory_xact_lock_shared(hashtextextended(:k, 0))"),
                {"k": f"oracle-review-gate:{tenant_id}"},
            )
            disabled = (await s.get(User, pm.user_id)).disabled_at is not None
        return free, disabled

    async def fake_revoke(http, conn):
        seen.append(("provider", *(await free_and_committed())))
        return "failed"

    class Runtime:
        async def cancel(self, workflow_id):
            seen.append(("runtime", *(await free_and_committed())))

    monkeypatch.setattr(connections_service, "revoke_at_provider", fake_revoke)
    from oracle.runs import service as runs_service

    monkeypatch.setattr(runs_service, "get_runtime", lambda: Runtime())

    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert sorted(seen) == [("provider", True, True), ("runtime", True, True)]
    async with tenant_session(ctx.tenant_id) as s:
        rows = {f.kind: f for f in await s.scalars(select(DisableFollowup))}
        assert rows["runtime_cancel"].status == "done"
        # The provider refused: kept for a retry from the ticker.
        assert rows["provider_revoke"].status == "pending"
        assert rows["provider_revoke"].outcome == "failed"
        assert rows["provider_revoke"].attempts == 1

    async def ok_revoke(http, conn):
        return "revoked"

    monkeypatch.setattr(connections_service, "revoke_at_provider", ok_revoke)
    assert (await client.post("/v1/internal/tick", headers=ctx.auth)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(
            select(DisableFollowup).where(DisableFollowup.kind == "provider_revoke")
        )
        assert row.status == "done" and row.outcome == "revoked"
        # Oracle's copy of the credential is gone once the provider confirmed.
        assert row.ciphertext is None
        assert await s.scalar(
            select(AuditEvent.id).where(AuditEvent.action == "connection.provider_revoke")
        )


# --- MAJOR 3: approvals by people demoted before this change -----------------------------


def test_the_migration_lapses_approvals_of_people_demoted_before_it(scratch_db):  # noqa: F811
    from alembic import command

    from tests.test_migrations import _cfg, _run

    cfg = _cfg()
    command.upgrade(cfg, "0014_review")
    tenant = uuid.uuid4()
    demoted, approver, gone = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    weak_token, owner_token = uuid.uuid4(), uuid.uuid4()
    _run("INSERT INTO tenants (id, name) VALUES (:id, 'Example Co')", id=tenant)
    for uid, role in ((demoted, "commenter"), (approver, "approver")):
        _run(
            "INSERT INTO users (id, tenant_id, email, password_hash, role) "
            "VALUES (:u, :t, :e, 'x', :r)",
            u=uid,
            t=tenant,
            e=f"{role}@example.com",
            r=role,
        )
    for tid, role, revoked in ((weak_token, "commenter", None), (owner_token, "owner", None)):
        _run(
            "INSERT INTO api_tokens (id, tenant_id, name, token_hash, role, revoked_at) "
            "VALUES (:i, :t, :n, :h, :r, :x)",
            i=tid,
            t=tenant,
            n=role,
            h=uuid.uuid4().hex,
            r=role,
            x=revoked,
        )
    docs = {}
    for slug, approved_by in (
        ("by-demoted", demoted),
        ("by-approver", approver),
        ("by-gone", gone),
    ):
        doc, ver = uuid.uuid4(), uuid.uuid4()
        docs[slug] = (doc, ver)
        _run(
            "INSERT INTO documents (id, tenant_id, slug, title, status) "
            "VALUES (:d, :t, :s, 'Doc', 'approved')",
            d=doc,
            t=tenant,
            s=slug,
        )
        _run(
            "INSERT INTO document_versions (id, tenant_id, document_id, number, markdown, "
            "content_hash, approved_at, approved_by) "
            "VALUES (:v, :t, :d, 1, '# Doc', 'h', now(), :by)",
            v=ver,
            t=tenant,
            d=doc,
            by=approved_by,
        )
    _, ver = docs["by-approver"]
    reviews = {
        "demoted": (demoted, "approved"),
        "demoted-objection": (demoted, "changes_requested"),
        "approver": (approver, "approved"),
        "gone": (gone, "approved"),
        "weak-token": (weak_token, "approved"),
        "owner-token": (owner_token, "approved"),
    }
    ids = {}
    for key, (who, value) in reviews.items():
        ids[key] = uuid.uuid4()
        _run(
            "INSERT INTO section_reviews (id, tenant_id, version_id, section_key, verdict, "
            "reviewer_id) VALUES (:i, :t, :v, :k, :x, :w)",
            i=ids[key],
            t=tenant,
            v=ver,
            k=key,
            x=value,
            w=who,
        )

    command.upgrade(cfg, "0014_member_disable")

    lapsed = {
        r[0]: (r[1], r[2])
        for r in _run("SELECT id, lapsed_at IS NOT NULL, lapse_reason FROM section_reviews")
    }
    assert lapsed[ids["demoted"]] == (True, "demoted before this change")
    assert lapsed[ids["weak-token"]] == (True, "demoted before this change")
    assert lapsed[ids["gone"]][0] is True
    # Objections never lapse; current approvers' approvals stand.
    for key in ("demoted-objection", "approver", "owner-token"):
        assert lapsed[ids[key]] == (False, None), key
    rows = {
        r[0]: r[1:]
        for r in _run(
            "SELECT d.slug, d.status, v.approved_at IS NULL, v.approval_lapsed_by, "
            "v.approval_lapse_reason, jsonb_array_length(v.approval_lapses) "
            "FROM documents d JOIN document_versions v ON v.document_id = d.id"
        )
    }
    assert rows["by-demoted"] == ("in_review", True, demoted, "demoted before this change", 1)
    assert rows["by-approver"] == ("approved", False, None, None, 0)
    assert rows["by-gone"][:2] == ("in_review", True)
    # The downgrade guard still holds: lapsed approvals would count again.
    with pytest.raises(RuntimeError, match="lapsed"):
        command.downgrade(cfg, "0014_review")


# --- OAuth grants: approvals record the grant; revoking it voids them --------------------


async def test_approvals_through_an_oauth_grant_record_it_and_revoking_it_voids_them(client):
    ctx = await setup(client)
    await policy(client, ctx, section_approval="all_sections")
    pm = await person(ctx.tenant_id, "approver", "pm")
    client_id, access, _, grant_id = await oauth_grant(ctx, pm.user_id)
    mcp = {"Authorization": f"Bearer {access}"}
    await approve_all(client, mcp, 1)
    await approved(client, ctx, headers=mcp)
    assert (await check(client, ctx))["can_publish"] is True
    async with tenant_session(ctx.tenant_id) as s:
        reviews = (await s.scalars(select(SectionReview))).all()
        assert reviews and {r.oauth_grant_id for r in reviews} == {grant_id}
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_grant_id == grant_id and v1.approved_by == pm.user_id
        [event] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "version.approve"))
        ).all()
        assert event.actor_grant_id == grant_id

    resp = await client.post("/oauth/revoke", data={"client_id": client_id, "token": access})
    assert resp.status_code == 200
    body = await check(client, ctx)
    assert {"version_approval_lapsed", "missing_approval"} <= set(codes(body))
    async with tenant_session(ctx.tenant_id) as s:
        assert all(r.lapsed_at is not None for r in await s.scalars(select(SectionReview)))
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_at is None and v1.approval_lapsed_at is not None
        assert "OAuth" in v1.approval_lapse_reason
    # The person's own sign-in still works; a fresh approval counts.
    await approve_all(client, pm.headers, 1)
    await approved(client, ctx, headers=pm.headers)
    assert (await check(client, ctx))["can_publish"] is True


async def test_a_replayed_refresh_token_ends_the_grant_and_its_approvals(client):
    from oracle.mcp.oauth.service import OAuthError, refresh

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    client_id, access, refresh_token, _ = await oauth_grant(ctx, pm.user_id)
    await approved(client, ctx, headers={"Authorization": f"Bearer {access}"})
    assert (await check(client, ctx))["can_publish"] is True
    await refresh(client_id, refresh_token, None)
    with pytest.raises(OAuthError):
        await refresh(client_id, refresh_token, None)
    assert codes(await check(client, ctx)) == ["version_approval_lapsed"]


async def test_a_grant_revoked_outside_oauth_still_voids_at_gate_time(client):
    from oracle.mcp.oauth.models import OAuthToken

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


# --- minors ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "form",
    [
        lambda u: u.hex,
        lambda u: str(u).upper(),
        lambda u: "{" + str(u) + "}",
        lambda u: f"urn:uuid:{u}",
    ],
    ids=["undashed", "uppercase", "braces", "urn"],
)
@pytest.mark.parametrize("stored_undashed", [False, True], ids=["stored-dashed", "stored-hex"])
async def test_notion_page_ids_match_in_any_uuid_form(client, form, stored_undashed):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    page = uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="notion", name="Wiki")
        s.add(source)
        await s.flush()
        stored = page.hex if stored_undashed else str(page)
        s.add(SourceItem(source_id=source.id, external_id=stored, kind="page", title="Plan"))
        await s.commit()
        source_id = source.id
    draft = replace(
        replace(DRAFT, "ref: https://example.com/calendar-survey", f'ref: "{form(page)}"'),
        "source: web",
        "source: notion",
    )
    assert (await import_md(client, ctx.auth, draft, base=1)).status_code == 201
    await approved(client, ctx, 2)
    # The item exists, its source revoked: the item lookup matches.
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.scalar(select(SourceItem).where(SourceItem.source_id == source_id))
        item.deleted_at = datetime.now(UTC)
        await s.commit()
    body = await check(client, ctx, 2)
    assert codes(body) == ["source_permission_revoked"]
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]
    # Hard-deleted, only the tombstone names it: the tombstone matches too.
    resp = await client.delete(f"/v1/sources/{source_id}", headers=owner.headers)
    assert resp.status_code == 204, resp.text
    body = await check(client, ctx, 2)
    assert blocker(body, "source_permission_revoked")["section_keys"] == ["goal-trace"]


async def test_an_oauth_refresh_racing_a_disable_is_refused(client):
    from oracle.mcp.oauth.service import OAuthError, refresh

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    client_id, _, refresh_token, _ = await oauth_grant(ctx, pm.user_id)
    # A disable in progress holds the member's row until it commits.
    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, pm.user_id, with_for_update=True)
        task = asyncio.create_task(refresh(client_id, refresh_token, None))
        await asyncio.sleep(0.3)
        user.disabled_at = datetime.now(UTC)
        user.sessions_valid_after = user.disabled_at
        await s.commit()
    with pytest.raises(OAuthError) as raised:
        await task
    assert raised.value.error == "invalid_grant"


async def test_an_oauth_token_minted_during_a_disable_is_dead_after_the_restore(client):
    """A credential issued before the restore (a refresh that committed while the
    disable ran) never acts for the restored member."""
    from oracle.mcp.oauth.models import OAuthToken

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    _, access, _, grant_id = await oauth_grant(ctx, pm.user_id)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    # The race's outcome: a row the bulk revoke did not see.
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(
            update(OAuthToken).where(OAuthToken.family_id == grant_id).values(revoked_at=None)
        )
        await s.commit()
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    headers = {"Authorization": f"Bearer {access}"}
    assert (await client.get(f"/v1/documents/{DOC}", headers=headers)).status_code == 401


async def test_a_connection_callback_finishing_after_a_disable_connects_nothing(
    client, monkeypatch
):
    from oracle.connections import oauth
    from oracle.connections.models import Connection

    monkeypatch.setenv("ORACLE_OAUTH_GITHUB_CLIENT_ID", "client-123")
    monkeypatch.setenv("ORACLE_OAUTH_GITHUB_CLIENT_SECRET", "secret-456")
    monkeypatch.setenv("ORACLE_OAUTH_REDIRECT_BASE", "https://oracle.example.com")
    oauth.get_oauth_settings.cache_clear()
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    state = oauth.encode_state(
        oauth.State(
            tenant_id=ctx.tenant_id,
            user_id=pm.user_id,
            provider="github",
            verifier="v" * 64,
            connection_id=None,
        )
    )
    use_provider_http(lambda request: httpx.Response(200, json={"id": 42, "login": "user-42"}))
    real = oauth.exchange_code

    async def slow_exchange(*args, **kwargs):
        # The owner disables the member while the provider answers.
        async with tenant_session(ctx.tenant_id) as s:
            user = await s.get(User, pm.user_id)
            user.disabled_at = datetime.now(UTC)
            user.sessions_valid_after = user.disabled_at
            await s.commit()
        return oauth.Tokens("example-access", "example-refresh", None, ["repo"])

    monkeypatch.setattr(oauth, "exchange_code", slow_exchange)
    try:
        back = await client.get(
            "/v1/connections/github/callback",
            params={"code": "the-code", "state": state},
            headers=pm.headers,
        )
    finally:
        monkeypatch.setattr(oauth, "exchange_code", real)
        oauth.get_oauth_settings.cache_clear()
        clear_provider_http()
    assert back.status_code == 303
    assert "error" in parse_qs(urlparse(back.headers["location"]).query)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(Connection))).all() == []


async def test_invites_the_disabled_owner_created_are_revoked(client):
    ctx = await setup(client)
    b = await person(ctx.tenant_id, "owner", "owner-b")
    resp = await client.post(
        "/v1/invites", json={"email": "friend@example.com", "role": "owner"}, headers=b.headers
    )
    assert resp.status_code == 201, resp.text
    other = await client.post(
        "/v1/invites", json={"email": "other@example.com", "role": "viewer"}, headers=ctx.auth
    )
    assert other.status_code == 201
    assert (await disable(client, ctx, b.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        invites = {i.email: i for i in await s.scalars(select(Invite))}
    assert invites["friend@example.com"].revoked_at is not None
    assert invites["other@example.com"].revoked_at is None


async def test_queued_llm_jobs_of_the_disabled_member_are_cancelled(client):
    from oracle.docs.models import Document
    from oracle.jobs.models import LlmJob

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    other = await person(ctx.tenant_id, "approver", "other")
    async with tenant_session(ctx.tenant_id) as s:
        document = await s.scalar(select(Document).where(Document.slug == DOC))
        mine = LlmJob(kind="refinement", document_id=document.id, requested_by=pm.user_id)
        theirs = LlmJob(kind="refinement", document_id=document.id, requested_by=other.user_id)
        s.add_all([mine, theirs])
        await s.commit()
        mine_id, theirs_id = mine.id, theirs.id
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(LlmJob, mine_id)).status == "cancelled"
        assert (await s.get(LlmJob, theirs_id)).status == "queued"


async def test_a_disabled_approvers_spend_approval_is_voided_on_an_unstarted_run(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    creator = await person(ctx.tenant_id, "owner", "creator")
    at = datetime.now(UTC)
    async with tenant_session(ctx.tenant_id) as s:
        unstarted = Run(
            flow="baseline_to_prd",
            created_by=creator.user_id,
            status="running",
            estimate_usd=Decimal("80"),
            approved_by=pm.user_id,
            approved_at=at,
            knobs={"spend_ceiling_usd": "120"},
        )
        started = Run(
            flow="baseline_to_prd",
            created_by=creator.user_id,
            status="running",
            estimate_usd=Decimal("80"),
            approved_by=pm.user_id,
            approved_at=at,
            started_at=at,
            knobs={"spend_ceiling_usd": "120"},
        )
        s.add_all([unstarted, started])
        await s.flush()
        s.add(RunSegment(run_id=unstarted.id, seq=1, name="baseline", status="pending"))
        s.add(
            RunSegment(
                run_id=started.id,
                seq=1,
                name="baseline",
                status="running",
                started_at=at,
                swarm_workflow_id="wf-x",
            )
        )
        await s.commit()
        unstarted_id, started_id = unstarted.id, started.id
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        u = await s.get(Run, unstarted_id)
        assert u.status == "awaiting_approval" and u.approved_by is None
        assert "spend_ceiling_usd" not in (u.knobs or {})
        st = await s.get(Run, started_id)
        assert st.status == "running" and st.approved_by == pm.user_id
        assert st.knobs["spend_ceiling_usd"] == "120"


async def test_disabled_members_are_not_section_owners_reviewers_or_invitees(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    active = await person(ctx.tenant_id, "commenter", "active")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    for body in ({"owner_id": str(pm.user_id)}, {"reviewer_ids": [str(pm.user_id)]}):
        resp = await client.put(
            f"/v1/documents/{DOC}/sections/risks/assignment", json=body, headers=ctx.auth
        )
        assert resp.status_code in (400, 422), resp.text
        assert "disabled" in resp.text
    resp = await client.post(
        f"/v1/documents/{DOC}/campaigns",
        json={"title": "Read me", "version": 1, "audience_roles": ["approver", "commenter"]},
        headers=ctx.auth,
    )
    assert resp.status_code in (200, 201), resp.text
    # Invited: the active commenter only (the disabled approver is not).
    assert resp.json()["invited"] == 1
    from oracle.review.models import Notification

    async with tenant_session(ctx.tenant_id) as s:
        notified = {n.user_id for n in await s.scalars(select(Notification))}
    assert active.user_id in notified and pm.user_id not in notified


async def test_the_legacy_version_view_shows_a_lapsed_approval_as_lapsed(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approve_all(client, pm.headers, 1)
    assert (await set_role(client, ctx, pm.user_id, "commenter")).status_code == 200
    version = (await client.get(ctx.v(1), headers=ctx.auth)).json()
    verdicts = [s["verdict"] for s in version["sections"] if s["verdict"]]
    assert verdicts
    for v in verdicts:
        assert v["verdict"] == "approved" and v["lapsed_at"] is not None
        assert "demoted" in v["lapse_reason"]


async def test_a_disabled_row_does_not_block_the_same_email_in_another_tenant(client):
    from oracle.auth.service import authenticate_user
    from tests.conftest import make_tenant

    email = f"shared-{uuid.uuid4().hex[:6]}@example.com"
    first, second = await make_tenant("First Co"), await make_tenant("Second Co")
    ids = {}
    for tenant in (first, second):
        async with tenant_session(tenant) as s:
            user = await create_user(s, email, "pw")
            await s.commit()
            ids[tenant] = user.id
    # Whichever row a lookup finds first, a disabled one never hides the other.
    for disabled, active in ((first, second), (second, first)):
        async with unscoped_session() as s:
            for tenant, value in ((disabled, datetime.now(UTC)), (active, None)):
                (await s.get(User, ids[tenant])).disabled_at = value
            await s.commit()
        user = await authenticate_user(email, "pw")
        assert user is not None and user.id == ids[active]


def test_an_ai_patch_cannot_add_sections_at_the_end():
    from types import SimpleNamespace

    from oracle.docs.parser import DraftError
    from oracle.jobs.service import compose_markdown

    sections = [
        SimpleNamespace(section_key="a", level=2, heading="A", body_md="Kept."),
        SimpleNamespace(section_key="b", level=2, heading="B", body_md="Last."),
    ]
    with pytest.raises(DraftError) as raised:
        compose_markdown(
            {"title": "T"}, sections, {"b": ("B", "Last.\n\n## Extra {#extra}\n\nAdded.")}, []
        )
    [problem] = raised.value.problems
    assert problem.code == "section_added" and problem.section_key == "extra"


async def test_a_new_approval_keeps_the_lapsed_history(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    await approved(client, ctx, headers=pm.headers)
    assert (await set_role(client, ctx, pm.user_id, "commenter")).status_code == 200
    await approved(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        v1 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 1))
        assert v1.approved_at is not None and v1.approval_lapsed_at is None
        [entry] = v1.approval_lapses
        assert entry["approved_by"] == str(pm.user_id)
        assert "demoted" in entry["reason"] and entry["lapsed_at"]
    version = (await client.get(ctx.v(1), headers=ctx.auth)).json()
    [lapse] = version["approval_lapses"]
    assert lapse["approved_by"] == str(pm.user_id)


# --- also checked ---------------------------------------------------------------------------


async def test_a_sync_finishing_after_a_disable_leaves_the_source_paused(client, monkeypatch):
    from oracle.sources import service as sources_service
    from oracle.sources import sync as sync_engine
    from oracle.sources.base import CursorCheckpoint

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    async with tenant_session(ctx.tenant_id) as s:
        # A source whose last sync failed syncs again (only a paused one is refused).
        source = Source(owner_user_id=pm.user_id, kind="notion", name="Wiki", status="error")
        s.add(source)
        await s.commit()
        source_id = source.id

    class Connector:
        async def sync(self, config, credential, cursor):
            # The disable pauses the source while the sync runs.
            async with tenant_session(ctx.tenant_id) as s:
                (await s.get(Source, source_id)).status = "paused"
                await s.commit()
            if False:
                yield CursorCheckpoint(cursor={"page": 1})

    async def credential_for(db, source):
        return {"access_token": "placeholder"}, None

    monkeypatch.setattr(sources_service, "connector_for", lambda kind: Connector())
    monkeypatch.setattr(sources_service, "credential_for", credential_for)
    async with tenant_session(ctx.tenant_id) as s:
        source = await s.get(Source, source_id)
        stats = await sync_engine.sync_source(s, source)
        assert stats.outcome == "completed", stats
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Source, source_id)).status == "paused"


async def test_a_disabled_members_sessions_cut_off_also_applies_to_user_api_tokens(client):
    """An API token for the member created while the disable ran (not seen by its bulk
    revoke) never acts after the restore."""
    from oracle.auth.models import ApiToken
    from tests.test_review_v2_security_3 import member_token

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    token_id, bearer = await member_token(ctx, pm.user_id)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(ApiToken, token_id)).revoked_at = None
        await s.commit()
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    assert (await client.get(f"/v1/documents/{DOC}", headers=bearer)).status_code == 401


async def test_a_restored_member_signs_in_fresh_and_can_approve_again(client):
    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    email = await email_of(ctx, pm.user_id)
    await approved(client, ctx, headers=pm.headers)
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    assert (await restore(client, ctx, pm.user_id)).status_code == 200
    fresh = await sign_in(client, email)
    await approved(client, ctx, headers=fresh)
    assert (await check(client, ctx))["can_publish"] is True
    s1 = await states(client, ctx.auth, 1)
    assert s1


from tests.test_migrations import scratch_db  # noqa: E402,F401
