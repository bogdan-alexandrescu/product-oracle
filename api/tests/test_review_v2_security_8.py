"""CR-07 review fixes, round 8 (PR #84, on #78 / #69 / #57 / #45 / #38), after the merge of
main's adapter v2 (PR #85). A segment never reaches SwarmCloud twice and an orphan's
spend is always counted (M1); an import already under way never lands after a cancel or
a disable (M2); a demotion voids spend approvals and decisions, and an overrun Resume is
a spend approval (C2); an unreachable cancel is dropped after 3 days with an Inbox note
(P3d); the tick takes owners and tick-scoped tokens only; minors. Synthetic
placeholders only."""

import asyncio
import json
import uuid
from datetime import timedelta
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import func, select

from oracle import readiness
from oracle.auth.models import ApiToken, User
from oracle.baseline.models import Entity
from oracle.docs.models import DocumentVersion
from oracle.members.models import MemberFollowUp
from oracle.runs import service
from oracle.runs.models import Run, RunSegment
from oracle.runtokens import RunToken
from oracle.swarm import FakeRuntime, Outcome, RuntimeUnavailable, WorkflowStatus, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.review_v2_helpers import DOC, person, setup
from tests.test_review_v2_security_3 import disable, member_token
from tests.test_review_v2_security_6 import _decide, _pending, _read, _started, _tick

WAIT = 10


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


class _Clock:
    """Oracle's clock for runs, moved forward by the test."""

    def __init__(self, monkeypatch) -> None:
        self.offset = timedelta(0)
        real = service._now
        monkeypatch.setattr(service, "_now", lambda: real() + self.offset)

    def forward(self, seconds: float) -> None:
        self.offset += timedelta(seconds=seconds)


async def _segment(ctx, run_id, seq: int = 1) -> RunSegment:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(
            select(RunSegment).where(
                RunSegment.run_id == uuid.UUID(str(run_id)), RunSegment.seq == seq
            )
        )


async def _run_row(ctx, run_id) -> Run:
    async with tenant_session(ctx.tenant_id) as s:
        return await s.get(Run, uuid.UUID(str(run_id)))


