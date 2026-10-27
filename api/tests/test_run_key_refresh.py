"""The run's MCP key renewed when SwarmCloud parks a step whose key expired (SwarmCloud
#2498, PR 2502): the park's detail read from the task, the re-store call and its
refusals by HTTP status, one renewal per park with the same scopes and a fresh expiry,
and the token kept out of logs, knobs, notes and the run API."""

import json
import logging
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from oracle.runs import workflow
from oracle.runs.models import Run, RunSegment
from oracle.runtokens import RunToken, verify_run_token
from oracle.swarm import RuntimeUnavailable, set_runtime
from oracle.swarm.settings import get_runtime_settings
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import FakeSwarmCloud, _err
from tests.test_runs import get, started, tick

PUBLIC = "https://oracle.swarm.saga.xyz"
FIRST = "baseline-1-researcher"
RENEWED = "Key renewed at "


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv("ORACLE_PUBLIC_URL", PUBLIC)
    for key in (
        "ORACLE_CHECKPOINT_WAIT_SECONDS",
        "ORACLE_CHECKPOINT_TAIL_SECONDS",
        "ORACLE_STEP_SECONDS",
        "ORACLE_TRUSTED_PROXY_HOPS",
    ):
        monkeypatch.delenv(key, raising=False)
    get_runtime_settings.cache_clear()
    yield
    get_runtime_settings.cache_clear()
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


def parking(shape: str = "blocked_by") -> FakeSwarmCloud:
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    swarm.park_expired = shape
    set_runtime(swarm.runtime())
    return swarm


async def parked_run(client, auth, swarm: FakeSwarmCloud) -> dict:
    """A run whose first step starts after its key expired in SwarmCloud's queue."""
    run = await started(client, auth)
    swarm.tick(86400 + 60)
    return run


async def raw_tick(client, auth) -> list[str]:
    resp = await client.post("/v1/internal/tick", headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()["errors"]


async def tokens(tenant_id, run_id) -> list[RunToken]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(RunToken).where(RunToken.run_id == run_id).order_by(RunToken.created_at)
        )
        return list(rows)


def submitted_token(swarm: FakeSwarmCloud) -> str:
    return swarm.submissions()[0]["mcp_credentials"]["oracle"]["value"]


def restored(swarm: FakeSwarmCloud, n: int = -1) -> dict:
    return swarm.restores[n]["mcp_credentials"]["oracle"]


# --------------------------------------------------------------------------- the client


@pytest.mark.parametrize("shape", ["blocked_by", "waiting"])
async def test_the_park_detail_is_read_from_either_shape(client, owner, shape):
    """protects=#2498's watch: the park's credential, code, server, expired_at and
    parked_at from task.blocked_by[] or task.waiting.detail; fails_when=either shape is
    not read into the status's parked entry; no_claim=other park reasons."""
    _, auth = owner
    swarm = parking(shape)
    swarm.promote_on_restore = False
    await parked_run(client, auth, swarm)
    status = await swarm.runtime().status("wf_1")
    [park] = [p for p in status.parked if p.step_id == FIRST]
    assert park.reason == "CREDENTIAL_MISSING" and park.mcp_expired
    assert (park.credential, park.code, park.server) == ("mcp", "mcp_credential_expired", "oracle")
    assert park.expired_at is not None and park.parked_at is not None


@pytest.mark.parametrize(
    "status,reason",
    [(403, "forbidden"), (404, "not_found"), (409, "conflict"), (422, "mcp_credential_shape")],
)
async def test_the_restore_call_refusals_carry_their_http_status(status, reason):
    """protects=the re-store client maps refusals by HTTP status; fails_when=a refusal is
    not a RuntimeUnavailable with its status, or the value appears in its message;
    no_claim=SwarmCloud's specific codes (not switched on yet)."""
    swarm = FakeSwarmCloud(mcp=True)
    swarm.fail_restores = [_err(status, reason)]
    with pytest.raises(RuntimeUnavailable) as caught:
        await swarm.runtime().store_mcp_credentials("wf_9", "oracle", "ort_Secret123456", 600)
    assert caught.value.status == status and "ort_Secret123456" not in str(caught.value)
    assert swarm.restores[0]["mcp_credentials"] == {
        "oracle": {"value": "ort_Secret123456", "expires_in": 600}
    }


