"""#1572: a Redo's note never reads "about $0": with the segment's estimate unknown it says
"one more segment" and no amount; a known estimate still reads ", about $N"."""

import uuid

import pytest
from sqlalchemy import update

from oracle.runs.models import RunSegment
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.test_adapter_v2 import _at_baseline, _decide_raw, _member, on
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_runs import get, tick

settings = _v2_settings


@pytest.fixture
async def owner():
    return await seed_auth()


async def _no_estimate(tenant_id, run: dict) -> None:
    async with tenant_session(tenant_id) as s:
        await s.execute(
            update(RunSegment)
            .where(RunSegment.run_id == uuid.UUID(run["id"]))
            .values(estimate_usd=None)
        )
        await s.commit()


def _redo_notes(run: dict) -> list[str]:
    return [n for n in run["notes"] if "one more segment" in n]


async def _console_not_yet(client, auth, tenant_id, unknown: bool) -> dict:
    swarm = on()
    await _member(tenant_id, "lead@example.com")
    run = await _at_baseline(client, auth, swarm)
    if unknown:
        await _no_estimate(tenant_id, run)
    swarm.console_answer(
        "wf_1", "baseline-review1", "NOT_YET", ["Missing goal"], by="lead@example.com"
    )
    await tick(client, auth)
    return await get(client, auth, run["id"])


async def test_an_unknown_estimate_leaves_the_amount_out_of_the_redo_notes(client, owner):
    tenant_id, auth = owner
    run = await _console_not_yet(client, auth, tenant_id, unknown=True)
    [console] = _redo_notes(run)
    assert "(a new workflow: one more segment) or Continue." in console
    assert "about $" not in console

    resp = await _decide_raw(client, auth, run, "redo")
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    redo = [n for n in _redo_notes(run) if "chose Redo" in n]
    assert len(redo) == 1 and redo[0].endswith("(one more segment).")
    assert all("about $" not in n for n in run["notes"])


async def test_a_known_estimate_still_reads_about_n(client, owner):
    tenant_id, auth = owner
    run = await _console_not_yet(client, auth, tenant_id, unknown=False)
    [console] = _redo_notes(run)
    assert "one more segment, about $" in console and "about $0)" not in console

    resp = await _decide_raw(client, auth, run, "redo")
    assert resp.status_code == 200, resp.text
    run = await get(client, auth, run["id"])
    [redo] = [n for n in _redo_notes(run) if "chose Redo" in n]
    assert "(one more segment, about $" in redo and "about $0)" not in redo