async def _inbox(client, headers) -> dict:
    resp = await client.get("/v1/inbox", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _queue_only(monkeypatch) -> None:
    """Requests queue their submission and the route's submit_queued does nothing: the
    segment stays queued (approved or decided, not submitted) until the test lets it."""

    async def nothing(db, run_id, *, budget=None):
        return None

    monkeypatch.setattr(service, "submit_queued", nothing)


# --- M1: a segment reaches SwarmCloud once; an orphan is adopted, its spend counted ----


async def test_a_submission_cut_by_its_budget_is_adopted_not_sent_again(
    client, runtime, monkeypatch
):
    """SwarmCloud records the submission but its answer never comes back within the
    submission's budget (here 0.5 s; the tick's own 0.3 s per run is never applied to the
    POST), and claims expire at once: the next passes look the submission up by its key
    and adopt it. Exactly one submission, and the run runs it (its cost counted)."""
    ctx = await setup(client)
    monkeypatch.setattr(service, "TICK_RUN_SECONDS", 0.3)
    monkeypatch.setattr(service, "CLAIM_SECONDS", 0)
    monkeypatch.setattr(service, "SUBMIT_SECONDS", 0.5)
    real = runtime.submit

    async def recorded_then_silent(spec):
        wid = await real(spec)
        await asyncio.sleep(30)
        return wid

    monkeypatch.setattr(runtime, "submit", recorded_then_silent)
    run = await _started(client, ctx)
    seg = await _segment(ctx, run["id"])
    assert seg.status == "pending" and seg.artifacts["lost"]["label"].endswith("-baseline-1")
    await _tick(client, ctx)
    await _tick(client, ctx)
    assert len(runtime.submitted) == 1
    run = await _read(client, ctx, run["id"])
    [attempt] = run["segments"][0]["attempts"]
    assert attempt["workflow_id"].startswith("fake-baseline-a1")
    assert run["spent_usd"] > 0
    assert run["status"] in ("running", "awaiting_checkpoint")


async def test_a_post_slower_than_the_ticks_budget_is_not_cut(client, runtime, monkeypatch):
    """The tick's per-run deadline applies to its reads, never to the POST: a submission
    that answers after it is recorded normally, sent once."""
    ctx = await setup(client)
    monkeypatch.setattr(service, "TICK_RUN_SECONDS", 0.3)
    _queue_only(monkeypatch)
    run = await _started(client, ctx)
    monkeypatch.undo()
    monkeypatch.setattr(service, "TICK_RUN_SECONDS", 0.3)
    real = runtime.submit

    async def slow(spec):
        await asyncio.sleep(0.6)
        return await real(spec)

    monkeypatch.setattr(runtime, "submit", slow)
    await _tick(client, ctx)
    seg = await _segment(ctx, run["id"])
    assert len(runtime.submitted) == 1 and seg.swarm_workflow_id is not None


@pytest.mark.parametrize(
    "failure",
    [
        RuntimeUnavailable("cannot reach SwarmCloud (POST /v1/workflows): ReadTimeout", lost=True),
        RuntimeUnavailable("ReadTimeout"),  # says nothing either way: may have landed
        RuntimeUnavailable(
            "SwarmCloud refused POST /v1/workflows: HTTP 502", status=502, lost=True
        ),
        RuntimeUnavailable(
            "SwarmCloud accepted the workflow but returned no id", status=202, lost=True
        ),
    ],
    ids=["read_timeout", "no_status", "bad_gateway", "accepted_without_id"],
)
async def test_an_unknown_outcome_is_looked_up_never_resubmitted(
    client, runtime, monkeypatch, failure
):
    """SwarmCloud records the submission, then the answer is lost: Oracle looks it up by
    its key before anything else, finds it and adopts it. One submission."""
    ctx = await setup(client)
    real = runtime.submit

    async def recorded_then_lost(spec):
        await real(spec)
        raise failure

    monkeypatch.setattr(runtime, "submit", recorded_then_lost)
    run = await _started(client, ctx)
    await _tick(client, ctx)
    assert len(runtime.submitted) == 1
    seg = await _segment(ctx, run["id"])
    assert seg.swarm_workflow_id and seg.swarm_workflow_id.startswith("fake-baseline-a1")
    assert "lost" not in seg.artifacts


@pytest.mark.parametrize(
    "failure",
    [
        RuntimeUnavailable(
            "cannot reach SwarmCloud (POST /v1/workflows): ConnectError", never_sent=True
        ),
        RuntimeUnavailable("SwarmCloud refused POST /v1/workflows: HTTP 422", status=422),
    ],
    ids=["connect_error", "refused_4xx"],
)
async def test_a_submission_never_sent_is_retried_by_the_next_tick(
    client, runtime, monkeypatch, failure
):
    """Not sent for sure (no connection; a 4xx refusal): the claim is released at once and
    the next tick submits again, no lookup first."""
    ctx = await setup(client)
    real = runtime.submit
    calls = []

    async def refuse_once(spec):
        calls.append(spec.label)
        if len(calls) == 1:
            raise failure
        return await real(spec)

    looked: list[str] = []
    real_find = runtime.find_by_label

    async def find(label, since=None):
        looked.append(label)
        return await real_find(label, since)

    monkeypatch.setattr(runtime, "submit", refuse_once)
    monkeypatch.setattr(runtime, "find_by_label", find)
    run = await _started(client, ctx)
    seg = await _segment(ctx, run["id"])
    assert seg.status == "pending" and "lost" not in seg.artifacts and "claim" not in seg.artifacts
    await _tick(client, ctx)
    assert len(runtime.submitted) == 1 and looked == []
    assert calls[0] == calls[1]  # the same key: the first was never made


async def test_a_pass_that_dies_after_sending_is_looked_up_by_the_next(
    client, runtime, monkeypatch
):
    """The process that sent the submission dies before it records SwarmCloud's answer
    (its claim keeps the key it sent): once the claim expires the next pass looks the key
    up and adopts the workflow instead of sending it again."""
    ctx = await setup(client)
    _queue_only(monkeypatch)
    run = await _started(client, ctx)
    monkeypatch.undo()
    real = service._record_outcome
    died: list[bool] = []

    async def dies_once(db, run_id, segment_id, claim_id, out):
        if not died:
            died.append(True)
            await db.rollback()
            raise RuntimeError("the process died")
        await real(db, run_id, segment_id, claim_id, out)

    monkeypatch.setattr(service, "_record_outcome", dies_once)
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200 and resp.json()["errors"], resp.text
    seg = await _segment(ctx, run["id"])
    assert seg.artifacts["claim"]["sent"]["label"].endswith("-baseline-1")
    assert len(runtime.submitted) == 1
    # Within CLAIM_SECONDS the claim holds: nothing is sent.
    await _tick(client, ctx)
    assert len(runtime.submitted) == 1
    monkeypatch.setattr(service, "CLAIM_SECONDS", 0)
    await _tick(client, ctx)
    assert len(runtime.submitted) == 1
    seg = await _segment(ctx, run["id"])
    assert seg.swarm_workflow_id and seg.swarm_workflow_id.startswith("fake-baseline-a1")
    run = await _read(client, ctx, run["id"])
    assert any("could not tell whether submission" in n for n in run["notes"]), run["notes"]


async def test_a_lost_submission_never_resolved_waits_in_the_inbox(client, runtime, monkeypatch):
    """The answer is lost and SwarmCloud's listing never shows the key nor rules it out:
    nothing is sent again; past the lookup window the run is in the Inbox (Stuck runs,
    Retry and Cancel)."""
    ctx = await setup(client)
    clock = _Clock(monkeypatch)
    real = runtime.submit

    async def lost(spec):
        await real(spec)
        raise RuntimeUnavailable("ReadTimeout", lost=True)

    async def inconclusive(label, since=None):
        raise RuntimeUnavailable("SwarmCloud's task listing did not end", lost=True)

    monkeypatch.setattr(runtime, "submit", lost)
    monkeypatch.setattr(runtime, "find_by_label", inconclusive)
    run = await _started(client, ctx)
    clock.forward(service.LOST_LOOKUP_SECONDS + 60)
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert len(runtime.submitted) == 1
    [item] = (await _inbox(client, ctx.auth))["lookups"]
    assert item["id"] == run["id"] and item["can_retry"] is True
    assert "was lost and is still not found" in item["stuck"]


async def test_a_spent_budget_claims_nothing_and_mints_nothing(client, runtime, monkeypatch):
    ctx = await setup(client)
    _queue_only(monkeypatch)
    run = await _started(client, ctx)
    monkeypatch.undo()
    async with tenant_session(ctx.tenant_id) as s:
        await service.submit_queued(s, uuid.UUID(run["id"]), budget=0)
        tokens = await s.scalar(select(func.count()).select_from(RunToken))
    seg = await _segment(ctx, run["id"])
    assert "claim" not in seg.artifacts and tokens == 0 and runtime.submitted == []
    # A tick with too little of its budget left starts no submission either.
    async with tenant_session(ctx.tenant_id) as s:
        out = await service.tick(s, budget_seconds=service.MIN_SUBMIT_SECONDS - 1)
    assert runtime.submitted == [] and out.errors
    await _tick(client, ctx)
    assert len(runtime.submitted) == 1


def _swarmcloud(handler):
    from oracle.swarm.swarmcloud import StaticBearer, SwarmCloudRuntime

    return SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("sc-bearer"), transport=httpx.MockTransport(handler)
    )