async def test_the_restore_call_reads_what_was_stored_and_promoted(client, owner):
    _, auth = owner
    swarm = parking()
    swarm.fail_restores = [
        httpx.Response(
            200,
            json={
                "stored": [{"server": "oracle", "expires_at": "2026-10-28T00:00:00Z"}],
                "promoted": 2,
            },
        )
    ]
    answer = await swarm.runtime().store_mcp_credentials("wf_1", "oracle", "ort_Abc12345678", 60)
    assert answer.promoted == 2 and answer.stored[0][0] == "oracle"
    assert answer.stored[0][1] == datetime(2026, 10, 28, tzinfo=UTC)


# --------------------------------------------------------------------------- the run


@pytest.mark.parametrize("shape", ["blocked_by", "waiting"])
async def test_a_parked_expired_step_gets_one_renewal_and_proceeds(client, owner, shape):
    """protects=the run's key refresh on a CREDENTIAL_MISSING/mcp_credential_expired park:
    the old token revoked, a new one with the SAME scopes and a fresh expiry re-stored,
    the step goes on, a run note says so; fails_when=no re-store, a second one, wider or
    other scopes, the old token still valid, the step still parked, no note, or the
    disabled-server advice shown for it; no_claim=the length of the new lifetime beyond
    SwarmCloud's 60..86400 s and the steps still to run."""
    tenant_id, auth = owner
    swarm = parking(shape)
    run = await parked_run(client, auth, swarm)
    old = submitted_token(swarm)
    old_scopes = sorted((await verify_run_token(old)).scopes)

    await tick(client, auth)
    assert len(swarm.restores) == 1 and swarm.restores[0]["workflow_id"] == "wf_1"
    sent = restored(swarm)
    assert sent["value"] != old and 60 <= sent["expires_in"] <= 86400
    assert await verify_run_token(old) is None
    claims = await verify_run_token(sent["value"])
    assert claims is not None and sorted(claims.scopes) == old_scopes
    fresh = claims.expires_at - datetime.now(UTC)
    assert timedelta(seconds=sent["expires_in"] - 120) < fresh
    assert fresh <= timedelta(seconds=sent["expires_in"])
    rows = await tokens(tenant_id, run["id"])
    assert [sorted(r.scopes) for r in rows if r.revoked_at is None] == [old_scopes]

    await tick(client, auth)
    assert swarm.workflows["wf_1"].step(FIRST).state == "SUCCEEDED"
    assert len(swarm.restores) == 1 and len(swarm.submissions()) == 1
    run = await get(client, auth, run["id"])
    notes = [n for n in run["notes"] if n.startswith(RENEWED)]
    assert len(notes) == 1 and "expired while it waited in SwarmCloud's queue" in notes[0]
    assert workflow.ADVICE["CREDENTIAL_MISSING"] not in run["notes"]


async def test_two_ticks_during_one_park_renew_once(client, owner):
    """protects=one renewal per park; fails_when=a second tick that still sees the park
    before SwarmCloud promotes the step mints or re-stores again; no_claim=a new park of
    the same step later (renewed again)."""
    tenant_id, auth = owner
    swarm = parking()
    swarm.promote_on_restore = False
    run = await parked_run(client, auth, swarm)
    await tick(client, auth)
    await tick(client, auth)
    await tick(client, auth)
    assert len(swarm.restores) == 1
    rows = await tokens(tenant_id, run["id"])
    assert len(rows) == 2 and [r.revoked_at is None for r in rows] == [False, True]
    run = await get(client, auth, run["id"])
    assert len([n for n in run["notes"] if n.startswith(RENEWED)]) == 1


