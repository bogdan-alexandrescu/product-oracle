"""B5 dated goal measurements: record, order, delete, same day, roles."""

from datetime import UTC, date, datetime, timedelta

import pytest

from oracle import company_time
from oracle.baseline import goals
from tests.baseline_helpers import entity, make_ctx

B = "/v1/baseline"


@pytest.fixture
async def ctx():
    return await make_ctx()


def _today() -> date:
    """The company's day (no time zone set: Pacific), as the API dates a measurement; the
    process's own date is a day ahead in UTC from 5 PM Pacific."""
    return company_time.day(datetime.now(UTC))


async def _goal(client, ctx, **attrs) -> dict:
    attrs = {"metric": "Setups", "unit": "%", "comparison": "at_least", "target": 45, **attrs}
    return await entity(client, ctx, type="goal", key="activation", attrs=attrs)


async def _record(client, ctx, goal, value, day, who="approver", **body):
    return await client.post(
        f"{B}/entities/{goal['id']}/measurements",
        json={"value": value, "measured_on": day.isoformat(), **body},
        headers=ctx.as_(who),
    )


async def _attrs(client, ctx, goal) -> dict:
    return (await client.get(f"{B}/entities/{goal['id']}", headers=ctx.as_("viewer"))).json()[
        "attrs"
    ]


# protects=criterion 6: the latest by date is the goal's current; an older date does not
# move it; deleting the latest rolls back; fails_when=current follows the last write rather
# than the latest day; no_claim=Home's trend.
async def test_record_updates_current_to_latest_by_date(client, ctx):
    goal = await _goal(client, ctx)
    today = _today()
    resp = await _record(client, ctx, goal, 38, today - timedelta(days=5), note="October export")
    assert resp.status_code == 201, resp.text
    row = resp.json()
    assert row["value"] == 38 and row["note"] == "October export"
    assert row["recorded_by"] == str(ctx.users["approver"].id)
    attrs = await _attrs(client, ctx, goal)
    assert (attrs["current"], attrs["current_as_of"]) == (
        38,
        (today - timedelta(days=5)).isoformat(),
    )
    await _record(client, ctx, goal, 33, today - timedelta(days=30))
    assert (await _attrs(client, ctx, goal))["current"] == 38
    latest = (await _record(client, ctx, goal, 40, today)).json()
    assert (await _attrs(client, ctx, goal))["current"] == 40
    listed = (
        await client.get(f"{B}/entities/{goal['id']}/measurements", headers=ctx.as_("viewer"))
    ).json()
    assert [m["value"] for m in listed] == [40, 38, 33]
    resp = await client.delete(f"{B}/measurements/{latest['id']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204
    attrs = await _attrs(client, ctx, goal)
    assert (attrs["current"], attrs["current_as_of"]) == (
        38,
        (today - timedelta(days=5)).isoformat(),
    )
    revs = (
        await client.get(f"{B}/entities/{goal['id']}/revisions", headers=ctx.as_("viewer"))
    ).json()
    assert len(revs) >= 4


# protects=one row per goal per day; fails_when=a second same-day value adds a row;
# no_claim=notes.
async def test_same_day_replaces(client, ctx):
    goal = await _goal(client, ctx)
    today = _today()
    await _record(client, ctx, goal, 38, today)
    await _record(client, ctx, goal, 39, today)
    listed = (
        await client.get(f"{B}/entities/{goal['id']}/measurements", headers=ctx.as_("viewer"))
    ).json()
    assert [m["value"] for m in listed] == [39]
    assert (await _attrs(client, ctx, goal))["current"] == 39


# protects=approvers and owners record, everyone reads; fails_when=a commenter records or
# deletes; no_claim=API tokens.
async def test_roles(client, ctx):
    goal = await _goal(client, ctx)
    assert (await _record(client, ctx, goal, 38, _today(), who="commenter")).status_code == 403
    row = (await _record(client, ctx, goal, 38, _today(), who="owner")).json()
    resp = await client.delete(f"{B}/measurements/{row['id']}", headers=ctx.as_("commenter"))
    assert resp.status_code == 403
    resp = await client.get(f"{B}/entities/{goal['id']}/measurements", headers=ctx.as_("viewer"))
    assert resp.status_code == 200


# protects=422 when the entity is not a goal, the goal has no unit yet, or the date is in
# the future; fails_when=any of those records; no_claim=evidence links.
async def test_refusals(client, ctx):
    today = _today()
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    assert (await _record(client, ctx, feat, 1, today)).status_code == 422
    vague = await entity(client, ctx, type="goal", key="churn", attrs={"metric": "Churn"})
    assert (await _record(client, ctx, vague, 1, today)).status_code == 422
    goal = await _goal(client, ctx)
    assert (await _record(client, ctx, goal, 1, today + timedelta(days=2))).status_code == 422


async def _company_zone(client, ctx, zone: str) -> None:
    resp = await client.put(
        "/v1/settings/company_timezone",
        json={"value": zone},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text


# protects=review finding 2: "today" is the company's day (Company time zone), so
# an Oracle east of UTC records today's value in its morning; with no time zone set, UTC;
# fails_when=today's value is refused as "in the future" before UTC's midnight;
# no_claim=the date picker's default (the UI).
async def test_today_is_the_companys_day(client, ctx, monkeypatch):
    # 09:00 on 21 October in Auckland is still 20 October in UTC.
    monkeypatch.setattr(goals, "now", lambda: datetime(2026, 10, 20, 20, 0, tzinfo=UTC))
    goal = await _goal(client, ctx)
    auckland = date(2026, 10, 21)
    assert (await _record(client, ctx, goal, 38, auckland)).status_code == 422
    await _company_zone(client, ctx, "Pacific/Auckland")
    resp = await _record(client, ctx, goal, 38, auckland)
    assert resp.status_code == 201, resp.text
    assert (await _record(client, ctx, goal, 38, date(2026, 10, 22))).status_code == 422
    resp = await client.patch(
        f"{B}/entities/{goal['id']}",
        json={"attrs": {"current": 39, "current_as_of": "2026-10-21"}},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
