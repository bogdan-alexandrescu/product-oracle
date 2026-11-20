"""#1572: a cost or a duration nobody reported is unknown (null), never 0 ("free"): a run's
spend and a segment's or attempt's cost sum only the known values, and are null when none
is known; a timed-out webhook call's duration is null."""

from decimal import Decimal

import httpx
import pytest

from oracle.runs import service
from oracle.runs.models import Run, RunSegment
from oracle.runs.schemas import SegmentAttempt
from oracle.webhooks import outbox
from tests.fixtures import seed_auth
from tests.test_adapter_v2 import on, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_runs import create, get, started, tick

settings = _v2_settings


@pytest.fixture
async def owner():
    return await seed_auth()


def _running(run: dict) -> dict:
    return next(s for s in run["segments"] if s["status"] == "running")


def test_cost_columns_are_nullable_with_no_zero_default():
    for column in (Run.__table__.c.spent_usd, RunSegment.__table__.c.cost_usd):
        assert column.nullable
        assert column.server_default is None
    assert SegmentAttempt(attempt=1).cost_usd is None


def test_a_sum_counts_only_the_known_costs():
    assert service._known_sum([None, None]) is None
    assert service._known_sum([]) is None
    assert service._known_sum([None, 0.5, "1.25"]) == Decimal("1.75")
    assert service._known_sum([0, None]) == Decimal(0)


async def test_a_run_with_no_cost_reported_has_unknown_spend(client, owner):
    _, auth = owner
    draft = await create(client, auth)
    assert draft["spent_usd"] is None
    listed = (await client.get("/v1/runs", headers=auth)).json()
    rows = listed["items"] if isinstance(listed, dict) else listed
    assert next(r for r in rows if r["id"] == draft["id"])["spent_usd"] is None

    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    first = swarm.workflows["wf_1"].steps[0]
    swarm.forged[first.step_id] = {"state": "RUNNING"}
    await tick(client, auth)
    out = await get(client, auth, run["id"])
    seg = _running(out)
    assert seg["cost_usd"] is None
    assert [a["cost_usd"] for a in seg["attempts"]] == [None]
    assert out["spent_usd"] is None
    assert all(s["cost_usd"] is None for s in out["segments"] if s["status"] == "pending")

    swarm.forged[first.step_id] = {"state": "RUNNING", "cost_usd_total": 0.5}
    await tick(client, auth)
    out = await get(client, auth, run["id"])
    assert _running(out)["cost_usd"] == 0.5
    assert out["spent_usd"] == 0.5


async def test_a_timed_out_call_has_no_duration():
    assert outbox.Answer().duration_ms is None

    def timeout(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
        answer = await outbox.post(client, "https://hooks.example.com/in", b"{}", {})
    assert answer.error == "timeout"
    assert answer.duration_ms is None
