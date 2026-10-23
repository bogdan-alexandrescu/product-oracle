"""#242 (A5): an invite reaches the person. Creating an invite grants the invitee IAP
access on Oracle's backend services, and Oracle emails them the sign-in link in the
background; the invite records both outcomes (``access``, ``email_status``) for the
Members page. Revoking an invite, or removing a member, takes the access away unless
the person still needs it; restoring a member grants it again.

Against a fake IAP policy client and a fake mailer: no Google or mail calls.
"""

import asyncio
import base64
import copy
import email
import json
import uuid
from datetime import UTC, datetime, timedelta
from email import policy as email_policy

import httpx
import pytest
from sqlalchemy import select

from oracle.auth.models import User
from oracle.auth.service import hash_password
from oracle.config import get_settings
from oracle.mcp.oauth.service import oauth_settings
from oracle.members import delivery, iap_access, mailer
from oracle.members import service as members_service
from oracle.members.models import Invite, MemberFollowUp
from oracle.members.schemas import plain_address
from oracle.models import AuditEvent
from oracle.seed import seed
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import tenant_session

ROLE = "roles/iap.httpsResourceAccessor"
BACKENDS = ["oracle-api-be", "oracle-web-be"]
PUBLIC = "https://oracle.example.com"


class FakeIap:
    """IAP's getIamPolicy/setIamPolicy per backend service, with etags."""

    def __init__(self) -> None:
        self.policies: dict[str, dict] = {}
        self.fail: str | None = None
        self.conflicts = 0
        self.gets = 0
        self.sets: list[str] = []
        self._n = 0
        # A write that waits for ``hold``: ``holding`` is set once one is waiting.
        self.hold: asyncio.Event | None = None
        self.holding = asyncio.Event()

    def _policy(self, backend: str) -> dict:
        return self.policies.setdefault(backend, {"version": 1, "etag": "BwE0", "bindings": []})

    async def get_policy(self, http, backend: str) -> dict:
        self.gets += 1
        if self.fail:
            raise iap_access.IapError(self.fail)
        return copy.deepcopy(self._policy(backend))

    async def set_policy(self, http, backend: str, policy: dict) -> dict:
        if self.hold is not None and not self.hold.is_set():
            self.holding.set()
            await self.hold.wait()
        if self.fail:
            raise iap_access.IapError(self.fail)
        current = self._policy(backend)
        if self.conflicts:
            # Someone else wrote the policy between our read and our write.
            self.conflicts -= 1
            current["etag"] += "x"
            raise iap_access.EtagConflict("409: etag mismatch")
        if policy.get("etag") != current["etag"]:
            raise iap_access.EtagConflict("409: etag mismatch")
        self._n += 1
        new = copy.deepcopy(policy)
        new["etag"] = f"BwE{self._n}"
        self.policies[backend] = new
        self.sets.append(backend)
        return copy.deepcopy(new)

    def members(self, backend: str) -> list[str]:
        for b in self._policy(backend)["bindings"]:
            if b["role"] == ROLE:
                return list(b["members"])
        return []

    def bound(self, address: str) -> list[str]:
        """The backends where ``address`` holds the IAP accessor role."""
        return [b for b in BACKENDS if f"user:{address}" in self.members(b)]


class FakeMailer:
    def __init__(self) -> None:
        self.sent: list[mailer.InviteEmail] = []
        self.attempts = 0
        self.fail_times = 0
        self.gate: asyncio.Event | None = None

    async def send(self, http, message: mailer.InviteEmail) -> None:
        self.attempts += 1
        if self.gate is not None:
            await self.gate.wait()
        if self.fail_times:
            self.fail_times -= 1
            raise mailer.MailError("the Gmail API answered 503")
        self.sent.append(message)


@pytest.fixture
def iap(monkeypatch) -> FakeIap:
    fake = FakeIap()
    settings = get_settings()
    monkeypatch.setattr(settings, "iap_backends", list(BACKENDS))
    monkeypatch.setattr(settings, "gcp_project", "oracle-prod")
    monkeypatch.setattr(iap_access, "get_client", lambda: fake)
    return fake


@pytest.fixture
async def mail(monkeypatch):
    fake = FakeMailer()
    monkeypatch.setattr(mailer, "get_mailer", lambda: fake)
    monkeypatch.setattr(get_settings(), "mail_retry_seconds", 0)
    monkeypatch.setenv("ORACLE_PUBLIC_URL", PUBLIC)
    monkeypatch.setattr(get_settings(), "app_url", "")
    # Both read ORACLE_PUBLIC_URL once and cache it: clear them on the way in and out,
    # so no later test sees this URL (same_origin, the OAuth issuer).
    get_runtime_settings.cache_clear()
    oauth_settings.cache_clear()
    yield fake
    await delivery.drain()
    monkeypatch.delenv("ORACLE_PUBLIC_URL")
    get_runtime_settings.cache_clear()
    oauth_settings.cache_clear()


@pytest.fixture
async def owner(client):
    """The seeded admin's token (it acts as admin@example.com, an owner)."""
    r = await seed()
    return r.tenant_id, {"Authorization": f"Bearer {r.token}"}


async def _invite(client, headers, address="pat@example.com", role="approver"):
    resp = await client.post("/v1/invites", json={"email": address, "role": role}, headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _audit(tenant_id, action: str) -> list[dict]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.created_at)
        )
        return [e.data for e in rows]


async def _open_invites(client, headers) -> dict[str, dict]:
    return {i["email"]: i for i in (await client.get("/v1/invites", headers=headers)).json()}


