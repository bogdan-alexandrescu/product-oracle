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

from oracle.runs import service, workflow
from oracle.runs.models import Run, RunSegment
from oracle.runtokens import RunToken, verify_run_token
from oracle.swarm import FakeRuntime, Outcome, Parked, RuntimeUnavailable, WorkflowSpec, set_runtime
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
    async with tenant_session(tenant_id) as s:
        knob = (await s.get(Run, run["id"])).knobs["workflow"]
    # The decision's tail rule counts from the renewed key, not the submission's.
    assert abs(datetime.fromisoformat(knob["expires_at"]) - claims.expires_at) < timedelta(
        seconds=60
    )

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
    # It was minted for the run and sent, in the PUT's body, and nowhere else.
    assert await verify_run_token(token) is not None
    [put] = [r for r in swarm.requests if r.method == "PUT"]
    assert put.url.path == "/v1/workflows/wf_1/mcp-credentials" and token in put.content.decode()
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


async def test_the_local_runtime_parks_and_restores_too():
    """protects=the fake runtime serves a parked mcp-expired step and the re-store call;
    fails_when=the park is not served, a re-store does not promote it, the value is
    kept, or a scripted refusal is not raised; no_claim=the run's tick (the local runtime
    has caller MCP off, so its runs never attach a key)."""
    park = Parked(
        "baseline-1-researcher",
        "t1",
        "CREDENTIAL_MISSING",
        credential="mcp",
        code="mcp_credential_expired",
        server="oracle",
    )
    runtime = FakeRuntime({"baseline": [Outcome(parked=(park,))]})
    spec = WorkflowSpec(name="b", steps=(), labels={"segment": "baseline"})
    wid = await runtime.submit(spec)
    status = await runtime.status(wid)
    assert status.state == "running" and status.parked == (park,) and park.mcp_expired
    answer = await runtime.store_mcp_credentials(wid, "oracle", "ort_Secret123456", 600)
    assert answer.promoted == 1 and (await runtime.status(wid)).parked == ()
    assert "ort_Secret123456" not in repr(runtime.stored)

    refusal = RuntimeUnavailable("refused", status=409, code="conflict")
    runtime = FakeRuntime({"baseline": [Outcome(parked=(park,), restore_refusal=refusal)]})
    wid = await runtime.submit(spec)
    with pytest.raises(RuntimeUnavailable) as caught:
        await runtime.store_mcp_credentials(wid, "oracle", "ort_Secret123456", 600)
    assert caught.value.status == 409 and runtime.stored == []


# ------------------------------------------------------------------- review follow-ups


def on_swarm_clock(monkeypatch, swarm: FakeSwarmCloud) -> None:
    """Oracle's clock is SwarmCloud's (one clock, as in production): expiries compare."""
    monkeypatch.setattr(service, "_now", lambda: swarm.now)


def repark(swarm: FakeSwarmCloud, after: float = 120) -> None:
    """SwarmCloud reports the step parked again, with a new parked_at but the same
    expiry it parked for at first (a child task the sweep promotes, or a re-report)."""
    swarm.tick(after)
    step = swarm.workflows["wf_1"].step(FIRST)
    step.state, step.park_reason, step.parked_at = "PARKED", "CREDENTIAL_MISSING", swarm.now


def fail_step(swarm: FakeSwarmCloud) -> None:
    step = swarm.workflows["wf_1"].step(FIRST)
    step.state, step.park_reason, step.parked_at = "FAILED", None, None
    step.error_code = "mcp_credential_expired"
    step.last_error = "mcp_credential_expired: the workflow's credential expired"


async def test_a_repark_older_than_the_renewed_key_does_not_renew_again(client, owner, monkeypatch):
    """protects=a stored key newer than a park's expiry is not replaced: the renewed token
    the promoted steps use stays valid; fails_when=a re-park (new parked_at) whose
    expired_at is before the renewal revokes the renewed token and re-stores another;
    no_claim=a park whose key expired after the renewal (renewed again)."""
    tenant_id, auth = owner
    swarm = parking()
    swarm.promote_on_restore = False
    on_swarm_clock(monkeypatch, swarm)
    run = await parked_run(client, auth, swarm)
    await tick(client, auth)
    assert len(swarm.restores) == 1
    renewed = restored(swarm)["value"]
    repark(swarm)
    await tick(client, auth)
    await tick(client, auth)
    assert len(swarm.restores) == 1
    assert await verify_run_token(renewed) is not None
    assert len(await tokens(tenant_id, run["id"])) == 2


async def test_a_new_park_after_a_refusal_shows_no_second_advice(client, owner, monkeypatch):
    """protects=a 403/422 refusal is reported once per workflow, not once per park;
    fails_when=a later park of the same workflow mints and re-stores again or shows the
    advice twice; no_claim=a new workflow of the run (a fresh key at its submission)."""
    _, auth = owner
    swarm = parking()
    swarm.fail_restores = [_err(403, "forbidden", "not yours")]
    on_swarm_clock(monkeypatch, swarm)
    run = await parked_run(client, auth, swarm)
    assert len(await raw_tick(client, auth)) == 1
    repark(swarm)
    assert await raw_tick(client, auth) == []
    assert await raw_tick(client, auth) == []
    assert len(swarm.restores) == 1
    run = await get(client, auth, run["id"])
    assert run["notes"].count(workflow.ADVICE["key_refresh_forbidden"]) == 1


