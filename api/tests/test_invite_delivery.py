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
from oracle.members import delivery, iap_access, mailer
from oracle.members.models import Invite
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

    def _policy(self, backend: str) -> dict:
        return self.policies.setdefault(backend, {"version": 1, "etag": "BwE0", "bindings": []})

    async def get_policy(self, http, backend: str) -> dict:
        self.gets += 1
        if self.fail:
            raise iap_access.IapError(self.fail)
        return copy.deepcopy(self._policy(backend))

    async def set_policy(self, http, backend: str, policy: dict) -> dict:
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
    get_runtime_settings.cache_clear()
    yield fake
    await delivery.drain()
    get_runtime_settings.cache_clear()


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

    # Resend: queued again, and this time it goes out.
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
