# ruff: noqa: F811 - the roadmap fixtures are imported
"""F6 Weekly alignment report: the roadmap against engineering every week, in owners'
Inbox and in a Slack channel through Oracle's own Slack app, installed once per company.

Slack is faked with an ``httpx.MockTransport`` (``oracle.integrations.slack_api``); the real
Slack API is never called. The clock is ``oracle.reports.clock.now``; every model transport
is patched to fail, so a model call anywhere fails the test.
"""

import json
import logging
import uuid
from datetime import UTC, date, datetime, timedelta
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo

import httpx
import pytest
from sqlalchemy import select, update

from oracle.connections import oauth
from oracle.integrations import slack_api, slack_oauth
from oracle.integrations.models import CompanyIntegration
from oracle.llm import gateway
from oracle.mcp.scopes import required_scope
from oracle.models import AuditEvent
from oracle.reports import alignment, clock
from oracle.reports import slack as report_slack
from oracle.reports.models import AlignmentReport
from oracle.rituals import clock as ritual_clock
from oracle.rituals import service as rituals
from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.roadmap.models import ProductTrack
from oracle.tenancy import tenant_session
from oracle.tenant_settings_api import DEFAULTS
from oracle.ticker import router as ticker
from tests.day_helpers import company_today
from tests.roadmap_helpers import other_company
from tests.test_mcp import mcp_client, run_token, text_of
from tests.test_roadmap import (  # noqa: F401 - fixtures
    PRD,
    ROADMAP,
    approved_prd,
    as_user,
    built_roadmap,
    owner,
    runtime,
)

LA = ZoneInfo("America/Los_Angeles")
TOKEN = "xoxb-fake-bot-token-0123456789"
SETTING = "/v1/settings/alignment_report"
CHANNEL = {"id": "C0PLAN", "name": "plan"}


def la(*args: int) -> datetime:
    return datetime(*args, tzinfo=LA).astimezone(UTC)


@pytest.fixture(autouse=True)
def company_in_los_angeles(monkeypatch):
    """These tests' company works in Los Angeles: its Company time zone, which the weekly
    report reads (it has no zone of its own)."""
    monkeypatch.setitem(DEFAULTS, "company_timezone", "America/Los_Angeles")


async def company_zone(client, auth, zone: str) -> None:
    resp = await client.put("/v1/settings/company_timezone", json={"value": zone}, headers=auth)
    assert resp.status_code == 200, resp.text


class FakeSlack:
    """Slack's Web API: records every call; answers from per-method queues, else OK."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict, httpx.Headers]] = []
        self.answers: dict[str, list[httpx.Response]] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.host == "slack.com", request.url
        method = request.url.path.rsplit("/", 1)[-1]
        raw = request.content.decode()
        if request.headers.get("content-type", "").startswith("application/json"):
            body = json.loads(raw or "{}")
        else:
            body = {k: v[0] for k, v in parse_qs(raw).items()}
        self.calls.append((method, body, request.headers))
        if self.answers.get(method):
            r = self.answers[method].pop(0)
            return httpx.Response(r.status_code, headers=r.headers, content=r.content)
        if method == "oauth.v2.access":
            return httpx.Response(200, json={
                "ok": True, "access_token": TOKEN, "token_type": "bot",
                # G8 Slack bridge's scopes too (an F6-only install asks to reconnect).
                "scope": ",".join(slack_oauth.BOT_SCOPES),
                "bot_user_id": "U0BOT",
                "app_id": "A0ORACLE", "team": {"id": "T0EXAMPLE", "name": "Example Co"},
            })  # fmt: skip
        if method == "conversations.list":
            # Slack lists the private channels the bot was invited to only when asked.
            found = [
                {"id": "C0PLAN", "name": "plan", "is_private": False},
                {"id": "C0ENG", "name": "eng", "is_private": False},
            ]
            if "private_channel" in str(body.get("types")).split(","):
                found.append({"id": "G0LEADS", "name": "leads", "is_private": True})
            return httpx.Response(200, json={
                "ok": True, "channels": found, "response_metadata": {"next_cursor": ""},
            })  # fmt: skip
        if method == "chat.postMessage":
            return httpx.Response(
                200, json={"ok": True, "channel": body.get("channel"), "ts": "1761490812.000100"}
            )
        if method == "auth.revoke":
            return httpx.Response(200, json={"ok": True, "revoked": True})
        return httpx.Response(404, json={"ok": False, "error": "unknown_method"})

    def of(self, method: str) -> list[dict]:
        return [body for m, body, _ in self.calls if m == method]


@pytest.fixture
def slack(monkeypatch):
    monkeypatch.setenv("ORACLE_OAUTH_SLACK_CLIENT_ID", "slack-client")
    monkeypatch.setenv("ORACLE_OAUTH_SLACK_CLIENT_SECRET", "slack-secret")
    monkeypatch.setenv("ORACLE_OAUTH_REDIRECT_BASE", "https://oracle.example.com")
    monkeypatch.setenv("ORACLE_APP_URL", "https://oracle.example.com")
    from oracle.config import get_settings

    get_settings.cache_clear()
    oauth.get_oauth_settings.cache_clear()
    fake = FakeSlack()
    previous = slack_api.set_transport(httpx.MockTransport(fake.handler))
    yield fake
    slack_api.set_transport(previous)
    oauth.get_oauth_settings.cache_clear()
    get_settings.cache_clear()


class _NoModel:
    async def complete(self, token, request):  # pragma: no cover - fails the test if hit
        raise AssertionError("the alignment report made a model call")


@pytest.fixture(autouse=True)
def no_model_calls():
    """AC11: deterministic, no model call. Any model call raises."""
    previous = gateway.set_transports(gateway.Transports(plan=_NoModel(), api_key=_NoModel()))
    yield
    gateway.set_transports(previous)


@pytest.fixture
def at(monkeypatch):
    """Sets Oracle's report and ritual clocks: ``at(datetime)``. The weekly report is the
    ``alignment_report`` ritual (H2), so the rituals' clock moves with the report's."""
    state = {"now": datetime.now(UTC)}
    monkeypatch.setattr(clock, "now", lambda: state["now"])
    monkeypatch.setattr(ritual_clock, "now", lambda: state["now"])

    def set_(when: datetime) -> datetime:
        state["now"] = when
        return when

    return set_


async def a_track(client, auth, runtime) -> dict:
    """The checkout PRD approved, its roadmap built (one active track), and engineering's
    state: payment (now) slips past its Beta date, shipping (next) started early, and one
    issue no item names."""
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    (track,) = (await client.get("/v1/tracks", headers=auth)).json()
    records = [
        {"external_ref": "ENG-412", "state": "in_progress", "target_date": "2026-12-20",
         "track_id": track["id"], "item_key": "payment-step"},
        {"external_ref": "ENG-413", "state": "in_progress", "track_id": track["id"],
         "item_key": "shipping-step"},
        {"external_ref": "ENG-777", "title": "Refactor cart", "state": "todo",
         "track_id": track["id"]},
    ]  # fmt: skip
    resp = await client.post(
        "/v1/tracker/records", json={"tracker": "jira", "records": records}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    return track


async def install(client, auth) -> dict:
    """Settings › Notifications › Connect Slack for notifications, through Slack's OAuth."""
    resp = await client.get("/v1/company-integrations/slack/install", headers=auth)
    assert resp.status_code == 200, resp.text
    url = urlparse(resp.json()["url"])
    query = parse_qs(url.query)
    resp = await client.get(
        "/v1/company-integrations/slack/callback",
        params={"state": query["state"][0], "code": "code-1"},
        headers=auth,
    )
    assert resp.status_code == 303, resp.text
    assert resp.headers["location"] == "/settings/notifications?connected=slack"
    (row,) = (await client.get("/v1/company-integrations", headers=auth)).json()
    return row


