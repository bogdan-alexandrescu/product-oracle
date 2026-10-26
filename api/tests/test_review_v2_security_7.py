"""CR-07 review fixes, round 7 (PR #78, on #69 / #57 / #45 / #38), after round 6's
security review: a cancelled run (or a disabled member's) never comes back to life, the
tick holds no run row lock across a SwarmCloud call, and the review gate is not held
while a client's request body is read. Synthetic placeholders only."""

import asyncio
import uuid

import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.runs.models import Run, RunSegment
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, DRAFT, MARKDOWN, person, setup
from tests.test_review_v2_security_3 import disable
from tests.test_review_v2_security_6 import OVERSPEND, _read, _started, _tick

WAIT = 5  # seconds: long enough for any route here, short enough to fail fast


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


# --- ITEM 3: the gate is not held while a request body is received --------------------

YAML = """entities:
  - type: feature
    key: slow-upload
    title: Slow upload
"""


class _SlowBody:
    """A request body sent in two halves, the second only once released: a client on
    a slow link."""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.sent_first, self.release = asyncio.Event(), asyncio.Event()

    async def __aiter__(self):
        half = len(self.data) // 2
        yield self.data[:half]
        self.sent_first.set()
        await self.release.wait()
        yield self.data[half:]


@pytest.mark.parametrize("route", ["baseline_yaml", "document_version"])
async def test_the_gate_is_not_held_while_a_request_body_is_received(client, route):
    """An approver uploads slowly; meanwhile the owner disables another member (which
    takes the gate exclusively). The disable does not wait for the upload."""
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    other = await person(ctx.tenant_id, "commenter", "other")
    if route == "baseline_yaml":
        url, data, ctype = "/v1/baseline/yaml", YAML.encode(), "application/yaml"
    else:
        url, data, ctype = f"/v1/documents/{DOC}/versions", DRAFT.encode(), MARKDOWN["Content-Type"]
    body = _SlowBody(data)
    upload = asyncio.create_task(
        client.post(url, content=body, headers={**approver.headers, "Content-Type": ctype})
    )
    try:
        await asyncio.wait_for(body.sent_first.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, other.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not upload.done()
    finally:
        body.release.set()
    resp = await asyncio.wait_for(upload, WAIT)
    assert resp.status_code in (200, 201), resp.text


@pytest.mark.parametrize("route", ["baseline_yaml", "document_version"])
async def test_a_request_body_over_the_limit_is_refused_before_the_gate(client, monkeypatch, route):
    from oracle.config import get_settings
    from oracle.review import publish

    ctx = await setup(client)
    monkeypatch.setattr(get_settings(), "max_body_bytes", 64)
    taken: list[bool] = []
    real = publish.gate_lock

    async def spy(db, *, shared):
        taken.append(shared)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    if route == "baseline_yaml":
        url, ctype = "/v1/baseline/yaml", "application/yaml"
    else:
        url, ctype = f"/v1/documents/{DOC}/versions", MARKDOWN["Content-Type"]

    async def chunks():  # no Content-Length: the limit holds while reading
        yield b"x" * 50
        yield b"x" * 50

    resp = await client.post(url, content=chunks(), headers={**ctx.auth, "Content-Type": ctype})
    assert resp.status_code == 413, resp.text
    assert taken == []


# --- ITEM 1: a cancelled or disabled member's run never comes back to life ------------


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


def _during_import(monkeypatch, act) -> list[bool]:
    """Run ``act`` while the run's baseline.yaml is being imported (its own
    transaction, the run's row lock released): a cancel or a disable that lands then."""
    from oracle.runs import service

    real = service._import_baseline
    fired: list[bool] = []

    async def spy(db, run, text):
        out = await real(db, run, text)
        if not fired:
            fired.append(True)
            await act()
        return out

    monkeypatch.setattr(service, "_import_baseline", spy)
    return fired


def _ended(run) -> None:
    """Cancelled, and nothing of it reopened: no checkpoint waits, no segment runs."""
    assert run["status"] == "cancelled", run
    assert [c for c in run["checkpoints"] if c["status"] == "pending"] == []
    assert [s["status"] for s in run["segments"]][1:] == ["cancelled"] * (len(run["segments"]) - 1)


@pytest.mark.parametrize("checkpoint", [True, False])
async def test_a_run_cancelled_during_its_import_stays_cancelled(
    client, monkeypatch, runtime, checkpoint
):
    ctx = await setup(client)
    knobs = {} if checkpoint else {"checkpoints": {"baseline_confirm": False}}
    run = await _started(client, ctx, **knobs)

    async def cancel():
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        assert resp.status_code == 200, resp.text

    fired = _during_import(monkeypatch, cancel)
    await _tick(client, ctx)
    assert fired
    _ended(await _read(client, ctx, run["id"]))
    assert len(runtime.submitted) == 1  # the next segment was never submitted
    await _tick(client, ctx)
    _ended(await _read(client, ctx, run["id"]))
    assert len(runtime.submitted) == 1


@pytest.mark.parametrize("checkpoint", [True, False])
async def test_a_run_whose_creator_is_disabled_during_its_import_stays_cancelled(
    client, monkeypatch, runtime, checkpoint
):
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    knobs = {} if checkpoint else {"checkpoints": {"baseline_confirm": False}}
    run = await _started(client, ctx, author.headers, **knobs)

    async def disable_author():
        resp = await disable(client, ctx, author.user_id)
        assert resp.status_code == 200, resp.text

    fired = _during_import(monkeypatch, disable_author)
    await _tick(client, ctx)
    assert fired
    _ended(await _read(client, ctx, run["id"]))
    assert len(runtime.submitted) == 1


@pytest.mark.parametrize("checkpoint", [True, False])
async def test_a_resume_racing_a_cancel_does_not_reopen_the_run(
    client, monkeypatch, runtime, checkpoint
):
    """Paused on overrun with its segment done; the owner resumes, and while the
    resume imports the segment's baseline.yaml the run is cancelled."""
    ctx = await setup(client)
    runtime.script["baseline"] = [Outcome(cost_usd=OVERSPEND)]
    knobs = {} if checkpoint else {"checkpoints": {"baseline_confirm": False}}
    run = await _started(client, ctx, **knobs)
    await _tick(client, ctx)
    assert (await _read(client, ctx, run["id"]))["status"] == "paused_overrun"

    async def cancel():
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        assert resp.status_code == 200, resp.text

    fired = _during_import(monkeypatch, cancel)
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=ctx.auth)
    assert fired
    assert resp.status_code in (200, 409), resp.text
    _ended(await _read(client, ctx, run["id"]))
    await _tick(client, ctx)
    _ended(await _read(client, ctx, run["id"]))
    assert len(runtime.submitted) == 1


