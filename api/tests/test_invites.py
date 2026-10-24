# ruff: noqa: F811 (the IAP fixture, imported from tests.test_iap)
"""A5 Members and access: invites expire, can be resent, and approvers invite too; names.

Cards:
- protects: an invite reaches only the intended address within its window; approvers
  invite and manage only viewers and commenters they invited; a person's name is stored
  trimmed, shown in the directory and taken from the invite at first sign-in.
- fails_when: an expired invite is claimed, an approver gives approver or touches an
  owner's invite, an invite outside the company's domains is made with Google sign-in on,
  or a bad name is stored.
- no_claim: the email delivery (oracle.members.delivery has its own tests); the web page.
"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle.auth.models import ApiToken, User
from oracle.auth.service import create_api_token
from oracle.config import get_settings
from oracle.members.models import Invite
from oracle.models import AuditEvent
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import person
from tests.test_iap import HEADER, assertion, fetches  # noqa: F401 (fixture)

LEAD = "lead@example.com"


async def _expire(tenant_id, invite_id) -> None:
    async with tenant_session(tenant_id) as s:
        invite = await s.get(Invite, invite_id)
        invite.expires_at = datetime.now(UTC) - timedelta(minutes=1)
        await s.commit()


async def _actions(tenant_id, action: str) -> list[dict]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(select(AuditEvent).where(AuditEvent.action == action))
        return [e.data for e in rows]


def _close_to(value: str, delta: timedelta) -> bool:
    got = datetime.fromisoformat(value)
    return abs(got - (datetime.now(UTC) + delta)) < timedelta(minutes=1)


async def test_an_invite_expires_and_resend_brings_it_back(client, fetches):
    from tests.test_access_requests import _seed_request

    # Under ``request`` an expired invite is refused (``join``, the default, lets them in).
    r = await _seed_request()
    owner = await person(r.tenant_id, "owner")
    made = await client.post(
        "/v1/invites", json={"email": LEAD, "role": "commenter"}, headers=owner.headers
    )
    assert made.status_code == 201, made.text
    invite = made.json()
    assert invite["status"] == "open" and invite["resend_count"] == 0
    assert _close_to(invite["expires_at"], timedelta(days=14))

    await _expire(r.tenant_id, invite["id"])
    assert (await client.get("/v1/me", headers={HEADER: assertion(LEAD)})).status_code == 401
    state = (await client.get("/v1/auth/access", headers={HEADER: assertion(LEAD)})).json()
    assert state["state"] == "invite_expired" and state["invite_expired_at"]
    listed = (await client.get("/v1/invites", headers=owner.headers)).json()
    assert [i["status"] for i in listed] == ["expired"]
    only = (await client.get("/v1/invites?status=expired", headers=owner.headers)).json()
    assert [i["id"] for i in only] == [invite["id"]]

    # A new invite for that email: resend the expired one instead.
    dup = await client.post(
        "/v1/invites", json={"email": LEAD, "role": "viewer"}, headers=owner.headers
    )
    assert dup.status_code == 409 and "has an expired invite; resend it" in dup.json()["detail"]

    resent = await client.post(f"/v1/invites/{invite['id']}/resend", headers=owner.headers)
    assert resent.status_code == 200, resent.text
    body = resent.json()
    assert body["status"] == "open" and body["resend_count"] == 1 and body["resent_at"]
    assert _close_to(body["expires_at"], timedelta(days=14))
    assert len(await _actions(r.tenant_id, "invite.resend")) == 1
    me = await client.get("/v1/me", headers={HEADER: assertion(LEAD)})
    assert me.status_code == 200 and me.json()["role"] == "commenter"

    # Accepted now: resending is a 409; so is resending a revoked one.
    assert (
        await client.post(f"/v1/invites/{invite['id']}/resend", headers=owner.headers)
    ).status_code == 409
    other = await client.post(
        "/v1/invites", json={"email": "other@example.com", "role": "viewer"}, headers=owner.headers
    )
    await client.delete(f"/v1/invites/{other.json()['id']}", headers=owner.headers)
    assert (
        await client.post(f"/v1/invites/{other.json()['id']}/resend", headers=owner.headers)
    ).status_code == 409


async def test_invites_outside_the_company_domains_are_refused_with_google_sign_in(
    client, fetches, monkeypatch
):
    r = await seed()
    owner = await person(r.tenant_id, "owner")
    out = await client.post(
        "/v1/invites", json={"email": "x@elsewhere.test", "role": "viewer"}, headers=owner.headers
    )
    assert out.status_code == 422
    assert "outside the company's email domains (example.com)" in out.json()["detail"]
    async with tenant_session(r.tenant_id) as s:
        assert (await s.scalars(select(Invite))).all() == []
    # Google sign-in off: made as before.
    monkeypatch.setattr(get_settings(), "iap_audiences", [])
    monkeypatch.setattr(get_settings(), "iap_allowed_domains", [])
    ok = await client.post(
        "/v1/invites", json={"email": "x@elsewhere.test", "role": "viewer"}, headers=owner.headers
    )
    assert ok.status_code == 201, ok.text


async def test_approvers_invite_viewers_and_commenters_and_see_only_theirs(client):
    r = await seed()
    owner = await person(r.tenant_id, "owner")
    approver = await person(r.tenant_id, "approver")
    commenter = await person(r.tenant_id, "commenter")
    theirs = await client.post(
        "/v1/invites", json={"email": "a@example.com", "role": "viewer"}, headers=owner.headers
    )
    mine = await client.post(
        "/v1/invites",
        json={"email": "b@example.com", "role": "commenter"},
        headers=approver.headers,
    )
    assert mine.status_code == 201, mine.text
    high = await client.post(
        "/v1/invites", json={"email": "c@example.com", "role": "approver"}, headers=approver.headers
    )
    assert high.status_code == 403
    assert high.json()["detail"] == (
        "Approvers invite viewers and commenters. Ask an owner to invite an approver."
    )
    listed = (await client.get("/v1/invites", headers=approver.headers)).json()
    assert [i["email"] for i in listed] == ["b@example.com"]
    assert listed[0]["invited_by_name"]
    owner_id = theirs.json()["id"]
    assert (
        await client.post(f"/v1/invites/{owner_id}/resend", headers=approver.headers)
    ).status_code == 404
    assert (
        await client.delete(f"/v1/invites/{owner_id}", headers=approver.headers)
    ).status_code == 404
    assert (
        await client.post(f"/v1/invites/{mine.json()['id']}/resend", headers=approver.headers)
    ).status_code == 200
    assert (
        await client.delete(f"/v1/invites/{mine.json()['id']}", headers=approver.headers)
    ).status_code == 204
    # The owner sees every invite.
    assert len((await client.get("/v1/invites?status=all", headers=owner.headers)).json()) == 2

    for method, url in [
        ("GET", "/v1/invites"),
        ("POST", "/v1/invites"),
        ("POST", f"/v1/invites/{owner_id}/resend"),
        ("DELETE", f"/v1/invites/{owner_id}"),
        ("GET", "/v1/access-requests"),
    ]:
        body = {"email": "d@example.com", "role": "viewer"} if method == "POST" else None
        resp = await client.request(method, url, json=body, headers=commenter.headers)
        assert resp.status_code == 403, (method, url)


async def test_me_lists_invite_roles_per_role(client):
    r = await seed()
    expected = {
        "owner": ["viewer", "commenter", "approver", "owner"],
        "approver": ["viewer", "commenter"],
        "commenter": [],
        "viewer": [],
    }
    for role, roles in expected.items():
        p = await person(r.tenant_id, role)
        assert (await client.get("/v1/me", headers=p.headers)).json()["invite_roles"] == roles


async def test_owners_name_members(client):
    r = await seed()
    owner = await person(r.tenant_id, "owner")
    member = await person(r.tenant_id, "approver", name="design.approver")
    url = f"/v1/members/{member.user_id}"
    resp = await client.patch(url, json={"name": "  Support lead "}, headers=owner.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Support lead"
    assert await _actions(r.tenant_id, "member.name") == [{"before": None, "after": "Support lead"}]
    people = (await client.get("/v1/people?q=support", headers=owner.headers)).json()
    assert [p["name"] for p in people] == ["Support lead"]

    assert (
        await client.patch(url, json={"name": "x" * 81}, headers=owner.headers)
    ).status_code == 422
    assert (
        await client.patch(url, json={"name": "a\x07b"}, headers=owner.headers)
    ).status_code == 422
    empty = await client.patch(url, json={}, headers=owner.headers)
    assert empty.status_code == 422 and empty.json()["detail"] == "Send role, name or both"
    cleared = await client.patch(url, json={"name": None}, headers=owner.headers)
    assert cleared.status_code == 200 and cleared.json()["name"] is None
    people = (await client.get(f"/v1/people?ids={member.user_id}", headers=owner.headers)).json()
    assert people[0]["name"].startswith("Design Approver")  # the email-derived name
    many = await client.get("/v1/people?limit=500", headers=owner.headers)
    assert many.status_code == 200


async def test_members_name_themselves_with_a_writable_credential(client):
    r = await seed()
    commenter = await person(r.tenant_id, "commenter")
    resp = await client.patch("/v1/me/account", json={"name": "Pat Doe"}, headers=commenter.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "Pat Doe"
    assert (await client.get("/v1/me", headers=commenter.headers)).json()["name"] == "Pat Doe"
    async with tenant_session(r.tenant_id) as s:
        token, raw = await create_api_token(s, "read only")
        row = await s.get(ApiToken, token.id)
        row.user_id, row.scope = commenter.user_id, "oracle:read"
        await s.commit()
    read_only = await client.patch(
        "/v1/me/account", json={"name": "Other"}, headers={"Authorization": f"Bearer {raw}"}
    )
    assert read_only.status_code == 403


async def test_the_invite_name_becomes_the_member_name(client, fetches):
    r = await seed()
    owner = await person(r.tenant_id, "owner")
    made = await client.post(
        "/v1/invites",
        json={"email": LEAD, "role": "viewer", "name": " Support lead "},
        headers=owner.headers,
    )
    assert made.json()["name"] == "Support lead"
    me = await client.get("/v1/me", headers={HEADER: assertion(LEAD)})
    assert me.status_code == 200 and me.json()["name"] == "Support lead"
    async with tenant_session(r.tenant_id) as s:
        user = await s.scalar(select(User).where(User.email == LEAD))
        assert user.name == "Support lead"


@pytest.mark.parametrize("action", ["access", "email"])
async def test_an_owner_demoted_while_waiting_cannot_retry_access_or_email(
    client, monkeypatch, action
):
    """protects=#519 item 6: Retry access (POST /v1/invites/{id}/access) and Resend email
    (POST /v1/invites/{id}/email) take the gate and re-read the owner under it, as
    _may_act_on does; fails_when=an owner demoted to approver while the request waits
    still re-grants IAP access or emails the invite (200); no_claim=the IAP call itself
    (tests.test_iap)."""
    from oracle.review import publish

    r = await seed()
    owner = await person(r.tenant_id, "owner")
    made = await client.post(
        "/v1/invites", json={"email": LEAD, "role": "viewer"}, headers=owner.headers
    )
    assert made.status_code == 201, made.text
    invite = made.json()
    async with tenant_session(r.tenant_id) as s:
        before = len(list(await s.scalars(select(AuditEvent))))
    real = publish.gate_lock
    fired: list[bool] = []

    async def spy(db, *, shared):
        if not fired:
            fired.append(True)
            async with tenant_session(r.tenant_id) as s:
                (await s.get(User, owner.user_id)).role = "approver"
                await s.commit()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    resp = await client.post(f"/v1/invites/{invite['id']}/{action}", headers=owner.headers)
    assert fired, f"{action} did not take the gate"
    assert resp.status_code == 403, resp.text
    async with tenant_session(r.tenant_id) as s:
        assert len(list(await s.scalars(select(AuditEvent)))) == before
