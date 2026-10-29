"""A1 First-run path: GET /v1/setup, the Set up checklist on Home.

Every test reads the step state from real tables (connections, sources, users, invites,
tenant_settings, user_preferences); nothing here proves the web draws it (web/e2e/setup.spec.ts).
"""

import re
from datetime import UTC, datetime, timedelta

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
from tests.conftest import make_tenant
from tests.connection_helpers import add_connection, make_person

OWNER_KEYS = [
    "connect", "sources", "invite", "domains", "eng_lead", "horizons", "timezone",
    "build_baseline",
]  # fmt: skip
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
    # without its rows, or the order differs; no_claim=the web draws it (eight owner
    # steps, A3's eng_lead, H2's timezone and B1's build_baseline among them).
    body = await _setup(client, owner)
    assert [s["key"] for s in body["steps"]] == OWNER_KEYS
    assert [s["done"] for s in body["steps"]] == [False] * 8
    assert body["done"] == 0 and body["total"] == 8 and body["hidden"] is False
    assert _step(body, "connect")["count"] == 0
    assert _step(body, "sources")["count"] == 0
    assert _step(body, "invite")["count"] == 1
    assert _step(body, "domains") == {
        "key": "domains",
        "done": False,
        "count": 0,
        "detail": None,
        "invited": None,
        "run_id": None,
    }
    assert _step(body, "horizons") == {
        "key": "horizons",
        "done": False,
        "count": None,
        "detail": None,
        "invited": None,
        "run_id": None,
    }


async def test_connect_counts_only_the_callers_active_connections(client, tenant_id, owner):
    # protects=Connect tools reads the person's own active connections; fails_when=an
    # errored connection or someone else's counts; no_claim=the provider accepted the token.
    await add_connection(tenant_id, owner.id, "github", account_id="1")
    body = await _setup(client, owner)
    assert _step(body, "connect") == {
        "key": "connect",
        "done": True,
        "count": 1,
        "detail": None,
        "invited": None,
        "run_id": None,
    }
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
        "invited": None,
        "run_id": None,
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
    assert body == {"steps": [], "done": 0, "total": 0, "hidden": False, "welcome": False}


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
    assert resp.json()["detail"] == "A run token acts only through Oracle's MCP server"
    assert (await client.get("/v1/setup")).status_code == 401


async def test_domains_from_the_environment(client, owner, monkeypatch):
    # protects=Company domains reads company_domains() (env or setting); fails_when=the
    # env var is ignored or the single domain is not named; no_claim=narrowing behaviour.
    monkeypatch.setenv("ORACLE_IAP_ALLOWED_DOMAINS", '["example.com"]')
    get_settings.cache_clear()
    step = _step(await _setup(client, owner), "domains")
    assert step == {
        "key": "domains",
        "done": True,
        "count": 1,
        "detail": "example.com",
        "invited": None,
        "run_id": None,
    }

    put = await client.put(
        "/v1/settings/company_email_domains",
        json={"value": ["example.org"]},
        headers=owner.headers,
    )
    assert put.status_code == 200, put.text
    step = _step(await _setup(client, owner), "domains")
    assert step == {
        "key": "domains",
        "done": True,
        "count": 2,
        "detail": None,
        "invited": None,
        "run_id": None,
    }


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
        "invited": 0,
        "run_id": None,
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
        "invited": 0,
        "run_id": None,
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


async def test_timezone_done_once_the_company_time_zone_is_stored(client, tenant_id, owner):
    # protects=H2's Time zone step (A1's registry): owners only, done once an owner stored
    # company_timezone, open again after a reset; fails_when=the UTC default reads as
    # done, an approver gets the step, or a reset leaves it done; no_claim=the web's
    # "Time zone" copy and where it opens.
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    assert "timezone" not in [s["key"] for s in (await _setup(client, approver))["steps"]]
    before = await _setup(client, owner)
    assert _step(before, "timezone") == {
        "key": "timezone", "done": False, "count": None, "detail": None,
        "invited": None, "run_id": None,
    }  # fmt: skip
    url = "/v1/settings/company_timezone"
    put = await client.put(url, json={"value": "Europe/Lisbon"}, headers=owner.headers)
    assert put.status_code == 200, put.text
    body = await _setup(client, owner)
    assert _step(body, "timezone") == {
        "key": "timezone", "done": True, "count": None, "detail": "Europe/Lisbon",
        "invited": None, "run_id": None,
    }  # fmt: skip
    assert body["done"] == before["done"] + 1
    reset = await client.put(url, json={"value": None}, headers=owner.headers)
    assert reset.status_code == 200
    assert _step(await _setup(client, owner), "timezone")["done"] is False


