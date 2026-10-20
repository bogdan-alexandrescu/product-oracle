"""CR-06 review fixes, round 6 (PR #69, on #57 / #45 / #38), after round 5's security
review: approver-level writes re-check the caller under the gate (C2: a disable voids
their approvals, a demoted approver's lapse), and the review gate is never held across
a SwarmCloud call. Synthetic placeholders only."""

import asyncio
import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from oracle import readiness
from oracle.auth.models import User
from oracle.models import AuditEvent
from oracle.runs.models import Run, RunSegment
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.review_v2_helpers import DOC, edit, person, setup, states
from tests.test_review_v2_security_3 import disable, member_token

WAIT = 5  # seconds: long enough for any route here, short enough to fail fast


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _lose(ctx, how: str, user_id, token_id=None) -> None:
    """The caller loses standing: disabled, demoted one step (owner to approver,
    approver to commenter), or their API token revoked."""
    from oracle.auth.models import ApiToken

    async with tenant_session(ctx.tenant_id) as s:
        user = await s.get(User, user_id)
        if how == "disabled":
            user.disabled_at = datetime.now(UTC)
        elif how == "demoted":
            user.role = "approver" if user.role == "owner" else "commenter"
        else:
            (await s.get(ApiToken, token_id)).revoked_at = datetime.now(UTC)
        await s.commit()