def _spec():
    from oracle.swarm import StepSpec, WorkflowSpec

    return WorkflowSpec(
        name="oracle-test",
        steps=(StepSpec(key="s1", role="writer", profile="claude-code", prompt="x"),),
        outputs=("prd.md",),
        label="oracle-run-seg-1",
    )


@pytest.mark.parametrize(
    "answer, sent_for_sure",
    [
        (httpx.ConnectError("refused"), False),
        (httpx.ConnectTimeout("slow"), False),
        (httpx.ReadTimeout("slow"), True),
        (httpx.WriteTimeout("slow"), True),
        (httpx.RemoteProtocolError("closed"), True),
        (httpx.Response(503, text="<html>bad gateway</html>"), True),
        (httpx.Response(202, json={"workflow": {}}), True),
        (httpx.Response(200, text="not json"), True),
        (httpx.Response(422, json={"code": "invalid_request", "message": "bad step"}), False),
    ],
    ids=[
        "connect_error",
        "connect_timeout",
        "read_timeout",
        "write_timeout",
        "protocol_error",
        "5xx",
        "accepted_without_id",
        "non_json_2xx",
        "4xx",
    ],
)
async def test_swarmclouds_submit_outcomes_are_classified(answer, sent_for_sure):
    """M1: only an answer that proves nothing was made releases a claim for an automatic
    retry; everything else may have landed and is looked up first."""

    def handler(request: httpx.Request) -> httpx.Response:
        if isinstance(answer, Exception):
            raise answer
        return answer

    with pytest.raises(RuntimeUnavailable) as caught:
        await _swarmcloud(handler).submit(_spec())
    assert service._refused_for_sure(caught.value) is (not sent_for_sure), caught.value


# --- M2: an import under way never lands after a cancel or a disable ---------------------

