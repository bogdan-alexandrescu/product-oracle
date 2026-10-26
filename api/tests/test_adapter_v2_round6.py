"""Adapter v2 review fixes, round 6: an answer Oracle cannot read yet holds the run token
(W5), 'Stop cancelling' keeps counting the workflow's spend (P3d), cancel() never
reuses a lookup made for an earlier submission under the same label, and the minors."""

import uuid
from dataclasses import replace
from decimal import Decimal

import pytest
from sqlalchemy import select

from oracle.runs import service
from oracle.runs.models import RunSegment
from oracle.swarm import RuntimeUnavailable
from oracle.tenancy import tenant_session
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import EGRESS, FakeSwarmCloud
from tests.test_adapter_v2 import (
    LB,
    _at_baseline,
    _ceiling,
    _Clock,
    _console,
    _decide_raw,
    _draft_markdown,
    _inbox,
    _knobs_of,
    _member,
    _retried,
    _task_lookups,
    _tick_errors,
    _waiting,
    _writes,
    mcp_session,
    on,
    token_of,
    use,
)
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_runs import decide, get, pending, started, tick

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings


@pytest.fixture
async def owner():
    return await seed_auth()


# Built from pieces at runtime: no credential-shaped literal in the source.
_TAIL = "abcdefgh" + "12345"


def _wf_cost(swarm: FakeSwarmCloud, wid: str) -> float:
    return sum(s.cost for s in swarm.workflows[wid].steps)


async def _segment_art(tenant_id, run_id: str, seq: int = 1) -> dict:
    async with tenant_session(tenant_id) as s:
        seg = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run_id), RunSegment.seq == seq)
        )
        return dict(seg.artifacts or {})


# --------------------------------------------------------------------------- MAJOR 1 (W5)


@pytest.mark.parametrize("fault", ["form_502", "form_bare_404", "lagging_record"])
async def test_an_answer_oracle_cannot_read_yet_holds_the_token(client, owner, monkeypatch, fault):
    """A non-approver answers MERGE in the console; the form keeps answering 502, a bare
    404, or the record lags the step, and the workflow moves on: the token is read-only
    and the Inbox shows the run waiting to read the answer, until it is read."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _member(tenant_id, "commenter@example.com", "commenter")
    run = await _at_baseline(client, auth, swarm)
    token = token_of(swarm)
    if fault == "form_502":
        swarm.form_status = 502
    elif fault == "form_bare_404":
        swarm.form_status = 404
    else:
        swarm.lag_records = True
    swarm.console_answer("wf_1", "baseline-review1", "MERGE", by="commenter@example.com")
    for _ in range(3):
        clock.forward(service.WATCH_SECONDS + 1)
        await _tick_errors(client, auth)
    # The workflow went on past the wait (its next segment's agents ran).
    assert swarm.workflows["wf_1"].step("baseline-review1").state == "SUCCEEDED"
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert run["status"] == "awaiting_checkpoint"
    assert run["token_read_only"] is True
    assert _console(run, cp["id"])["needs"] == "unread"
    held = await _writes(token)
    for name in ("push_draft", "import_version", "propose_change"):
        assert held[name].startswith("ERROR") and "waiting for approval" in held[name], held
    assert held["get_run_output"].startswith("OK")
    [shown] = [c for c in (await _inbox(client, auth))["checkpoints"] if c["id"] == cp["id"]]
    assert shown["console"]["needs"] == "unread"
    # Read at last: the answerer is not an approver, so it still waits (W5), held.
    swarm.form_status, swarm.lag_records = None, False
    clock.forward(service.WATCH_SECONDS + 1)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert _console(run, cp["id"])["needs"] == "confirm"
    assert run["token_read_only"] is True
    # An approver decides: released.
    run = await decide(client, auth, run, "approved")
    assert run["token_read_only"] is False


@pytest.mark.parametrize("cause", ["retryable_read", "no_verdict"])
async def test_an_already_answered_post_oracle_cannot_read_holds_the_token(
    client, owner, monkeypatch, cause
):
    """The approver's Inbox post gets 409 already_answered and the recorded answer cannot
    be read (a retryable read, or no verdict on a change request): "decide again", and
    the run's token is read-only meanwhile, the run in the Inbox; once read, released."""
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _waiting(client, auth, tenant_id, swarm)
    token = token_of(swarm)
    swarm.console_answer("wf_1", "next_draft-review1", "NOT_YET", ["x"], by="stranger@x.io")
    step = swarm.workflows["wf_1"].step("next_draft-review1")
    if cause == "retryable_read":
        swarm.form_status = 502
        resp = await _decide_raw(client, auth, run, "approved")
    else:
        step.files["review1.json"] = '{"verdict": "MAYBE", "findings": []}'
        resp = await _decide_raw(client, auth, run, "changes_requested", "Add a metric")
    assert resp.status_code == 503 and "decide again" in resp.text, resp.text
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert _console(run, cp["id"])["needs"] in ("unread", "unreadable")
    assert run["token_read_only"] is True
    async with mcp_session(token, f"{EGRESS[0]}, {LB}") as c:
        res = await c.call_tool(
            "push_draft", {"doc": "w5", "markdown": _draft_markdown(), "base_version": 0}
        )
        assert res.is_error and "waiting for approval" in res.content[0].text
    assert any(c["id"] == cp["id"] for c in (await _inbox(client, auth))["checkpoints"])
    # Readable again: the approver rule applies (an approver decides: followed).
    swarm.form_status = None
    step.files["review1.json"] = '{"findings": ["x"], "verdict": "NOT_YET"}'
    clock.forward(service.WATCH_SECONDS + 1)
    run = await decide(client, auth, run, "changes_requested", note="x")
    assert run["token_read_only"] is False and run["status"] == "running"


