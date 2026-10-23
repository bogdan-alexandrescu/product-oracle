# ruff: noqa: F811 - the ritual fixtures are imported
"""The Company time zone (owner decisions 2026-10-22): one setting, America/Los_Angeles
by default, that the weekly alignment report and every ritual read (rituals have no zone
of their own) (goals' "today" is in
test_goal_measurements). Made-up company and people.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from oracle.reports import alignment
from oracle.tenancy import tenant_session
from tests.ritual_helpers import at, ctx, rituals_of, tick  # noqa: F401 - fixtures
from tests.test_rituals import create

ZONE = "/v1/settings/company_timezone"
REPORT = "/v1/settings/alignment_report"


async def _zone(client, ctx, zone: str, who: str = "owner"):
    return await client.put(ZONE, json={"value": zone}, headers=ctx.as_(who))


async def test_one_setting_los_angeles_by_default(client, ctx):
    """protects=Company time zone is America/Los_Angeles until an owner sets an IANA zone
    (owner decision 2026-10-22); owners only; fails_when=it reads UTC unset, a bad name is
    stored or an approver changes it; no_claim=the UI."""
    resp = await client.get(ZONE, headers=ctx.as_("owner"))
    assert resp.status_code == 200 and resp.json()["value"] == "America/Los_Angeles"
    assert resp.json()["is_default"] is True
    assert (await _zone(client, ctx, "Mars/Olympus")).status_code == 422
    assert (await _zone(client, ctx, "Asia/Tokyo", who="approver")).status_code == 403
    resp = await _zone(client, ctx, "Asia/Tokyo")
    assert resp.status_code == 200, resp.text
    assert (await client.get(ZONE, headers=ctx.as_("owner"))).json()["value"] == "Asia/Tokyo"


async def test_the_alignment_report_reads_the_company_time_zone(client, ctx):
    """protects=the weekly report has no zone of its own: its schedule is in the Company
    time zone; fails_when=the report keeps Los Angeles, or its setting still takes a
    zone; no_claim=the report's content."""
    value = (await client.get(REPORT, headers=ctx.as_("owner"))).json()["value"]
    assert "timezone" not in value
    resp = await client.put(
        REPORT, json={"value": {"timezone": "Europe/Paris"}}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 422
    async with tenant_session(ctx.tenant_id) as db:
        assert (await alignment.load_settings(db)).timezone == "America/Los_Angeles"
    await _zone(client, ctx, "Europe/Paris")
    async with tenant_session(ctx.tenant_id) as db:
        assert (await alignment.load_settings(db)).timezone == "Europe/Paris"


async def test_companies_that_never_saved_the_report_keep_monday_0800_los_angeles(ctx, at):
    """protects=owner decision 2026-10-22: with no Company time zone and no report setting
    saved, the weekly report and its ritual stay on Monday 08:00 in Los Angeles, as
    before the one zone; fails_when=they move to UTC; no_claim=the report's content."""
    await tick(ctx.tenant_id)
    async with tenant_session(ctx.tenant_id) as db:
        s = await alignment.load_settings(db)
    assert (s.weekday, s.time, s.timezone) == ("mon", "08:00", "America/Los_Angeles")
    ritual = (await rituals_of(ctx.tenant_id))["alignment_report"]
    assert (ritual.schedule["weekday"], ritual.schedule["time"]) == (0, "08:00")
    assert ritual.schedule["timezone"] == "America/Los_Angeles"


async def test_rituals_follow_the_company_time_zone(client, ctx, at):
    """protects=one zone (owner decision 2026-10-22): every ritual is in the Company time
    zone, the built-ins, the alignment report and an owner's own alike, and all move to a
    new one with their next date in it; fails_when=a ritual keeps a zone of its own or
    stays on the old company zone; no_claim=occurrences already prepared."""
    await tick(ctx.tenant_id)
    resp = await create(client, ctx)  # the body names Europe/Berlin: not the company's
    assert resp.status_code == 201, resp.text
    assert resp.json()["schedule"]["timezone"] == "America/Los_Angeles"
    before = await rituals_of(ctx.tenant_id)
    assert (await _zone(client, ctx, "Asia/Tokyo")).status_code == 200
    after = await rituals_of(ctx.tenant_id)
    for kind, r in after.items():
        assert r.schedule["timezone"] == "Asia/Tokyo", kind
        if r.status == "active":
            # 09:00 Tokyo is sixteen hours before 09:00 Los Angeles: the next date moved.
            assert r.next_due_at != before[kind].next_due_at, kind


async def test_the_alignment_reports_ritual_stays_in_the_company_time_zone(client, ctx, at):
    """protects=H2 review (major): the weekly report's zone is the Company time zone, so
    its ritual cannot be moved to another zone on Company › Rituals, and a new day or
    time there is the report's own setting; fails_when=the ritual fires in Berlin while
    the report counts its week in UTC, or the setting keeps Monday 08:00 after the
    ritual moved to Friday; no_claim=the report's content."""
    await tick(ctx.tenant_id)
    ritual = (await rituals_of(ctx.tenant_id))["alignment_report"]
    assert ritual.schedule["timezone"] == "America/Los_Angeles"
    path = f"/v1/rituals/{ritual.id}"

    async def patch(schedule: dict):
        body = {"lock_version": ritual.lock_version, "schedule": schedule}
        return await client.patch(path, json=body, headers=ctx.as_("owner"))

    monthly = {"freq": "monthly", "week_of_month": 1, "weekday": 0, "time": "08:00"}
    assert (await patch(monthly)).status_code == 422
    # A zone in the body is not the ritual's: it stays in the Company time zone.
    berlin = {"freq": "weekly", "weekday": 4, "time": "16:00", "timezone": "Europe/Berlin"}
    resp = await patch(berlin)
    assert resp.status_code == 200, resp.text
    assert resp.json()["schedule"]["timezone"] == "America/Los_Angeles"
    value = (await client.get(REPORT, headers=ctx.as_("owner"))).json()["value"]
    assert (value["weekday"], value["time"]) == ("fri", "16:00")
    async with tenant_session(ctx.tenant_id) as db:
        settings = await alignment.load_settings(db)
    assert (settings.weekday, settings.time, settings.timezone) == (
        "fri", "16:00", "America/Los_Angeles",
    )  # fmt: skip