# --- A. IAP access per invite --------------------------------------------------------------


async def test_creating_an_invite_grants_iap_access_on_each_backend(client, owner, iap, mail):
    tenant_id, headers = owner
    # Someone already bound stays bound; another role's binding is untouched.
    iap.policies["oracle-api-be"] = {
        "version": 1,
        "etag": "BwE0",
        "bindings": [
            {"role": ROLE, "members": ["user:admin@example.com"]},
            {"role": "roles/iap.admin", "members": ["serviceAccount:oracle@p.iam"]},
        ],
    }
    body = await _invite(client, headers)
    assert body["access"] == "granted"
    assert body["access_error"] is None
    assert body["access_at"] is not None
    assert iap.bound("pat@example.com") == BACKENDS
    assert "user:admin@example.com" in iap.members("oracle-api-be")
    other = iap.policies["oracle-api-be"]["bindings"][1]
    assert other == {"role": "roles/iap.admin", "members": ["serviceAccount:oracle@p.iam"]}
    [event] = await _audit(tenant_id, "invite_access.grant")
    assert event["outcome"] == "granted"
    assert event["email"] == "pat@example.com"
    assert event["backends"] == BACKENDS
    assert (await _open_invites(client, headers))["pat@example.com"]["access"] == "granted"


async def test_the_grant_is_idempotent(client, owner, iap, mail):
    _, headers = owner
    for b in BACKENDS:
        iap.policies[b] = {
            "version": 1,
            "etag": "BwE0",
            "bindings": [{"role": ROLE, "members": ["user:pat@example.com"]}],
        }
    body = await _invite(client, headers)
    assert body["access"] == "granted"
    # Already bound: nothing written, and no second copy of the member.
    assert iap.sets == []
    assert iap.members("oracle-api-be") == ["user:pat@example.com"]


async def test_no_backends_skips_the_grant_and_records_it(client, owner, iap, mail, monkeypatch):
    tenant_id, headers = owner
    monkeypatch.setattr(get_settings(), "iap_backends", [])
    body = await _invite(client, headers)
    assert body["access"] == "skipped"
    assert body["access_error"] is None
    assert iap.gets == 0
    [event] = await _audit(tenant_id, "invite_access.grant")
    assert event["outcome"] == "skipped"


async def test_a_grant_failure_keeps_the_invite_pending_and_retry_grants(client, owner, iap, mail):
    tenant_id, headers = owner
    iap.fail = "IAP answered 403: the caller does not have permission"
    body = await _invite(client, headers)
    assert body["status"] == "open"
    assert body["access"] == "pending"
    assert "403" in body["access_error"]
    listed = (await _open_invites(client, headers))["pat@example.com"]
    assert (listed["access"], listed["access_error"]) == ("pending", body["access_error"])

    # Still failing: still pending, and the attempt is audited.
    again = await client.post(f"/v1/invites/{body['id']}/access", headers=headers)
    assert again.status_code == 200, again.text
    assert again.json()["access"] == "pending"

    iap.fail = None
    retried = await client.post(f"/v1/invites/{body['id']}/access", headers=headers)
    assert retried.status_code == 200, retried.text
    assert (retried.json()["access"], retried.json()["access_error"]) == ("granted", None)
    assert iap.bound("pat@example.com") == BACKENDS
    outcomes = [e["outcome"] for e in await _audit(tenant_id, "invite_access.grant")]
    assert outcomes == ["failed", "failed", "granted"]


async def test_retry_access_refusals(client, owner, iap, mail):
    _, headers = owner
    body = await _invite(client, headers)
    missing = await client.post(f"/v1/invites/{uuid.uuid4()}/access", headers=headers)
    assert missing.status_code == 404
    assert (await client.delete(f"/v1/invites/{body['id']}", headers=headers)).status_code == 204
    revoked = await client.post(f"/v1/invites/{body['id']}/access", headers=headers)
    assert revoked.status_code == 409


async def test_an_etag_conflict_is_retried_once(client, owner, iap, mail):
    _, headers = owner
    iap.conflicts = 1
    assert (await _invite(client, headers))["access"] == "granted"
    assert iap.bound("pat@example.com") == BACKENDS

    # Two conflicts in a row on the same backend: not retried again, the invite waits.
    iap.conflicts = 2
    body = await _invite(client, headers, "sam@example.com")
    assert body["access"] == "pending"
    assert "etag" in body["access_error"]


async def test_revoking_an_invite_takes_the_access_away(client, owner, iap, mail):
    tenant_id, headers = owner
    body = await _invite(client, headers)
    assert iap.bound("pat@example.com") == BACKENDS
    assert (await client.delete(f"/v1/invites/{body['id']}", headers=headers)).status_code == 204
    assert iap.bound("pat@example.com") == []
    [event] = await _audit(tenant_id, "invite_access.remove")
    assert (event["email"], event["outcome"]) == ("pat@example.com", "removed")


async def test_revoking_keeps_the_access_of_an_active_member(client, owner, iap, mail):
    tenant_id, headers = owner
    body = await _invite(client, headers)
    # They became a member (a sign-in that raced the revoke) while the invite was open.
    async with tenant_session(tenant_id) as s:
        s.add(User(email="pat@example.com", password_hash=hash_password("x"), role="approver"))
        await s.commit()
    assert (await client.delete(f"/v1/invites/{body['id']}", headers=headers)).status_code == 204
    assert iap.bound("pat@example.com") == BACKENDS
    [event] = await _audit(tenant_id, "invite_access.remove")
    assert event["outcome"] == "kept"


