"""PR #128, security review round 7: nothing is held across a SwarmCloud call (the review
gate, a run's row lock), an Inbox decision is recorded under the gate and posted after it,
and every approver/owner write under /v1/runs re-checks the caller under the gate (CR-06).
Synthetic placeholders only."""

import inspect
import uuid
from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from oracle.main import app
from oracle.models import AuditEvent
from oracle.review import publish
from oracle.runs import service
from oracle.runs.models import Run
from oracle.swarm import set_runtime
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.review_v2_helpers import DOC, person
from tests.review_v2_helpers import setup as review_setup
from tests.test_adapter_v2 import (
    _decide_raw,
    _waiting,
    feedback_doc,
    on,
)
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_review_v2_security_6 import (
    _at_checkpoint,
    _lose,
    _lose_on_first_gate,
    _read,
    _run,
    _started,
)
from tests.test_review_v2_security_6 import runtime as runtime  # the FakeRuntime fixture
from tests.test_runs import decide, get, started, tick

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings


@pytest.fixture
async def owner():
    return await seed_auth()


# --- nothing is held across a runtime call ---------------------------------------------


class Probe:
    """A runtime that checks, before each call it forwards, that nothing is held across
    it: no row lock on any run, and not the review gate (both tried from another
    connection)."""

    def __init__(self, inner, tenant_id) -> None:
        self.inner, self.tenant_id, self.held = inner, tenant_id, []

    def __getattr__(self, name):
        attr = getattr(self.inner, name)
        if not inspect.iscoroutinefunction(attr):
            return attr

        async def call(*args, **kwargs):
            await self.check(name)
            return await attr(*args, **kwargs)

        return call

    async def check(self, name: str) -> None:
        key = f"oracle-review-gate:{self.tenant_id}"
        async with tenant_session(self.tenant_id) as s:
            free = await s.scalar(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": key}
            )
            if not free:
                self.held.append(f"{name}: the review gate")
            await s.rollback()
        async with tenant_session(self.tenant_id) as s:
            try:
                await s.execute(select(Run.id).with_for_update(nowait=True))
            except DBAPIError:
                self.held.append(f"{name}: a run's row lock")
            await s.rollback()


def probed(swarm, tenant_id) -> Probe:
    probe = Probe(swarm.runtime(), tenant_id)
    set_runtime(probe)
    return probe


async def test_start_tick_and_decision_hold_nothing_across_swarmcloud(client, owner):
    """Start (features, MCP registration, submit), the tick's reads (status, artifacts,
    a wait) and an Inbox decision's answer post: none with the gate or a run's row
    lock held."""
    tenant_id, auth = owner
    swarm = on()
    probe = probed(swarm, tenant_id)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    await tick(client, auth)  # reads the open wait
    run = await decide(client, auth, run, "changes_requested", note="Tighten the scope")
    assert len(swarm.answers) == 1
    await tick(client, auth)
    assert probe.held == []


async def test_a_late_decision_cancels_and_submits_with_nothing_held(client, owner, monkeypatch):
    """Under the tail the decision cancels the waiting workflow and continues as a new
    one: the cancel and the submit are made outside the gate and the row lock."""
    tenant_id, auth = owner
    swarm = on()
    probe = probed(swarm, tenant_id)
    await feedback_doc(client, auth, tenant_id)
    run = await started(client, auth, flow="feedback_loop", document="checkout-redesign")
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    real_now = service._now
    monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(hours=23))
    run = await decide(client, auth, run, "changes_requested", note="Still too broad")
    assert swarm.workflows["wf_1"].state == "CANCELLED" and len(swarm.submissions()) == 2
    assert run["status"] == "running"
    assert probe.held == []


