"""B5 review finding (major): a goal's horizons are the company's planning_horizons
setting (Settings › Company), not B2's defaults written into the code. Made-up goals.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import UTC, date, datetime

import pytest

from oracle.baseline import goals
from tests.baseline_helpers import entity, make_ctx

# Now is the current and next quarter; Next the 2 after; Later 18 to 30 months.
WIDE = {"short_quarters": 2, "medium_quarters": 2, "long_from_months": 18, "long_to_months": 30}
ON = date(2026, 10, 15)
GOAL = {"metric": "Setups", "unit": "%", "comparison": "at_least", "target": 45}


@pytest.fixture
async def ctx():
    return await make_ctx()


def test_the_windows_are_the_setting():
    """protects=horizon_window and horizon_of read the horizons they are given (B2's
    defaults without); fails_when=short is always this quarter or long always 12-24
    months; no_claim=the stored setting (below)."""
    assert goals.horizon_window("short", ON) == (date(2026, 10, 1), date(2026, 12, 31))
    assert goals.horizon_window("short", ON, WIDE) == (date(2026, 10, 1), date(2027, 3, 31))
    assert goals.horizon_window("medium", ON, WIDE) == (date(2027, 4, 1), date(2027, 9, 30))
    assert goals.horizon_window("long", ON, WIDE) == (date(2028, 4, 15), date(2029, 4, 15))
    assert goals.horizon_of(date(2027, 3, 31), ON) == "medium"
    assert goals.horizon_of(date(2027, 3, 31), ON, WIDE) == "short"
    assert goals.horizon_of(date(2027, 12, 31), ON, WIDE) == "medium"
    assert goals.horizon_of(date(2028, 6, 30), ON, WIDE) == "long"


def test_goal_check_and_reading_text_use_the_setting():
    """protects=due_outside_horizon and "2027-Q1" read as text follow the horizons;
    fails_when=a due date inside the company's Now warns, or 2027-Q1 reads as medium;
    no_claim=other warnings."""
    attrs = {**GOAL, "horizon": "short", "due": "2027-03-31"}
    assert "due_outside_horizon" in goals.goal_check(attrs, on=ON)["warnings"]
    assert "due_outside_horizon" not in goals.goal_check(attrs, on=ON, horizons=WIDE)["warnings"]
    values, left = goals.read_text({**GOAL, "horizon_text": "2027-Q1"}, on=ON, horizons=WIDE)
    assert left == [] and values["horizon"] == "short"


async def test_the_api_reads_the_stored_horizons(client, ctx, monkeypatch):
    """protects=a goal's goal_check on the API uses Settings › Company horizons;
    fails_when=it warns due_outside_horizon by B2's defaults after an owner widened Now;
    no_claim=the form's tooltip (the Playwright spec)."""
    monkeypatch.setattr(goals, "now", lambda: datetime(2026, 10, 15, 12, tzinfo=UTC))
    goal = await entity(
        client, ctx, type="goal", key="activation",
        attrs={**GOAL, "horizon": "short", "due": "2027-03-31"},
    )  # fmt: skip
    url = f"/v1/baseline/entities/{goal['id']}"
    got = (await client.get(url, headers=ctx.as_("viewer"))).json()
    assert "due_outside_horizon" in got["goal_check"]["warnings"]
    resp = await client.put(
        "/v1/settings/planning_horizons", json={"value": WIDE}, headers=ctx.as_("owner")
    )
    assert resp.status_code == 200, resp.text
    got = (await client.get(url, headers=ctx.as_("viewer"))).json()
    assert "due_outside_horizon" not in got["goal_check"]["warnings"]
    # The form's Horizon tip reads them from here (approvers cannot read Settings).
    assert got["goal_check"]["horizons"] == WIDE
