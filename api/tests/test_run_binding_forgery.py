"""Security review of PR 101: a bare ``x-oracle-run-id`` header must not make a person a
run. Only a server-signed run binding (or a run token) does (S6: only runs read the text
a finding released "shared in full"; people see title, link and the 400-char excerpt).

A header that is present but does not verify is refused with 400 (fail closed): ignoring
it would let a regression in signing turn a run into its creator.

Synthetic placeholders only.
"""

import uuid

from itsdangerous import TimestampSigner, URLSafeTimedSerializer

from oracle.auth import service
from oracle.auth.service import create_api_token, sign_run_binding
from oracle.config import get_settings
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.test_intake_sharing import EXCERPT_A, share_all
from tests.test_intake_sharing_round5 import fake, world  # noqa: F401
from tests.test_oauth import full_flow

FORGED = "x-oracle-run-id"


def forged(ctx, who: str) -> dict[str, str]:
    return {**ctx.as_(who), FORGED: str(uuid.uuid4())}


async def assert_refused(client, intake_id, items, headers, label) -> None:
    """Every read that would show run-only text is a 400, and shows nothing."""
    reads = [
        (f"/v1/source-items/{items['a']}", None),
        ("/v1/search", {"q": "buyers", "limit": 100}),
        (f"/v1/intakes/{intake_id}/evidence", {"q": "buyers", "limit": 50}),
    ]
    for url, params in reads:
        resp = await client.get(url, params=params, headers=headers)
        assert resp.status_code == 400, (label, url, resp.status_code, resp.text)
        assert EXCERPT_A not in resp.text and str(items["a"]) not in resp.text, (label, url)


async def test_a_bare_run_header_on_a_person_credential_is_refused(client, fake):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    for who in ("approver", "viewer", "token"):
        await assert_refused(client, intake_id, items, forged(ctx, who), who)


async def test_a_header_that_does_not_verify_is_refused(client, fake, monkeypatch):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    author, approver = ctx.users["author"], ctx.users["approver"]
    other_salt = URLSafeTimedSerializer(get_settings().secret_key, salt="oracle-session")
    cases = {
        "garbage": "not-a-signed-value",
        "wrong user": sign_run_binding(author.id, uuid.uuid4()),
        "wrong salt": other_salt.dumps({"u": str(approver.id), "r": str(uuid.uuid4())}),
        "non-string run": service._run_serializer().dumps({"u": str(approver.id), "r": 123}),
    }
    for label, value in cases.items():
        headers = {**ctx.as_("approver"), FORGED: value}
        await assert_refused(client, intake_id, items, headers, label)
    # Expired: a binding older than the (short) max-age.
    good = sign_run_binding(approver.id, uuid.uuid4())
    monkeypatch.setattr(get_settings(), "run_binding_max_age_seconds", -1)
    headers = {**ctx.as_("approver"), FORGED: good}
    await assert_refused(client, intake_id, items, headers, "expired")


async def test_a_binding_for_one_user_on_another_users_credential_is_refused(client, fake):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    binding = sign_run_binding(ctx.users["author"].id, uuid.uuid4())
    for who in ("approver", "viewer"):
        headers = {**ctx.as_(who), FORGED: binding}
        await assert_refused(client, intake_id, items, headers, who)


async def test_a_user_bound_po_token_with_a_bare_header_is_refused(client, fake):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    async with tenant_session(ctx.tenant_id) as s:
        _, raw = await create_api_token(s, "user-bound", user_id=ctx.users["approver"].id)
        await s.commit()
    assert raw.startswith("po_")
    headers = {"Authorization": f"Bearer {raw}", FORGED: str(uuid.uuid4())}
    await assert_refused(client, intake_id, items, headers, "po_")
    # Without the header the same token is an ordinary person.
    resp = await client.get("/v1/me", headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 200, resp.text


async def test_a_poa_token_with_a_bare_header_is_refused(client):
    _, tok = await full_flow(client)
    bearer = {"Authorization": f"Bearer {tok['access_token']}"}
    assert tok["access_token"].startswith("poa_")
    resp = await client.get("/v1/me", headers={**bearer, FORGED: str(uuid.uuid4())})
    assert resp.status_code == 400, resp.text
    resp = await client.get("/v1/me", headers=bearer)
    assert resp.status_code == 200, resp.text


def test_a_binding_whose_run_is_not_a_string_is_none_not_an_error():
    user = uuid.uuid4()
    for bad in (123, None, ["x"]):
        value = service._run_serializer().dumps({"u": str(user), "r": bad})
        assert service.read_run_binding(value, user) is None


def test_a_valid_binding_round_trips_for_its_user_only():
    user, run = uuid.uuid4(), uuid.uuid4()
    value = sign_run_binding(user, run)
    assert service.read_run_binding(value, user) == run
    assert service.read_run_binding(value, uuid.uuid4()) is None
    assert service.read_run_binding(value, None) is None


def _signed_at(monkeypatch, when: int) -> None:
    monkeypatch.setattr(TimestampSigner, "get_timestamp", lambda self: when)


def test_a_binding_exactly_at_its_max_age_is_read_and_one_second_later_is_not(monkeypatch):
    user, run = uuid.uuid4(), uuid.uuid4()
    max_age = get_settings().run_binding_max_age_seconds
    assert max_age == 300
    _signed_at(monkeypatch, 1_800_000_000)
    value = sign_run_binding(user, run)
    _signed_at(monkeypatch, 1_800_000_000 + max_age)
    assert service.read_run_binding(value, user) == run
    _signed_at(monkeypatch, 1_800_000_000 + max_age + 1)
    assert service.read_run_binding(value, user) is None


async def test_a_company_token_carrying_a_valid_binding_is_refused(client, fake):  # noqa: F811
    """A company API token (kind='token') has no user: no binding is issued for it, so
    even one validly signed for the run's creator is refused, never read as the run."""
    ctx, intake_id, items = await world(client, fake, hidden=False)
    await share_all(client, ctx, intake_id, "full")
    author = ctx.users["author"]
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(flow="baseline_to_prd", status="running", created_by=author.id)
        s.add(run)
        await s.commit()
        run_id = run.id
    binding = sign_run_binding(author.id, run_id)
    assert service.read_run_binding(binding, author.id) == run_id
    headers = {**ctx.as_("token"), FORGED: binding}
    await assert_refused(client, intake_id, items, headers, "company token")


def _malformed(serializer: URLSafeTimedSerializer) -> str:
    """Correctly signed, but its payload does not decode (itsdangerous BadPayload, a
    BadData that is not a BadSignature)."""
    return serializer.make_signer(serializer.salt).sign(b"!!not-base64!!").decode()


def test_a_signed_but_malformed_binding_or_cookie_is_none_not_an_error():
    user = uuid.uuid4()
    assert service.read_run_binding(_malformed(service._run_serializer()), user) is None
    assert service.read_session_cookie(_malformed(service._serializer())) is None


async def test_a_signed_but_malformed_binding_or_cookie_fails_closed(client, fake):  # noqa: F811
    ctx, intake_id, items = await world(client, fake, hidden=False)
    headers = {**ctx.as_("approver"), FORGED: _malformed(service._run_serializer())}
    await assert_refused(client, intake_id, items, headers, "malformed binding")
    cookie = f"{get_settings().session_cookie_name}={_malformed(service._serializer())}"
    resp = await client.get("/v1/me", headers={"Cookie": cookie})
    assert resp.status_code == 401, resp.text
