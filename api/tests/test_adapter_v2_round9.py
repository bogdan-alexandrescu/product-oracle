"""Adapter v2 review fixes, round 9: a resumed advance that keeps failing (counted,
stopped at 5, in the Inbox with Retry, the workflow still read meanwhile), shared status
checks share only a read-only answer (W5, owner 2026-10-20), a stuck cancel's cost is
read and not 'unknown' (P3d), Cancel again enforced by the service, the overrun's kind,
the shared HTTP client, and one more read after a 'gone' that follows a confirmed
cancel."""

import uuid

import pytest
from sqlalchemy import select

from oracle.auth.service import create_user, make_session_cookie
from oracle.config import get_settings
from oracle.models import AuditEvent
from oracle.runs import service
from oracle.runs.models import Run, RunSegment
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.fixtures import seed_auth
from tests.test_adapter_v2 import (
    _ceiling,
    _inbox,
    _tick_errors,
    on,
    use,
)
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_adapter_v2_round7 import _wf_cost
from tests.test_runs import as_user, get, started

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings


@pytest.fixture
async def owner():
    return await seed_auth()


async def _audits(tenant_id, action: str) -> list[AuditEvent]:
    async with tenant_session(tenant_id) as s:
        return list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))


async def _segment(tenant_id, run_id: str, seq: int = 1) -> RunSegment:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run_id), RunSegment.seq == seq)
        )


async def _user(tenant_id, role: str) -> tuple[uuid.UUID, dict[str, str]]:
    """A member of ``role`` and their session cookie."""
    async with tenant_session(tenant_id) as s:
        user = await create_user(s, f"{role}-{uuid.uuid4().hex[:6]}@example.com", "pw")
        user.role = role
        await s.commit()
    return user.id, {"Cookie": f"{get_settings().session_cookie_name}={make_session_cookie(user)}"}


async def _created_by(tenant_id, run_id: str, user_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run_id))
        row.created_by = user_id
        await s.commit()


async def _other_tenant_owner() -> dict[str, str]:
    return await as_user(await make_tenant("Other Co"), "owner")


# --------------------------------------------------------------------------- item 1


class _ImportFails:
    """baseline.yaml's import raises every time (an error none of the import's own
    refusals covers), with agent content in its message."""

    def __init__(self, monkeypatch) -> None:
        self.calls = 0
        self.real = service._import_baseline
        self.failing = True
        monkeypatch.setattr(service, "_import_baseline", self)

    async def __call__(self, db, run, text):
        self.calls += 1
        if self.failing:
            raise ValueError("agent wrote: secret-agent-content-77")
        return await self.real(db, run, text)


async def _interrupted(client, auth, monkeypatch, swarm) -> tuple[dict, _ImportFails]:
    """A run whose advance raised in its import after the first commit."""
    use(swarm)
    run = await started(client, auth)
    fails = _ImportFails(monkeypatch)
    assert await _tick_errors(client, auth)
    assert fails.calls == 1
    return run, fails