@pytest.mark.parametrize(
    "refusal", [_err(409, "conflict", "finished"), _err(404, "not_found", "no such workflow")]
)
async def test_a_finished_or_unknown_workflow_ends_quietly(client, owner, refusal):
    """protects=409 (finished workflow) and 404 end quietly, as SwarmCloud ships them
    (generic body codes); fails_when=the tick reports an error, the run gets advice or a
    renewal note, it fails because of the refusal, or the re-store is tried again;
    no_claim=how the run ends (its normal end handling)."""
    _, auth = owner
    swarm = parking()
    swarm.fail_restores = [refusal]
    swarm.promote_on_restore = False
    run = await parked_run(client, auth, swarm)
    assert await raw_tick(client, auth) == []
    assert await raw_tick(client, auth) == []
    assert len(swarm.restores) == 1
    run = await get(client, auth, run["id"])
    assert run["status"] == "running"
    assert not [n for n in run["notes"] if n.startswith(RENEWED)]
    assert workflow.ADVICE["key_refresh_forbidden"] not in run["notes"]
    assert workflow.ADVICE["key_refresh_refused"] not in run["notes"]


@pytest.mark.parametrize(
    "refusal,advice",
    [
        (_err(403, "forbidden", "not yours"), "key_refresh_forbidden"),
        (_err(422, "mcp_credential_unexpected", "oracle"), "key_refresh_refused"),
        (_err(422, "mcp_server_unregistered", "oracle"), "key_refresh_refused"),
        (_err(422, "mcp_credential_shape", "oracle"), "key_refresh_refused"),
    ],
)
async def test_a_refused_restore_shows_its_advice_once(client, owner, refusal, advice):
    """protects=403 and 422 show their advice on the run and are reported once;
    fails_when=no advice, it shows twice, the tick reports it on every pass, or the
    re-store is tried again for the same park; no_claim=the body's specific code."""
    _, auth = owner
    swarm = parking()
    swarm.fail_restores = [refusal]
    run = await parked_run(client, auth, swarm)
    first = await raw_tick(client, auth)
    assert len(first) == 1 and str(refusal.status_code) in first[0]
    assert await raw_tick(client, auth) == []
    assert len(swarm.restores) == 1
    run = await get(client, auth, run["id"])
    assert run["notes"].count(workflow.ADVICE[advice]) == 1
    assert not [n for n in run["notes"] if n.startswith(RENEWED)]


async def test_the_restart_fallback_does_not_also_act_when_the_park_renewed(client, owner):
    """protects=the park path and a restart on queued key expiry cannot both act;
    fails_when=a renewed park also resubmits the workflow (a second submission) or the
    run fails or restarts; no_claim=a SwarmCloud that fails the step instead of parking
    it (that path's own tests)."""
    _, auth = owner
    swarm = parking()
    run = await parked_run(client, auth, swarm)
    for _ in range(3):
        await tick(client, auth)
    assert len(swarm.submissions()) == 1 and len(swarm.restores) == 1
    run = await get(client, auth, run["id"])
    assert run["status"] in ("running", "awaiting_checkpoint")
    async with tenant_session(owner[0]) as s:
        row = await s.get(Run, run["id"])
        assert (row.knobs["workflow"]["key_refresh"] or {}).get("park")


async def test_the_token_never_shows_in_logs_knobs_notes_or_the_run_api(client, owner, caplog):
    """protects=the renewed token goes only in the re-store body; fails_when=it appears
    in a log line, the run's knobs, a segment's artifacts or notes, or the run API's
    answer; no_claim=SwarmCloud's own logs."""
    tenant_id, auth = owner
    caplog.set_level(logging.DEBUG)
    swarm = parking()
    run = await parked_run(client, auth, swarm)
    await tick(client, auth)
    await tick(client, auth)
    token = restored(swarm)["value"]
    assert token not in caplog.text
    body = (await client.get(f"/v1/runs/{run['id']}", headers=auth)).text
    assert token not in body and RENEWED in body
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, run["id"])
        assert token not in json.dumps(row.knobs, default=str)
        segments = await s.scalars(select(RunSegment).where(RunSegment.run_id == row.id))
        for seg in segments:
            assert token not in json.dumps(seg.artifacts, default=str)
            assert token not in (seg.error or "")