@pytest.mark.parametrize(
    "refusal", [_err(403, "forbidden", "not yours"), _err(422, "mcp_credential_shape", "x")]
)
async def test_a_refused_restore_revokes_the_key_it_minted(client, owner, refusal):
    """protects=a key SwarmCloud refused is not left valid; fails_when=the token minted
    for a refused re-store is still unrevoked; no_claim=a 5xx (tried again)."""
    tenant_id, auth = owner
    swarm = parking()
    swarm.fail_restores = [refusal]
    run = await parked_run(client, auth, swarm)
    await raw_tick(client, auth)
    assert len(swarm.restores) == 1
    assert await verify_run_token(restored(swarm)["value"]) is None
    assert [r.revoked_at is None for r in await tokens(tenant_id, run["id"])] == [False, False]


@pytest.mark.parametrize(
    "detail,advice",
    [
        ({"credential": "mcp", "code": "mcp_credential_missing", "server": "oracle"},
         "key_missing"),
        ({"credential": "mcp", "code": "mcp_credential_expired", "server": None},
         "key_expired_unnamed"),
    ],
)  # fmt: skip
async def test_a_key_park_that_cannot_be_renewed_says_why(client, owner, detail, advice):
    """protects=a CREDENTIAL_MISSING park for a missing key, or an expired one without a
    server to name, gets its own advice; fails_when=it shows the 'connection switched off'
    advice, gets none, or Oracle tries a re-store; no_claim=SwarmCloud's other codes."""
    _, auth = owner
    swarm = parking()
    run = await started(client, auth)
    swarm.servers["oracle"]["enabled"] = False
    swarm.forged[FIRST] = {
        "blocked_by": [{"reason": "CREDENTIAL_MISSING", "expired_at": None, **detail}]
    }
    await tick(client, auth)
    await tick(client, auth)
    assert swarm.restores == []
    run = await get(client, auth, run["id"])
    assert workflow.ADVICE["CREDENTIAL_MISSING"] not in run["notes"]
    assert run["notes"].count(workflow.ADVICE[advice]) == 1


async def test_steps_still_to_run_are_sized_by_the_submitted_waits(client, owner):
    """protects=the renewed key's lifetime counts waits as at submission (StepSpec.waits,
    kept on the workflow); fails_when=it counts a segment's review keys instead, which
    differ from the wait step ids; no_claim=the length of a step or a wait."""
    _, auth = owner
    swarm = parking()
    swarm.promote_on_restore = False
    run = await parked_run(client, auth, swarm)
    await tick(client, auth)
    status = await swarm.runtime().status("wf_1")
    async with tenant_session(owner[0]) as s:
        row = await s.get(Run, run["id"])
        wf = dict(row.knobs["workflow"])
        waits = wf["waits"]
        assert waits and set(waits) <= {st.step_id for st in status.steps}
        wf.pop("key_refresh", None)
        wf["segments"] = [{**e, "reviews": ["not-a-step"]} for e in wf.get("segments") or []]
        status = await swarm.runtime().status("wf_1")
        park = Parked(FIRST, "t", "CREDENTIAL_MISSING", credential="mcp",
                      code="mcp_credential_expired", server="oracle",
                      parked_at=datetime.now(UTC))  # fmt: skip
        marked = service._mark_key_refresh(row, wf, status, [park])
        await s.rollback()
    left = [st for st in status.steps if st.state not in service._FINISHED_STEPS]
    agents = sum(1 for st in left if st.step_id not in waits)
    want = workflow.credential_seconds(agents, len(left) - agents, get_runtime_settings())
    assert marked["key_refresh"]["seconds"] == want


async def test_a_renewed_park_then_a_failed_step_acts_once(client, owner, monkeypatch):
    """protects=finding 1's guard: after the park path renewed, a step SwarmCloud then
    fails mcp_credential_expired is not renewed again and not resubmitted alongside it
    (at most one of renewal or restart acts); fails_when=a second re-store or a second
    submission follows; no_claim=the restart-once fallback (lane #732), which is not on
    this branch's base: this test is its merge guard."""
    _, auth = owner
    swarm = parking()
    swarm.promote_on_restore = False
    on_swarm_clock(monkeypatch, swarm)
    run = await parked_run(client, auth, swarm)
    await tick(client, auth)
    assert len(swarm.restores) == 1
    swarm.tick(120)
    fail_step(swarm)
    for _ in range(3):
        await raw_tick(client, auth)
    assert len(swarm.restores) == 1 and len(swarm.submissions()) == 1
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"


async def test_a_refused_park_then_a_failed_step_acts_at_most_once(client, owner, monkeypatch):
    """protects=finding 1's guard: a refused renewal followed by the step failing
    mcp_credential_expired is acted on at most once (no second re-store, at most one
    resubmission); fails_when=a renewal is tried again or the run resubmits more than once;
    no_claim=the restart-once fallback (lane #732): this test is its merge guard."""
    _, auth = owner
    swarm = parking()
    swarm.fail_restores = [_err(422, "mcp_server_unregistered", "oracle")]
    on_swarm_clock(monkeypatch, swarm)
    await parked_run(client, auth, swarm)
    await raw_tick(client, auth)
    swarm.tick(120)
    fail_step(swarm)
    for _ in range(3):
        await raw_tick(client, auth)
    assert len(swarm.restores) == 1 and len(swarm.submissions()) <= 2