def _lose_on_first_gate(monkeypatch, ctx, how, user_id, token_id=None) -> list[bool]:
    """The first time the request takes the gate, the caller loses standing (a disable,
    a demotion or a revoke that commits while the request waits on the gate). Returns
    a flag the test reads: did the request take the gate at all?"""
    from oracle.review import publish

    real = publish.gate_lock
    fired: list[bool] = []

    async def spy(db, *, shared):
        if not fired:
            fired.append(True)
            await _lose(ctx, how, user_id, token_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    return fired


async def _tick(client, ctx) -> dict:
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["errors"] == []
    return resp.json()


async def _run(client, ctx, headers=None, **knobs) -> dict:
    headers = headers or ctx.auth
    resp = await client.post(
        "/v1/runs", json={"flow": "baseline_to_prd", "document": DOC, "knobs": knobs},
        headers=headers,
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    run = resp.json()
    est = await client.post(f"/v1/runs/{run['id']}/estimate", headers=headers)
    assert est.status_code == 200, est.text
    return run


async def _started(client, ctx, headers=None, **knobs) -> dict:
    headers = headers or ctx.auth
    run = await _run(client, ctx, headers, **knobs)
    resp = await client.post(f"/v1/runs/{run['id']}/start", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _read(client, ctx, run_id) -> dict:
    resp = await client.get(f"/v1/runs/{run_id}", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _at_checkpoint(client, ctx) -> dict:
    run = await _started(client, ctx)
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint", run
    return run


def _pending(run) -> dict:
    return next(c for c in run["checkpoints"] if c["status"] == "pending")


def _decide(client, run, headers, decision="approved", note=None):
    cp = _pending(run)
    return client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": decision, "note": note},
        headers=headers,
    )


class _Blocked:
    """Holds one runtime call (submit or cancel) until released: SwarmCloud being slow."""

    def __init__(self, runtime: FakeRuntime, method: str) -> None:
        self.entered, self.release = asyncio.Event(), asyncio.Event()
        real = getattr(runtime, method)

        async def slow(*args, **kwargs):
            self.entered.set()
            await self.release.wait()
            return await real(*args, **kwargs)

        setattr(runtime, method, slow)


# --- ITEM 1a: a checkpoint decision re-checks the caller under the gate ---------------


@pytest.mark.parametrize("how", ["disabled", "demoted", "token_revoked"])
@pytest.mark.parametrize("decision", ["approved", "changes_requested"])
async def test_a_checkpoint_decision_by_an_approver_who_lost_standing_is_refused(
    client, monkeypatch, runtime, how, decision
):
    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    token_id, bearer = await member_token(ctx, approver.user_id, "approver-agent")
    headers = bearer if how == "token_revoked" else approver.headers
    fired = _lose_on_first_gate(monkeypatch, ctx, how, approver.user_id, token_id)
    resp = await _decide(client, run, headers, decision, "Cite G1")
    assert fired, "the decision did not take the gate"
    assert resp.status_code == 403, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert _pending(run)["decided_by"] is None
    assert len(runtime.submitted) == 1  # nothing more was submitted, nothing spent


async def test_an_active_approver_still_decides_a_checkpoint(client, runtime):
    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    resp = await _decide(client, run, approver.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"
    assert resp.json()["segments"][1]["status"] == "running"
    assert len(runtime.submitted) == 2


@pytest.mark.parametrize("decision", ["approved", "changes_requested"])
async def test_a_disable_racing_a_checkpoint_decision_voids_it(client, runtime, decision):
    """Approver B decides a checkpoint; while SwarmCloud takes its time over the
    segment B's decision starts, owner A disables B. The disable does not wait for
    SwarmCloud, and B's decision is void: the checkpoint waits again, the workflow
    submitted for it is cancelled, nothing more runs for it."""
    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    first_workflow = runtime.submitted[0].labels
    approver = await person(ctx.tenant_id, "approver", "approver")
    blocked = _Blocked(runtime, "submit")
    decided = asyncio.create_task(_decide(client, run, approver.headers, decision, "Cite G1"))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, approver.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not decided.done()
    finally:
        blocked.release.set()
    resp = await decided
    assert resp.status_code == 200, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint", run
    cp = _pending(run)
    assert cp["decided_by"] is None and cp["decided_at"] is None
    # The workflow SwarmCloud started for the void decision is cancelled at once.
    assert len(runtime.submitted) == 2
    assert len(runtime.cancelled) == 1
    assert runtime.cancelled[0].startswith(f"fake-{runtime.submitted[1].labels['segment']}-")
    seg = run["segments"]
    assert seg[0]["status"] == "succeeded" and seg[1]["status"] == "pending"
    assert seg[0]["attempts"][-1]["attempt"] == int(first_workflow["attempt"])
    async with tenant_session(ctx.tenant_id) as s:
        voided = list(
            await s.scalars(
                select(AuditEvent).where(AuditEvent.action == "checkpoint.decision_voided")
            )
        )
        assert [e.data["decided_by"] for e in voided] == [str(approver.user_id)]
    # A tick submits nothing for it.
    await _tick(client, ctx)
    assert len(runtime.submitted) == 2
    # Another approver decides it again; the next segment starts.
    other = await person(ctx.tenant_id, "approver", "other")
    resp = await _decide(client, await _read(client, ctx, run["id"]), other.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "running"


async def test_a_disable_voids_a_decision_whose_submission_is_waiting_for_a_retry(client, runtime):
    """The runtime refused the submission a decision started (it waits for the tick's
    retry); the decider is disabled: the decision is void, the tick submits nothing."""
    from oracle.swarm import RuntimeUnavailable

    ctx = await setup(client)
    run = await _at_checkpoint(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    real = runtime.submit

    async def down(spec):
        raise RuntimeUnavailable("SwarmCloud is down")

    runtime.submit = down
    resp = await _decide(client, run, approver.headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["segments"][1]["status"] == "pending"
    runtime.submit = real
    assert (await disable(client, ctx, approver.user_id)).status_code == 200
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert len(runtime.submitted) == 1


# --- ITEM 1b: the other approver-only branches re-check under the gate ----------------


@pytest.mark.parametrize("how", ["disabled", "demoted"])
async def test_an_approver_section_edit_by_one_who_lost_standing_is_refused(
    client, monkeypatch, how
):
    from oracle.docs.models import DocumentVersion

    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    rev = (await states(client, ctx.auth, 1))["problem"]["revision"]
    fired = _lose_on_first_gate(monkeypatch, ctx, how, approver.user_id)
    resp = await edit(client, approver.headers, "problem", 1, rev, "Rewritten.")
    assert fired, "the edit did not take the gate"
    assert resp.status_code == 403, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(DocumentVersion.id).where(DocumentVersion.number == 2)) is None


async def test_an_active_approver_still_edits_any_section(client):
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    rev = (await states(client, ctx.auth, 1))["problem"]["revision"]
    resp = await edit(client, approver.headers, "problem", 1, rev, "Rewritten.")
    assert resp.status_code == 201, resp.text


@pytest.mark.parametrize("how", ["disabled", "demoted"])
async def test_an_owner_cancelling_someone_elses_run_after_losing_standing_is_refused(
    client, monkeypatch, runtime, how
):
    """Owner B cancels a run approver A created; B is demoted to approver (or disabled)
    while the request waits on the gate: an approver cancels only their own runs."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)
    owner = await person(ctx.tenant_id, "owner", "owner")
    fired = _lose_on_first_gate(monkeypatch, ctx, how, owner.user_id)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=owner.headers)
    assert fired
    assert resp.status_code == 403, resp.text
    assert (await _read(client, ctx, run["id"]))["status"] == "running"
    assert runtime.cancelled == []


async def test_an_owner_and_the_creator_still_cancel(client, runtime):
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    owner = await person(ctx.tenant_id, "owner", "owner")
    for headers in (owner.headers, author.headers):
        run = await _started(client, ctx, author.headers)
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=headers)
        assert resp.status_code == 200, resp.text
        assert resp.json()["status"] == "cancelled"
    assert len(runtime.cancelled) == 2


async def _evidence(ctx, added_by=None) -> uuid.UUID:
    from oracle.baseline.models import Entity, Evidence

    async with tenant_session(ctx.tenant_id) as s:
        feature = Entity(
            type="feature", key=f"calendar-{uuid.uuid4().hex[:6]}", title="Calendar", origin="user"
        )
        s.add(feature)
        await s.flush()
        ev = Evidence(
            entity_id=feature.id,
            url="https://example.com/calendar-survey",
            excerpt="Teams miss shared deadlines.",
            confidence=Decimal("0.7"),
            kind="web" if added_by else None,
            added_by=added_by,
        )
        s.add(ev)
        await s.commit()
        return ev.id


@pytest.mark.parametrize("how", ["disabled", "demoted"])
async def test_an_approver_removing_evidence_after_losing_standing_is_refused(
    client, monkeypatch, how
):
    from oracle.baseline.models import Evidence

    ctx = await setup(client)
    evidence_id = await _evidence(ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    fired = _lose_on_first_gate(monkeypatch, ctx, how, approver.user_id)
    resp = await client.delete(f"/v1/baseline/evidence/{evidence_id}", headers=approver.headers)
    assert fired, "the removal did not take the gate"
    assert resp.status_code == 403, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(Evidence, evidence_id) is not None


async def test_an_approver_and_the_commenter_who_added_a_link_still_remove_it(client):
    ctx = await setup(client)
    approver = await person(ctx.tenant_id, "approver", "approver")
    commenter = await person(ctx.tenant_id, "commenter", "commenter")
    theirs = await _evidence(ctx)
    resp = await client.delete(f"/v1/baseline/evidence/{theirs}", headers=approver.headers)
    assert resp.status_code == 204, resp.text
    mine = await _evidence(ctx, added_by=commenter.user_id)
    resp = await client.delete(f"/v1/baseline/evidence/{mine}", headers=commenter.headers)
    assert resp.status_code == 204, resp.text


async def _comment(client, ctx) -> str:
    resp = await client.post(
        f"/v1/documents/{DOC}/versions/1/comments",
        json={
            "section_key": "problem",
            "anchor": {"exact": "shared deadlines", "prefix": "", "suffix": ""},
            "body": "Which teams?",
        },
        headers=ctx.auth,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


@pytest.mark.parametrize("how", ["disabled", "demoted"])
async def test_an_approver_moderating_a_comment_after_losing_standing_is_refused(
    client, monkeypatch, how
):
    ctx = await setup(client)
    comment_id = await _comment(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    fired = _lose_on_first_gate(monkeypatch, ctx, how, approver.user_id)
    resp = await client.patch(
        f"/v1/comments/{comment_id}", json={"resolved": True, "body": "Rewritten"},
        headers=approver.headers,
    )  # fmt: skip
    assert fired, "the moderation did not take the gate"
    assert resp.status_code == 403, resp.text
    comments = await client.get(f"/v1/documents/{DOC}/versions/1/comments", headers=ctx.auth)
    [comment] = comments.json()
    assert comment["resolved_at"] is None and comment["body"] == "Which teams?"


async def test_an_approver_still_moderates_and_an_author_still_edits_their_own(client):
    ctx = await setup(client)
    comment_id = await _comment(client, ctx)
    approver = await person(ctx.tenant_id, "approver", "approver")
    resp = await client.patch(
        f"/v1/comments/{comment_id}", json={"resolved": True}, headers=approver.headers
    )
    assert resp.status_code == 200, resp.text
    resp = await client.patch(
        f"/v1/comments/{comment_id}", json={"body": "Which teams, exactly?"}, headers=ctx.auth
    )
    assert resp.status_code == 200, resp.text


# --- ITEM 2: the review gate is not held across a SwarmCloud call -----------------------


async def _prepare(client, ctx, runtime, route: str) -> tuple[dict, str]:
    """A run ready for ``route``, and the runtime call the route makes."""
    if route == "start":
        return await _run(client, ctx), "submit"
    if route == "approve":
        run = await _started(client, ctx, depth="deep")
        assert run["status"] == "awaiting_approval"
        return run, "submit"
    if route == "resume":
        # Paused on overrun with its segment finished and its checkpoint off: resuming
        # submits the next segment.
        runtime.script["baseline"] = [Outcome(cost_usd=Decimal(50), polls=1)]
        run = await _started(client, ctx, checkpoints={"baseline_confirm": False})
        await _tick(client, ctx)
        await _tick(client, ctx)
        run = await _read(client, ctx, run["id"])
        assert run["status"] == "paused_overrun", run
        return run, "submit"
    if route == "cancel":
        return await _started(client, ctx), "cancel"
    return await _at_checkpoint(client, ctx), "submit"


async def _call(client, ctx, route: str, run: dict):
    if route == "decide":
        return await _decide(client, run, ctx.auth)
    return await client.post(f"/v1/runs/{run['id']}/{route}", headers=ctx.auth)


@pytest.mark.parametrize("route", ["start", "approve", "resume", "cancel", "decide"])
async def test_a_slow_runtime_call_does_not_hold_the_gate(client, runtime, route):
    """The route's SwarmCloud call hangs; a disable of another member, which takes the
    gate exclusively, completes while the call is still waiting."""
    ctx = await setup(client)
    bystander = await person(ctx.tenant_id, "approver", "bystander")
    run, method = await _prepare(client, ctx, runtime, route)
    calls_before = len(runtime.submitted) + len(runtime.cancelled)
    blocked = _Blocked(runtime, method)
    call = asyncio.create_task(_call(client, ctx, route, run))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, bystander.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        assert not call.done(), "the call was not under way"
    finally:
        blocked.release.set()
    resp = await call
    assert resp.status_code == 200, resp.text
    assert len(runtime.submitted) + len(runtime.cancelled) == calls_before + 1
    expected = "cancelled" if route == "cancel" else "running"
    assert resp.json()["status"] == expected, resp.json()


async def test_a_disable_racing_a_start_cancels_the_workflow_it_submitted(client, runtime):
    """Approver B starts their run; while SwarmCloud takes its time, B is disabled: the
    disable does not wait, the run is cancelled, and the workflow that SwarmCloud
    started for it is cancelled as soon as Oracle hears of it."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _run(client, ctx, author.headers)
    blocked = _Blocked(runtime, "submit")
    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/start", headers=author.headers))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, author.user_id), WAIT)
        assert resp.status_code == 200, resp.text
    finally:
        blocked.release.set()
    resp = await call
    assert resp.status_code == 200, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "cancelled"
    assert len(runtime.submitted) == 1 and len(runtime.cancelled) == 1
    async with tenant_session(ctx.tenant_id) as s:
        seg = await s.scalar(select(RunSegment).where(RunSegment.seq == 1))
        assert seg.status == "cancelled" and seg.swarm_workflow_id is None
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "run.workflow_cancelled")
        )
        assert event.data["workflow_id"] == runtime.cancelled[0]


async def test_a_disable_racing_an_approve_voids_it_and_cancels_the_workflow(client, runtime):
    """Owner B approves a run's cost; while SwarmCloud takes its time, B is disabled:
    the approval is void (the run waits for an owner again) and the workflow is
    cancelled."""
    ctx = await setup(client)
    run = await _started(client, ctx, depth="deep")
    owner = await person(ctx.tenant_id, "owner", "owner")
    blocked = _Blocked(runtime, "submit")
    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/approve", headers=owner.headers))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await asyncio.wait_for(disable(client, ctx, owner.user_id), WAIT)
        assert resp.status_code == 200, resp.text
    finally:
        blocked.release.set()
    assert (await call).status_code == 200
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_approval", run
    assert len(runtime.cancelled) == 1
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        assert row.approved_by is None
        seg = await s.scalar(select(RunSegment).where(RunSegment.seq == 1))
        assert seg.status == "pending" and seg.swarm_workflow_id is None
    await _tick(client, ctx)
    assert len(runtime.submitted) == 1


async def test_a_submission_lost_after_commit_is_made_by_the_tick(client, runtime, monkeypatch):
    """The state change commits, then the process dies before SwarmCloud is called: the
    next tick makes the submission."""
    from oracle.runs import service

    async def die(db, run_id):
        raise RuntimeError("the process died")

    ctx = await setup(client)
    run = await _run(client, ctx)
    monkeypatch.setattr(service, "submit_queued", die)
    with pytest.raises(RuntimeError):
        await client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth)
    monkeypatch.undo()
    assert runtime.submitted == []
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(Run, uuid.UUID(run["id"]))).status == "running"
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["segments"][0]["status"] == "running"
    assert len(runtime.submitted) == 1


async def test_a_claimed_submission_is_not_made_twice_by_the_tick(client, runtime):
    """A tick that runs while a route's submission is under way leaves it alone."""
    ctx = await setup(client)
    run = await _run(client, ctx)
    blocked = _Blocked(runtime, "submit")
    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        await asyncio.wait_for(_tick(client, ctx), WAIT)
    finally:
        blocked.release.set()
    assert (await call).status_code == 200
    assert len(runtime.submitted) == 1
    assert (await _read(client, ctx, run["id"]))["segments"][0]["status"] == "running"


async def test_a_failed_cancel_of_a_workflow_started_for_a_changed_run_is_retried(
    client, runtime, monkeypatch
):
    """The run was cancelled while its submission was under way, and the runtime does
    not confirm the cancel of the workflow it started: it stays on the run's searches
    (its spend read) and the tick cancels it again (round 8: main's searches, not a
    run_cancel follow-up)."""
    from datetime import timedelta

    from oracle.runs import service
    from oracle.swarm import RuntimeUnavailable

    ctx = await setup(client)
    run = await _run(client, ctx)
    blocked = _Blocked(runtime, "submit")
    real_cancel = runtime.cancel

    async def down(workflow_id):
        raise RuntimeUnavailable("SwarmCloud is down")

    call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/start", headers=ctx.auth))
    try:
        await asyncio.wait_for(blocked.entered.wait(), WAIT)
        resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        assert resp.status_code == 200, resp.text
        runtime.cancel = down
    finally:
        blocked.release.set()
    assert (await call).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        [entry] = row.knobs["searches"]
    assert entry["id"].startswith("fake-baseline") and not entry.get("cancelled")
    assert runtime.cancelled == []
    runtime.cancel = real_cancel
    real_now = service._now
    monkeypatch.setattr(
        service, "_now", lambda: real_now() + timedelta(seconds=service.STUCK_LOOKUP_SECONDS + 1)
    )
    await _tick(client, ctx)
    assert runtime.cancelled == [entry["id"]]


# --- MINORS --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "spelling", ["{{URN:UUID:{u}}}", "UUID:{u}", "URN:{u}", "Uuid:{h}", "{{urn:uuid:{U}}}"]
)
def test_external_key_reads_every_uuid_spelling_in_any_case(spelling):
    from oracle.review.publish import _as_uuid, external_key

    u = uuid.UUID("12345678-9abc-def0-1234-56789abcdef0")
    value = spelling.format(u=u, U=str(u).upper(), h=u.hex)
    assert external_key(value) == str(u)
    assert _as_uuid(value) == u


@pytest.mark.parametrize(
    "stored", ["uuid:{u}", "URN:{u}", "UUID:{h}", "{{URN:UUID:{u}}}", " urn:uuid:{U} "]
)
async def test_a_stored_id_in_any_uuid_spelling_reads_as_its_hex_in_sql(client, stored):
    from sqlalchemy import literal

    from oracle.review.publish import _hex32

    ctx = await setup(client)
    u = uuid.uuid4()
    value = stored.format(u=u, U=str(u).upper(), h=u.hex)
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(_hex32(literal(value)))) == u.hex