BASELINE_YAML = """version: 1
entities:
  - type: feature
    key: m2-orphan
    title: M2 orphan
edges: []
"""


async def _member_events(ctx) -> int:
    """The change events a disable records about the member (and their sources)."""
    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(
            select(func.count())
            .select_from(ChangeEvent)
            .where(ChangeEvent.subject_kind.in_(("member", "source_permission")))
        )


async def _counts(ctx) -> tuple[int, int, int]:
    async with tenant_session(ctx.tenant_id) as s:
        entities = await s.scalar(
            select(func.count()).select_from(Entity).where(Entity.key == "m2-orphan")
        )
        events = await s.scalar(select(func.count()).select_from(ChangeEvent))
        versions = await s.scalar(select(func.count()).select_from(DocumentVersion))
    return entities, events, versions


def _before_import(monkeypatch, name: str, act) -> list[bool]:
    """Run ``act`` (a cancel, a disable) as the import starts, before anything of it is
    written: it commits first."""
    real = getattr(service, name)
    fired: list[bool] = []

    async def spy(db, run, *args):
        if not fired:
            fired.append(True)
            await act()
        return await real(db, run, *args)

    monkeypatch.setattr(service, name, spy)
    return fired


@pytest.mark.parametrize("act", ["cancel", "disable_author"])
async def test_a_baseline_import_after_a_cancel_or_disable_writes_nothing(
    client, runtime, monkeypatch, act
):
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    runtime.script["baseline"] = [
        Outcome(artifacts={"baseline.yaml": BASELINE_YAML, "summary.md": "# Summary\n"})
    ]
    run = await _started(client, ctx, author.headers)
    before = await _counts(ctx)

    async def go():
        if act == "cancel":
            resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth)
        else:
            resp = await disable(client, ctx, author.user_id)
        assert resp.status_code == 200, resp.text

    fired = _before_import(monkeypatch, "_import_baseline", go)
    await client.post("/v1/internal/tick", headers=ctx.auth)
    assert fired
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "cancelled", run
    assert [c for c in run["checkpoints"] if c["status"] == "pending"] == []
    entities, events, versions = await _counts(ctx)
    assert entities == 0 and versions == before[2]
    # No change event from the run (a disable records its own, about the member).
    assert events == before[1] + (0 if act == "cancel" else await _member_events(ctx))


@pytest.mark.parametrize("act", ["cancel", "disable_author"])
async def test_a_draft_import_after_a_cancel_or_disable_writes_no_version(
    client, runtime, monkeypatch, act
):
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    resp = await client.post(
        "/v1/runs",
        json={"flow": "feedback_loop", "document": DOC, "knobs": {}},
        headers=author.headers,
    )
    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert (await client.post(f"/v1/runs/{run['id']}/estimate", headers=author.headers)).is_success
    assert (await client.post(f"/v1/runs/{run['id']}/start", headers=author.headers)).is_success
    before = await _counts(ctx)

    async def go():
        if act == "cancel":
            resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=author.headers)
        else:
            resp = await disable(client, ctx, author.user_id)
        assert resp.status_code == 200, resp.text

    fired = _before_import(monkeypatch, "_import_draft", go)
    await client.post("/v1/internal/tick", headers=ctx.auth)
    assert fired
    assert (await _read(client, ctx, run["id"]))["status"] == "cancelled"
    assert (await _counts(ctx))[2] == before[2]