async def test_a_retried_lost_submission_is_queued_and_nothing_is_held(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    probe = probed(swarm, tenant_id)
    swarm.other_tasks = 1100  # the lost submission is behind newer tasks
    swarm.lose_next_submit = True
    run = await started(client, auth)
    real_now = service._now
    monkeypatch.setattr(
        service, "_now", lambda: real_now() + timedelta(seconds=service.LOST_LOOKUP_SECONDS + 60)
    )
    await tick(client, auth)
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["segments"][0]["workflow_id"] == "wf_2"
    await tick(client, auth)  # looks for the abandoned one
    assert probe.held == []


async def test_an_unconfirmed_cancel_is_retried_by_the_tick_with_nothing_held(client, owner):
    tenant_id, auth = owner
    swarm = on()
    probe = probed(swarm, tenant_id)
    run = await started(client, auth)
    swarm.fail_cancels = 1
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    await tick(client, auth)
    await tick(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    assert probe.held == []


# --- an Inbox decision is recorded first; a failed post is the tick's ------------------

_UNAVAILABLE = {"code": "unavailable", "message": "try later", "detail": {"reason": "unavailable"}}


async def test_a_refused_post_leaves_the_decision_recorded_for_the_tick(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.fail_next_answer = httpx.Response(503, json=_UNAVAILABLE)
    resp = await _decide_raw(client, auth, run, "changes_requested", "Cover returns")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    run = await get(client, auth, run["id"])
    # Recorded: nothing left to decide again, nothing posted yet.
    assert [c["status"] for c in run["checkpoints"]] == ["changes_requested"]
    assert swarm.answers == [] and run["status"] == "awaiting_checkpoint"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert len(swarm.answers) == 1 and len(swarm.submissions()) == 1
    assert run["status"] == "running"
    await tick(client, auth)
    assert len(swarm.answers) == 1  # never answered twice


async def test_a_lost_answer_is_replayed_by_the_tick_never_doubled(client, owner):
    tenant_id, auth = owner
    swarm = on()
    run = await _waiting(client, auth, tenant_id, swarm)
    swarm.lose_next_answer = True  # recorded by SwarmCloud, the response lost
    resp = await _decide_raw(client, auth, run, "changes_requested", "Add a guardrail metric")
    assert resp.status_code == 503 and "recorded" in resp.text, resp.text
    assert len(swarm.answers) == 1
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert len(swarm.answers) == 1 and len(swarm.submissions()) == 1
    assert run["status"] == "running"


# --- CR-06: every approver/owner write under /v1/runs re-checks the caller -------------

# Every write route under /v1/runs and the role it needs. A new route must be listed here,
# and so is walked by the test below: a caller who loses standing between authenticating
# and writing is refused under the gate.
WRITE_ROUTES = {
    ("post", "/v1/runs"): "approver",
    ("patch", "/v1/runs/{run_id}"): "approver",
    ("post", "/v1/runs/{run_id}/estimate"): "approver",
    ("post", "/v1/runs/{run_id}/start"): "approver",
    ("post", "/v1/runs/{run_id}/approve"): "owner",
    ("post", "/v1/runs/{run_id}/resume"): "owner",
    ("post", "/v1/runs/{run_id}/retry"): "approver",
    ("post", "/v1/runs/{run_id}/cancel"): "approver",
    ("post", "/v1/runs/{run_id}/stop-cancelling"): "approver",
    ("post", "/v1/runs/{run_id}/retry-lookup"): "approver",
    ("post", "/v1/runs/{run_id}/retry-import"): "owner",
    ("post", "/v1/runs/{run_id}/segments/{seq}/retry-draft-import"): "approver",
    ("post", "/v1/runs/{run_id}/cancel-again"): "approver",
    ("post", "/v1/runs/{run_id}/dismiss-overrun"): "approver",
    ("post", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide"): "approver",
}


def test_every_run_write_route_is_walked():
    found = {
        (method, path)
        for path, item in app.openapi()["paths"].items()
        if path.startswith("/v1/runs")
        for method in item
        if method in ("post", "put", "patch", "delete")
    }
    assert found == set(WRITE_ROUTES), (
        "a write route under /v1/runs is not in WRITE_ROUTES (or one was removed): add it, "
        "and make it re-check the caller under the gate (CR-06)"
    )


@pytest.mark.parametrize("route", sorted(WRITE_ROUTES), ids=lambda r: f"{r[0]} {r[1]}")
@pytest.mark.parametrize("how", ["demoted", "disabled"])
async def test_a_caller_who_lost_standing_before_the_write_is_refused(
    client, monkeypatch, runtime, route, how
):
    method, template = route
    role = WRITE_ROUTES[route]
    ctx = await review_setup(client)
    caller = await person(ctx.tenant_id, role, "caller")
    body = None
    if template.endswith("/decide") or "retry-draft-import" in template:
        run = await _at_checkpoint(client, ctx)
        checkpoint_id = next(c["id"] for c in run["checkpoints"] if c["status"] == "pending")
    elif template == "/v1/runs":
        run, checkpoint_id = {"id": "unused"}, "unused"
        body = {"flow": "baseline_to_prd", "document": DOC, "knobs": {}}
    else:
        run, checkpoint_id = await _run(client, ctx), "unused"
    if template.endswith("/decide"):
        body = {"decision": "approved", "note": None}
    elif template.endswith("/cancel-again"):
        body = {"workflow_id": "wf_unused"}
    elif method == "patch":
        body = {"knobs": {}}
    path = template.format(run_id=run["id"], seq=1, checkpoint_id=checkpoint_id)
    fired = _lose_on_first_gate(monkeypatch, ctx, how, caller.user_id)
    resp = await client.request(method.upper(), path, json=body, headers=caller.headers)
    assert fired, f"{method.upper()} {template} did not take the gate"
    assert resp.status_code == 403, resp.text


@pytest.mark.parametrize("how", ["demoted", "disabled"])
async def test_cancel_re_checks_the_caller_after_its_runtime_calls(
    client, monkeypatch, runtime, how
):
    """Cancel releases the gate its dependency took while it calls the runtime; the write
    that follows takes it again and re-reads the caller. Here the caller loses standing
    between the two."""
    ctx = await review_setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)

    real = publish.gate_lock
    takes: list[bool] = []

    async def spy(db, *, shared):
        takes.append(True)
        if len(takes) == 2:
            await _lose(ctx, how, author.user_id)
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", spy)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=author.headers)
    assert len(takes) >= 2, "the write after the runtime calls did not take the gate again"
    assert resp.status_code == 403, resp.text
    assert (await _read(client, ctx, run["id"]))["status"] == "running"


# --- CR-06 after a runtime call: standing lost WHILE SwarmCloud answers ----------------
#
# A write route that calls SwarmCloud while it handles the request does so with the gate
# released (nothing is held across a call), so the caller may lose standing during the
# call. One that writes on what the call returned takes the gate again and re-reads the
# caller before it writes: 403, nothing written (DURING, with the call to lose standing
# in). One whose only call submits what its write queued, after the write committed, needs
# no re-read: the write was the caller's while they had standing, and a disable cancels
# or voids what it started (oracle.members.service.disable_member; AFTER_COMMIT). Every
# other write route makes no runtime call (NO_CALL). A new route must be put in one.
DURING = {
    ("post", "/v1/runs/{run_id}/retry"): "find_by_label",
    ("post", "/v1/runs/{run_id}/retry-lookup"): "status",
    ("post", "/v1/runs/{run_id}/cancel"): "cancel",
}
AFTER_COMMIT = {
    ("post", "/v1/runs/{run_id}/start"),
    ("post", "/v1/runs/{run_id}/approve"),
    ("post", "/v1/runs/{run_id}/resume"),
    ("post", "/v1/runs/{run_id}/checkpoints/{checkpoint_id}/decide"),
}
NO_CALL = {
    ("post", "/v1/runs"),
    ("patch", "/v1/runs/{run_id}"),
    ("post", "/v1/runs/{run_id}/estimate"),
    ("post", "/v1/runs/{run_id}/stop-cancelling"),
    ("post", "/v1/runs/{run_id}/retry-import"),
    ("post", "/v1/runs/{run_id}/segments/{seq}/retry-draft-import"),
    ("post", "/v1/runs/{run_id}/cancel-again"),
    ("post", "/v1/runs/{run_id}/dismiss-overrun"),
}


def test_every_run_write_route_says_whether_it_calls_swarmcloud():
    kinds = [set(DURING), AFTER_COMMIT, NO_CALL]
    assert sum(len(k) for k in kinds) == len(set().union(*kinds)), "a route is in two lists"
    assert set().union(*kinds) == set(WRITE_ROUTES), (
        "a write route under /v1/runs is not in DURING, AFTER_COMMIT or NO_CALL: say whether "
        "it calls SwarmCloud, and if it writes on what the call returned, re-check the caller "
        "under the gate after the call (CR-06)"
    )


class LoseDuring:
    """The runtime, except that its first call to the armed method makes the caller lose
    standing (a disable or a demotion committed while SwarmCloud answers) before it is
    forwarded."""

    def __init__(self, inner, tenant_id) -> None:
        self.inner, self.tenant_id = inner, tenant_id
        self.armed: tuple | None = None
        self.fired: list[str] = []

    def arm(self, method: str, how: str, user_id) -> None:
        self.armed = (method, how, user_id)

    def __getattr__(self, name):
        attr = getattr(self.inner, name)
        if not inspect.iscoroutinefunction(attr):
            return attr

        async def call(*args, **kwargs):
            if self.armed is not None and self.armed[0] == name:
                _, how, user_id = self.armed
                self.armed = None
                await _lose(SimpleNamespace(tenant_id=self.tenant_id), how, user_id)
                self.fired.append(name)
            return await attr(*args, **kwargs)

        return call


async def _knobs(tenant_id, run_id) -> dict:
    async with tenant_session(tenant_id) as s:
        return dict((await s.get(Run, uuid.UUID(run_id))).knobs or {})


async def _audits(tenant_id, action: str) -> int:
    async with tenant_session(tenant_id) as s:
        return len(list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action))))