# --------------------------------------------------------------------------- MAJOR 2 (P3d)


async def _stuck_cancel(client, auth, tenant_id, swarm, clock) -> dict:
    """A run paused on overrun whose workflow's cancel SwarmCloud answers with a bare 404
    (reads work) NOT_FOUND_TRIES times, the workflow spending all along."""
    run = await _at_baseline(client, auth, swarm)
    swarm.html_404_cancel = True
    wf = swarm.workflows["wf_1"]
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    for _ in range(service.NOT_FOUND_TRIES):
        wf.steps[0].cost += 1.0  # it keeps spending
        await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "paused_overrun"
    [stuck] = (await _inbox(client, auth))["lookups"]
    assert stuck["id"] == run["id"] and "404" in stuck["stuck"]
    assert stuck["can_stop_cancelling"] is True
    return run


async def test_stop_cancelling_keeps_counting_the_spend_and_the_ceiling_still_trips(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stuck_cancel(client, auth, tenant_id, swarm, clock)
    wf = swarm.workflows["wf_1"]
    # Resting (past the cap): the cancel call rests, the cost is still read every tick.
    cancels = len(swarm.cancels)
    wf.steps[0].cost += 1.0
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert len(swarm.cancels) == cancels
    # Stop cancelling (a short confirm in the web): the Inbox item clears, and Oracle
    # keeps reading the workflow's status and cost in the background.
    resp = await client.post(f"/v1/runs/{run['id']}/stop-cancelling", headers=auth)
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, auth))["lookups"] == []
    assert "wf_1" in (resp.json()["searching"] or "")
    entry = (await _knobs_of(tenant_id, run["id"]))["searches"][0]
    assert entry["id"] == "wf_1"
    # Round 7 (P3d, owner 2026-10-19): the run had not ended, so Stop cancelling ended it.
    assert resp.json()["status"] == "cancelled"
    # A ceiling just over the spend: the stopped workflow's spend trips it (Inbox).
    await _ceiling(tenant_id, run["id"], str(run["spent_usd"] + 0.5))
    wf.steps[0].cost += 1.0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert "ceiling" in ((await _inbox(client, auth))["lookups"][0]["stuck"] or "")
    assert len(swarm.cancels) == cancels and len(swarm.submissions()) == 1
    # Once SwarmCloud says it ended, its last cost lands and the search ends.
    wf.steps[0].cost += 1.0
    swarm._cancel(wf)
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["spent_usd"] == _wf_cost(swarm, "wf_1") and run["searching"] is None