async def test_an_import_reads_its_creators_standing_now_not_a_stale_copy(client, runtime):
    """The creator was disabled by a transaction the run's session never saw: the import
    reads the row now and refuses (the run is cancelled by the recheck)."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        _ = (await s.get(User, author.user_id)).disabled_at  # a copy in this session
        async with tenant_session(ctx.tenant_id) as other:
            user = await other.get(User, author.user_id)
            user.disabled_at = func.now()
            await other.commit()
        out = await service._import_as(s, row)
        await s.rollback()
    assert out == "run creator is disabled"


# --- C2: a demotion voids; an overrun Resume is a spend approval ------------------------


async def _demote(client, ctx, user_id, role: str):
    resp = await client.patch(f"/v1/members/{user_id}", json={"role": role}, headers=ctx.auth)
    assert resp.status_code == 200, resp.text


async def test_a_demotion_voids_a_pending_spend_approval(client, runtime, monkeypatch):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "owner-b")
    run = await _started(client, ctx, depth="deep")
    assert run["status"] == "awaiting_approval"
    _queue_only(monkeypatch)
    resp = await client.post(f"/v1/runs/{run['id']}/approve", headers=owner.headers)
    assert resp.status_code == 200 and resp.json()["status"] == "running", resp.text
    monkeypatch.undo()
    await _demote(client, ctx, owner.user_id, "approver")
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_approval"
    assert [r["id"] for r in (await _inbox(client, ctx.auth))["approvals"]] == [run["id"]]
    await _tick(client, ctx)
    assert runtime.submitted == []


async def test_a_demotion_that_still_allows_it_voids_nothing(client, runtime, monkeypatch):
    """An owner demoted to... owner is no change; an approver's checkpoint decision stands
    when they are demoted from owner to approver (the checkpoint needs an approver)."""
    ctx = await setup(client)
    decider = await person(ctx.tenant_id, "owner", "decider")
    run = await _started(client, ctx)
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    _queue_only(monkeypatch)
    assert (await _decide(client, run, decider.headers)).status_code == 200
    monkeypatch.undo()
    await _demote(client, ctx, decider.user_id, "approver")
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "running"
    await _tick(client, ctx)
    assert len(runtime.submitted) == 2


async def test_a_demotion_voids_a_checkpoint_decision_not_acted_on(client, runtime, monkeypatch):
    ctx = await setup(client)
    decider = await person(ctx.tenant_id, "approver", "decider")
    run = await _started(client, ctx)
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    cp = _pending(run)
    _queue_only(monkeypatch)
    assert (await _decide(client, run, decider.headers)).status_code == 200
    monkeypatch.undo()
    await _demote(client, ctx, decider.user_id, "commenter")
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert _pending(run)["id"] == cp["id"]
    assert any(c["id"] == cp["id"] for c in (await _inbox(client, ctx.auth))["checkpoints"])
    await _tick(client, ctx)
    assert len(runtime.submitted) == 1


async def _paused(client, ctx, runtime, monkeypatch) -> dict:
    """A run paused on overrun: its segment cost three times its estimate."""
    runtime.script["baseline"] = [Outcome(cost_usd=Decimal("500"))]
    run = await _started(client, ctx)
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "paused_overrun", run
    return run


@pytest.mark.parametrize("how", ["demoted", "disabled"])
async def test_an_owners_resume_is_a_spend_approval_voided_by_removal_or_demotion(
    client, runtime, monkeypatch, how
):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "resumer")
    run = await _paused(client, ctx, runtime, monkeypatch)
    before = (await _run_row(ctx, run["id"])).knobs["spend_ceiling_usd"]
    _queue_only(monkeypatch)
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=owner.headers)
    assert resp.status_code == 200, resp.text
    monkeypatch.undo()
    row = await _run_row(ctx, run["id"])
    approval = row.knobs["resume_approval"]
    assert approval["by"] == str(owner.user_id) and approval["at"]
    assert approval["ceiling_usd"] == row.knobs["spend_ceiling_usd"] != before
    assert approval["previous_ceiling_usd"] == before
    if how == "demoted":
        await _demote(client, ctx, owner.user_id, "approver")
    else:
        assert (await disable(client, ctx, owner.user_id)).status_code == 200
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "paused_overrun"
    row = await _run_row(ctx, run["id"])
    assert row.knobs["spend_ceiling_usd"] == before and "resume_approval" not in row.knobs
    assert [r["id"] for r in (await _inbox(client, ctx.auth))["overruns"]] == [run["id"]]
    submitted = len(runtime.submitted)
    await _tick(client, ctx)
    assert len(runtime.submitted) == submitted
    # Another owner resumes: it goes on.
    resp = await client.post(f"/v1/runs/{run['id']}/resume", headers=ctx.auth)
    assert resp.status_code == 200 and resp.json()["status"] != "paused_overrun", resp.text


async def test_a_token_revoke_voids_no_spend_approval(client, runtime, monkeypatch):
    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "token-owner")
    token_id, headers = await member_token(ctx, owner.user_id)
    run = await _started(client, ctx, depth="deep")
    _queue_only(monkeypatch)
    assert (await client.post(f"/v1/runs/{run['id']}/approve", headers=headers)).status_code == 200
    monkeypatch.undo()
    resp = await client.delete(f"/v1/api-tokens/{token_id}", headers=ctx.auth)
    assert resp.status_code == 204, resp.text
    await _tick(client, ctx)
    run = await _read(client, ctx, run["id"])
    assert run["status"] != "awaiting_approval" and len(runtime.submitted) == 1


async def test_a_busy_run_is_rechecked_after_the_disable_commits(client, runtime, monkeypatch):
    """The disable never waits on a run's row (a tick or a request may hold it across a
    call to SwarmCloud): a busy run gets a run_recheck follow-up, done once it is free."""
    ctx = await setup(client)
    author = await person(ctx.tenant_id, "approver", "author")
    run = await _started(client, ctx, author.headers)
    async with tenant_session(ctx.tenant_id) as holder:
        await holder.execute(select(Run.id).where(Run.id == uuid.UUID(run["id"])).with_for_update())
        resp = await asyncio.wait_for(disable(client, ctx, author.user_id), WAIT)
        assert resp.status_code == 200, resp.text
        await holder.rollback()
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(MemberFollowUp).where(MemberFollowUp.kind == "run_recheck"))
    assert row is not None and str(row.target_id) == run["id"]
    resp = await client.post("/v1/internal/tick", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "cancelled"


# --- P3d: an unreachable cancel is retried for 3 days, its spend read, then noted ---------


async def test_an_unreachable_cancel_is_dropped_after_three_days_with_an_inbox_note(
    client, runtime, monkeypatch
):
    ctx = await setup(client)
    clock = _Clock(monkeypatch)
    author = await person(ctx.tenant_id, "approver", "author")
    runtime.script["baseline"] = [Outcome(polls=10**6)]
    run = await _started(client, ctx, author.headers)
    wid = (await _segment(ctx, run["id"])).swarm_workflow_id
    cost = [Decimal("1")]

    async def cancel_fails(workflow_id):
        raise RuntimeUnavailable("cannot reach SwarmCloud (POST cancel): ReadTimeout", lost=True)

    async def status(workflow_id):
        if cost[0] is None:
            raise RuntimeUnavailable("cannot reach SwarmCloud (GET): ConnectError")
        return WorkflowStatus("running", cost[0])

    monkeypatch.setattr(runtime, "cancel", cancel_fails)
    monkeypatch.setattr(runtime, "status", status)
    assert (await disable(client, ctx, author.user_id)).status_code == 200
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "cancelled"
    # While it may still run, its spend is read into the run's.
    cost[0] = Decimal("4")
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await client.post("/v1/internal/tick", headers=ctx.auth)
    assert (await _read(client, ctx, run["id"]))["spent_usd"] == 4.0
    # Past the 24 h of a provider revoke it is still tried.
    cost[0] = None
    clock.forward(25 * 3600)
    await client.post("/v1/internal/tick", headers=ctx.auth)
    searches = (await _run_row(ctx, run["id"])).knobs.get("searches")
    assert searches and searches[0]["id"] == wid
    # After 3 days it is dropped, with a note in the Inbox until dismissed.
    clock.forward(service.COST_UNKNOWN_SECONDS + 60)
    await client.post("/v1/internal/tick", headers=ctx.auth)
    assert not (await _run_row(ctx, run["id"])).knobs.get("searches")
    [item] = (await _inbox(client, ctx.auth))["lookups"]
    assert item["stuck"].startswith(
        f"Oracle stopped trying to cancel {wid}; it may still be running in SwarmCloud; "
        "spend counted until "
    ), item["stuck"]
    assert item["can_dismiss_cancel_note"] is True and item["spent_usd"] == 4.0
    resp = await client.post(f"/v1/runs/{run['id']}/dismiss-cancel-note", headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, ctx.auth))["lookups"] == []


# --- the tick: owners and a tick-scoped token only ---------------------------------------


async def _company_token(ctx, role: str) -> dict[str, str]:
    from oracle.auth.service import create_api_token

    async with tenant_session(ctx.tenant_id) as s:
        token, raw = await create_api_token(s, f"{role}-token")
        token.role = role
        await s.commit()
    return {"Authorization": f"Bearer {raw}"}


async def test_the_tick_takes_owners_and_the_tick_token_only(client, runtime):
    from oracle.tick_token import mint

    ctx = await setup(client)
    tick = "/v1/internal/tick"
    assert (await client.post(tick, headers=ctx.auth)).status_code == 200
    assert (await client.post(tick, headers=await _company_token(ctx, "owner"))).status_code == 200
    for role in ("viewer", "commenter", "approver"):
        resp = await client.post(tick, headers=await _company_token(ctx, role))
        assert resp.status_code == 403, (role, resp.text)
    approver = await person(ctx.tenant_id, "approver", "approver")
    assert (await client.post(tick, headers=approver.headers)).status_code == 403
    raw = await mint("scheduler-tick", ctx.tenant_id)
    scheduler = {"Authorization": f"Bearer {raw}"}
    assert (await client.post(tick, headers=scheduler)).status_code == 200
    # It does nothing else: not a read, not a write, not the MCP server.
    assert (await client.get("/v1/runs", headers=scheduler)).status_code == 403
    assert (await client.get(f"/v1/documents/{DOC}", headers=scheduler)).status_code == 403
    resp = await client.post("/v1/runs", json={"flow": "baseline_to_prd"}, headers=scheduler)
    assert resp.status_code == 403
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(ApiToken).where(ApiToken.name == "scheduler-tick"))
        assert row.scope == "tick" and row.user_id is None and row.role == "viewer"
        row.revoked_at = func.now()
        await s.commit()
    assert (await client.post(tick, headers=scheduler)).status_code == 401


async def test_the_tick_refuses_a_run_token(client, runtime):
    ctx = await setup(client)
    run = await _started(client, ctx)
    token = runtime.submitted[0].mcp.token
    resp = await client.post("/v1/internal/tick", headers={**ctx.auth, "x-oracle-run-token": token})
    assert resp.status_code in (401, 403), resp.text
    assert (await _read(client, ctx, run["id"]))["status"] in ("running", "awaiting_checkpoint")


async def test_the_tick_rereads_an_owner_under_the_gate(client, runtime, monkeypatch):
    """An owner demoted while their tick waits on the gate is refused."""
    from oracle.review import publish

    ctx = await setup(client)
    owner = await person(ctx.tenant_id, "owner", "ticker")
    real = publish.gate_lock
    fired: list[bool] = []

    async def demote_first(db, *, shared):
        if not fired:
            fired.append(True)
            async with tenant_session(ctx.tenant_id) as s:
                (await s.get(User, owner.user_id)).role = "approver"
                await s.commit()
        await real(db, shared=shared)

    monkeypatch.setattr(publish, "gate_lock", demote_first)
    resp = await client.post("/v1/internal/tick", headers=owner.headers)
    assert resp.status_code == 403 and fired, resp.text


# --- minors ---------------------------------------------------------------------------


@pytest.mark.parametrize("spelling", ["urn:uuıd:", "URN:İ", "uuıd:", "urn:uuİd:"])
def test_external_key_folds_ascii_case_only(spelling):
    """ı (dotless i) and İ are not "i": a key with them is not a UUID spelling, in Python
    as in the SQL."""
    from oracle.review.publish import external_key

    hexed = "0" * 31 + "1"
    assert external_key(f"{spelling}{hexed}") == f"{spelling}{hexed}"
    assert external_key(f"URN:UUID:{hexed}") == str(uuid.UUID(hex=hexed))


async def test_the_artifact_cap_reads_the_expected_outputs_and_the_latest_step_first():
    """40 earlier files never crowd the reviser's draft out of the 32 read."""
    from oracle.swarm import swarmcloud

    steps = [{"step_id": "s1-writer", "task_id": "t1"}, {"step_id": "s2-revise", "task_id": "t2"}]
    early = [{"name": f"notes-{i}.md"} for i in range(40)]
    late = [{"name": "notes-late.md"}, {"name": "prd.md"}]
    read: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/workflows/wf_1":
            return httpx.Response(200, json={"workflow": {"state": "SUCCEEDED", "steps": steps}})
        if path == "/v1/tasks/t1/artifacts":
            return httpx.Response(200, json={"artifacts": early + [{"name": "prd.md"}]})
        if path == "/v1/tasks/t2/artifacts":
            return httpx.Response(200, json={"artifacts": late})
        if path.endswith("/artifacts/raw"):
            name = request.url.params["name"]
            read.append(f"{path.split('/')[3]}:{name}")
            return httpx.Response(200, text=f"{path.split('/')[3]} {name}")
        return httpx.Response(404)

    files = await _swarmcloud(handler).artifacts("wf_1", prefer=("prd.md",))
    assert files["prd.md"] == "t2 prd.md"  # the reviser's, read first
    assert files["notes-late.md"] == "t2 notes-late.md"
    assert len(read) == swarmcloud.MAX_ARTIFACT_FILES and read[0] == "t2:prd.md"
    assert "t1:prd.md" not in read