async def _disabled_with_connection(client, ctx, monkeypatch, outcome="failed"):
    from oracle.connections import service as connections
    from tests.test_review_v2_security_5 import _always, add_connection

    pm = await person(ctx.tenant_id, "approver", "pm")
    await add_connection(ctx, pm.user_id, "gh-1")
    monkeypatch.setattr(connections, "revoke_at_provider", _always(outcome))
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    return pm


async def _due(ctx) -> None:
    from oracle.members.models import MemberFollowUp

    async with tenant_session(ctx.tenant_id) as s:
        for row in await s.scalars(select(MemberFollowUp)):
            row.next_attempt_at = datetime.now(UTC)
        await s.commit()


async def test_follow_ups_still_run_when_an_earlier_part_of_the_tick_fails(client, monkeypatch):
    from oracle.connections import service as connections
    from oracle.members.models import MemberFollowUp
    from oracle.runs import router as runs_router
    from tests.test_review_v2_security_5 import _always

    ctx = await setup(client)
    await _disabled_with_connection(client, ctx, monkeypatch)
    await _due(ctx)

    async def broken(tenant_id, **kwargs):
        raise RuntimeError("the model jobs broke")

    monkeypatch.setattr(runs_router, "run_llm_jobs", broken)
    monkeypatch.setattr(connections, "revoke_at_provider", _always("revoked"))
    with pytest.raises(RuntimeError):
        await client.post("/v1/internal/tick", headers=ctx.auth)
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalar(select(MemberFollowUp))).status == "done"


