"""Shared setup for the H5 Metrics review tests: a fake PostHog (an httpx transport, so
no request leaves the process), the clock, and made-up metrics. The real PostHog API's
shape is not exercised here."""

import json
import re
from datetime import UTC, date, datetime, timedelta

import httpx
import pytest

from oracle.metrics import posthog, pull
from tests.baseline_helpers import confirm, entity

# Monday 19 October 2026, 12:00 UTC (05:00 in Los Angeles): the last complete week is the
# week of 12 October.
NOW = datetime(2026, 10, 19, 12, 0, tzinfo=UTC)
LAST_WEEK = date(2026, 10, 12)
KEY = "phx_test_key_0123456789abcdef"
QUERY = (
    "SELECT count(DISTINCT properties.team_id) FROM events "
    "WHERE timestamp >= '{period_start}' AND timestamp < '{period_end}'"
)
_START = re.compile(r">= '([^']+)'")


class FakePostHog:
    """Answers ``POST /api/projects/{id}/query/``: the key check ("SELECT 1") with 1, a
    metric's query with ``values[week_start]`` (by the ``{period_start}`` it carries)."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.values: dict[date, float] = {}
        self.default = 100.0
        self.refuse_key: str | None = None
        self.status = 200
        # Project ids whose queries fail with a 500.
        self.failing: set[str] = set()

    def week_of(self, request: httpx.Request) -> date | None:
        q = json.loads(request.content)["query"]["query"]
        m = _START.search(q)
        return datetime.fromisoformat(m.group(1)).date() if m else None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.refuse_key is not None:
            return httpx.Response(
                401, json={"detail": f"{self.refuse_key} (key {KEY} is not valid)"}
            )
        project = request.url.path.split("/")[3]
        if self.status != 200 or project in self.failing:
            return httpx.Response(self.status if self.status != 200 else 500,
                                  json={"detail": "Query failed upstream"})  # fmt: skip
        week = self.week_of(request)
        value = 1 if week is None else self.values.get(week, self.default)
        return httpx.Response(200, json={"results": [[value]], "columns": ["n"]})

    def queries(self) -> list[str]:
        return [json.loads(r.content)["query"]["query"] for r in self.requests]


@pytest.fixture
def fake_posthog():
    fake = FakePostHog()
    posthog.set_transport(httpx.MockTransport(fake.handler))
    yield fake
    posthog.set_transport(None)


@pytest.fixture
def clock(monkeypatch):
    """The metrics clock, movable: ``clock.at(moment)``."""

    class Clock:
        now = NOW

        def at(self, moment: datetime) -> None:
            self.now = moment

    c = Clock()
    monkeypatch.setattr(pull, "now", lambda: c.now)
    return c


async def connect(client, ctx, host: str = "eu", project_id: str = "12345") -> httpx.Response:
    return await client.put(
        "/v1/company-integrations/analytics",
        json={"provider": "posthog", "host": host, "project_id": project_id, "api_key": KEY},
        headers=ctx.as_("owner"),
    )


async def pct_goal(client, ctx, key: str = "activation") -> dict:
    goal = await entity(
        client, ctx, type="goal", key=key,
        attrs={"metric": "Activated teams", "unit": "%", "comparison": "at_least",
               "target": 45},
    )  # fmt: skip
    await confirm(client, ctx, goal)
    return goal


def body(ctx, **over) -> dict:
    out = {
        "title": "Weekly active teams",
        "description": "Teams with 3+ sessions in the week",
        "kind": "output",
        "unit": "teams",
        "direction": "up",
        "owner_id": str(ctx.users["commenter"].id),
        "source": "manual",
    }
    out.update(over)
    return out


async def create(client, ctx, who: str = "approver", **over) -> httpx.Response:
    return await client.post("/v1/metrics", json=body(ctx, **over), headers=ctx.as_(who))


def weeks_back(n: int, last: date = LAST_WEEK) -> list[date]:
    """The ``n`` weeks up to ``last``, oldest first."""
    return [last - timedelta(weeks=n - 1 - i) for i in range(n)]