async def test_an_import_that_keeps_failing_fails_its_step_visibly(client, runtime, monkeypatch):
    """An exception in an import never leaves the run running with nothing queued: it is
    retried by the tick, then its step fails and owners see it in the Inbox (Retry)."""
    ctx = await setup(client)

    async def broken(db, run, text):
        raise RuntimeError("the import broke")

    monkeypatch.setattr(service, "_import_baseline", broken)
    run = await _started(client, ctx)
    for _ in range(service.RESUME_TRIES + 1):
        await client.post("/v1/internal/tick", headers=ctx.auth)
    run = await _read(client, ctx, run["id"])
    assert run["status"] == "running" and run["segments"][0]["status"] == "failed"
    [item] = (await _inbox(client, ctx.auth))["imports"]
    assert item["id"] == run["id"] and item["can_retry_import"] is True


async def test_a_cancel_revokes_the_runs_tokens_under_the_exclusive_gate(client, runtime):
    """A request on the run's token holds the gate (shared) while it re-reads the token:
    the cancel's revoke waits for it, so it never lands in the middle of one."""
    from oracle.review import publish

    ctx = await setup(client)
    run = await _started(client, ctx)
    async with tenant_session(ctx.tenant_id) as reader:
        await publish.gate_lock(reader, shared=True)
        call = asyncio.create_task(client.post(f"/v1/runs/{run['id']}/cancel", headers=ctx.auth))
        await asyncio.sleep(0.5)
        assert not call.done()
        await reader.rollback()
    resp = await asyncio.wait_for(call, WAIT)
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        live = await s.scalar(
            select(func.count())
            .select_from(RunToken)
            .where(RunToken.run_id == uuid.UUID(run["id"]), RunToken.revoked_at.is_(None))
        )
    assert live == 0