async def test_removing_a_member_takes_the_access_away_and_restore_grants_it(
    client, owner, iap, mail
):
    tenant_id, headers = owner
    async with tenant_session(tenant_id) as s:
        user = User(email="lee@example.com", password_hash=hash_password("x"), role="commenter")
        s.add(user)
        await s.commit()
        user_id = user.id
    for b in BACKENDS:
        iap.policies[b] = {
            "version": 1,
            "etag": "BwE0",
            "bindings": [{"role": ROLE, "members": ["user:lee@example.com", "user:a@example.com"]}],
        }
    resp = await client.post(f"/v1/members/{user_id}/disable", headers=headers)
    assert resp.status_code == 200, resp.text
    assert iap.bound("lee@example.com") == []
    assert "user:a@example.com" in iap.members("oracle-web-be")

    resp = await client.post(f"/v1/members/{user_id}/restore", headers=headers)
    assert resp.status_code == 200, resp.text
    assert iap.bound("lee@example.com") == BACKENDS
    assert [e["outcome"] for e in await _audit(tenant_id, "member_access.grant")] == ["granted"]


async def test_the_domain_check_refuses_an_address_that_cannot_sign_in(
    client, owner, iap, mail, monkeypatch
):
    _, headers = owner
    monkeypatch.setattr(get_settings(), "iap_allowed_domains", ["example.com"])
    resp = await client.post(
        "/v1/invites", json={"email": "pat@example.org", "role": "viewer"}, headers=headers
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"] == "Only addresses at example.com can sign in to Oracle"
    assert iap.gets == 0 and mail.attempts == 0
    assert (await client.get("/v1/invites", headers=headers)).json() == []
    assert (await _invite(client, headers, "pat@Example.com"))["email"] == "pat@example.com"


# --- B. The invite email -------------------------------------------------------------------


async def test_the_mail_is_queued_not_sent_on_the_request(client, owner, iap, mail):
    _, headers = owner
    mail.gate = asyncio.Event()
    # A send held open never holds up the request.
    resp = await asyncio.wait_for(
        client.post(
            "/v1/invites", json={"email": "pat@example.com", "role": "viewer"}, headers=headers
        ),
        timeout=10,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["email_status"] == "queued"
    assert mail.sent == []
    mail.gate.set()
    await delivery.drain()
    invite = (await _open_invites(client, headers))["pat@example.com"]
    assert invite["email_status"] == "sent"
    assert invite["email_at"] is not None
    assert len(mail.sent) == 1


async def test_the_invite_email_says_who_what_and_where(client, owner, iap, mail):
    tenant_id, headers = owner
    body = await _invite(client, headers, "pat@example.com", "approver")
    await delivery.drain()
    [message] = mail.sent
    assert message.to == "pat@example.com"
    assert message.subject == "You're invited to Example Co Product Oracle as Approver"
    for part in (message.text, message.html):
        assert "admin@example.com" in part
        assert "Approver" in part
        assert f"{PUBLIC}/" in part
        assert "Sign in with Google using pat@example.com" in part
    assert body["sign_in_url"] == f"{PUBLIC}/"
    [event] = await _audit(tenant_id, "invite_email.send")
    assert (event["outcome"], event["attempt"]) == ("sent", 1)


async def test_a_failed_send_is_retried_once_then_recorded_failed(client, owner, iap, mail):
    tenant_id, headers = owner
    mail.fail_times = 1
    await _invite(client, headers)
    await delivery.drain()
    assert (await _open_invites(client, headers))["pat@example.com"]["email_status"] == "sent"
    assert mail.attempts == 2

    mail.fail_times = 2
    body = await _invite(client, headers, "sam@example.com")
    await delivery.drain()
    assert mail.attempts == 4
    invite = (await _open_invites(client, headers))["sam@example.com"]
    assert invite["email_status"] == "failed"
    assert "503" in invite["email_error"]
    assert invite["email_at"] is not None
    outcomes = [(e["email"], e["outcome"]) for e in await _audit(tenant_id, "invite_email.send")]
    assert outcomes == [
        ("pat@example.com", "failed"),
        ("pat@example.com", "sent"),
        ("sam@example.com", "failed"),
        ("sam@example.com", "failed"),
    ]

    # Resend (at once: nothing reached them): queued again, and this time it goes out.
    resent = await client.post(f"/v1/invites/{body['id']}/email", headers=headers)
    assert resent.status_code == 200, resent.text
    assert resent.json()["email_status"] == "queued"
    await delivery.drain()
    invite = (await _open_invites(client, headers))["sam@example.com"]
    assert (invite["email_status"], invite["email_error"]) == ("sent", None)


async def test_with_no_sender_nothing_is_sent(client, owner, iap, mail, monkeypatch):
    _, headers = owner
    monkeypatch.setattr(mailer, "get_mailer", lambda: None)
    body = await _invite(client, headers)
    assert body["email_status"] == "not_sent"
    assert body["email_at"] is not None
    assert body["sign_in_url"] == f"{PUBLIC}/"
    await delivery.drain()
    assert mail.attempts == 0
    resent = await client.post(f"/v1/invites/{body['id']}/email", headers=headers)
    assert resent.json()["email_status"] == "not_sent"


async def test_resend_refuses_a_closed_invite(client, owner, iap, mail):
    _, headers = owner
    body = await _invite(client, headers)
    await delivery.drain()
    assert (await client.delete(f"/v1/invites/{body['id']}", headers=headers)).status_code == 204
    resp = await client.post(f"/v1/invites/{body['id']}/email", headers=headers)
    assert resp.status_code == 409
    missing = await client.post(f"/v1/invites/{uuid.uuid4()}/email", headers=headers)
    assert missing.status_code == 404


async def test_the_tick_sends_a_queued_email_a_lost_process_left(client, owner, iap, mail):
    tenant_id, headers = owner
    body = await _invite(client, headers)
    await delivery.drain()
    mail.sent.clear()
    # The process died after queueing: still queued, a while ago.
    async with tenant_session(tenant_id) as s:
        invite = await s.get(Invite, uuid.UUID(body["id"]))
        invite.email_status = "queued"
        invite.email_at = datetime.now(UTC) - timedelta(minutes=10)
        await s.commit()
    async with tenant_session(tenant_id) as s:
        assert await delivery.send_queued(s, tenant_id) == 1
    assert len(mail.sent) == 1
    assert (await _open_invites(client, headers))["pat@example.com"]["email_status"] == "sent"
    # A fresh queued one is the request's own background send's.
    async with tenant_session(tenant_id) as s:
        invite = await s.get(Invite, uuid.UUID(body["id"]))
        invite.email_status = "queued"
        invite.email_at = datetime.now(UTC)
        await s.commit()
    async with tenant_session(tenant_id) as s:
        assert await delivery.send_queued(s, tenant_id) == 0


# --- The Google implementations, against fake transports -----------------------------------


def test_get_mailer_needs_the_provider_and_the_sender(monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, "mail_provider", "")
    monkeypatch.setattr(settings, "mail_sender", "oracle@example.com")
    assert mailer.get_mailer() is None
    monkeypatch.setattr(settings, "mail_provider", "gmail_api")
    monkeypatch.setattr(settings, "mail_sender", "")
    assert mailer.get_mailer() is None
    monkeypatch.setattr(settings, "mail_sender", "oracle@example.com")
    got = mailer.get_mailer()
    assert isinstance(got, mailer.GmailApiMailer)
    assert got.sender == "oracle@example.com"


def test_get_client_needs_the_project(monkeypatch):
    monkeypatch.setattr(get_settings(), "gcp_project", "")
    assert iap_access.get_client() is None
    monkeypatch.setattr(get_settings(), "gcp_project", "oracle-prod")
    assert isinstance(iap_access.get_client(), iap_access.GoogleIapClient)


class FakeMinter:
    def __init__(self) -> None:
        self.calls = 0

    async def token(self, http) -> str:
        self.calls += 1
        return "delegated-access-token"


async def test_the_gmail_mailer_posts_a_base64url_rfc822_message():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"id": "m1"})

    message = mailer.invite_email(
        to="pat@example.com",
        company="Example Co",
        role="approver",
        inviter="admin@example.com",
        link=f"{PUBLIC}/",
    )
    sender = mailer.GmailApiMailer("oracle@example.com", FakeMinter())
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        await sender.send(http, message)
    [req] = seen
    assert str(req.url) == "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    assert req.headers["Authorization"] == "Bearer delegated-access-token"
    raw = json.loads(req.content)["raw"]
    parsed = email.message_from_bytes(base64.urlsafe_b64decode(raw), policy=email_policy.default)
    assert parsed["To"] == "pat@example.com"
    assert parsed["From"] == "oracle@example.com"
    assert parsed["Subject"] == "You're invited to Example Co Product Oracle as Approver"
    assert parsed.get_content_type() == "multipart/alternative"
    kinds = [p.get_content_type() for p in parsed.iter_parts()]
    assert kinds == ["text/plain", "text/html"]
    assert f"{PUBLIC}/" in parsed.get_body(("plain",)).get_content()


