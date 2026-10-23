"""The Company time zone (owner decision 2026-10-22): one setting, UTC by default, that
the weekly alignment report and the rituals read (goals' "today" is in
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


async def test_one_setting_utc_by_default(client, ctx):
    """protects=Company time zone is UTC until an owner sets an IANA zone; owners only;
    fails_when=a bad name is stored or an approver changes it; no_claim=the UI."""
    resp = await client.get(ZONE, headers=ctx.as_("owner"))
    assert resp.status_code == 200 and resp.json()["value"] == "UTC"
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
        assert (await alignment.load_settings(db)).timezone == "UTC"
    await _zone(client, ctx, "Europe/Paris")
    async with tenant_session(ctx.tenant_id) as db:
        assert (await alignment.load_settings(db)).timezone == "Europe/Paris"


async def test_rituals_follow_the_company_time_zone(client, ctx, at):
    """protects=rituals read the Company time zone: the built-ins (the alignment report
    among them) and any ritual on the old company zone move to the new one, with their
    next date in it; a ritual an owner put in another zone keeps it; fails_when=a
    ritual stays on the old company zone; no_claim=occurrences already prepared."""
    await tick(ctx.tenant_id)
    resp = await create(client, ctx)  # Europe/Berlin
    assert resp.status_code == 201, resp.text
    before = await rituals_of(ctx.tenant_id)
    assert (await _zone(client, ctx, "Asia/Tokyo")).status_code == 200
    after = await rituals_of(ctx.tenant_id)
    assert after["custom"].schedule["timezone"] == "Europe/Berlin"
    for kind, r in after.items():
        if kind == "custom":
            continue
        assert r.schedule["timezone"] == "Asia/Tokyo", kind
        if r.status == "active":
            # 09:00 Tokyo is nine hours before 09:00 UTC: the next date moved.
            assert r.next_due_at != before[kind].next_due_at, kind
