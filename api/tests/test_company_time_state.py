# ruff: noqa: F811 - the ctx fixture is imported
"""#1677: the Company time zone read says how it went: fetched (the company's zone),
unavailable (its settings could not be read; the default zone is used) or not_applicable
(no company context), and the API says which one its dates used. Made-up company.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import pytest

from oracle import company_time
from oracle.reports import alignment
from oracle.tenancy import tenant_session
from tests.ritual_helpers import ctx  # noqa: F401 - fixture

STATE = "X-Company-Time-Zone-State"


async def _unreadable(_db):
    raise RuntimeError("settings unreadable")


async def test_the_read_says_fetched_or_not_applicable(ctx):
    """protects=a readable zone reads fetched, no session reads not_applicable, both
    with their zone; fails_when=the read returns a bare zone; no_claim=the API."""
    async with tenant_session(ctx.tenant_id) as db:
        read = await company_time.company_time_zone_read(db)
    assert read == company_time.ZoneRead("America/Los_Angeles", "fetched")
    none = await company_time.company_time_zone_read(None)
    assert none == company_time.ZoneRead(company_time.DEFAULT_ZONE, "not_applicable")


async def test_unreadable_settings_read_unavailable_not_silently(ctx, monkeypatch):
    """protects=settings that cannot be read give the default zone marked unavailable;
    fails_when=the default comes back as if it were the company's; no_claim=the web."""
    monkeypatch.setattr(alignment, "load_settings", _unreadable)
    async with tenant_session(ctx.tenant_id) as db:
        read = await company_time.company_time_zone_read(db)
        zone = await company_time.company_time_zone(db)
    assert read == company_time.ZoneRead(company_time.DEFAULT_ZONE, "unavailable")
    assert zone == company_time.DEFAULT_ZONE


@pytest.mark.parametrize("role", ["owner", "viewer"])
async def test_me_and_dated_responses_say_which_state_they_used(client, ctx, role):
    """protects=GET /v1/me names the state beside the zone, and its response header says
    it; fails_when=a member cannot tell a fetched zone from a fallback; no_claim=pages."""
    resp = await client.get("/v1/me", headers=ctx.as_(role))
    assert resp.status_code == 200, resp.text
    assert resp.json()["company_timezone_state"] == "fetched"
    assert resp.headers[STATE] == "fetched"


async def test_me_says_unavailable_when_the_settings_cannot_be_read(client, ctx, monkeypatch):
    """protects=an unreadable zone reaches the person as unavailable, on me and in the
    header; fails_when=me answers the default zone as fetched; no_claim=the web hint."""
    monkeypatch.setattr(alignment, "load_settings", _unreadable)
    resp = await client.get("/v1/me", headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["company_timezone"] == company_time.DEFAULT_ZONE
    assert body["company_timezone_state"] == "unavailable"
    assert resp.headers[STATE] == "unavailable"


async def test_a_dated_page_names_the_state_its_times_used(client, ctx, monkeypatch):
    """protects=a page whose times are in the Company time zone (the account pool) names
    the state beside its zone and in the header; fails_when=its times fall back to the
    default zone with nothing saying so; no_claim=every dated route has a field."""
    page = await client.get("/v1/claude-accounts", headers=ctx.as_("owner"))
    assert page.status_code == 200, page.text
    assert page.json()["time_zone_state"] == "fetched"
    monkeypatch.setattr(alignment, "load_settings", _unreadable)
    page = await client.get("/v1/claude-accounts", headers=ctx.as_("owner"))
    assert page.status_code == 200, page.text
    assert page.json()["time_zone"] == company_time.DEFAULT_ZONE
    assert page.json()["time_zone_state"] == "unavailable"
    assert page.headers[STATE] == "unavailable"