async def test_a_second_company_sees_only_its_own_counts(client, tenant_id, owner):
    # protects=every count is the caller's company's; fails_when=a step reads another
    # company's connections, sources, members, invites or horizons; no_claim=domains
    # (from the environment, the same for every company here).
    await add_connection(tenant_id, owner.id, "github", account_id="1")
    await make_person(tenant_id, "approver@example.com", "approver")
    async with tenant_session(tenant_id) as s:
        s.add(Source(owner_user_id=owner.id, kind="upload", name="Notes"))
        s.add(Invite(email="next@example.com", role="commenter"))
        await s.commit()
    put = await client.put(
        "/v1/settings/planning_horizons", json={"value": DEFAULT_HORIZONS}, headers=owner.headers
    )
    assert put.status_code == 200, put.text
    first = await _setup(client, owner)
    assert first["done"] == 4 and _step(first, "invite")["count"] == 2

    other = await make_person(await make_tenant("Second Co"), "second-owner@example.com")
    body = await _setup(client, other)
    assert [s["key"] for s in body["steps"]] == OWNER_KEYS
    assert [s["done"] for s in body["steps"]] == [False] * 8
    assert _step(body, "connect")["count"] == 0
    assert _step(body, "sources")["count"] == 0
    assert _step(body, "invite")["count"] == 1


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
    # One statement per owner step (eight; two for the baseline build: the last one built and
    # the one under way), plus the hide preference and the welcome.
    assert len(statements) <= 10, statements


def test_step_keys_are_checked_against_the_registry():
    # protects=SetupKey is open to later picks but closed to typos; fails_when=an unknown
    # key validates; no_claim=later picks' steps.
    assert [s.key for s in setup.STEPS] == OWNER_KEYS
    assert setup.SetupStep(key="connect", done=False).key == "connect"
    with pytest.raises(ValueError):
        setup.SetupStep(key="nope", done=False)


async def test_build_baseline_is_the_owners_last_step(client, tenant_id, owner):
    # protects=B1's Build baseline step: owners only, last, done once a baseline run
    # succeeded, dated by its finish; fails_when=a draft, failed or Baseline to PRD run
    # makes it done, or an approver sees it; no_claim=the web's "Built Oct 20" copy.
    approver = await make_person(tenant_id, "approver@example.com", "approver")
    assert "build_baseline" not in [s["key"] for s in (await _setup(client, approver))["steps"]]
    body = await _setup(client, owner)
    assert body["steps"][-1] == {
        "key": "build_baseline",
        "done": False,
        "count": None,
        "detail": None,
        "invited": None,
        "run_id": None,
    }
    async with tenant_session(tenant_id) as s:
        s.add(Run(flow="baseline", status="failed", created_by=owner.id))
        s.add(Run(flow="baseline", status="draft", created_by=owner.id))
        s.add(Run(flow="baseline_to_prd", status="succeeded", created_by=owner.id))
        await s.commit()
    assert _step(await _setup(client, owner), "build_baseline")["done"] is False
    async with tenant_session(tenant_id) as s:
        for day in (19, 20):
            finished = datetime(2026, 10, day, 15, tzinfo=UTC)
            s.add(
                Run(flow="baseline", status="succeeded", finished_at=finished, created_by=owner.id)
            )
        await s.commit()
    assert _step(await _setup(client, owner), "build_baseline") == {
        "key": "build_baseline",
        "done": True,
        "count": None,
        "detail": "2026-10-20T15:00:00+00:00",
        "invited": None,
        "run_id": None,
    }


async def test_invite_says_the_open_invites_beside_the_people(client, tenant_id, owner):
    # protects=qa-onboarding-18: Invite team counts open invites too ("4 people · 3
    # invited"); fails_when=an accepted or revoked invite is counted as open, or open
    # invites are left out; no_claim=the web's wording.
    await make_person(tenant_id, "second@example.com", "commenter")
    async with tenant_session(tenant_id) as s:
        s.add(Invite(email="a@example.com", role="viewer"))
        s.add(Invite(email="b@example.com", role="commenter"))
        s.add(Invite(email="gone@example.com", role="viewer", revoked_at=datetime.now(UTC)))
        s.add(Invite(email="in@example.com", role="viewer", accepted_at=datetime.now(UTC)))
        await s.commit()
    step = _step(await _setup(client, owner), "invite")
    assert step["count"] == 2 and step["invited"] == 2 and step["done"] is True