@pytest.mark.parametrize("target", ["cancelled", "running"])
async def test_a_checkpoint_decision_refuses_a_segment_not_in_the_expected_state(
    client, runtime, target
):
    """Defence in depth: a checkpoint whose next segment is not pending (cancelled, or
    already running) is not decided, and nothing is submitted."""
    ctx = await setup(client)
    run = await _started(client, ctx)
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    async with tenant_session(ctx.tenant_id) as s:
        seg = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == run["id"], RunSegment.seq == 2)
        )
        seg.status = target
        await s.commit()
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved", "note": None},
        headers=ctx.auth,
    )
    assert resp.status_code == 409, resp.text
    assert len(runtime.submitted) == 1


async def test_a_checkpoint_decision_on_a_cancelled_run_is_refused(client, runtime):
    ctx = await setup(client)
    run = await _started(client, ctx)
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    cp = next(c for c in run["checkpoints"] if c["status"] == "pending")
    async with tenant_session(ctx.tenant_id) as s:
        # A run cancelled under a checkpoint left pending (as a reopened one was).
        (await s.get(Run, uuid.UUID(run["id"]))).status = "cancelled"
        await s.commit()
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "approved", "note": None},
        headers=ctx.auth,
    )
    assert resp.status_code == 409, resp.text
    assert len(runtime.submitted) == 1


# --- ITEM 2: the tick holds no run row lock across a SwarmCloud call -----------------


class _Blocked:
    """Holds one runtime call until released: SwarmCloud being slow."""

    def __init__(self, runtime: FakeRuntime, method: str) -> None:
        self.entered, self.release = asyncio.Event(), asyncio.Event()
        real = getattr(runtime, method)

        async def slow(*args):
            self.entered.set()
            await self.release.wait()
            return await real(*args)

        setattr(runtime, method, slow)