async def test_the_gmail_mailer_raises_on_a_refusal():
    transport = httpx.MockTransport(lambda r: httpx.Response(403, json={"error": "no"}))
    sender = mailer.GmailApiMailer("oracle@example.com", FakeMinter())
    message = mailer.invite_email(
        to="pat@example.com", company="C", role="viewer", inviter="a@example.com", link="/"
    )
    async with httpx.AsyncClient(transport=transport) as http:
        with pytest.raises(mailer.MailError, match="403"):
            await sender.send(http, message)


class FakeAuth:
    """The service account's own access token (the metadata server's, in Cloud Run)."""

    email = "oracle-run@oracle-prod.iam.gserviceaccount.com"

    async def header(self, http) -> str:
        return "Bearer sa-token"

    async def identity(self, http) -> str | None:
        return self.email


async def test_the_delegated_token_is_signed_by_iam_and_cached():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.host == "iamcredentials.googleapis.com":
            assert request.headers["Authorization"] == "Bearer sa-token"
            claims = json.loads(json.loads(request.content)["payload"])
            assert claims["iss"] == FakeAuth.email
            assert claims["sub"] == "oracle@example.com"
            assert claims["scope"] == "https://www.googleapis.com/auth/gmail.send"
            assert claims["aud"] == "https://oauth2.googleapis.com/token"
            return httpx.Response(200, json={"keyId": "k", "signedJwt": "signed.jwt.value"})
        assert str(request.url) == "https://oauth2.googleapis.com/token"
        form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
        assert form["grant_type"] == "urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"
        assert form["assertion"] == "signed.jwt.value"
        return httpx.Response(
            200, json={"access_token": "delegated-access-token", "expires_in": 3600}
        )

    minter = mailer.DelegatedTokenMinter("oracle@example.com", FakeAuth())
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        assert await minter.token(http) == "delegated-access-token"
        assert await minter.token(http) == "delegated-access-token"
    path = f"/v1/projects/-/serviceAccounts/{FakeAuth.email}:signJwt"
    assert [r.url.path for r in seen] == [path, "/token"]