async def test_a_successful_revoke_that_fails_to_save_is_not_shown_as_a_failure(
    client, monkeypatch
):
    """The provider revoked the grant, then saving that failed: the next attempt
    records the success without asking the provider again (a second revoke of a dead
    grant fails), and owners never see it as "Couldn't revoke"."""
    from oracle.connections import service as connections
    from oracle.members import service as members
    from oracle.members.models import MemberFollowUp
    from tests.test_review_v2_security_5 import _always, _revoke_failures

    ctx = await setup(client)
    await _disabled_with_connection(client, ctx, monkeypatch)
    await _due(ctx)
    real_record = members.audit.record
    broke: list[bool] = []

    async def record_once(session, *args, **kwargs):
        if args[1] == "connection.provider_revoke" and not broke:
            broke.append(True)
            raise RuntimeError("the database went away")
        return await real_record(session, *args, **kwargs)

    calls: list = []
    monkeypatch.setattr(connections, "revoke_at_provider", _always("revoked", calls))
    monkeypatch.setattr(members.audit, "record", record_once)
    await _tick(client, ctx)
    assert broke and len(calls) == 1
    assert await _revoke_failures(client, ctx.auth) == []
    # The provider now refuses: the grant is gone. The next attempt does not ask it.
    monkeypatch.setattr(connections, "revoke_at_provider", _always("failed", calls))
    await _due(ctx)
    await _tick(client, ctx)
    assert len(calls) == 1
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(MemberFollowUp))
        assert row.status == "done" and row.outcome == "revoked" and row.ciphertext is None
    assert await _revoke_failures(client, ctx.auth) == []


