# ruff: noqa: F811 - the ctx fixture is imported
"""#401: every screen shows dates and times in the Company time zone, so every member
reads it from GET /v1/me (Settings' own GET is for owners), and the Fireflies and Slack
pickers' days are days in that zone: the picker saves the zone beside them
(``timezone``). Made-up company and people.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import UTC, datetime

import pytest

from oracle.sources.base import ConnectorConfigError
from oracle.sources.connectors import fireflies, slack
from tests.ritual_helpers import ctx  # noqa: F401 - fixture

ZONE = "/v1/settings/company_timezone"


async def test_every_role_reads_the_company_time_zone_on_me(client, ctx):
    """protects=GET /v1/me names the Company time zone for every role, Los Angeles until
    an owner sets one; fails_when=a viewer cannot learn the zone its screens show, or me
    keeps the old zone after a change; no_claim=how the web formats with it."""
    for role in ("owner", "approver", "commenter", "viewer", "token"):
        resp = await client.get("/v1/me", headers=ctx.as_(role))
        assert resp.status_code == 200, resp.text
        assert resp.json()["company_timezone"] == "America/Los_Angeles"
    put = await client.put(ZONE, json={"value": "Asia/Tokyo"}, headers=ctx.as_("owner"))
    assert put.status_code == 200, put.text
    for role in ("owner", "viewer"):
        me = (await client.get("/v1/me", headers=ctx.as_(role))).json()
        assert me["company_timezone"] == "Asia/Tokyo"


def _at(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_fireflies_days_start_and_end_at_midnight_in_the_saved_zone():
    """protects=a picked From/To is whole days in the zone the picker saved: Oct 1 to
    Oct 31 in Los Angeles is 07:00Z Oct 1 up to 07:00Z Nov 1; fails_when=the days stay
    UTC days; no_claim=the browse lists (test_fireflies_browse)."""
    picked = fireflies.selection(
        {
            "mode": "all",
            "date_from": "2026-10-01",
            "date_to": "2026-10-31",
            "timezone": "America/Los_Angeles",
        }
    )
    assert picked.date_from == _at(2026, 10, 1, 7)
    assert picked.date_to_end == _at(2026, 11, 1, 7)
    late = {"id": "M1"}
    # 23:30 on Oct 31 in Los Angeles is Nov 1 in UTC: still inside the picked days.
    assert picked.matches(late, _at(2026, 11, 1, 6, 30))
    assert not picked.matches(late, _at(2026, 10, 1, 6, 30))


def test_fireflies_sources_saved_before_the_zone_keep_their_utc_days():
    """protects=a source saved before #401 (no ``timezone``) still means the same days;
    a zone that is not IANA is refused; fails_when=old sources shift by the company's
    offset or a bad zone is stored; no_claim=the web."""
    old = fireflies.selection({"mode": "all", "date_from": "2026-10-01"})
    assert old.date_from == _at(2026, 10, 1)
    with pytest.raises(ConnectorConfigError):
        fireflies.selection({"mode": "all", "date_from": "2026-10-01", "timezone": "Mars/Base"})


def test_slack_since_and_until_are_days_in_the_saved_zone():
    """protects=Slack's Since/Until are whole days in the saved zone, as Fireflies';
    without one, UTC days as before; fails_when=Slack keeps UTC days; no_claim=the
    narrowing on save."""
    zoned = {"channels": ["C1"], "since": "2026-10-01", "until": "2026-10-31"}
    zoned["timezone"] = "Asia/Tokyo"
    assert slack._since(zoned) == _at(2026, 9, 30, 15).timestamp()
    assert slack._until(zoned) == _at(2026, 10, 31, 15).timestamp()
    assert slack._range_of(zoned)["timezone"] == "Asia/Tokyo"
    assert slack._since({"since": "2026-10-01"}) == _at(2026, 10, 1).timestamp()
    with pytest.raises(ConnectorConfigError):
        slack._since({"since": "2026-10-01", "timezone": "Mars/Base"})