async def test_the_google_iap_client_reads_and_writes_the_policy():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith(":getIamPolicy"):
            return httpx.Response(200, json={"etag": "BwE0", "bindings": []})
        if json.loads(request.content)["policy"]["etag"] == "stale":
            return httpx.Response(409, json={"error": {"status": "ABORTED"}})
        return httpx.Response(200, json=json.loads(request.content)["policy"])

    client = iap_access.GoogleIapClient("oracle-prod", FakeAuth())
    base = (
        "https://iap.googleapis.com/v1/projects/oracle-prod/iap_web/compute/services/oracle-api-be"
    )
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        assert (await client.get_policy(http, "oracle-api-be"))["etag"] == "BwE0"
        await client.set_policy(http, "oracle-api-be", {"etag": "BwE0", "bindings": []})
        with pytest.raises(iap_access.EtagConflict):
            await client.set_policy(http, "oracle-api-be", {"etag": "stale", "bindings": []})
    assert [str(r.url) for r in seen[:2]] == [f"{base}:getIamPolicy", f"{base}:setIamPolicy"]
    assert all(r.headers["Authorization"] == "Bearer sa-token" for r in seen)


def test_the_jwt_claims_expire_within_an_hour():
    claims = mailer.delegation_claims("sa@p.iam", "oracle@example.com", now=1_000)
    assert claims["exp"] - claims["iat"] <= 3600
    assert claims["iat"] == 1_000


# --- Security review of #243 ----------------------------------------------------------------

CRAFTED = [
    "a@evil.com,b@corp.com",
    "a@evil.com;b@corp.com",
    "a@evil.com, b@corp.com",
    "Pat <b@corp.com>",
    "<b@corp.com>",
    '"a@evil.com"@corp.com',
    '"Pat" <b@corp.com>',
    "a@evil.com <b@corp.com>",
    "a(evil.com)@corp.com",
    "b@corp.com (a@evil.com)",
    "a:b@corp.com",
    "group: a@evil.com;@corp.com",
    "a@evil.com b@corp.com",
    "a@evil.com\tb@corp.com",
    "a@evil.com\r\nBcc: b@corp.com",
    "a@evil.com@corp.com",
]
MALFORMED = [
    "pat",
    "@corp.com",
    "pat@",
    "pat@corp",
    "pat@@corp.com",
    "pat@corp..com",
    "pat@.corp.com",
]
# RFC 2047 encoded-words and non-ASCII: the To header would decode each into another
# address (``a@evil.com``, or the list ``a@evil.com,x@corp.com``).
ENCODED = [
    "=?utf-8?q?a=40evil.com=3e?=x@corp.com",
    "=?utf-8?q?a=40evil.com=2c?=x@corp.com",
    "x@=?utf-8?q?corp.com?=",
    "x@=?utf-8?q?evil?=.corp.com",
    "p\u00e4t@corp.com",
    "pat@c\u00f6rp.com",
    "\u212aim@corp.com",
    ".pat@corp.com",
    "pat.@corp.com",
    "pa..t@corp.com",
    "pat@corp.com.",
    "pat@-corp.com",
    "pat@corp_x.com",
]


@pytest.mark.parametrize("address", CRAFTED + MALFORMED + ENCODED)
async def test_a_crafted_or_malformed_address_is_refused_and_nothing_happens(
    client, owner, iap, mail, monkeypatch, address
):
    tenant_id, headers = owner
    monkeypatch.setattr(get_settings(), "iap_allowed_domains", ["corp.com"])
    resp = await client.post(
        "/v1/invites", json={"email": address, "role": "viewer"}, headers=headers
    )
    assert resp.status_code == 422, resp.text
    await delivery.drain()
    async with tenant_session(tenant_id) as s:
        assert (await s.scalars(select(Invite))).all() == []
    assert iap.gets == 0 and iap.sets == []
    assert mail.attempts == 0
    assert await _audit(tenant_id, "invite.create") == []


async def test_one_plain_address_is_taken_lowercased(client, owner, iap, mail, monkeypatch):
    _, headers = owner
    monkeypatch.setattr(get_settings(), "iap_allowed_domains", ["corp.com"])
    body = await _invite(client, headers, "  Pat.Lee+oracle@Corp.COM ")
    assert body["email"] == "pat.lee+oracle@corp.com"
    await delivery.drain()
    assert iap.bound("pat.lee+oracle@corp.com") == BACKENDS
    assert [m.to for m in mail.sent] == ["pat.lee+oracle@corp.com"]


@pytest.mark.parametrize("address", CRAFTED + MALFORMED + ENCODED)
def test_a_crafted_malformed_or_encoded_address_is_not_a_plain_address(address):
    with pytest.raises(ValueError):
        plain_address(address)


@pytest.mark.parametrize("address", CRAFTED[:8] + ENCODED[:4])
def test_the_mailer_never_addresses_more_than_one_plain_address(address):
    sender = mailer.GmailApiMailer("oracle@corp.com", FakeMinter())
    message = mailer.invite_email(
        to=address, company="C", role="viewer", inviter="a@corp.com", link="/"
    )
    with pytest.raises(mailer.MailError):
        sender._raw(message)


