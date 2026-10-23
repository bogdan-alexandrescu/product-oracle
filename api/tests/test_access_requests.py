# ruff: noqa: F811 (the IAP fixture, imported from tests.test_iap)
"""A5 Members and access: who becomes a member through Google sign-in.

Cards:
- protects: no one becomes a member without an invite or an owner's (or approver's) yes
  under ``request``; the state a refused person sees; who may approve, and as what.
- fails_when: an uninvited person gets a user row, a second pending row, an outside
  domain gets in, a declined person gets a new row, or an approver approves an approver.
- no_claim: the gate in front of Oracle (the deployment's IAP access list); the web page.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from oracle.auth.models import User
from oracle.config import get_settings
from oracle.members.models import AccessRequest, Invite
from oracle.models import AuditEvent
from oracle.seed import seed
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from tests.review_v2_helpers import person
from tests.test_iap import HEADER, assertion, fetches  # noqa: F401 (fixture)

NEW = "new.person@example.com"


def _as(email: str) -> dict[str, str]:
    return {HEADER: assertion(email)}


async def _setting(tenant_id, key: str, value) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.scalar(select(TenantSetting).where(TenantSetting.key == key))
        if row is None:
            s.add(TenantSetting(key=key, value=value))
        else:
            row.value = value
        await s.commit()


async def _requests(tenant_id) -> list[AccessRequest]:
    async with tenant_session(tenant_id) as s:
        return list((await s.scalars(select(AccessRequest))).all())


async def _user(tenant_id, email: str) -> User | None:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(User).where(User.email == email))


async def _owner(tenant_id):
    return await person(tenant_id, "owner")


async def test_request_rule_keeps_an_uninvited_person_waiting(client, fetches):
    r = await seed()
    resp = await client.get("/v1/me", headers=_as(NEW))
    assert resp.status_code == 401
    assert await _user(r.tenant_id, NEW) is None
    [row] = await _requests(r.tenant_id)
    assert (row.email, row.status) == (NEW, "pending")
    seen = row.last_seen_at

    # A second sign-in within 10 minutes: no second row, last_seen_at unchanged.
    assert (await client.get("/v1/me", headers=_as(NEW))).status_code == 401
    [again] = await _requests(r.tenant_id)
    assert again.id == row.id and again.last_seen_at == seen

    state = await client.get("/v1/auth/access", headers=_as(NEW))
    assert state.status_code == 200
    body = state.json()
    assert body["state"] == "pending" and body["email"] == NEW
    assert body["company"] and body["requested_at"]
    async with tenant_session(r.tenant_id) as s:
        actions = (await s.scalars(select(AuditEvent.action))).all()
        assert list(actions) == ["access_request.create"]


async def test_access_state_without_google_sign_in(client):
    await seed()
    resp = await client.get("/v1/auth/access")
    assert resp.json() == {
        "state": "no_google_sign_in", "email": None, "company": None,
        "requested_at": None, "note": None, "invite_expired_at": None,
    }  # fmt: skip


async def test_the_note_is_set_on_the_pending_request(client, fetches):
    r = await seed()
    assert (
        await client.post("/v1/auth/access/note", json={"note": "x"}, headers=_as(NEW))
    ).status_code == 409
    await client.get("/v1/me", headers=_as(NEW))
    resp = await client.post(
        "/v1/auth/access/note", json={"note": "I lead support."}, headers=_as(NEW)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["note"] == "I lead support."
    [row] = await _requests(r.tenant_id)
    assert row.note == "I lead support."
    too_long = await client.post("/v1/auth/access/note", json={"note": "x" * 501}, headers=_as(NEW))
    assert too_long.status_code == 422


async def test_inbox_lists_requests_for_owners_and_approvers_only(client, fetches):
    r = await seed()
    await client.get("/v1/me", headers=_as(NEW))
    owner = await _owner(r.tenant_id)
    approver = await person(r.tenant_id, "approver")
    commenter = await person(r.tenant_id, "commenter")

    mine = (await client.get("/v1/inbox", headers=owner.headers)).json()
    [row] = mine["access_requests"]
    assert row["email"] == NEW and row["default_role"] == "commenter"
    assert row["roles"] == ["viewer", "commenter", "approver", "owner"]
    assert mine["total"] >= 1

    theirs = (await client.get("/v1/inbox", headers=approver.headers)).json()
    assert theirs["access_requests"][0]["roles"] == ["viewer", "commenter"]
    assert (await client.get("/v1/inbox", headers=commenter.headers)).json()[
        "access_requests"
    ] == []
    # The badge counts it: approving it drops the owner's total by one.
    await client.post(
        f"/v1/access-requests/{row['id']}/approve", json={"role": "viewer"}, headers=owner.headers
    )
    after = (await client.get("/v1/inbox", headers=owner.headers)).json()
    assert after["access_requests"] == [] and after["total"] == mine["total"] - 1


async def test_approve_lets_them_in_with_the_role_and_name(client, fetches):
    r = await seed()
    await client.get("/v1/me", headers=_as(NEW))
    [req] = await _requests(r.tenant_id)
    owner = await _owner(r.tenant_id)
    resp = await client.post(
        f"/v1/access-requests/{req.id}/approve",
        json={"role": "viewer", "name": "Support lead"},
        headers=owner.headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "approved" and resp.json()["invite_id"]
    assert (await client.get("/v1/auth/access", headers=_as(NEW))).json()["state"] == "approved"

    me = await client.get("/v1/me", headers=_as(NEW))
    assert me.status_code == 200, me.text
    assert (me.json()["role"], me.json()["name"]) == ("viewer", "Support lead")
    async with tenant_session(r.tenant_id) as s:
        provision = await s.scalar(select(AuditEvent).where(AuditEvent.action == "provision"))
        assert provision.data["via"] == "access_request"
        assert (await s.get(AccessRequest, req.id)).status == "approved"
    # Not pending any more: a second approve is a 409.
    again = await client.post(
        f"/v1/access-requests/{req.id}/approve", json={"role": "viewer"}, headers=owner.headers
    )
    assert again.status_code == 409


async def test_decline_keeps_them_out_until_an_invite(client, fetches):
    r = await seed()
    await client.get("/v1/me", headers=_as(NEW))
    [req] = await _requests(r.tenant_id)
    owner = await _owner(r.tenant_id)
    resp = await client.post(f"/v1/access-requests/{req.id}/decline", headers=owner.headers)
    assert resp.status_code == 200 and resp.json()["status"] == "declined"

    assert (await client.get("/v1/me", headers=_as(NEW))).status_code == 401
    assert len(await _requests(r.tenant_id)) == 1
    assert (await client.get("/v1/auth/access", headers=_as(NEW))).json()["state"] == "declined"

    # Reopen puts it back to pending (Undo).
    reopened = await client.post(f"/v1/access-requests/{req.id}/reopen", headers=owner.headers)
    assert reopened.status_code == 200 and reopened.json()["status"] == "pending"
    await client.post(f"/v1/access-requests/{req.id}/decline", headers=owner.headers)

    # An invite beats a declined request.
    invite = await client.post(
        "/v1/invites", json={"email": NEW, "role": "commenter"}, headers=owner.headers
    )
    assert invite.status_code == 201, invite.text
    me = await client.get("/v1/me", headers=_as(NEW))
    assert me.status_code == 200 and me.json()["role"] == "commenter"


async def test_reopen_an_approved_request_revokes_its_unclaimed_invite(client, fetches):
    r = await seed()
    await client.get("/v1/me", headers=_as(NEW))
    [req] = await _requests(r.tenant_id)
    owner = await _owner(r.tenant_id)
    approved = await client.post(
        f"/v1/access-requests/{req.id}/approve", json={"role": "viewer"}, headers=owner.headers
    )
    invite_id = uuid.UUID(approved.json()["invite_id"])
    resp = await client.post(f"/v1/access-requests/{req.id}/reopen", headers=owner.headers)
    assert resp.status_code == 200 and resp.json()["status"] == "pending"
    async with tenant_session(r.tenant_id) as s:
        assert (await s.get(Invite, invite_id)).revoked_at is not None
    assert (await client.get("/v1/me", headers=_as(NEW))).status_code == 401


async def test_join_and_refuse_rules_and_new_sign_ins_off(client, fetches, monkeypatch):
    r = await seed()
    await _setting(r.tenant_id, "sign_in_without_invite", "join")
    joined = await client.get("/v1/me", headers=_as("lee@example.com"))
    assert joined.status_code == 200 and joined.json()["role"] == "commenter"

    await _setting(r.tenant_id, "sign_in_without_invite", "refuse")
    assert (await client.get("/v1/me", headers=_as(NEW))).status_code == 401
    assert await _requests(r.tenant_id) == []
    assert (await client.get("/v1/auth/access", headers=_as(NEW))).json()["state"] == "invite_only"

    await _setting(r.tenant_id, "sign_in_without_invite", "request")
    monkeypatch.setattr(get_settings(), "iap_auto_provision", False)
    assert (await client.get("/v1/me", headers=_as(NEW))).status_code == 401
    assert await _requests(r.tenant_id) == []
    assert (await client.get("/v1/auth/access", headers=_as(NEW))).json()["state"] == "invite_only"


async def test_sign_in_domains_include_the_company_setting_never_inferred(
    client, fetches, monkeypatch
):
    settings = get_settings()
    monkeypatch.setattr(settings, "iap_allowed_domains", [])
    monkeypatch.setattr(settings, "infer_company_domains", True)
    r = await seed()
    # No domains set: nobody is admitted, even with inference on (local development).
    assert (await client.get("/v1/me", headers=_as("x@example.com"))).status_code == 401
    assert await _requests(r.tenant_id) == []
    state = (await client.get("/v1/auth/access", headers=_as("x@example.com"))).json()
    assert state["state"] == "outside_domains"

    await _setting(r.tenant_id, "company_email_domains", ["example.org"])
    assert (await client.get("/v1/me", headers=_as("x@example.org"))).status_code == 401
    assert [q.email for q in await _requests(r.tenant_id)] == ["x@example.org"]
    out = (await client.get("/v1/auth/access", headers=_as("x@example.net"))).json()
    assert out["state"] == "outside_domains"


async def test_removed_member_state(client, fetches):
    r = await seed()
    async with tenant_session(r.tenant_id) as s:
        user = await s.scalar(select(User).where(User.email == "admin@example.com"))
        user.disabled_at = datetime.now(UTC)
        s.add(User(email="kept@example.com", password_hash="x", role="viewer"))
        await s.commit()
    state = await client.get("/v1/auth/access", headers=_as("admin@example.com"))
    assert state.json()["state"] == "removed"
    assert (await client.get("/v1/auth/access", headers=_as("kept@example.com"))).json()[
        "state"
    ] == "member"


async def test_default_role_and_rule_settings(client):
    r = await seed()
    owner = await _owner(r.tenant_id)
    for bad in ("approver", "owner"):
        resp = await client.put(
            "/v1/settings/iap_default_role", json={"value": bad}, headers=owner.headers
        )
        assert resp.status_code == 422, bad
    ok = await client.put(
        "/v1/settings/iap_default_role", json={"value": "viewer"}, headers=owner.headers
    )
    assert ok.status_code == 200
    maybe = await client.put(
        "/v1/settings/sign_in_without_invite", json={"value": "maybe"}, headers=owner.headers
    )
    assert maybe.status_code == 422
    join = await client.put(
        "/v1/settings/sign_in_without_invite", json={"value": "join"}, headers=owner.headers
    )
    assert join.status_code == 200


async def test_sign_in_rules(client, fetches):
    r = await seed()
    owner = await _owner(r.tenant_id)
    await _setting(r.tenant_id, "company_email_domains", ["example.org"])
    resp = await client.get("/v1/sign-in-rules", headers=owner.headers)
    assert resp.status_code == 200
    assert resp.json() == {
        "google_sign_in": True,
        "new_sign_ins_off": False,
        "domains": [
            {"domain": "example.com", "from": "deployment"},
            {"domain": "example.org", "from": "settings"},
        ],
        "without_invite": "request",
        "default_role": "commenter",
    }
    approver = await person(r.tenant_id, "approver")
    assert (await client.get("/v1/sign-in-rules", headers=approver.headers)).status_code == 403


async def test_approvers_approve_as_viewer_or_commenter_only(client, fetches):
    r = await seed()
    await client.get("/v1/me", headers=_as(NEW))
    [req] = await _requests(r.tenant_id)
    approver = await person(r.tenant_id, "approver")
    commenter = await person(r.tenant_id, "commenter")
    url = f"/v1/access-requests/{req.id}"
    assert (await client.get("/v1/access-requests", headers=commenter.headers)).status_code == 403
    assert (await client.post(f"{url}/decline", headers=commenter.headers)).status_code == 403
    high = await client.post(f"{url}/approve", json={"role": "approver"}, headers=approver.headers)
    assert high.status_code == 403
    assert "Ask an owner to invite an approver" in high.json()["detail"]
    listed = await client.get("/v1/access-requests", headers=approver.headers)
    assert [q["email"] for q in listed.json()] == [NEW]
    ok = await client.post(f"{url}/approve", json={"role": "viewer"}, headers=approver.headers)
    assert ok.status_code == 200, ok.text


async def test_an_approve_for_someone_already_a_member_closes_the_request(client, fetches):
    r = await seed()
    await client.get("/v1/me", headers=_as(NEW))
    [req] = await _requests(r.tenant_id)
    async with tenant_session(r.tenant_id) as s:
        s.add(User(email=NEW, password_hash="x", role="viewer"))
        await s.commit()
    owner = await _owner(r.tenant_id)
    resp = await client.post(
        f"/v1/access-requests/{req.id}/approve", json={"role": "viewer"}, headers=owner.headers
    )
    assert resp.status_code == 409
    [row] = await _requests(r.tenant_id)
    assert row.status == "closed"


async def test_a_pending_request_is_closed_when_an_invite_lets_them_in(client, fetches):
    r = await seed()
    await client.get("/v1/me", headers=_as(NEW))
    owner = await _owner(r.tenant_id)
    await client.post("/v1/invites", json={"email": NEW, "role": "viewer"}, headers=owner.headers)
    assert (await client.get("/v1/me", headers=_as(NEW))).status_code == 200
    [row] = await _requests(r.tenant_id)
    assert row.status == "closed"
    async with tenant_session(r.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(AccessRequest)) == 1


async def test_last_seen_is_touched_after_ten_minutes(client, fetches):
    r = await seed()
    await client.get("/v1/me", headers=_as(NEW))
    old = datetime.now(UTC) - timedelta(minutes=11)
    async with tenant_session(r.tenant_id) as s:
        row = await s.scalar(select(AccessRequest))
        row.last_seen_at = old
        await s.commit()
    await client.get("/v1/me", headers=_as(NEW))
    [row] = await _requests(r.tenant_id)
    assert row.last_seen_at > old + timedelta(minutes=10)