async def test_stop_cancelling_a_cancelled_run_still_counts_its_spend(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _at_baseline(client, auth, swarm)
    swarm.html_404_cancel = True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    wf = swarm.workflows["wf_1"]
    for _ in range(service.NOT_FOUND_TRIES):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    assert (await _inbox(client, auth))["lookups"][0]["can_stop_cancelling"] is True
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)  # Stop cancelling
    assert resp.status_code == 200, resp.text
    assert (await _inbox(client, auth))["lookups"] == []
    wf.steps[0].cost += 2.0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "cancelled" and run["spent_usd"] == _wf_cost(swarm, "wf_1")


async def test_a_plain_cancel_on_a_stuck_run_tries_one_more_cancel_first(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _stuck_cancel(client, auth, tenant_id, swarm, clock)
    swarm.html_404_cancel = False  # SwarmCloud's cancel route works again
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    run = resp.json()
    assert run["status"] == "cancelled" and run["spent_usd"] == _wf_cost(swarm, "wf_1")
    assert (await _knobs_of(tenant_id, run["id"])).get("searches") is None


# --------------------------------------------------------------------------- MAJOR 3


async def test_cancel_never_reuses_a_lookup_of_an_earlier_submission_under_the_same_label(
    client, owner, monkeypatch
):
    """cancel() looks up the lost submission outside the row lock; meanwhile the ticker
    rules it out and resubmits under the same label, losing the answer again. Under the
    lock cancel() must not take the stale "not found" for the new submission."""
    tenant_id, auth = owner
    swarm = on()
    runtime = use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    first = (await _segment_art(tenant_id, run["id"]))["lost"]
    real = runtime.find_by_label
    calls: list[str] = []

    async def find(label, since=None):
        calls.append(label)
        if len(calls) == 1:
            # cancel()'s lookup, outside the lock: the ticker runs meanwhile. The first
            # submission never landed; the ticker rules it out and submits again under
            # the same label, and that answer is lost too (its lookup inconclusive).
            del swarm.workflows["wf_1"]
            swarm.other_tasks, swarm.older_tasks = 0, 5
            swarm.lose_next_submit = True
            await tick(client, auth)
            swarm.other_tasks = 0
            return None  # true of the first submission
        if len(calls) == 3:
            # The ticker's lookup right after its own lost submission: inconclusive.
            raise RuntimeUnavailable("listing too deep", lost=True)
        return await real(label, since)

    monkeypatch.setattr(runtime, "find_by_label", find)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    # The ticker's resubmission, under the same label.
    assert swarm.submissions()[1]["steps"][0]["metadata"]["oracle_key"] == first["label"]
    # The resubmission is found under the lock and cancelled, its cost counted.
    assert swarm.workflows["wf_2"].state == "CANCELLED"
    run = await get(client, auth, run["id"])
    assert any(a["workflow_id"] == "wf_2" for a in run["segments"][0]["attempts"])


# --------------------------------------------------------------------------- minors


async def test_search_results_are_kept_when_the_rest_of_the_tick_fails(client, owner, monkeypatch):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm._advance(swarm.workflows["wf_1"])
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    runtime = use(swarm)
    real = runtime.status

    async def status(workflow_id):
        if workflow_id == "wf_2":
            raise RuntimeUnavailable("SwarmCloud is unavailable", status=503)
        return await real(workflow_id)

    monkeypatch.setattr(runtime, "status", status)
    errors = await _tick_errors(client, auth)
    assert errors, "the rest of the tick failed"
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    knobs = await _knobs_of(tenant_id, run["id"])
    assert not knobs.get("searches")
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert found and found[0]["cost_usd"] == _wf_cost(swarm, "wf_1")


async def test_a_found_search_answered_with_bare_404s_rests_and_surfaces_in_the_inbox(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.html_404_ids = {"wf_1"}
    await _tick_errors(client, auth)  # found: its cancel and status bare-404
    entry = (await _knobs_of(tenant_id, run["id"]))["searches"][0]
    assert entry["id"] == "wf_1" and entry["not_found"] == 1
    # Resting between reads, not every tick.
    calls = len([r for r in swarm.requests if "wf_1" in r.url.path])
    await _tick_errors(client, auth)
    assert len([r for r in swarm.requests if "wf_1" in r.url.path]) == calls
    for _ in range(service.NOT_FOUND_TRIES - 1):
        clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
        await _tick_errors(client, auth)
    [stuck] = (await _inbox(client, auth))["lookups"]
    assert stuck["id"] == run["id"] and "wf_1" in stuck["stuck"] and "404" in stuck["stuck"]


async def test_a_confirmed_cancel_with_a_gone_read_keeps_the_entry_until_its_cost_is_read(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm._advance(swarm.workflows["wf_1"])
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.gone_reads_after_cancel = 1
    await _tick_errors(client, auth)
    assert swarm.workflows["wf_1"].state == "CANCELLED"
    knobs = await _knobs_of(tenant_id, run["id"])
    assert knobs.get("searches"), "kept: its cost is not read yet"
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    run = await get(client, auth, run["id"])
    found = [a for a in run["segments"][0]["attempts"] if a["workflow_id"] == "wf_1"]
    assert found[0]["cost_usd"] == _wf_cost(swarm, "wf_1") > 0
    assert run["searching"] is None


async def test_a_background_search_allows_slack_past_the_credentials_end(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    clock.forward(86400 + 60)  # past the credential, within the slack
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["searching"]


async def test_a_non_attach_submissions_search_is_not_bounded_by_the_run_token_ttl(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = FakeSwarmCloud()  # caller MCP off: nothing attached, no credential bound
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    clock.forward(6 * 3600 + 60)  # past the run token's TTL
    await tick(client, auth)
    assert (await get(client, auth, run["id"]))["searching"]


async def test_a_found_search_still_running_past_its_end_is_read_until_it_ends(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    run = await _retried(client, auth, swarm, clock)
    swarm.other_tasks = 0
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)  # due for a lookup
    swarm.html_404_cancel = True  # its cancel is never confirmed; its status reads
    await _tick_errors(client, auth)
    clock.forward(86400 + 4 * 3600)
    await _tick_errors(client, auth)
    assert (await _knobs_of(tenant_id, run["id"])).get("searches")
    swarm._cancel(swarm.workflows["wf_1"])
    clock.forward(service.STUCK_LOOKUP_SECONDS + 1)
    await _tick_errors(client, auth)
    assert not (await _knobs_of(tenant_id, run["id"])).get("searches")


async def test_the_first_background_lookup_comes_on_the_next_tick_after_retry(
    client, owner, monkeypatch
):
    _, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    await _retried(client, auth, swarm, clock)
    lookups = len(_task_lookups(swarm))
    await tick(client, auth)
    assert len(_task_lookups(swarm)) > lookups


async def test_cancel_never_lowers_a_recorded_cost(client, owner, monkeypatch):
    _, auth = owner
    swarm = on()
    run = await _at_baseline(client, auth, swarm)
    spent = run["spent_usd"]
    assert spent > 0
    runtime = use(swarm)
    real = runtime.status

    async def stale(workflow_id):
        # A read older than the tick's (served by a lagging replica, say).
        return replace(await real(workflow_id), cost_usd=Decimal("0"))

    monkeypatch.setattr(runtime, "status", stale)
    resp = await client.post(f"/v1/runs/{run['id']}/cancel", headers=auth)
    assert resp.status_code == 200, resp.text
    assert resp.json()["spent_usd"] == spent


async def test_retry_rechecks_under_the_lock_before_clearing_a_stuck_lookup(
    client, owner, monkeypatch
):
    tenant_id, auth = owner
    swarm = on()
    clock = _Clock(monkeypatch)
    use(swarm)
    swarm.other_tasks = 1100
    swarm.lose_next_submit = True
    run = await started(client, auth)
    clock.forward(service.LOST_LOOKUP_SECONDS + 60)
    await tick(client, auth)
    run_id = uuid.UUID(run["id"])

    async def set_lost(value):
        async with tenant_session(tenant_id) as s:
            seg = await s.scalar(
                select(RunSegment).where(RunSegment.run_id == run_id, RunSegment.seq == 1)
            )
            art = dict(seg.artifacts)
            if value is None:
                art.pop("lost")
            else:
                art["lost"] = value
            seg.artifacts = art
            await s.commit()

    lost = (await _segment_art(tenant_id, run["id"]))["lost"]
    await set_lost(None)  # what retry() reads without the lock: resolved
    real = service._get_run

    async def get_run(db, rid, *, lock=False):
        if lock:
            await set_lost(lost)  # meanwhile: unresolved again
        return await real(db, rid, lock=lock)

    monkeypatch.setattr(service, "_get_run", get_run)
    resp = await client.post(f"/v1/runs/{run['id']}/retry", headers=auth)
    assert resp.status_code == 409, resp.text
    assert (await _knobs_of(tenant_id, run["id"])).get("stuck_lookup")


async def test_advance_takes_the_current_attempt_not_the_last_listed(client, owner):
    tenant_id, auth = owner
    swarm = FakeSwarmCloud()  # one workflow per segment
    use(swarm)
    run = await started(client, auth)
    async with tenant_session(tenant_id) as s:
        # The first segment: the run has more, and an unordered read returns whichever
        # row the scan meets first (after an update, under load, not always this one).
        seg = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == uuid.UUID(run["id"]), RunSegment.seq == 1)
        )
        art = dict(seg.artifacts)
        # A found earlier submission listed after the current one (a higher number).
        art["attempts"] = [
            *art["attempts"],
            {"attempt": 7, "workflow_id": "wf_9", "cost_usd": 0, "state": "cancelled"},
        ]
        seg.artifacts = art
        await s.commit()
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = pending(run)
    assert cp["payload"]["attempt"] == 1
    states = {a["workflow_id"]: a["state"] for a in run["segments"][0]["attempts"]}
    assert states == {"wf_1": "succeeded", "wf_9": "cancelled"}


# --------------------------------------------------------------------------- redaction


@pytest.mark.parametrize(
    "text",
    [
        # Joined by a percent-escape that ends in a hex letter.
        "token%3Dort_" + _TAIL,
        "a%2Bort_" + _TAIL,
        "key%3Aort_" + _TAIL,
        "x%3dpo_" + _TAIL,
        # By an escaped \x0a, \b or \f.
        "line one\\x0aort_" + _TAIL,
        "line one\\bort_" + _TAIL,
        "line one\\fort_" + _TAIL,
        # The OAuth refresh and code prefixes.
        "refresh por_" + _TAIL,
        "code=poc_" + _TAIL,
        "%3Dpor_" + _TAIL,
        # Bearer with an escaped line break, or a quoted value.
        "Authorization: Bearer\\n" + "sc-" + "secret-1",
        'Authorization: Bearer "' + "sc-" + 'secret-1"',
        'Authorization: Bearer \\"' + "sc-" + 'secret-1\\"',
        # Bearer header-<letters> and token-<letters>.
        "Authorization: Bearer header-" + "secretabcdefgh",
        "Authorization: Bearer token-" + "secretabcdefgh",
    ],
)
def test_round_6_tokens_however_joined_are_redacted(text):
    from oracle.swarm.swarmcloud import _redact, redact_whole

    for fn in (_redact, redact_whole):
        out = fn(text)
        assert "abcdefgh" not in out and "secret" not in out, out
        assert "<withheld>" in out


@pytest.mark.parametrize(
    "text",
    [
        "max_po_lines_per_page",
        "write to alice_po_reviewer@corp.com",
        "bearer token-based auth",
        "Bearer token-based authentication is used",
        "the bearer header-only scheme",
        "a 100%25 portion",
        "the por_table and poc_draft names",
        "use a Bearer token",
        "support_ticket and import_policy",
    ],
)
def test_round_6_ordinary_words_are_not_withheld(text):
    from oracle.swarm.swarmcloud import _redact, redact_whole

    assert _redact(text) == text and redact_whole(text) == text