async def _stuck_lookup(client, auth, headers, swarm, tenant_id, monkeypatch) -> dict:
    """A run whose lost submission is past the lookup cap (Inbox: Retry)."""
    swarm.other_tasks = 1100  # the lost submission is behind newer tasks
    swarm.lose_next_submit = True
    run = await started(client, headers)
    real_now = service._now
    monkeypatch.setattr(
        service, "_now", lambda: real_now() + timedelta(seconds=service.LOST_LOOKUP_SECONDS + 60)
    )
    await tick(client, auth)
    assert (await _knobs(tenant_id, run["id"])).get("stuck_lookup")
    return run


async def _cost_unknown(client, headers, tenant_id) -> dict:
    """A run with a searched workflow whose cost is unknown (Inbox: Retry lookup), one
    Oracle no longer cancels: Retry lookup reads its status."""
    run = await started(client, headers)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        entry = {"id": "wf_1", "seq": 1, "label": "oracle-r-baseline-1", "cost_unknown": True}
        row.knobs = {**(row.knobs or {}), "searches": [{**entry, "cancel": False}]}
        await s.commit()
    return run


@pytest.mark.parametrize("route", sorted(DURING), ids=lambda r: f"{r[0]} {r[1]}")
@pytest.mark.parametrize("how", ["demoted", "disabled"])
@pytest.mark.parametrize("who", ["creator", "owner"])
async def test_a_caller_who_lost_standing_during_the_runtime_call_is_refused(
    client, monkeypatch, route, how, who
):
    """``creator``: the approver who created the run; ``owner``: an owner who did not.
    Either loses standing while SwarmCloud answers the route's call: 403, and what the
    route writes after the call is not written."""
    method, template = route
    tenant_id, auth = await seed_auth()
    swarm = on()
    lose = LoseDuring(swarm.runtime(), tenant_id)
    set_runtime(lose)
    author = await person(tenant_id, "approver", "author")
    caller = author if who == "creator" else await person(tenant_id, "owner", "owner")
    creator = author.headers if who == "creator" else auth
    if template.endswith("/retry"):
        run = await _stuck_lookup(client, auth, creator, swarm, tenant_id, monkeypatch)
    elif template.endswith("/retry-lookup"):
        run = await _cost_unknown(client, creator, tenant_id)
    else:
        run = await started(client, creator)
    before = await _knobs(tenant_id, run["id"])
    submitted = len(swarm.submissions())
    lose.arm(DURING[route], how, caller.user_id)
    resp = await client.request(
        method.upper(), template.format(run_id=run["id"]), headers=caller.headers
    )
    assert lose.fired == [DURING[route]], f"{template} did not call {DURING[route]}"
    assert resp.status_code == 403, resp.text
    assert (await get(client, auth, run["id"]))["status"] == "running"
    assert len(swarm.submissions()) == submitted
    knobs = await _knobs(tenant_id, run["id"])
    if template.endswith("/retry"):
        assert knobs.get("stuck_lookup") == before["stuck_lookup"]
        assert await _audits(tenant_id, "run.retried") == 0
    elif template.endswith("/retry-lookup"):
        assert knobs["searches"] == before["searches"]
        assert await _audits(tenant_id, "run.lookup_retried") == 0
    else:
        assert await _audits(tenant_id, "run.cancelled") == 0