@pytest.mark.parametrize(
    "address", ["pat@corp.com", "pat.lee+oracle@corp.com", "o'neil!#$%&*/?=^_`{|}~-@a-1.corp.com"]
)
def test_the_rendered_to_header_is_the_address_byte_for_byte(address):
    sender = mailer.GmailApiMailer("oracle@corp.com", FakeMinter())
    message = mailer.invite_email(
        to=address, company="C", role="viewer", inviter="a@corp.com", link="/"
    )
    raw = base64.urlsafe_b64decode(sender._raw(message))
    head = raw.split(b"\n\n", 1)[0].splitlines()
    assert [line for line in head if line.lower().startswith(b"to:")] == [
        b"To: " + address.encode()
    ]


def test_the_mailer_refuses_a_to_header_that_does_not_render_as_the_address(monkeypatch):
    # Defence in depth: past plain_address, the rendered To line is still checked.
    monkeypatch.setattr(mailer, "plain_address", lambda v: v)
    sender = mailer.GmailApiMailer("oracle@corp.com", FakeMinter())
    for address in ENCODED[:2]:
        message = mailer.invite_email(
            to=address, company="C", role="viewer", inviter="a@corp.com", link="/"
        )
        with pytest.raises(mailer.MailError):
            sender._raw(message)


@pytest.mark.parametrize("address", CRAFTED[:8] + ENCODED[:4])
async def test_the_iap_member_is_only_ever_one_plain_address(address):
    fake = FakeIap()
    with pytest.raises(iap_access.IapError):
        await iap_access.grant(fake, BACKENDS, address)
    assert fake.gets == 0 and fake.sets == []


async def _follow_ups(tenant_id, kind: str) -> list[MemberFollowUp]:
    async with tenant_session(tenant_id) as s:
        return list(
            await s.scalars(
                select(MemberFollowUp)
                .where(MemberFollowUp.kind == kind)
                .order_by(MemberFollowUp.created_at)
            )
        )


async def _tick(tenant_id) -> None:
    """The tick, with every follow-up due now."""
    async with tenant_session(tenant_id) as s:
        for row in await s.scalars(select(MemberFollowUp)):
            row.next_attempt_at = None
        await s.commit()
    async with tenant_session(tenant_id) as s, httpx.AsyncClient() as http:
        await members_service.run_follow_ups(s, None, http)


async def test_a_failed_revoke_is_queued_and_the_tick_removes_the_binding(client, owner, iap, mail):
    tenant_id, headers = owner
    body = await _invite(client, headers)
    assert iap.bound("pat@example.com") == BACKENDS
    iap.fail = "Google returned 503 (unavailable)"
    assert (await client.delete(f"/v1/invites/{body['id']}", headers=headers)).status_code == 204
    assert iap.bound("pat@example.com") == BACKENDS
    [event] = await _audit(tenant_id, "invite_access.remove")
    assert event["outcome"] == "failed"
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    assert (row.status, row.email) == ("pending", "pat@example.com")

    # Still failing at the next tick: still owed.
    await _tick(tenant_id)
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    assert row.status == "pending"
    assert iap.bound("pat@example.com") == BACKENDS

    iap.fail = None
    await _tick(tenant_id)
    assert iap.bound("pat@example.com") == []
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    assert (row.status, row.outcome) == ("done", "removed")
    outcomes = [e["outcome"] for e in await _audit(tenant_id, "invite_access.remove")]
    assert outcomes[-1] == "removed"


async def test_a_queued_revoke_keeps_the_binding_of_someone_invited_again(client, owner, iap, mail):
    tenant_id, headers = owner
    body = await _invite(client, headers)
    iap.fail = "Google returned 503 (unavailable)"
    assert (await client.delete(f"/v1/invites/{body['id']}", headers=headers)).status_code == 204
    iap.fail = None
    await _invite(client, headers)
    await _tick(tenant_id)
    assert iap.bound("pat@example.com") == BACKENDS
    [row] = await _follow_ups(tenant_id, "iap_revoke")
    assert (row.status, row.outcome) == ("done", "kept")