@pytest.mark.parametrize("ctype", ["application/json", "multipart/form-data; boundary=x"])
async def test_every_request_body_is_capped_while_it_arrives(client, monkeypatch, ctype):
    from oracle import http

    ctx = await setup(client)
    monkeypatch.setattr(http, "MAX_BODY_BYTES", 1024)
    monkeypatch.setattr(http, "MAX_UPLOAD_REQUEST_BYTES", 4096)
    limit = 4096 if ctype.startswith("multipart") else 1024
    big = b"x" * (limit + 1)
    resp = await client.post("/v1/runs", content=big, headers={**ctx.auth, "Content-Type": ctype})
    assert resp.status_code == 413, resp.text

    async def chunks():  # no Content-Length: refused as it grows past the cap
        for _ in range(limit // 256 + 2):
            yield b"x" * 256

    resp = await client.post(
        "/v1/runs", content=chunks(), headers={**ctx.auth, "Content-Type": ctype}
    )
    assert resp.status_code == 413, resp.text
    # Under the cap, the route answers as usual.
    resp = await client.post(
        "/v1/runs",
        content=json.dumps({"flow": "nope"}).encode(),
        headers={**ctx.auth, "Content-Type": "application/json"},
    )
    assert resp.status_code == 422


@pytest.mark.parametrize(
    "yaml_text, why",
    [
        ("a: &x [1, 2]\nb: *x\n", "anchor or alias"),
        ("entities: " + "[" * 40 + "]" * 40 + "\n", "levels deep"),
        ("entities: !!python/object:os.system x\n", "explicit YAML tag"),
        ("note: " + "x" * 30_000 + "\n", "characters"),
        ("n: " + "9" * 40 + "\n", "digits"),
    ],
    ids=["alias", "depth", "tag", "long_value", "long_number"],
)
async def test_the_baseline_yaml_is_read_the_bounded_way(client, yaml_text, why):
    ctx = await setup(client)
    resp = await client.post(
        "/v1/baseline/yaml",
        content=yaml_text.encode(),
        headers={**ctx.auth, "Content-Type": "application/yaml"},
    )
    assert resp.status_code == 422, resp.text
    assert why in resp.text, resp.text


async def test_a_baseline_round_trips_through_the_bounded_loader(client):
    ctx = await setup(client)
    yaml_text = BASELINE_YAML.replace("m2-orphan", "bounded-ok")
    resp = await client.post(
        "/v1/baseline/yaml",
        content=yaml_text.encode(),
        headers={**ctx.auth, "Content-Type": "application/yaml"},
    )
    assert resp.status_code in (200, 201), resp.text
    exported = await client.get("/v1/baseline/yaml", headers=ctx.auth)
    assert exported.status_code == 200
    resp = await client.post(
        "/v1/baseline/yaml",
        content=exported.content,
        headers={**ctx.auth, "Content-Type": "application/yaml"},
    )
    assert resp.status_code in (200, 201), resp.text