async def test_a_resume_that_keeps_failing_stops_at_five_and_still_reads_the_workflow(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for n in range(1, service.RESUME_TRIES + 1):
        swarm.workflows["wf_1"].steps[0].cost += 1.0  # spent meanwhile
        errors = await _tick_errors(client, auth)
        assert errors and all("secret-agent-content" not in e for e in errors), errors
        assert fails.calls == 1 + n
        got = await get(client, auth, run["id"])
        assert got["spent_usd"] == pytest.approx(_wf_cost(swarm, "wf_1")), n
        seg = await _segment(tenant_id, run["id"])
        attempt = seg.artifacts["attempts"][-1]
        assert attempt["resume_failures"]["count"] == n
        assert attempt["resume_failures"]["error"] == "ValueError"
        assert attempt["resume_failures"]["at"]
    # Stopped: no more tries, the step failed with a clear reason, in the owners' Inbox.
    await _tick_errors(client, auth)
    assert fails.calls == 1 + service.RESUME_TRIES
    got = await get(client, auth, run["id"])
    seg = got["segments"][0]
    assert seg["status"] == "failed" and "ValueError" in (seg["error"] or ""), seg
    assert "secret-agent-content" not in str(got)
    [item] = (await _inbox(client, auth))["imports"]
    assert item["id"] == run["id"] and item["can_retry_import"] is True
    assert (
        item["import_failed"].startswith("Couldn't import")
        and "ValueError" in (item["import_failed"])
    )
    assert "secret-agent-content" not in item["import_failed"]
    assert await _audits(tenant_id, "run.import_failed")
    # Approvers do not see it (an owner's Retry).
    lead = await as_user(tenant_id, "approver")
    assert (await _inbox(client, lead))["imports"] == []


async def test_a_failing_resume_does_not_skip_the_ceiling(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, _ = await _interrupted(client, auth, monkeypatch, swarm)
    await _ceiling(tenant_id, run["id"], "0.01")
    swarm.workflows["wf_1"].steps[0].cost += 5.0
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "paused_overrun", got["status"]


async def test_a_failing_resume_does_not_skip_a_workflow_that_ended(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    run, _ = await _interrupted(client, auth, monkeypatch, swarm)
    wf = swarm.workflows["wf_1"]
    wf.state = "FAILED"
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "failed", got["status"]


async def test_retry_import_is_an_owners_audited_and_resets_the_count(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for _ in range(service.RESUME_TRIES):
        await _tick_errors(client, auth)
    url = f"/v1/runs/{run['id']}/retry-import"
    # Owners only: not even an approver who created the run; another tenant's run is
    # not found.
    lead_id, lead = await _user(tenant_id, "approver")
    await _created_by(tenant_id, run["id"], lead_id)
    assert (await client.post(url, headers=lead)).status_code == 403
    assert (await client.post(url, headers=await _other_tenant_owner())).status_code == 404
    fails.failing = False
    resp = await client.post(url, headers=auth)
    assert resp.status_code == 200, resp.text
    assert await _audits(tenant_id, "run.import_retried")
    seg = await _segment(tenant_id, run["id"])
    assert seg.status == "succeeded" and "resume_failures" not in seg.artifacts["attempts"][-1]
    assert (await _inbox(client, auth))["imports"] == []
    # A second Retry has nothing to do.
    assert (await client.post(url, headers=auth)).status_code == 409
    await _tick_errors(client, auth)
    got = await get(client, auth, run["id"])
    assert got["status"] == "awaiting_checkpoint" and got["waiting_on"] == "baseline_confirm"


async def test_retry_import_resets_the_count_to_five_more_tries(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    run, fails = await _interrupted(client, auth, monkeypatch, swarm)
    for _ in range(service.RESUME_TRIES):
        await _tick_errors(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/retry-import", headers=auth)
    assert resp.status_code == 200, resp.text
    before = fails.calls
    await _tick_errors(client, auth)
    assert fails.calls == before + 1
    seg = await _segment(tenant_id, run["id"])
    assert seg.status == "succeeded"
    assert seg.artifacts["attempts"][-1]["resume_failures"]["count"] == 1


async def test_importing_baseline_again_makes_no_second_proposal_for_a_locked_item(client, owner):
    """A resume imports baseline.yaml again: a locked item it would change gets one
    proposal, not one per try."""
    from oracle.baseline.models import Entity, Proposal

    tenant_id, auth = owner
    use(on())
    run = await started(client, auth)
    first = "version: 1\nentities:\n  - type: feature\n    key: f1\n    title: First\nedges: []\n"
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert "error" not in await service._import_baseline(s, row, first)
        entity = await s.scalar(select(Entity))
        entity.locked = True
        await s.commit()
        for _ in range(3):
            out = await service._import_baseline(s, row, first.replace("First", "Second"))
            assert out.get("proposals") == 1, out
        proposals = list(await s.scalars(select(Proposal)))
    assert len(proposals) == 1