async def test_a_failed_revoke_on_removal_shows_on_the_member_and_the_tick_retries(
    client, owner, iap, mail
):
    tenant_id, headers = owner
    async with tenant_session(tenant_id) as s:
        user = User(email="lee@example.com", password_hash=hash_password("x"), role="commenter")
        s.add(user)
        await s.commit()
        user_id = user.id
    for b in BACKENDS:
        iap.policies[b] = {
            "version": 1,
            "etag": "BwE0",
            "bindings": [{"role": ROLE, "members": ["user:lee@example.com"]}],
        }
    iap.fail = "Google returned 500 (server error)"
    resp = await client.post(f"/v1/members/{user_id}/disable", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["access_pending"] == "revoke"
    members = {m["email"]: m for m in (await client.get("/v1/members", headers=headers)).json()}
    assert members["lee@example.com"]["access_pending"] == "revoke"
    assert members["admin@example.com"]["access_pending"] is None

    iap.fail = None
    await _tick(tenant_id)
    assert iap.bound("lee@example.com") == []
    members = {m["email"]: m for m in (await client.get("/v1/members", headers=headers)).json()}
    assert members["lee@example.com"]["access_pending"] is None


async def test_a_failed_grant_on_restore_is_queued_and_the_tick_grants(client, owner, iap, mail):
    tenant_id, headers = owner
    async with tenant_session(tenant_id) as s:
        user = User(
            email="lee@example.com",
            password_hash=hash_password("x"),
            role="commenter",
            disabled_at=datetime.now(UTC),
        )
        s.add(user)
        await s.commit()
        user_id = user.id
    iap.fail = "Google returned 503 (unavailable)"
    resp = await client.post(f"/v1/members/{user_id}/restore", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["access_pending"] == "grant"
    [row] = await _follow_ups(tenant_id, "iap_grant")
    assert (row.status, row.email) == ("pending", "lee@example.com")

    iap.fail = None
    await _tick(tenant_id)
    assert iap.bound("lee@example.com") == BACKENDS
    [row] = await _follow_ups(tenant_id, "iap_grant")
    assert (row.status, row.outcome) == ("done", "granted")
    assert [e["outcome"] for e in await _audit(tenant_id, "member_access.grant")] == [
        "failed",
        "granted",
    ]


async def _invite_id(tenant_id, address: str) -> str:
    async with tenant_session(tenant_id) as s:
        return str(await s.scalar(select(Invite.id).where(Invite.email == address)))


async def test_a_revoke_during_an_in_flight_grant_leaves_no_binding(client, owner, iap, mail):
    tenant_id, headers = owner
    iap.hold = asyncio.Event()
    creating = asyncio.create_task(
        client.post(
            "/v1/invites", json={"email": "pat@example.com", "role": "viewer"}, headers=headers
        )
    )
    await asyncio.wait_for(iap.holding.wait(), timeout=10)
    # The grant is under way at Google; the owner revokes the invite meanwhile.
    invite_id = await _invite_id(tenant_id, "pat@example.com")
    revoking = asyncio.create_task(client.delete(f"/v1/invites/{invite_id}", headers=headers))
    await asyncio.sleep(0.5)
    iap.hold.set()
    created, revoked = await asyncio.wait_for(asyncio.gather(creating, revoking), timeout=30)
    assert created.status_code == 201, created.text
    assert revoked.status_code == 204, revoked.text
    assert iap.bound("pat@example.com") == []
    removed = await _audit(tenant_id, "invite_access.remove")
    assert any(e["outcome"] == "removed" for e in removed), removed


async def test_a_revoke_racing_a_new_invite_keeps_the_new_invites_binding(client, owner, iap, mail):
    tenant_id, headers = owner
    first = await _invite(client, headers)
    assert iap.bound("pat@example.com") == BACKENDS
    iap.hold = asyncio.Event()
    revoking = asyncio.create_task(client.delete(f"/v1/invites/{first['id']}", headers=headers))
    await asyncio.wait_for(iap.holding.wait(), timeout=10)
    # The revoke is writing the policy without them; the owner invites them again.
    creating = asyncio.create_task(
        client.post(
            "/v1/invites", json={"email": "pat@example.com", "role": "viewer"}, headers=headers
        )
    )
    await asyncio.sleep(0.5)
    iap.hold.set()
    revoked, created = await asyncio.wait_for(asyncio.gather(revoking, creating), timeout=30)
    assert revoked.status_code == 204, revoked.text
    assert created.status_code == 201, created.text
    assert created.json()["access"] == "granted"
    assert iap.bound("pat@example.com") == BACKENDS


async def test_the_body_less_invite_posts_refuse_another_origin(client, iap, mail):
    from tests.test_oauth import PASSWORD

    await seed(password=PASSWORD)
    resp = await client.post(
        "/v1/auth/login", json={"email": "admin@example.com", "password": PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    body = await _invite(client, {"Origin": "http://localhost:3000"})
    await delivery.drain()
    gets, attempts = iap.gets, mail.attempts
    for path in (f"/v1/invites/{body['id']}/access", f"/v1/invites/{body['id']}/email"):
        for headers in (
            {"Origin": "https://evil.example.net"},
            {"Origin": "null"},
            {"Sec-Fetch-Site": "cross-site"},
        ):
            resp = await client.post(path, headers=headers)
            assert resp.status_code == 403, (path, headers, resp.text)
            assert "Cross-site" in resp.json()["detail"]
    await delivery.drain()
    assert (iap.gets, mail.attempts) == (gets, attempts)
    ok = await client.post(
        f"/v1/invites/{body['id']}/access", headers={"Origin": "http://localhost:3000"}
    )
    assert ok.status_code == 200, ok.text


async def test_run_and_read_only_tokens_cannot_retry_or_resend(client, iap, monkeypatch):
    from tests.test_account import _admin_id, _run_token
    from tests.test_read_only_credentials import _bearer

    read_only = await _bearer(client, "oracle:read")
    mail = FakeMailer()
    monkeypatch.setattr(mailer, "get_mailer", lambda: mail)
    r = await seed()
    owner_headers = {"Authorization": f"Bearer {r.token}"}
    body = await _invite(client, owner_headers)
    await delivery.drain()
    from oracle.auth.deps import RUN_HEADER, RUN_TOKEN_HEADER
    from oracle.auth.service import sign_run_binding

    admin_id = await _admin_id(r.tenant_id)
    run = await _run_token(r.tenant_id, admin_id, ["read:documents"])
    gets, attempts = iap.gets, mail.attempts
    for headers in (
        read_only,
        {**owner_headers, RUN_TOKEN_HEADER: run},
        {**owner_headers, RUN_HEADER: sign_run_binding(admin_id, uuid.uuid4())},
    ):
        for path in (f"/v1/invites/{body['id']}/access", f"/v1/invites/{body['id']}/email"):
            resp = await client.post(path, headers=headers)
            assert resp.status_code == 403, (path, resp.text)
    await delivery.drain()
    assert (iap.gets, mail.attempts) == (gets, attempts)


async def test_resend_waits_a_minute_after_the_last_send(client, owner, iap, mail):
    tenant_id, headers = owner
    body = await _invite(client, headers)
    await delivery.drain()
    soon = await client.post(f"/v1/invites/{body['id']}/email", headers=headers)
    assert soon.status_code == 429, soon.text
    left = int(soon.headers["Retry-After"])
    assert 0 < left <= 60
    assert f"{left} seconds" in soon.json()["detail"]
    await delivery.drain()
    assert len(mail.sent) == 1
    assert await _audit(tenant_id, "invite_email.resend") == []

    async with tenant_session(tenant_id) as s:
        invite = await s.get(Invite, uuid.UUID(body["id"]))
        invite.email_at = datetime.now(UTC) - timedelta(seconds=61)
        await s.commit()
    later = await client.post(f"/v1/invites/{body['id']}/email", headers=headers)
    assert later.status_code == 200, later.text
    await delivery.drain()
    assert len(mail.sent) == 2


GOOGLE_BODY = {"error": {"message": "Project 4815162342 policy for oracle-api-be is denied"}}
GOOGLE_400 = {"error": {"code": 400, "message": "User pat+tag@example.com does not exist."}}
# Made-up credentials a response could echo back: none of them is ever recorded.
LEAKED = ("eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl", "po_faketoken123")


async def test_the_iap_client_keeps_googles_own_message_with_the_status():
    client = iap_access.GoogleIapClient("oracle-prod", FakeAuth())
    transport = httpx.MockTransport(lambda r: httpx.Response(400, json=GOOGLE_400))
    async with httpx.AsyncClient(transport=transport) as http:
        with pytest.raises(iap_access.IapError) as raised:
            await client.set_policy(http, "oracle-api-be", {})
    assert str(raised.value) == (
        "Google returned 400 (bad request): User pat+tag@example.com does not exist."
    )
    for code, reason in ((403, "permission denied"), (503, "unavailable"), (500, "server error")):
        transport = httpx.MockTransport(lambda r, code=code: httpx.Response(code, json=GOOGLE_BODY))
        async with httpx.AsyncClient(transport=transport) as http:
            with pytest.raises(iap_access.IapError) as raised:
                await client.get_policy(http, "oracle-api-be")
        assert str(raised.value) == (
            f"Google returned {code} ({reason}): {GOOGLE_BODY['error']['message']}"
        )


def test_googles_message_is_capped_and_holds_no_tokens():
    leaky = {"error": {"message": f"Bearer {LEAKED[0]} and {LEAKED[1]} refused"}}
    said = iap_access.google_refusal(400, json.dumps(leaky))
    assert said.startswith("Google returned 400 (bad request): ")
    for token in LEAKED:
        assert token not in said
    assert "[token removed]" in said

    long = iap_access.google_refusal(400, json.dumps({"error": {"message": "denied " * 1000}}))
    assert len(long) <= len("Google returned 400 (bad request): ") + iap_access.MESSAGE_CAP
    assert long.endswith("…")
    # Not Google's JSON error (HTML, empty, or no message): the status alone.
    assert iap_access.google_refusal(502, "<html>Bad gateway</html>") == (
        "Google returned 502 (unavailable)"
    )
    assert iap_access.google_refusal(404, "") == "Google returned 404 (not found)"
    assert iap_access.google_refusal(400, json.dumps({"error": {"code": 400}})) == (
        "Google returned 400 (bad request)"
    )
    # OAuth's token endpoint says it its own way.
    oauth = {"error": "unauthorized_client", "error_description": "Client is unauthorized."}
    assert iap_access.google_refusal(401, json.dumps(oauth)) == (
        "Google returned 401 (not authenticated): Client is unauthorized."
    )


async def test_the_gmail_mailer_keeps_googles_own_message_with_the_status():
    transport = httpx.MockTransport(lambda r: httpx.Response(400, json=GOOGLE_400))
    sender = mailer.GmailApiMailer("oracle@example.com", FakeMinter())
    message = mailer.invite_email(
        to="pat@example.com", company="C", role="viewer", inviter="a@example.com", link="/"
    )
    said = "Google returned 400 (bad request): User pat+tag@example.com does not exist."
    async with httpx.AsyncClient(transport=transport) as http:
        with pytest.raises(mailer.MailError) as raised:
            await sender.send(http, message)
    assert str(raised.value) == said

    minter = mailer.DelegatedTokenMinter("oracle@example.com", FakeAuth())
    async with httpx.AsyncClient(transport=transport) as http:
        with pytest.raises(mailer.MailError) as raised:
            await minter.token(http)
    assert str(raised.value) == said


async def test_the_invite_records_googles_message_never_an_exceptions_text(
    client, owner, iap, mail, monkeypatch
):
    _, headers = owner
    real = iap_access.GoogleIapClient("oracle-prod", FakeAuth())
    transport = httpx.MockTransport(lambda r: httpx.Response(400, json=GOOGLE_400))
    monkeypatch.setattr(iap_access, "get_client", lambda: real)
    opened = httpx.AsyncClient  # every client Oracle opens meanwhile answers 403
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: opened(transport=transport))

    class Leaky:
        async def send(self, http, message) -> None:
            raise RuntimeError(json.dumps(GOOGLE_BODY))

    monkeypatch.setattr(mailer, "get_mailer", lambda: Leaky())
    body = await _invite(client, headers)
    await delivery.drain()
    invite = (await _open_invites(client, headers))["pat@example.com"]
    assert invite["access"] == "pending"
    assert invite["access_error"] == (
        "oracle-api-be: Google returned 400 (bad request): User pat+tag@example.com does not exist."
    )
    assert invite["access_at"] is not None
    assert invite["email_status"] == "failed"
    assert "4815162342" not in invite["email_error"]
    assert body["id"] == invite["id"]