@pytest.mark.parametrize("method", ["status", "artifacts"])
async def test_a_slow_swarmcloud_call_in_the_tick_does_not_block_a_disable(client, runtime, method):
    """The tick reads a run's workflow while SwarmCloud takes its time; the owner
    disables the run's creator meanwhile (the gate exclusively, then the run's row).
    The disable does not wait for SwarmCloud, and the tick then leaves the run
    cancelled: no checkpoint, nothing submitted."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)
    blocked = _Blocked(runtime, method)
    ticking = asyncio.create_task(client.post("/v1/internal/tick", headers=ctx.auth))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, author.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not ticking.done()
    finally:
        blocked.release.set()
    resp = await asyncio.wait_for(ticking, WAIT)
    assert resp.status_code == 200, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "cancelled"
    assert run["checkpoints"] == []
    assert len(runtime.submitted) == 1


async def test_a_tick_pass_on_one_run_has_an_overall_deadline(client, monkeypatch, runtime):
    """SwarmCloud never answers: the tick gives up on the run within its deadline,
    reports it, and the run is as it was."""
    from oracle.runs import service

    ctx = await setup(client)
    run = await _started(client, ctx)
    monkeypatch.setattr(service, "TICK_RUN_SECONDS", 0.3)
    _Blocked(runtime, "status")
    resp = await asyncio.wait_for(client.post("/v1/internal/tick", headers=ctx.auth), WAIT)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["errors"]) == 1
    assert (await _read(client, ctx, run["id"]))["status"] == "running"


def _swarm(raw):
    """A SwarmCloud whose one task lists ``names`` and serves each through ``raw``."""
    import httpx

    from oracle.swarm.swarmcloud import StaticBearer, SwarmCloudRuntime

    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/workflows/wf_1":
            return httpx.Response(
                200,
                json={
                    "workflow": {"state": "SUCCEEDED", "steps": [{"task_id": "t1"}]},
                    "tasks": [{"id": "t1", "state": "SUCCEEDED"}],
                },
            )
        if path.endswith("/artifacts"):
            return httpx.Response(200, json={"artifacts": raw.listing()})
        if path.endswith("/artifacts/raw"):
            calls.append(request.url.params["name"])
            return raw.serve(request.url.params["name"])
        return httpx.Response(404)

    rt = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("sc-bearer"), transport=httpx.MockTransport(handler)
    )
    return rt, calls


async def test_an_oversized_artifact_is_refused_without_being_read_in_full():
    import httpx

    from oracle.swarm import swarmcloud

    sent = {"bytes": 0}
    chunk = b"x" * 65536

    class Raw:
        def listing(self):
            return [{"name": "huge.md", "role": None}, {"name": "prd.md", "role": None}]

        def serve(self, name):
            if name == "prd.md":
                return httpx.Response(200, text="# PRD")

            async def body():  # 50 MB, no Content-Length
                for _ in range(800):
                    sent["bytes"] += len(chunk)
                    yield chunk

            return httpx.Response(200, content=body())

    rt, _ = _swarm(Raw())
    files = await rt.artifacts("wf_1")
    assert files == {"prd.md": "# PRD"}
    assert sent["bytes"] <= swarmcloud.MAX_ARTIFACT_BYTES + 2 * len(chunk)


async def test_an_artifact_announced_oversized_is_not_read():
    import httpx

    class Raw:
        def listing(self):
            return [{"name": "huge.md", "role": None}]

        def serve(self, name):
            return httpx.Response(
                200, content=b"x", headers={"Content-Length": str(50 * 1024 * 1024)}
            )

    rt, _ = _swarm(Raw())
    assert await rt.artifacts("wf_1") == {}


async def test_the_artifacts_read_per_pass_are_capped():
    import httpx

    from oracle.swarm import swarmcloud

    class Raw:
        def listing(self):
            return [{"name": f"note-{i}.md", "role": None} for i in range(1000)]

        def serve(self, name):
            return httpx.Response(200, text=name)

    rt, calls = _swarm(Raw())
    files = await rt.artifacts("wf_1")
    assert len(calls) == swarmcloud.MAX_ARTIFACT_FILES
    assert len(files) == swarmcloud.MAX_ARTIFACT_FILES


# --- MINORS --------------------------------------------------------------------------


async def _segment(ctx, run_id, seq) -> RunSegment:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(
            select(RunSegment).where(
                RunSegment.run_id == uuid.UUID(str(run_id)), RunSegment.seq == seq
            )
        )


async def test_the_claim_keeps_the_reviewers_note_until_the_submission_succeeds(client, runtime):
    """Changes requested with a note; while SwarmCloud takes the re-run, the claimed
    segment still holds the note (a process that dies mid-call loses nothing)."""
    from tests.test_review_v2_security_6 import _at_checkpoint, _decide

    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    blocked = _Blocked(runtime, "submit")
    decided = asyncio.create_task(_decide(client, run, ctx.auth, "changes_requested", "Cite G1"))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        seg = await _segment(ctx, run["id"], 1)
        assert seg.artifacts.get("claim")
        assert seg.artifacts.get("pending_note") == "Cite G1"
    finally:
        blocked.release.set()
    assert (await decided).status_code == 200
    seg = await _segment(ctx, run["id"], 1)
    assert "pending_note" not in seg.artifacts
    assert seg.artifacts["attempts"][-1]["note"] == "Cite G1"


async def test_a_cancel_records_its_runtime_follow_up_before_the_call(client, runtime):
    """The cancel's follow-up is in the cancel's own transaction: when the runtime is
    called it is already saved, so a crash in between leaves it for the tick."""
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    run = await _started(client, ctx)
    seen: list = []
    real = runtime.cancel

    async def spy(workflow_id):
        async with tenant_session(ctx.tenant_id) as s:
            seen.append(
                await s.scalar(
                    select(MemberFollowUp).where(MemberFollowUp.workflow_id == workflow_id)
                )
            )
        await real(workflow_id)

    runtime.cancel = spy
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert len(seen) == 1 and seen[0] is not None and seen[0].kind == "run_cancel"
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(MemberFollowUp, seen[0].id)).status == "done"


async def test_a_workflow_started_for_a_changed_run_has_its_follow_up_before_the_call(
    client, runtime
):
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    run = await _run_estimated(client, ctx)
    blocked = _Blocked(runtime, "submit")
    seen: list = []
    real = runtime.cancel

    async def spy(workflow_id):
        async with tenant_session(ctx.tenant_id) as s:
            seen.append(
                await s.scalar(
                    select(MemberFollowUp).where(MemberFollowUp.workflow_id == workflow_id)
                )
            )
        await real(workflow_id)

    runtime.cancel = spy
    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        assert resp.status_code == 200, resp.text
    finally:
        blocked.release.set()
    assert (await call).status_code == 200
    assert len(seen) == 1 and seen[0] is not None


async def _run_estimated(client, ctx) -> dict:
    from tests.test_review_v2_security_6 import _run

    return await _run(client, ctx)


async def test_an_unexpected_submission_error_is_recorded_not_a_500(client, runtime):
    ctx = await setup(client)
    run = await _run_estimated(client, ctx)
    real = runtime.submit

    async def broken(spec):
        raise ValueError("unexpected answer")

    runtime.submit = broken
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    seg = resp.json()["segments"][0]
    assert seg["status"] == "pending" and "ValueError" in seg["error"]
    assert "claim" not in (await _segment(ctx, run["id"], 1)).artifacts
    runtime.submit = real
    await _tick(client, ctx)
    assert (await _read(client, ctx, run["id"]))["segments"][0]["status"] == "running"


async def test_a_cancel_follow_up_does_not_write_onto_a_segment_requeued_since(client, runtime):
    from datetime import UTC, datetime

    from oracle.members.models import MemberFollowUp
    from oracle.runs.service import QUEUED
    from oracle.swarm import RuntimeUnavailable
    from tests.test_review_v2_security_6 import _at_checkpoint

    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    seg = await _segment(ctx, run["id"], 2)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RunSegment, seg.id)
        row.error = QUEUED  # queued again since its earlier workflow was cancelled
        s.add(
            MemberFollowUp(
                member_id=uuid.UUID(run["created_by"]),
                kind="run_cancel",
                target_id=seg.id,
                workflow_id="fake-old-workflow",
                next_attempt_at=datetime.now(UTC),
            )
        )
        await s.commit()

    async def down(workflow_id):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.cancel = down
    await _tick(client, ctx)
    assert (await _segment(ctx, run["id"], 2)).error == QUEUED


async def test_the_tick_refuses_a_viewer_api_token(client, runtime):
    from oracle.auth.service import create_api_token

    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, "read-only")
        token.role = "viewer"
        await s.commit()
    resp = await client.post("/v1/internal/tick", headers={"Authorization": f"Bearer {raw}"})
    assert resp.status_code == 403, resp.text
    await _tick(client, ctx)  # an owner's token still runs it


SPELLINGS = [
    "{u}",
    "{h}",
    "urn:uuid:{U}",
    " {{{u}}}\t",
    "UUID:{h}",
    "0x{h30}",  # uuid.UUID reads it (int(..., 16)); the SQL never did
    "{h_}",  # an underscore: the same
    "{u}}}{{",  # braces inside
    " {u}",  # a non-ASCII space
    "{h31}",
    "not-a-uuid",
]


@pytest.mark.parametrize("spelling", SPELLINGS)
async def test_external_key_and_the_sql_read_exactly_the_same_spellings(client, spelling):
    from sqlalchemy import literal

    from oracle.review.publish import _as_uuid, _hex32, external_key

    ctx = await setup(client)
    u = uuid.UUID("12345678-9abc-def0-1234-56789abcdef0")
    value = spelling.format(
        u=u, U=str(u).upper(), h=u.hex, h30=u.hex[:30], h_=u.hex[:16] + "_" + u.hex[17:],
        h31=u.hex[:31],
    )  # fmt: skip
    parsed = _as_uuid(value)
    async with tenant_session(ctx.tenant_id) as s:
        in_sql = await s.scalar(select(_hex32(literal(value))))
    assert (parsed.hex if parsed else None) == in_sql
    assert (external_key(value) == str(parsed)) if parsed else (external_key(value) != str(u))