async def test_build_baseline_names_the_build_under_way(client, tenant_id, owner):
    # protects=qa-onboarding-10: while a baseline build is under way the step names its run,
    # so Home says Building and links to it; fails_when=a finished, draft or other flow's run
    # is named, or none is named while one runs; no_claim=the web's copy.
    async with tenant_session(tenant_id) as s:
        s.add(Run(flow="baseline", status="failed", created_by=owner.id))
        s.add(Run(flow="baseline_to_prd", status="running", created_by=owner.id))
        await s.commit()
    assert _step(await _setup(client, owner), "build_baseline")["run_id"] is None
    async with tenant_session(tenant_id) as s:
        run = Run(flow="baseline", status="running", created_by=owner.id)
        s.add(run)
        await s.flush()
        run_id = run.id
        await s.commit()
    step = _step(await _setup(client, owner), "build_baseline")
    assert step["run_id"] == str(run_id) and step["done"] is False
    async with tenant_session(tenant_id) as s:
        (await s.get(Run, run_id)).status = "succeeded"
        await s.commit()
    step = _step(await _setup(client, owner), "build_baseline")
    assert step["run_id"] is None and step["done"] is True


def test_the_web_checklist_names_every_step_the_api_returns():
    """protects=H2 review blocker: Home's Set up checklist has its copy (label, Open
    link, status) for every step oracle.setup.STEPS can return, timezone among them;
    fails_when=a step the API returns is missing from web/app/home/_setup.tsx's STEPS
    (Home drew no row for it, or threw for owners); no_claim=the copy itself
    (web/e2e/setup.spec.ts)."""
    from pathlib import Path

    source = (Path(__file__).parents[2] / "web/app/home/_setup.tsx").read_text()
    block = source.split("const STEPS", 1)[1].split("\n};", 1)[0]
    web_keys = re.findall(r"^  (\w+): \{$", block, flags=re.M)
    assert web_keys == [s.key for s in setup.STEPS]


async def _invited(tenant_id, email: str, role: str, accepted_at: datetime):
    person = await make_person(tenant_id, email, role)
    async with tenant_session(tenant_id) as s:
        s.add(Invite(email=email, role=role, accepted_at=accepted_at))
        await s.commit()
    return person


async def test_a_member_who_joined_by_invite_is_welcomed(client, tenant_id, owner):
    # protects=the welcome is for every member who joined through an invite, however long
    # ago, until they dismiss it (#140 A1 welcome, BGD 2026-10-25: no time window);
    # fails_when=the company's own owner or a member added without an invite is welcomed,
    # or one who joined by invite long ago is not; no_claim=the wording (the web's copy).
    now = datetime.now(UTC)
    invited = await _invited(tenant_id, "invited@example.com", "commenter", now)
    viewer = await _invited(tenant_id, "reader@example.com", "viewer", now)
    old = await _invited(tenant_id, "longago@example.com", "approver", now - timedelta(days=400))
    seeded = await make_person(tenant_id, "seeded@example.com", "commenter")
    assert (await _setup(client, invited))["welcome"] is True
    assert (await _setup(client, viewer))["welcome"] is True
    assert (await _setup(client, old))["welcome"] is True
    assert (await _setup(client, seeded))["welcome"] is False
    assert (await _setup(client, owner))["welcome"] is False


async def test_dismissing_the_welcome_is_each_persons_own(client, tenant_id, owner):
    # protects=Dismiss keeps the welcome away for that person only, any role, however long
    # ago they joined; fails_when=it comes back, a viewer is refused, or one person's
    # dismissal hides another's; no_claim=the web's dismiss button.
    now = datetime.now(UTC)
    first = await _invited(tenant_id, "first@example.com", "viewer", now)
    second = await _invited(tenant_id, "second@example.com", "commenter", now)
    old = await _invited(tenant_id, "third@example.com", "approver", now - timedelta(days=400))
    for person in (first, old):
        resp = await client.patch(
            "/v1/me/preferences", json={"welcome_dismissed": True}, headers=person.headers
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["welcome_dismissed"] is True
        assert (await _setup(client, person))["welcome"] is False
    assert (await _setup(client, second))["welcome"] is True