async def set_report(client, auth, **value) -> dict:
    body = {"enabled": True, "weekday": "mon", "time": "08:00", "slack_channel": None,
            **value}  # fmt: skip
    resp = await client.put(SETTING, json={"value": body}, headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()["value"]


async def due(tenant_id) -> list[AlignmentReport]:
    """One ticker pass of the ritual engine (H2), which owns the weekly report's clock."""
    async with tenant_session(tenant_id) as db:
        await rituals.tick_due(db)
    return await reports_of(tenant_id)


async def report_ritual(tenant_id) -> Ritual:
    async with tenant_session(tenant_id) as db:
        return await db.scalar(select(Ritual).where(Ritual.kind == "alignment_report"))


async def reports_of(tenant_id) -> list[AlignmentReport]:
    async with tenant_session(tenant_id) as db:
        return list(await db.scalars(select(AlignmentReport).order_by(AlignmentReport.created_at)))


def this_monday(now: datetime) -> date:
    local = now.astimezone(LA).date()
    return local - timedelta(days=local.weekday())


# --------------------------------------------------------------------------- unit


def test_week_window_in_the_company_time_zone():
    """protects=the week a report covers; fails_when=the week is not Monday 00:00 to Monday
    00:00 local, or a DST change shifts it; no_claim=the scheduled moment."""
    start, end = alignment.week_window(date(2026, 10, 19), "America/Los_Angeles")
    assert (start, end) == (
        datetime(2026, 10, 19, 7, tzinfo=UTC),
        datetime(2026, 10, 26, 7, tzinfo=UTC),
    )
    # The week DST ends in (Sunday Nov 1): seven local days, 169 hours.
    start, end = alignment.week_window(date(2026, 10, 26), "America/Los_Angeles")
    assert (start, end) == (
        datetime(2026, 10, 26, 7, tzinfo=UTC),
        datetime(2026, 11, 2, 8, tzinfo=UTC),
    )
    assert alignment.week_start_of(la(2026, 10, 25, 23, 59)) == date(2026, 10, 19)
    assert alignment.week_start_of(
        datetime(2026, 10, 26, 7, tzinfo=UTC), "America/Los_Angeles"
    ) == date(2026, 10, 26)
    assert alignment.week_start_of(
        datetime(2026, 10, 26, 6, 59, tzinfo=UTC), "America/Los_Angeles"
    ) == date(2026, 10, 19)


def test_the_scheduled_moment_is_local():
    """protects=Monday 08:00 in the company's zone; fails_when=the moment is computed in UTC
    or ignores DST, or another weekday is not honoured; no_claim=building the report."""
    settings = alignment.ReportSettings(weekday="mon", time="08:00", timezone="America/Los_Angeles")
    assert alignment.scheduled_moment(date(2026, 10, 26), settings) == datetime(
        2026, 10, 26, 15, tzinfo=UTC
    )
    # Monday Nov 2 is PST: 08:00 local is 16:00 UTC.
    assert alignment.scheduled_moment(date(2026, 11, 2), settings) == datetime(
        2026, 11, 2, 16, tzinfo=UTC
    )
    fri = alignment.ReportSettings(weekday="fri", time="17:30", timezone="Europe/Berlin")
    assert alignment.scheduled_moment(date(2026, 10, 26), fri) == datetime(
        2026, 10, 30, 16, 30, tzinfo=UTC
    )


def _content(n_tracks: int) -> dict:
    tracks = []
    for i in range(n_tracks):
        risky = i == 0
        tracks.append({
            "track_id": str(uuid.uuid4()), "status": "active",
            "prd": {"slug": f"prd-{i}", "title": f"PRD {i}"}, "link": f"/plan?item=prd-{i}",
            "health": "at_risk" if risky else "on_track",
            "health_before": "on_track", "headline": "h",
            "next_milestone": {"name": "Beta", "date": "2026-11-30", "verified": True},
            "alignment": {"aligned": 1, "drift": 0, "untracked": 0, "done": 0},
            "needs_attention": [{
                "item_key": "item-b", "title": "Item <B>", "horizon": "now", "kind": "slipping",
                "detail": "ENG-405 targets Dec 9, after the milestone date Nov 30.",
                "alert_id": None, "link": f"/plan?item=prd-{i}:item-b",
            }] if risky else [],
            "drift": [], "dates": {"verified": [], "withdrawn": []}, "prd_moved": False,
        })  # fmt: skip
    return {
        "kind": "weekly", "week_start": "2026-10-19",
        "headline": "1 of 7 tracks at risk; 1 date slipping as of now.",
        "summary": {"tracks": n_tracks, "at_risk": 1, "off_track": 0, "slips": 1,
                    "untracked_now": 4, "unplanned": 0, "dates_verified": 0, "dates_withdrawn": 0},
        "tracks": tracks, "needs_attention_as_of_now": True,
    }  # fmt: skip


def test_slack_text_has_the_summary_at_most_five_item_lines_and_the_link(slack):
    """protects=the Slack message (§4); fails_when=more than 5 item lines, no summary line,
    no link to the report, or Slack's control characters are not escaped; no_claim=delivery."""
    rid = uuid.uuid4()
    text = report_slack.message(_content(7), rid)
    lines = text.splitlines()
    assert lines[0] == "*Weekly alignment · week of Oct 19*"
    assert lines[1] == "1 of 7 tracks at risk · 1 date slipping · 4 Now items without an issue"
    items = [line for line in lines if line.startswith("• ")]
    assert len(items) == 5
    assert items[0].startswith("• PRD 0 · At risk · ")
    assert "ENG-405" in items[0]
    assert items[1] == "• PRD 1 · On track · next: Beta, Nov 30 ✓"
    assert "+2 more in Oracle" in lines
    assert lines[-1] == f"<https://oracle.example.com/plan/reports/{rid}|Open the report in Oracle>"
    # Three tracks: every one listed, no "+N more".
    short = report_slack.message(_content(3), rid)
    assert "more in Oracle" not in short and short.count("\n• ") == 3


def test_slack_text_neutralises_slack_formatting_in_titles(slack):
    """protects=the Slack message reads as written; fails_when=a *, _, ~ or ` in a track,
    milestone or item title turns into Slack bold, italics, strike or code; no_claim=the
    stored Markdown."""
    content = _content(2)
    content["tracks"][0]["prd"]["title"] = "*Bold* _it_ ~gone~ `code`"
    content["tracks"][0]["needs_attention"][0]["detail"] = "Item *B* is _late_"
    content["tracks"][1]["next_milestone"]["name"] = "`Beta`_~*"
    text = report_slack.message(content, uuid.uuid4())
    items = [line for line in text.splitlines() if line.startswith("• ")]
    assert items[0] == (
        "• \uff0aBold\uff0a \uff3fit\uff3f \uff5egone\uff5e \uff40code\uff40 · At risk · "
        "Item \uff0aB\uff0a is \uff3flate\uff3f"
    )
    assert items[1] == "• PRD 1 · On track · next: \uff40Beta\uff40\uff3f\uff5e\uff0a, Nov 30 ✓"
    # The message's own formatting stays: the bold title and the link.
    assert text.startswith("*Weekly alignment · week of Oct 19*\n")


def test_markdown_escapes_brackets_in_item_links():
    """protects=the stored Markdown's links; fails_when=a ] (or [ or \\) in an item title
    ends its link text early and breaks the link; no_claim=the web page."""
    content = _content(1)
    content["tracks"][0]["needs_attention"][0]["title"] = "Item [B] \\ done]"
    md = alignment.markdown(content)
    assert "- [Item \\[B\\] \\\\ done\\]](/plan?item=prd-0:item-b) · Now: " in md


def test_markdown_carries_the_headline_and_one_part_per_track():
    """protects=the stored Markdown (printable, §1); fails_when=a track, the headline or the
    'as of now' wording until F2 is missing; no_claim=the web page."""
    md = alignment.markdown(_content(2))
    assert md.startswith("# Weekly alignment · week of Oct 19\n")
    assert "1 of 7 tracks at risk" in md
    assert "## PRD 0 · At risk, was On track" in md and "## PRD 1 · On track" in md
    assert "### Needs attention (as of now)" in md
    assert "(/plan?item=prd-0:item-b)" in md


def test_report_prose_names_days_in_words_not_iso():
    """protects=qa-plan-9/57 (dates and horizons in the report's sentences); fails_when=a
    track headline, a drift detail or the Markdown shows 2026-11-30 or "(now)" instead of
    "Nov 30" and "· Now"; no_claim=the machine fields (next_milestone.date stays ISO)."""
    from types import SimpleNamespace

    from oracle.roadmap import tracker, views

    nxt = SimpleNamespace(name="First release", target_date=date(2026, 11, 30))
    counts = {"items": 3, "at_risk": 1, "blocked": 0, "stale": 0, "slipping": 1}
    assert views._headline("at_risk", counts, nxt) == (
        "At risk: 1 of 3 items need attention (1 slipping). Next milestone: First release, Nov 30."
    )
    assert views._headline("on_track", counts, nxt) == (
        "On track: 3 items. Next milestone: First release, Nov 30."
    )
    item = SimpleNamespace(item_key="threshold-alerts", horizon="now")
    record = SimpleNamespace(external_ref="ENG-405", state="in_progress",
                             target_date=date(2026, 12, 9))  # fmt: skip
    (slip,) = tracker.drift_of(item, [record], date(2026, 11, 30), date(2026, 10, 28))
    assert slip.detail == "ENG-405 targets Dec 9, after the milestone date Nov 30."
    overdue = tracker.drift_of(item, [record], date(2026, 10, 20), date(2026, 10, 28))
    assert overdue[-1].detail == ("The milestone date Oct 20 has passed and the work is not done.")
    content = _content(1)
    content["tracks"][0]["dates"] = {
        "verified": [{"reference": "ENG-412", "supports_date": "2026-11-30"}],
        "withdrawn": [{"reference": "ENG-413", "supports_date": "2026-12-15",
                       "reason": "Estimate replaced"}],
    }  # fmt: skip
    md = alignment.markdown(content)
    assert "- Next milestone: Beta, Nov 30 (verified basis)" in md
    assert "(/plan?item=prd-0:item-b) · Now: ENG-405 targets Dec 9" in md
    assert "- Verified: ENG-412 supports Nov 30" in md
    assert "- Withdrawn: ENG-413 (Dec 15): Estimate replaced" in md
    assert "2026-" not in md.split("\n", 1)[1] and "(now)" not in md


def test_headline_wording():
    """protects=§1's headline; fails_when=counts or plurals are wrong; no_claim=the counts."""
    assert alignment.headline({"tracks": 3, "at_risk": 1, "off_track": 0, "slips": 2,
                               "untracked_now": 4}) == (
        "1 of 3 tracks at risk; 2 dates slipping as of now; 4 Now items have no issue."
    )  # fmt: skip
    assert alignment.headline({"tracks": 1, "at_risk": 0, "off_track": 1, "slips": 1,
                               "untracked_now": 1}) == (
        "1 of 1 track at risk; 1 date slipping as of now; 1 Now item has no issue."
    )  # fmt: skip


async def test_the_setting_is_validated(client, owner):
    """protects=the alignment_report setting (§2); fails_when=a bad weekday, time, zone or
    channel is stored, or a commenter can change it; no_claim=the schedule itself."""
    tenant_id, auth = owner
    resp = await client.get(SETTING, headers=auth)
    # No zone of its own: the report reads the Company time zone.
    assert resp.json()["value"] == {
        "enabled": True, "weekday": "mon", "time": "08:00", "slack_channel": None,
    }  # fmt: skip
    for bad in ({"weekday": "monday"}, {"time": "8am"}, {"time": "24:00"},
                {"timezone": "Mars/Olympus"}, {"enabled": "yes"},
                {"slack_channel": {"id": "not a channel"}}, {"unknown": 1}):  # fmt: skip
        resp = await client.put(SETTING, json={"value": {"weekday": "mon", **bad}}, headers=auth)
        assert resp.status_code == 422, (bad, resp.text)
    # Partial values take the defaults for the rest.
    resp = await client.put(SETTING, json={"value": {"weekday": "tue"}}, headers=auth)
    assert resp.json()["value"]["time"] == "08:00" and resp.json()["value"]["weekday"] == "tue"
    commenter = await as_user(tenant_id, "commenter")
    assert (await client.put(SETTING, json={"value": {}}, headers=commenter)).status_code == 403


# --------------------------------------------------------------------------- schedule


async def test_the_ticker_builds_one_weekly_report_at_the_local_moment(
    client,
    owner,
    runtime,
    at,
):
    """AC1. protects=the weekly schedule; fails_when=a report is built before Monday 08:00
    local, none at 08:00, or a second one that week; no_claim=what the report says."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    at(la(2026, 10, 26, 7, 59))
    assert await due(tenant_id) == []
    at(la(2026, 10, 26, 8, 0))
    (report,) = await due(tenant_id)
    assert report.kind == "weekly" and report.week_start == date(2026, 10, 19)
    assert (report.period_start, report.period_end) == (la(2026, 10, 19), la(2026, 10, 26))
    assert report.slack_status == "not_configured" and report.generated_by is None
    # Further ticks that week build none.
    for later in (la(2026, 10, 26, 8, 1), la(2026, 10, 28, 12), la(2026, 11, 1, 23, 59)):
        at(later)
        assert len(await due(tenant_id)) == 1
    # And the database refuses a second one for the week anyway (the unique index).
    async with tenant_session(tenant_id) as db:
        with pytest.raises(alignment.AlreadyBuilt):
            await alignment.build(db, kind="weekly", week_start=date(2026, 10, 19))
    # Through the run ticker's company tick, after track monitoring.
    at(la(2026, 11, 2, 7, 59))
    out = ticker.TickerOut()
    await ticker._tick_company(tenant_id, out, ticker._Failures(out))
    assert len(await reports_of(tenant_id)) == 1
    # The DST week: Monday Nov 2 08:00 PST is 16:00 UTC.
    at(datetime(2026, 11, 2, 15, 59, tzinfo=UTC))
    await ticker._tick_company(tenant_id, out, ticker._Failures(out))
    assert len(await reports_of(tenant_id)) == 1
    at(datetime(2026, 11, 2, 16, 0, tzinfo=UTC))
    await ticker._tick_company(tenant_id, out, ticker._Failures(out))
    reports = await reports_of(tenant_id)
    assert [r.week_start for r in reports] == [date(2026, 10, 19), date(2026, 10, 26)]
    assert reports[1].period_end == datetime(2026, 11, 2, 8, tzinfo=UTC)
    assert out.companies.failed == 0
    # Generated is audited, by the ticker (system).
    async with tenant_session(tenant_id) as db:
        events = list(await db.scalars(
            select(AuditEvent).where(AuditEvent.action == "alignment_report.generated")
        ))  # fmt: skip
    assert len(events) == 2 and {e.actor for e in events} == {"system"}


async def test_disabled_or_no_active_track_builds_nothing(client, owner, runtime, at):
    """AC4. protects=no empty reports; fails_when=a company without an active or paused
    track, or with the report disabled, gets a report or an Inbox row; no_claim=content."""
    tenant_id, auth = owner
    at(la(2026, 10, 26, 9))
    assert await due(tenant_id) == []
    await a_track(client, auth, runtime)
    await set_report(client, auth, enabled=False)
    assert await due(tenant_id) == []
    await set_report(client, auth)
    async with tenant_session(tenant_id) as db:
        await db.execute(update(ProductTrack).values(status="closed"))
        await db.commit()
    assert await due(tenant_id) == []
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["reports"] == [] and inbox["report_failures"] == []
    # A paused track is reported.
    async with tenant_session(tenant_id) as db:
        await db.execute(update(ProductTrack).values(status="paused"))
        await db.commit()
    (report,) = await due(tenant_id)
    assert [t["status"] for t in report.content["tracks"]] == ["paused"]


async def test_the_weekly_report_is_the_alignment_report_ritual(client, owner, runtime, at):
    """H2 criterion 15. protects=one clock: the first tick seeds a built-in
    alignment_report ritual with F6's stored day, time and time zone, a change to the
    setting moves it, and pausing the ritual stops the weekly report through the run
    ticker; fails_when=the ritual is missing or on other times, or F6's own ticker check
    still builds the report; no_claim=Slack delivery (the tests below)."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    await company_zone(client, auth, "Europe/Paris")
    await set_report(client, auth, weekday="fri", time="16:30")
    at(la(2026, 10, 26, 9))
    assert await due(tenant_id) == []
    ritual = await report_ritual(tenant_id)
    assert ritual is not None and ritual.builtin and ritual.status == "active"
    assert ritual.title == "Weekly alignment report"
    s = ritual.schedule
    assert (s["freq"], s["weekday"], s["time"]) == ("weekly", 4, "16:30")
    assert s["timezone"] == "Europe/Paris"
    paris = ZoneInfo("Europe/Paris")
    assert ritual.next_due_at == datetime(2026, 10, 30, 16, 30, tzinfo=paris)
    # Company › Rituals lists it.
    listed = (await client.get("/v1/rituals", headers=auth)).json()
    assert "alignment_report" in {r["kind"] for r in listed}
    # The setting moves the ritual: Mondays 08:00; the Company time zone moves it back to
    # Los Angeles.
    await set_report(client, auth)
    assert (await report_ritual(tenant_id)).schedule["timezone"] == "Europe/Paris"
    await company_zone(client, auth, "America/Los_Angeles")
    ritual = await report_ritual(tenant_id)
    assert (ritual.schedule["weekday"], ritual.schedule["time"]) == (0, "08:00")
    assert ritual.schedule["timezone"] == "America/Los_Angeles"
    # Monday 08:00 has passed this week and last week is not reported yet: F6's catch-up,
    # the next tick reports it.
    assert ritual.next_due_at == la(2026, 10, 26, 8)
    # Paused on Company › Rituals, the run ticker builds no report at its moment: F6's
    # own check no longer runs.
    resp = await client.post(f"/v1/rituals/{ritual.id}/pause", headers=auth)
    assert resp.status_code == 200, resp.text
    at(la(2026, 11, 2, 8, 5))
    out = ticker.TickerOut()
    await ticker._tick_company(tenant_id, out, ticker._Failures(out))
    assert await reports_of(tenant_id) == [] and out.companies.failed == 0
    # Disabling the report pauses the ritual; enabling it resumes it.
    await client.post(f"/v1/rituals/{ritual.id}/resume", headers=auth)
    await set_report(client, auth, enabled=False)
    assert (await report_ritual(tenant_id)).status == "paused"
    await set_report(client, auth)
    assert (await report_ritual(tenant_id)).status == "active"


async def test_over_a_simulated_week_one_clock_builds_one_report(client, owner, runtime, at):
    """H2 criterion 15. protects=one clock: the run ticker, every hour for a week and
    twice in the same minute at the report's moment, builds exactly one weekly report,
    through exactly one alignment_report occurrence, and F6's own ticker check is gone;
    fails_when=no report, a second report or occurrence that week, or a report built
    before Monday 08:00 local; no_claim=the report's content (the tests below)."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    assert not hasattr(alignment, "due")
    out = ticker.TickerOut()
    moments = [la(2026, 10, 26, 0) + timedelta(hours=h) for h in range(7 * 24)]
    moments += [la(2026, 10, 26, 8), la(2026, 10, 26, 8, 0, 30)]
    built_at = None
    for moment in sorted(moments):
        at(moment)
        await ticker._tick_company(tenant_id, out, ticker._Failures(out))
        if built_at is None and await reports_of(tenant_id):
            built_at = moment
    (report,) = await reports_of(tenant_id)
    assert report.week_start == date(2026, 10, 19) and built_at == la(2026, 10, 26, 8)
    ritual = await report_ritual(tenant_id)
    async with tenant_session(tenant_id) as db:
        mine = RitualOccurrence.ritual_id == ritual.id
        occurrences = list(await db.scalars(select(RitualOccurrence).where(mine)))
    assert [o.due_at for o in occurrences] == [la(2026, 10, 26, 8)]
    assert occurrences[0].pre_read["blocks"][0]["rows"][0]["report_id"] == str(report.id)
    assert out.companies.failed == 0


# --------------------------------------------------------------------------- content


async def test_alignment_counts_and_needs_attention_match_the_roadmap(
    client,
    owner,
    runtime,
    at,
):
    """AC2. protects=the numbers (§1); fails_when=a track's alignment counts differ from
    GET /v1/roadmaps/{doc}/alignment, or needs attention is not the track's current at-risk
    reasons (until F2's alerts); no_claim=F2 alerts (not on main)."""
    tenant_id, auth = owner
    track = await a_track(client, auth, runtime)
    at(datetime.now(UTC))
    resp = await client.post("/v1/alignment-reports", json={}, headers=auth)
    assert resp.status_code == 201, resp.text
    report = resp.json()
    assert report["kind"] == "on_demand" and report["slack"]["status"] == "not_requested"
    assert report["week_start"] == this_monday(datetime.now(UTC)).isoformat()
    (t,) = report["tracks"]
    roadmap = (await client.get(f"/v1/roadmaps/{ROADMAP}/alignment", headers=auth)).json()
    counts = roadmap["counts"]
    assert t["alignment"] == {k: counts[k] for k in ("aligned", "drift", "untracked", "done")}
    overview = (await client.get(f"/v1/tracks/{track['id']}", headers=auth)).json()
    assert t["health"] == overview["health"] and t["headline"] == overview["headline"]
    expected = [(i["item_key"], r["kind"], r["detail"]) for i in overview["at_risk"]
                for r in i["reasons"]]  # fmt: skip
    assert [(n["item_key"], n["kind"], n["detail"]) for n in t["needs_attention"]] == expected
    assert all(n["link"] == f"/plan?item={PRD}:{n['item_key']}" for n in t["needs_attention"])
    assert report["needs_attention_as_of_now"] is True
    assert t["prd"] == {"slug": PRD, "title": overview["prd"]["title"]}
    # Drift both ways: started early (ahead) and tracker work no item names (unplanned).
    assert sorted((d["kind"], d["tracker_ref"] or d["item_key"]) for d in t["drift"]) == [
        ("ahead", "shipping-step"), ("unplanned", "ENG-777")]  # fmt: skip
    assert report["summary"]["tracks"] == 1 and report["summary"]["unplanned"] == 1
    assert report["summary"]["slips"] == sum(
        1 for d in overview["drift"] if d["kind"] in ("date_slip", "overdue")
    )
    assert t["next_milestone"]["name"] == "Beta" and t["next_milestone"]["verified"] is True
    assert report["headline"] == alignment.headline(report["summary"])
    assert report["markdown"].startswith("# Alignment so far · week of ")


async def test_dates_verified_and_withdrawn_in_the_week(client, owner, runtime, at):
    """AC3. protects=the week's date bases (§1 dates); fails_when=a basis outside the period
    is listed, one inside is missing, or a withdrawal has no reason; no_claim=F3 basis rows."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    now = datetime.now(UTC)
    day = (company_today() + timedelta(days=40)).isoformat()
    made = (await client.post(
        "/v1/schedule-bases",
        json={"kind": "estimate", "reference": "ENG-500", "supports_date": day, "prd": PRD},
        headers=auth,
    )).json()  # fmt: skip
    resp = await client.post(
        f"/v1/schedule-bases/{made['id']}/withdraw",
        json={"reason": "Estimate replaced"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    # A basis verified last week (its audit event moved back): not in this week's report.
    async with tenant_session(tenant_id) as db:
        await db.execute(
            update(AuditEvent)
            .where(AuditEvent.action == "schedule_basis.verified",
                   AuditEvent.data["reference"].astext == "ENG-412")
            .values(created_at=now - timedelta(days=8))
        )  # fmt: skip
        await db.commit()
    # The week that just ended holds every event of this week: build it as the ticker would.
    week = this_monday(now) + timedelta(days=7)
    at(alignment.scheduled_moment(week, alignment.ReportSettings(timezone="America/Los_Angeles")))
    (report,) = await due(tenant_id)
    assert report.week_start == this_monday(now)
    (t,) = report.content["tracks"]
    assert t["dates"]["verified"] == [{"reference": "ENG-500", "supports_date": day}]
    assert t["dates"]["withdrawn"] == [
        {"reference": "ENG-500", "supports_date": day, "reason": "Estimate replaced"}
    ]
    assert report.content["summary"]["dates_verified"] == 1
    assert report.content["summary"]["dates_withdrawn"] == 1
    assert "Estimate replaced" in report.markdown


async def test_health_a_week_ago_comes_from_monitoring(client, owner, runtime, at):
    """protects='At risk, was On track'; fails_when=health_before is not the health the
    monitor recorded before the week's change; no_claim=the monitor's own rules."""
    tenant_id, auth = owner
    await approved_prd(client, auth)
    await built_roadmap(client, auth, runtime)
    (track,) = (await client.get("/v1/tracks", headers=auth)).json()
    assert (await client.post(f"/v1/tracks/{track['id']}/monitor", headers=auth)).status_code == 200
    resp = await client.post(
        "/v1/tracker/records",
        json={"tracker": "jira", "records": [
            {"external_ref": "ENG-412", "state": "in_progress", "target_date": "2026-12-20",
             "track_id": track["id"], "item_key": "payment-step"}]},
        headers=auth,
    )  # fmt: skip
    assert resp.status_code == 200
    assert (await client.post(f"/v1/tracks/{track['id']}/monitor", headers=auth)).status_code == 200
    report = (await client.post("/v1/alignment-reports", json={}, headers=auth)).json()
    (t,) = report["tracks"]
    assert (t["health_before"], t["health"]) == ("on_track", "off_track")
    assert "## " + t["prd"]["title"] + " · Off track, was On track" in report["markdown"]


# --------------------------------------------------------------------------- slack


async def test_install_channel_and_weekly_post(client, owner, runtime, at, slack):
    """AC5, AC15 (API side). protects=Oracle's Slack app installed once and the weekly post;
    fails_when=the install asks other scopes, the post goes elsewhere, has more than 5 item
    lines, no link, or slack_ts is not Slack's ts; no_claim=the real Slack API."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    resp = await client.get("/v1/company-integrations/slack/install", headers=auth)
    url = urlparse(resp.json()["url"])
    assert f"{url.scheme}://{url.netloc}{url.path}" == "https://slack.com/oauth/v2/authorize"
    query = parse_qs(url.query)
    assert query["scope"] == [",".join(slack_oauth.BOT_SCOPES)]
    assert query["client_id"] == ["slack-client"]
    assert query["redirect_uri"] == [
        "https://oracle.example.com/v1/company-integrations/slack/callback"
    ]
    row = await install(client, auth)
    assert (row["provider"], row["purpose"], row["account_label"]) == (
        "slack",
        "notifications",
        "Example Co",
    )
    assert row["status"] == "active" and {"chat:write", "groups:read"} <= set(row["scopes"])
    (exchange,) = slack.of("oauth.v2.access")
    assert exchange["code"] == "code-1" and exchange["client_secret"] == "slack-secret"

    channels = (await client.get("/v1/company-integrations/slack/channels", headers=auth)).json()
    # A private channel the bot was invited to is listed too (groups:read).
    assert [(c["name"], c["is_private"]) for c in channels] == [
        ("eng", False),
        ("leads", True),
        ("plan", False),
    ]
    (listed,) = slack.of("conversations.list")
    assert listed["types"] == "public_channel,private_channel"
    resp = await client.post(
        "/v1/company-integrations/slack/test", json={"channel_id": "C0PLAN"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    (test_post,) = slack.of("chat.postMessage")
    assert test_post["channel"] == "C0PLAN"
    assert test_post["text"] == "Product Oracle will post the weekly alignment report here."

    await set_report(client, auth, slack_channel=CHANNEL)
    at(la(2026, 10, 26, 8))
    (report,) = await due(tenant_id)
    assert report.slack_status == "posted" and report.slack_ts == "1761490812.000100"
    assert report.slack_channel_id == "C0PLAN" and report.slack_attempts == 1
    post = slack.of("chat.postMessage")[-1]
    assert post["channel"] == "C0PLAN"
    lines = post["text"].splitlines()
    assert lines[0] == "*Weekly alignment · week of Oct 19*"
    assert len([line for line in lines if line.startswith("• ")]) <= 5
    assert lines[-1] == (
        f"<https://oracle.example.com/plan/reports/{report.id}|Open the report in Oracle>"
    )
    headers = next(h for m, _, h in slack.calls if m == "chat.postMessage")
    assert headers["authorization"] == f"Bearer {TOKEN}"
    out = (await client.get(f"/v1/alignment-reports/{report.id}", headers=auth)).json()
    assert out["slack"]["status"] == "posted" and out["slack"]["channel"] == CHANNEL
    assert out["slack"]["posted_at"] is not None and out["slack"]["error"] is None
    async with tenant_session(tenant_id) as db:
        posted = await db.scalar(
            select(AuditEvent).where(AuditEvent.action == "alignment_report.posted")
        )
        assert posted is not None and posted.data["channel_id"] == "C0PLAN"


async def test_the_test_message_needs_a_slack_channel_id(client, owner, slack):
    """protects=the test message posts to a channel only, like the saved setting;
    fails_when=a person's id, a channel name or junk reaches chat.postMessage;
    no_claim=Slack's own checks."""
    tenant_id, auth = owner
    await install(client, auth)
    for bad in ("U0SOMEONE", "#plan", "plan", "C0", "c0plan", "C0PLAN\n"):
        resp = await client.post(
            "/v1/company-integrations/slack/test", json={"channel_id": bad}, headers=auth
        )
        assert resp.status_code == 422, (bad, resp.text)
    assert slack.of("chat.postMessage") == []
    resp = await client.post(
        "/v1/company-integrations/slack/test", json={"channel_id": "G0LEADS"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    assert [p["channel"] for p in slack.of("chat.postMessage")] == ["G0LEADS"]


async def test_a_second_install_is_refused(client, owner, slack):
    """AC8 (second half). protects=one Oracle Slack install per company ('Slack poster');
    fails_when=a second Connect starts, or a racing callback replaces the first install;
    no_claim=G8's scopes."""
    tenant_id, auth = owner
    first = await install(client, auth)
    resp = await client.get("/v1/company-integrations/slack/install", headers=auth)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "Slack is already connected; disconnect it first"
    # A callback that races past the check: refused, its new token revoked, the first kept.
    state = oauth.encode_state(oauth.State(
        tenant_id=tenant_id, user_id=uuid.UUID(first["installed_by"]),
        provider="slack-notifications", verifier="-",
    ))  # fmt: skip
    slack.answers["oauth.v2.access"] = [httpx.Response(200, json={
        "ok": True, "access_token": "xoxb-second", "scope": "chat:write",
        "team": {"id": "T0OTHER", "name": "Other"}})]  # fmt: skip
    resp = await client.get(
        "/v1/company-integrations/slack/callback",
        params={"state": state, "code": "c2"},
        headers=auth,
    )
    assert resp.status_code == 303
    assert "error=" in resp.headers["location"] and "already" in resp.headers["location"]
    assert (await client.get("/v1/company-integrations", headers=auth)).json() == [first]
    assert slack.calls[-1][0] == "auth.revoke"
    assert slack.calls[-1][2]["authorization"] == "Bearer xoxb-second"


async def test_slack_failures_retry_then_fail_into_the_inbox(
    client,
    owner,
    runtime,
    at,
    slack,
):
    """AC6. protects=delivery with backoff for 24 hours, then the owners' Inbox; fails_when=a
    500 is not retried on schedule, the status never becomes failed, no report_failures row,
    or Retry does not post; no_claim=Slack's own retry semantics."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    await install(client, auth)
    await set_report(client, auth, slack_channel=CHANNEL)
    built = at(la(2026, 10, 26, 8))
    slack.answers["chat.postMessage"] = [httpx.Response(500, text="oops")] * 40
    (report,) = await due(tenant_id)
    assert report.slack_status == "pending" and report.slack_attempts == 1
    assert report.slack_next_attempt_at == built + timedelta(minutes=1)
    assert report.slack_error
    # Not before the next attempt time.
    at(built + timedelta(seconds=30))
    (report,) = await due(tenant_id)
    assert report.slack_attempts == 1
    at(built + timedelta(minutes=1))
    (report,) = await due(tenant_id)
    assert report.slack_attempts == 2
    assert report.slack_next_attempt_at == built + timedelta(minutes=6)
    # Slack's ratelimited answer waits for Retry-After.
    slack.answers["chat.postMessage"].insert(
        0,
        httpx.Response(
            429, headers={"Retry-After": "120"}, json={"ok": False, "error": "ratelimited"}
        ),
    )
    at(built + timedelta(minutes=6))
    (report,) = await due(tenant_id)
    assert report.slack_attempts == 3 and report.slack_error == "ratelimited"
    assert report.slack_next_attempt_at == built + timedelta(minutes=8)
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["report_failures"] == []
    # 24 hours of failures: failed, and the owners' Inbox shows it.
    at(built + timedelta(hours=24, minutes=1))
    (report,) = await due(tenant_id)
    assert report.slack_status == "failed"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (failure,) = inbox["report_failures"]
    assert failure["id"] == str(report.id) and failure["error"]
    assert failure["title"] == "Report not posted to Slack · week of Oct 19"
    total_before = inbox["total"]
    viewer = await as_user(tenant_id, "viewer")
    assert (await client.get("/v1/inbox", headers=viewer)).json()["report_failures"] == []
    # No more automatic attempts.
    at(built + timedelta(hours=30))
    (report,) = await due(tenant_id)
    assert report.slack_status == "failed"
    async with tenant_session(tenant_id) as db:
        failed = await db.scalar(
            select(AuditEvent).where(AuditEvent.action == "alignment_report.post_failed")
        )
        assert failed is not None
    # Retry (owners) posts again.
    assert (
        await client.post(f"/v1/alignment-reports/{report.id}/slack/retry", headers=viewer)
    ).status_code == 403
    slack.answers["chat.postMessage"] = []
    resp = await client.post(f"/v1/alignment-reports/{report.id}/slack/retry", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["slack"]["status"] == "posted"
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["report_failures"] == [] and inbox["total"] == total_before - 1


async def test_a_failure_can_be_dismissed(client, owner, runtime, at, slack):
    """protects=Dismiss on 'Report not posted to Slack'; fails_when=the row stays after a
    dismissal or a viewer can dismiss; no_claim=Retry."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    await install(client, auth)
    await set_report(client, auth, slack_channel=CHANNEL)
    built = at(la(2026, 10, 26, 8))
    slack.answers["chat.postMessage"] = [
        httpx.Response(200, json={"ok": False, "error": "not_in_channel"})
    ] * 40
    await due(tenant_id)
    at(built + timedelta(hours=25))
    (report,) = await due(tenant_id)
    assert report.slack_status == "failed" and report.slack_error == "not_in_channel"
    viewer = await as_user(tenant_id, "viewer")
    path = f"/v1/alignment-reports/{report.id}/slack/dismiss"
    assert (await client.post(path, headers=viewer)).status_code == 403
    assert (await client.post(path, headers=auth)).status_code == 200
    assert (await client.get("/v1/inbox", headers=auth)).json()["report_failures"] == []


async def test_retry_after_disconnect_says_slack_is_not_connected(
    client, owner, runtime, at, slack
):
    """protects=an honest Retry; fails_when=retrying a failed post after Disconnect quietly
    turns it into 'not configured' (out of the Inbox) instead of saying Slack is not
    connected; no_claim=the ticker's own attempts."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    row = await install(client, auth)
    await set_report(client, auth, slack_channel=CHANNEL)
    built = at(la(2026, 10, 26, 8))
    slack.answers["chat.postMessage"] = [
        httpx.Response(200, json={"ok": False, "error": "not_in_channel"})
    ] * 40
    await due(tenant_id)
    at(built + timedelta(hours=25))
    (report,) = await due(tenant_id)
    assert report.slack_status == "failed"
    assert (
        await client.delete(f"/v1/company-integrations/{row['id']}", headers=auth)
    ).status_code == 204
    resp = await client.post(f"/v1/alignment-reports/{report.id}/slack/retry", headers=auth)
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"] == (
        "Slack is not connected for notifications: connect it in Settings › Notifications, "
        "then retry"
    )
    (report,) = await reports_of(tenant_id)
    assert report.slack_status == "failed" and report.slack_error == "not_in_channel"
    (failure,) = (await client.get("/v1/inbox", headers=auth)).json()["report_failures"]
    assert failure["id"] == str(report.id)


async def test_the_bot_token_never_leaves_oracle(
    client,
    owner,
    runtime,
    at,
    slack,
    caplog,
):
    """AC7. protects=the company credential; fails_when=the bot token appears in any response,
    log line or audit event; no_claim=encryption strength (oracle.crypto)."""
    caplog.set_level(logging.DEBUG)
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    seen: list[str] = []

    async def call(method, url, **kw):
        resp = await client.request(method, url, headers=auth, **kw)
        seen.append(resp.text + json.dumps(dict(resp.headers)))
        return resp

    resp = await call("GET", "/v1/company-integrations/slack/install")
    state = parse_qs(urlparse(resp.json()["url"]).query)["state"][0]
    await call(
        "GET", "/v1/company-integrations/slack/callback", params={"state": state, "code": "c"}
    )
    await call("GET", "/v1/company-integrations")
    await call("GET", "/v1/company-integrations/slack/channels")
    await call("POST", "/v1/company-integrations/slack/test", json={"channel_id": "C0PLAN"})
    await call("PUT", SETTING, json={"value": {"slack_channel": CHANNEL}})
    slack.answers["chat.postMessage"] = [httpx.Response(500, text="oops")]
    created = await call("POST", "/v1/alignment-reports", json={"post_to_slack": True})
    rid = created.json()["id"]
    await call("POST", f"/v1/alignment-reports/{rid}/slack/retry")
    await call("GET", f"/v1/alignment-reports/{rid}")
    await call("GET", "/v1/alignment-reports")
    await call("GET", "/v1/inbox")
    await call("GET", "/v1/settings")
    (row,) = (await client.get("/v1/company-integrations", headers=auth)).json()
    await call("DELETE", f"/v1/company-integrations/{row['id']}")
    assert slack.of("auth.revoke")  # the token was used, so it existed in Oracle
    assert all(TOKEN not in text for text in seen)
    assert TOKEN not in caplog.text
    async with tenant_session(tenant_id) as db:
        events = list(await db.scalars(select(AuditEvent)))
    assert events and all(TOKEN not in json.dumps(e.data) for e in events)
    assert {"company_integration.installed", "company_integration.removed"} <= {
        e.action for e in events
    }


async def test_disconnect_revokes_and_stops_the_posts(client, owner, runtime, at, slack):
    """AC8. protects=S5b Disconnect revokes (G8 criterion 9: the row is kept ``revoked``,
    without its token); fails_when=auth.revoke is not called, the token stays, or the next
    report still posts; no_claim=per-person Slack connections."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    row = await install(client, auth)
    await set_report(client, auth, slack_channel=CHANNEL)
    commenter = await as_user(tenant_id, "commenter")
    path = f"/v1/company-integrations/{row['id']}"
    assert (await client.delete(path, headers=commenter)).status_code == 403
    assert (await client.delete(path, headers=await other_company())).status_code == 404
    assert (await client.delete(path, headers=auth)).status_code == 204
    (revoke,) = [h for m, _, h in slack.calls if m == "auth.revoke"]
    assert revoke["authorization"] == f"Bearer {TOKEN}"
    assert (await client.get("/v1/company-integrations", headers=auth)).json() == []
    async with tenant_session(tenant_id) as db:
        kept = await db.scalar(select(CompanyIntegration))
        assert kept is not None and kept.status == "revoked" and not kept.ciphertext
    # The channel goes with the install.
    assert (await client.get(SETTING, headers=auth)).json()["value"]["slack_channel"] is None
    at(la(2026, 10, 26, 8))
    (report,) = await due(tenant_id)
    assert report.slack_status == "not_configured"
    assert slack.of("chat.postMessage") == []
    # Slack failing to revoke does not keep Oracle's copy.
    row = await install(client, auth)
    slack.answers["auth.revoke"] = [httpx.Response(503)]
    assert (
        await client.delete(f"/v1/company-integrations/{row['id']}", headers=auth)
    ).status_code == 204
    assert (await client.get("/v1/company-integrations", headers=auth)).json() == []
    async with tenant_session(tenant_id) as db:
        kept = await db.scalar(select(CompanyIntegration))
        assert kept is not None and kept.status == "revoked" and not kept.ciphertext


async def test_generate_now_posts_only_when_asked(client, owner, runtime, slack):
    """AC16 (API side). protects=Generate now; fails_when=an on-demand report posts without
    'Post to Slack', or does not post with it; no_claim=the weekly schedule."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    await install(client, auth)
    await set_report(client, auth, slack_channel=CHANNEL)
    quiet = (
        await client.post("/v1/alignment-reports", json={"post_to_slack": False}, headers=auth)
    ).json()
    assert quiet["slack"]["status"] == "not_requested" and slack.of("chat.postMessage") == []
    loud = (
        await client.post("/v1/alignment-reports", json={"post_to_slack": True}, headers=auth)
    ).json()
    assert loud["slack"]["status"] == "posted"
    (post,) = slack.of("chat.postMessage")
    assert post["text"].startswith("*Alignment so far · week of ")
    listed = (await client.get("/v1/alignment-reports", headers=auth)).json()
    assert [r["id"] for r in listed] == [loud["id"], quiet["id"]]
    assert (await client.get("/v1/alignment-reports?limit=1&offset=1", headers=auth)).json()[0][
        "id"
    ] == quiet["id"]


async def test_generate_now_without_tracks_or_install(client, owner, runtime):
    """protects=honest refusals; fails_when=an empty report is made, or Post to Slack without
    an install claims it posted; no_claim=Slack delivery."""
    tenant_id, auth = owner
    resp = await client.post("/v1/alignment-reports", json={}, headers=auth)
    assert resp.status_code == 409 and "no active or paused track" in resp.json()["detail"]
    await a_track(client, auth, runtime)
    resp = await client.post("/v1/alignment-reports", json={"post_to_slack": True}, headers=auth)
    assert resp.status_code == 201 and resp.json()["slack"]["status"] == "not_configured"
    resp = await client.get("/v1/company-integrations/slack/channels", headers=auth)
    assert resp.status_code == 409


# --------------------------------------------------------------------------- inbox, rights


async def test_owners_inbox_lists_the_unread_report(client, owner, runtime, at):
    """AC9. protects=the Inbox's Report row (C1e states); fails_when=the unread report is not
    listed or not counted, a read by one owner moves it for another, or a viewer gets the
    row; no_claim=the web Inbox."""
    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    before = (await client.get("/v1/inbox", headers=auth)).json()["total"]
    at(la(2026, 10, 26, 8))
    (report,) = await due(tenant_id)
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    (row,) = inbox["reports"]
    assert row["id"] == str(report.id) and row["week_start"] == "2026-10-19"
    assert row["read"] is False and row["title"] == "Weekly alignment · week of Oct 19"
    assert row["summary"]["tracks"] == 1
    # The Weekly goals check-in's pre-read (H2) falls due in the same week.
    rituals = sum(r["counts"] for r in inbox["rituals"])
    assert inbox["total"] == before + 1 + rituals
    second_owner = await as_user(tenant_id, "owner")
    viewer = await as_user(tenant_id, "viewer")
    assert (await client.get("/v1/inbox", headers=viewer)).json()["reports"] == []
    # The viewer reads the report in Oracle all the same.
    assert (
        await client.get(f"/v1/alignment-reports/{report.id}", headers=viewer)
    ).status_code == 200

    resp = await client.post(f"/v1/alignment-reports/{report.id}/read", headers=auth)
    assert resp.status_code == 200 and resp.json()["read"] is True
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    assert inbox["reports"][0]["read"] is True and inbox["total"] == before + rituals
    other = (await client.get("/v1/inbox", headers=second_owner)).json()
    assert other["reports"][0]["read"] is False
    assert (await client.get(f"/v1/alignment-reports/{report.id}", headers=second_owner)).json()[
        "read"
    ] is False
    # Reading twice is fine.
    assert (
        await client.post(f"/v1/alignment-reports/{report.id}/read", headers=auth)
    ).status_code == 200


async def test_rights_and_company_scope(client, owner, runtime, slack):
    """AC10. protects=roles, company scope and run tokens; fails_when=a commenter generates,
    another company sees a report, or a run token reads one; no_claim=MCP tool listing."""
    company, auth = owner
    await a_track(client, auth, runtime)
    report = (await client.post("/v1/alignment-reports", json={}, headers=auth)).json()
    commenter = await as_user(company, "commenter")
    viewer = await as_user(company, "viewer")
    assert (
        await client.post("/v1/alignment-reports", json={}, headers=commenter)
    ).status_code == 403
    assert (await client.get("/v1/alignment-reports", headers=viewer)).status_code == 200
    assert (
        await client.post(f"/v1/alignment-reports/{report['id']}/read", headers=viewer)
    ).status_code == 200
    # G8: the channel list is open to commenters (mirroring a discussion).
    for path in ("/v1/company-integrations", "/v1/company-integrations/slack/install"):
        assert (await client.get(path, headers=commenter)).status_code == 403, path
    other = await other_company()
    rid = report["id"]
    for method, path in (("GET", f"/v1/alignment-reports/{rid}"),
                         ("POST", f"/v1/alignment-reports/{rid}/read"),
                         ("POST", f"/v1/alignment-reports/{rid}/slack/retry"),
                         ("POST", f"/v1/alignment-reports/{rid}/slack/dismiss"),
                         ("GET", f"/v1/alignment-reports/{uuid.uuid4()}")):  # fmt: skip
        assert (await client.request(method, path, headers=other)).status_code == 404, path
    assert (await client.get("/v1/alignment-reports", headers=other)).json() == []
    # Run tokens: the areas are in no read scope, so every route is refused to them.
    for method, path in (("GET", "/v1/alignment-reports"), ("GET", "/v1/alignment-reports/{id}"),
                         ("POST", "/v1/alignment-reports"),
                         ("GET", "/v1/company-integrations")):  # fmt: skip
        assert required_scope(method, path) is None
    from tests.test_mcp import user_with_role

    pm = await user_with_role(company, "owner", email="pm-runs@example.com")
    token = await run_token(company, ["read:documents", "read:baseline", "read:sources"], pm.id)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert names.isdisjoint({"list_alignment_reports", "get_alignment_report"})
        refused = await c.call_tool("get_alignment_report", {"report_id": rid})
        assert refused.is_error and "not available to run tokens" in text_of(refused)


async def test_callback_refusals(client, owner, slack):
    """protects=the OAuth callback; fails_when=a forged state, another person's state, a
    non-owner or Slack's error installs anything; no_claim=Slack's consent screen."""
    tenant_id, auth = owner
    base = "/v1/company-integrations/slack/callback"
    resp = await client.get(base, params={"state": "forged", "code": "c"}, headers=auth)
    assert resp.status_code == 303 and "error=" in resp.headers["location"]
    state = parse_qs(urlparse(
        (await client.get("/v1/company-integrations/slack/install", headers=auth)).json()["url"]
    ).query)["state"][0]  # fmt: skip
    other_owner = await as_user(tenant_id, "owner")
    resp = await client.get(base, params={"state": state, "code": "c"}, headers=other_owner)
    assert "error=" in resp.headers["location"]
    resp = await client.get(base, params={"state": state, "error": "access_denied"}, headers=auth)
    assert "error=access_denied" in resp.headers["location"]
    assert (await client.get("/v1/company-integrations", headers=auth)).json() == []
    assert slack.of("oauth.v2.access") == []


async def test_a_track_that_cannot_be_read_does_not_stop_the_report(
    client, owner, runtime, at, monkeypatch
):
    """protects=the weekly report per company; fails_when=one track whose overview raises
    stops the report for every other track, or is dropped without a word; no_claim=why it
    raised (monitoring logs and counts it too)."""
    from oracle.docs.models import Document
    from oracle.roadmap import views

    tenant_id, auth = owner
    await a_track(client, auth, runtime)
    async with tenant_session(tenant_id) as s:
        other = Document(slug="billing-prd", title="Billing PRD", kind="prd", status="draft")
        s.add(other)
        await s.flush()
        bad = ProductTrack(prd_document_id=other.id, title="Billing")
        s.add(bad)
        await s.commit()
        bad_id = bad.id
    real = views.overview

    async def overview(db, track):
        if track.id == bad_id:
            raise RuntimeError("boom")
        return await real(db, track)

    monkeypatch.setattr(views, "overview", overview)
    at(la(2026, 10, 26, 8))
    (report,) = await due(tenant_id)
    assert [t["prd"]["slug"] for t in report.content["tracks"]] == [PRD]
    assert report.content["unreadable_tracks"] == [{"track_id": str(bad_id), "title": "Billing"}]
    assert "could not read 1 track(s) this time: Billing" in report.markdown


async def _report_occurrence(tenant_id) -> RitualOccurrence:
    ritual = await report_ritual(tenant_id)
    async with tenant_session(tenant_id) as db:
        (occ,) = await db.scalars(
            select(RitualOccurrence).where(RitualOccurrence.ritual_id == ritual.id)
        )
        return occ


async def _summary_runs(tenant_id) -> list:
    from oracle.runs.models import Run

    async with tenant_session(tenant_id) as db:
        return list(await db.scalars(select(Run.id).where(Run.flow == "ritual_summary")))


async def test_failing_catch_ups_keep_the_ready_pre_read(client, owner, runtime, at, monkeypatch):
    """protects=H2 review (minor): F6's catch-up rebuilds an occurrence that is already
    ready; when the rebuild fails, however often, the occurrence stays ready with the
    pre-read it has; fails_when=three failed catch-ups turn a ready occurrence into
    failed (an owners' Inbox row for a pre-read people can read); no_claim=the first
    build's retries (test_rituals_ticker)."""
    from oracle.rituals import blocks

    tenant_id, auth = owner
    at(la(2026, 10, 26, 9))
    assert await due(tenant_id) == []
    built = await _report_occurrence(tenant_id)
    assert built.status == "ready"
    await a_track(client, auth, runtime)

    async def broken(*args, **kwargs):
        raise RuntimeError("report unavailable")

    monkeypatch.setitem(blocks.BUILDERS, "alignment_report", broken)
    for _ in range(rituals.MAX_ATTEMPTS + 1):
        await due(tenant_id)
    occ = await _report_occurrence(tenant_id)
    assert occ.status == "ready"
    assert occ.pre_read == built.pre_read and occ.attempts == 0


async def test_a_catch_up_rebuild_restarts_the_summary(client, owner, runtime, at):
    """protects=H2 review (minor): with Every pre-read, the catch-up that rebuilds this
    week's pre-read (now with the week's report) starts a new summary of it, and the
    summary of the empty pre-read is gone; fails_when=the occurrence keeps the summary
    of the pre-read it no longer has; no_claim=the run's content."""
    tenant_id, auth = owner
    resp = await client.put("/v1/rituals/summaries", json={"mode": "always"}, headers=auth)
    assert resp.status_code == 200, resp.text
    at(la(2026, 10, 26, 9))
    assert await due(tenant_id) == []
    first = await _report_occurrence(tenant_id)
    assert first.status == "ready" and first.summary_run_id is not None
    await a_track(client, auth, runtime)
    (report,) = await due(tenant_id)
    occ = await _report_occurrence(tenant_id)
    assert occ.pre_read["blocks"][0]["rows"][0]["report_id"] == str(report.id)
    assert occ.summary_run_id not in (None, first.summary_run_id)
    assert occ.summary_state == "running"
    assert len(await _summary_runs(tenant_id)) == 2
