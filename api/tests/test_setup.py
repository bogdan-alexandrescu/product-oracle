"""A1 First-run path: GET /v1/setup, the Set up checklist on Home.

Every test reads the step state from real tables (connections, sources, users, invites,
tenant_settings, user_preferences); nothing here proves the web draws it (web/e2e/setup.spec.ts).
"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, event

from oracle import setup
from oracle.auth.deps import RUN_TOKEN_HEADER, Principal
from oracle.auth.models import User
from oracle.auth.service import create_api_token
from oracle.config import get_settings
from oracle.db import get_engine
from oracle.members.models import Invite
from oracle.runs.models import Run
from oracle.runtokens import SCOPES, mint_run_token
from oracle.sources.models import Source
from oracle.tenancy import tenant_session
from tests.connection_helpers import add_connection, make_person

OWNER_KEYS = ["connect", "sources", "invite", "domains", "horizons"]
DEFAULT_HORIZONS = {
    "short_quarters": 1,
    "medium_quarters": 2,
    "long_from_months": 12,
    "long_to_months": 24,
}


@pytest.fixture(autouse=True)
def _no_domains(monkeypatch):
    # No company domain unless a test sets one: the env var is cleared, nothing inferred.
    monkeypatch.delenv("ORACLE_IAP_ALLOWED_DOMAINS", raising=False)
    monkeypatch.delenv("ORACLE_INFER_COMPANY_DOMAINS", raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
async def owner(tenant_id):
    return await make_person(tenant_id, "owner@example.com", "owner")


async def _setup(client, person) -> dict:
    resp = await client.get("/v1/setup", headers=person.headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _step(body: dict, key: str) -> dict:
    return next(s for s in body["steps"] if s["key"] == key)


async def test_a_new_companys_owner_has_every_step_open(client, owner):
    # protects=the owner's checklist for a new company; fails_when=a step reads done
    # without its rows, or the order differs; no_claim=the web draws it (A3's eng_lead
    # is not merged, so five owner steps).
    body = await _setup(client, owner)
    assert [s["key"] for s in body["steps"]] == OWNER_KEYS
    assert [s["done"] for s in body["steps"]] == [False] * 5
    assert body["done"] == 0 and body["total"] == 5 and body["hidden"] is False
    assert _step(body, "connect")["count"] == 0
    assert _step(body, "sources")["count"] == 0
    assert _step(body, "invite")["count"] == 1
    assert _step(body, "domains") == {"key": "domains", "done": False, "count": 0, "detail": None}
    assert _step(body, "horizons") == {
        "key": "horizons",
        "done": False,
        "count": None,
        "detail": None,
    }


async def test_connect_counts_only_the_callers_active_connections(client, tenant_id, owner):
    # protects=Connect tools reads the person's own active connections; fails_when=an
    # errored connection or someone else's counts; no_claim=the provider accepted the token.
    await add_connection(tenant_id, owner.id, "github", account_id="1")
    body = await _setup(client, owner)
    assert _step(body, "connect") == {"key": "connect", "done": True, "count": 1, "detail": None}
    assert body["done"] == 1

    await add_connection(tenant_id, owner.id, "slack", account_id="2", status="error")
    other = await make_person(tenant_id, "approver@example.com", "approver")
    await add_connection(tenant_id, other.id, "notion", account_id="3")
    assert _step(await _setup(client, owner), "connect")["count"] == 1


async def test_sources_counts_the_callers_own_sources(client, tenant_id, owner):
    # protects=Pick sources reads sources the person owns; fails_when=another member's
    # source makes it done; no_claim=the sources ever synced.
    other = await make_person(tenant_id, "commenter@example.com", "commenter")
    async with tenant_session(tenant_id) as s:
        s.add(Source(owner_user_id=other.id, kind="upload", name="Theirs"))
        await s.commit()
    assert _step(await _setup(client, owner), "sources")["done"] is False
    async with tenant_session(tenant_id) as s:
        s.add(Source(owner_user_id=owner.id, kind="upload", name="Notes"))
        s.add(Source(owner_user_id=owner.id, kind="github", name="Repo"))
        await s.commit()
    assert _step(await _setup(client, owner), "sources") == {
        "key": "sources",
        "done": True,
        "count": 2,
        "detail": None,
    }


async def test_commenters_get_their_own_steps_and_viewers_none(client, tenant_id, owner):
    # protects=which steps each role sees; fails_when=a commenter sees owner steps or a
    # viewer sees any; no_claim=approvers (same rule as commenters, not exercised here).
    commenter = await make_person(tenant_id, "commenter@example.com", "commenter")
    viewer = await make_person(tenant_id, "viewer@example.com", "viewer")
    body = await _setup(client, commenter)
    assert [s["key"] for s in body["steps"]] == ["connect", "sources"]
    assert body["total"] == 2 and body["done"] == 0
    body = await _setup(client, viewer)
    assert body == {"steps": [], "done": 0, "total": 0, "hidden": False}


async def test_only_a_signed_in_person_may_ask(client, tenant_id, owner):
    # protects=setup is a person's; fails_when=a run token or an API token for no member
    # gets steps; no_claim=MCP OAuth clients (they act as a person and pass).
    async with tenant_session(tenant_id) as s:
        _, raw = await create_api_token(s, "agent")
        run = Run(flow="baseline_to_prd", created_by=owner.id)
        s.add(run)
        await s.flush()
        run_token = await mint_run_token(s, run.id, SCOPES, ttl_seconds=600)
        await s.commit()
    resp = await client.get("/v1/setup", headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Setup is for people signed in"
    resp = await client.get("/v1/setup", headers={**owner.headers, RUN_TOKEN_HEADER: run_token})
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Setup is for people signed in"
    assert (await client.get("/v1/setup")).status_code == 401


async def test_domains_from_the_environment(client, owner, monkeypatch):
    # protects=Company domains reads company_domains() (env or setting); fails_when=the
    # env var is ignored or the single domain is not named; no_claim=narrowing behaviour.
    monkeypatch.setenv("ORACLE_IAP_ALLOWED_DOMAINS", '["example.com"]')
    get_settings.cache_clear()
    step = _step(await _setup(client, owner), "domains")
    assert step == {"key": "domains", "done": True, "count": 1, "detail": "example.com"}

    put = await client.put(
        "/v1/settings/company_email_domains",
        json={"value": ["example.org"]},
        headers=owner.headers,
    )
    assert put.status_code == 200, put.text
    step = _step(await _setup(client, owner), "domains")
    assert step == {"key": "domains", "done": True, "count": 2, "detail": None}


async def test_invite_is_done_with_two_members_or_an_open_invite(client, tenant_id, owner):
    # protects=Invite team's rule; fails_when=a revoked invite or a disabled member counts;
    # no_claim=the invite email was sent.
    async with tenant_session(tenant_id) as s:
        s.add(Invite(email="gone@example.com", role="viewer", revoked_at=datetime.now(UTC)))
        s.add(Invite(email="joined@example.com", role="viewer", accepted_at=datetime.now(UTC)))
        await s.commit()
    assert _step(await _setup(client, owner), "invite") == {
        "key": "invite",
        "done": False,
        "count": 1,
        "detail": None,
    }
    async with tenant_session(tenant_id) as s:
        s.add(Invite(email="next@example.com", role="commenter"))
        await s.commit()
    assert _step(await _setup(client, owner), "invite")["done"] is True

    async with tenant_session(tenant_id) as s:
        await s.execute(delete(Invite))
        await s.commit()
    disabled = await make_person(tenant_id, "left@example.com", "viewer")
    async with tenant_session(tenant_id) as s:
        user = await s.get(User, disabled.id)
        user.disabled_at = datetime.now(UTC)
        await s.commit()
    assert _step(await _setup(client, owner), "invite")["done"] is False
    await make_person(tenant_id, "second@example.com", "commenter")
    assert _step(await _setup(client, owner), "invite") == {
        "key": "invite",
        "done": True,
        "count": 2,
        "detail": None,
    }


async def test_horizons_done_while_a_row_is_stored(client, owner):
    # protects=Horizons is done once an owner confirmed (stored) them; fails_when=the
    # defaults read as done, or a reset leaves it done; no_claim=the Company page.
    put = await client.put(
        "/v1/settings/planning_horizons", json={"value": DEFAULT_HORIZONS}, headers=owner.headers
    )
    assert put.status_code == 200, put.text
    assert put.json()["is_default"] is False
    body = await _setup(client, owner)
    assert _step(body, "horizons")["done"] is True and body["done"] == 1
    reset = await client.put(
        "/v1/settings/planning_horizons", json={"value": None}, headers=owner.headers
    )
    assert reset.status_code == 200 and reset.json()["is_default"] is True
    assert _step(await _setup(client, owner), "horizons")["done"] is False


async def test_hidden_is_each_persons_own(client, tenant_id, owner):
    # protects=Hide is a per-person preference any role may set; fails_when=a viewer is
    # refused or one person's choice hides another's panel; no_claim=the header chip.
    viewer = await make_person(tenant_id, "viewer@example.com", "viewer")
    resp = await client.patch(
        "/v1/me/preferences", json={"setup_hidden": True}, headers=viewer.headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["setup_hidden"] is True
    assert (await _setup(client, viewer))["hidden"] is True
    assert (await _setup(client, owner))["hidden"] is False
    resp = await client.patch(
        "/v1/me/preferences", json={"setup_hidden": False}, headers=viewer.headers
    )
    assert resp.json()["setup_hidden"] is False
    assert (await _setup(client, viewer))["hidden"] is False


@pytest.mark.parametrize("members", [2, 50])
async def test_the_cost_is_fixed_whatever_the_size(tenant_id, owner, members):
    # protects=a fixed number of statements per call; fails_when=a query runs per member,
    # connection or source; no_claim=the statements' speed.
    async with tenant_session(tenant_id) as s:
        for i in range(members - 1):
            s.add(User(email=f"m{i}@example.com", password_hash="x", role="commenter"))
            s.add(Invite(email=f"i{i}@example.com", role="viewer"))
        await s.commit()
    for i in range(3):
        await add_connection(tenant_id, owner.id, "github", account_id=str(i))
    principal = Principal(tenant_id=tenant_id, kind="user", role="owner", user_id=owner.id)
    statements: list[str] = []

    def count(conn, cursor, statement, *args):
        statements.append(statement)

    engine = get_engine().sync_engine
    async with tenant_session(tenant_id) as s:
        await s.connection()  # the session's own setup is not the service's cost
        event.listen(engine, "before_cursor_execute", count)
        try:
            out = await setup.compute(s, principal)
        finally:
            event.remove(engine, "before_cursor_execute", count)
    assert [st.key for st in out.steps] == OWNER_KEYS
    assert out.steps[2].count == members
    assert len(statements) <= 8, statements


def test_step_keys_are_checked_against_the_registry():
    # protects=SetupKey is open to later picks but closed to typos; fails_when=an unknown
    # key validates; no_claim=later picks' steps.
    assert [s.key for s in setup.STEPS] == OWNER_KEYS
    assert setup.SetupStep(key="connect", done=False).key == "connect"
    with pytest.raises(ValueError):
        setup.SetupStep(key="nope", done=False)