async def test_a_budget_that_runs_out_mid_query_does_not_cut_the_query_or_fail_the_tick(
    client, monkeypatch, runtime
):
    """The tick's follow-up budget runs out while a follow-up is reading the database:
    only network calls are timed, so the query is not cancelled halfway (that can leave
    the session unusable and the tick a 500); the tick answers."""
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import AsyncSession

    from oracle.members import service as members
    from oracle.members.models import MemberFollowUp

    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)
    assert (await disable(client, ctx, author.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        s.add(
            MemberFollowUp(
                member_id=author.user_id,
                kind="run_recheck",
                target_id=uuid.UUID(run["id"]),
                status="pending",
                attempts=1,
                next_attempt_at=datetime.now(UTC),
            )
        )
        await s.commit()
    real_scalar = AsyncSession.scalar

    async def slow_scalar(self, statement, *args, **kwargs):
        described = getattr(statement, "column_descriptions", None) or [{}]
        if described[0].get("entity") is Run and "FOR UPDATE" in str(statement):
            await self.execute(text("SELECT pg_sleep(2)"))
        return await real_scalar(self, statement, *args, **kwargs)

    monkeypatch.setattr(AsyncSession, "scalar", slow_scalar)
    monkeypatch.setattr(members, "FOLLOW_UP_TICK_BUDGET_SECONDS", 0.5)
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    monkeypatch.undo()
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(MemberFollowUp).where(MemberFollowUp.kind == "run_recheck"))
        assert row.status == "done" and row.attempts == 2


async def test_the_sweep_rereads_what_it_revokes_after_taking_the_gate(client, monkeypatch):
    """A token created while the sweep waited on the gate is revoked and named in its
    audit; one revoked meanwhile is not named."""
    from oracle.members.service import sweep_disabled
    from oracle.review import publish

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    early, _ = await member_token(ctx, pm.user_id, "slipped-in")
    late: list[uuid.UUID] = []
    real = publish.gate_lock

    async def spy(db, *, shared):
        monkeypatch.setattr(publish, "gate_lock", real)
        token_id, _ = await member_token(ctx, pm.user_id, "slipped-in-later")
        late.append(token_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    async with tenant_session(ctx.tenant_id) as s:
        assert await sweep_disabled(s, None, pm.user_id) is True
    async with tenant_session(ctx.tenant_id) as s:
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "member.disable_sweep")
        )
        assert sorted(event.data["api_tokens"]) == sorted([str(early), str(late[0])])


async def test_the_sweep_cancels_a_job_queued_for_a_disabled_member(client):
    """The reporting job an import queued for its requester, committed after the
    requester's disable: the sweep cancels it."""
    from oracle.docs.models import Document
    from oracle.jobs.models import LlmJob
    from oracle.members.service import sweep_disabled

    ctx = await setup(client)
    pm = await person(ctx.tenant_id, "approver", "pm")
    assert (await disable(client, ctx, pm.user_id)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        doc_id = await s.scalar(select(Document.id).where(Document.slug == DOC))
        job = LlmJob(kind="reporting", document_id=doc_id, requested_by=pm.user_id)
        s.add(job)
        await s.commit()
        job_id = job.id
    async with tenant_session(ctx.tenant_id) as s:
        assert await sweep_disabled(s, None, pm.user_id) is True
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.get(LlmJob, job_id)).status == "cancelled"
