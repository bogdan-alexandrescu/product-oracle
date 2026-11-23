"""simple-speed: what a request signed in by Google IAP reads before its handler runs
(oracle.auth.iap.sign_in). Against Postgres; a test key stands in for Google's
(tests/test_iap.py).

Test cards (protects / fails_when / no_claim):

- test_a_members_request_signs_in_with_one_read: protects=a member whose sign-in was
  recorded in the last ten minutes is found with one statement on one connection (before:
  the company in one session, the member in another), with no fetch of Google's keys;
  fails_when=the company and the member are read apart again; no_claim=a first visit, an
  invite or an access request (the full path, tests/test_iap.py).
- test_a_sign_in_is_still_recorded: protects=a member's first request records the sign-in
  (last_sign_in_at) and the next one, within ten minutes, writes nothing;
  fails_when=the one read skips the record, or writes on every request; no_claim=the
  ten-minute resolution itself.
- test_a_disabled_member_is_still_refused: protects=a disabled member's request is a 401
  through the one read, and a member of a second company is not the first company's;
  fails_when=the one read signs in whoever holds the email; no_claim=sessions and tokens
  (tests/test_auth.py).
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import event, select

from oracle.auth import iap
from oracle.auth.models import User
from oracle.db import get_engine
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.test_iap import HEADER, assertion, fetches  # noqa: F401


class Reads:
    def __init__(self) -> None:
        self.statements: list[str] = []
        self.checkouts = 0

    def statement(self, conn, cursor, statement, *args) -> None:
        if "SAVEPOINT" not in statement:
            self.statements.append(statement)

    def checkout(self, *args) -> None:
        self.checkouts += 1

    def __enter__(self) -> "Reads":
        engine = get_engine().sync_engine
        event.listen(engine, "before_cursor_execute", self.statement)
        event.listen(engine.pool, "checkout", self.checkout)
        return self

    def __exit__(self, *exc) -> None:
        engine = get_engine().sync_engine
        event.remove(engine, "before_cursor_execute", self.statement)
        event.remove(engine.pool, "checkout", self.checkout)


async def _member(tenant_id, email: str, **kw) -> User:
    async with tenant_session(tenant_id) as s:
        user = User(email=email, password_hash="x", role="approver", **kw)
        s.add(user)
        await s.commit()
        return user


async def test_a_members_request_signs_in_with_one_read(fetches):  # noqa: F811
    """A member's request is signed in with one statement on one connection."""
    r = await seed()
    member = await _member(
        r.tenant_id, "dana@example.com", last_sign_in_at=datetime.now(UTC) - timedelta(minutes=1)
    )
    claims = await iap.verify_assertion(assertion("Dana@Example.com"), fetches_audience())
    with Reads() as reads:
        user = await iap.user_for_claims(claims)
    assert user is not None and user.id == member.id and user.tenant_id == r.tenant_id
    assert user.role == "approver" and user.email == "dana@example.com"
    assert len(reads.statements) == 1, reads.statements
    assert reads.checkouts == 1
    assert len(fetches) == 1


def fetches_audience() -> list[str]:
    from oracle.config import get_settings

    return get_settings().iap_audiences


async def test_a_sign_in_is_still_recorded(client, fetches):  # noqa: F811
    """The first request records the sign-in; the next one writes nothing."""
    r = await seed()
    member = await _member(r.tenant_id, "dana@example.com")
    headers = {HEADER: assertion("dana@example.com")}
    assert (await client.get("/v1/me", headers=headers)).status_code == 200
    async with tenant_session(r.tenant_id) as s:
        first = (await s.get(User, member.id)).last_sign_in_at
    assert first is not None
    with Reads() as reads:
        assert (await client.get("/v1/me", headers=headers)).status_code == 200
    assert not [q for q in reads.statements if q.startswith("UPDATE")], reads.statements
    async with tenant_session(r.tenant_id) as s:
        assert (await s.get(User, member.id)).last_sign_in_at == first


async def test_a_disabled_member_is_still_refused(client, fetches):  # noqa: F811
    """A disabled member is refused, and another company's member is not this one's."""
    r = await seed()
    recent = datetime.now(UTC) - timedelta(minutes=1)
    await _member(
        r.tenant_id, "gone@example.com", last_sign_in_at=recent, disabled_at=datetime.now(UTC)
    )
    resp = await client.get("/v1/me", headers={HEADER: assertion("gone@example.com")})
    assert resp.status_code == 401
    # The same email in a newer company is not the default company's member.
    other = await make_tenant("Example Other Co")
    await _member(other, "elsewhere@example.com", last_sign_in_at=recent)
    claims = await iap.verify_assertion(assertion("elsewhere@example.com"), fetches_audience())
    async with tenant_session(r.tenant_id) as s:
        assert await s.scalar(select(User).where(User.email == "elsewhere@example.com")) is None
    result = await iap.sign_in(claims)
    assert not isinstance(result, User) or result.tenant_id == r.tenant_id
