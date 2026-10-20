"""W5 hold, structural rule (owner 2026-10-20): a forged SwarmCloud task row cannot
release the run token's hold.

Until SwarmCloud's multi-tenancy Design B is on, any worker can rewrite any task row, so
a review step's ``state``, ``park_reason`` and ``opened_at`` are forgeable. A review step
counts as reached once its predecessor (the step it depends on) reads SUCCEEDED in the
same status read, whatever its own row says; a task with no state of its own, a step
whose task was not read, and PENDING or SKIPPED (states SwarmCloud does not have) all
hold. The only release is a review PARKED with exactly DEPENDENCY_INCOMPLETE whose
predecessor was read and has not succeeded (#112: agents write during work steps)."""

import uuid

import pytest

from oracle.runs import service
from oracle.swarm.runtime import StepStatus, WorkflowStatus, not_reached
from oracle.swarm.swarmcloud import SwarmCloudRuntime
from tests.fixtures import seed_auth
from tests.test_adapter_v2 import on, token_of, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_adapter_v2_round9 import _run_token_writes
from tests.test_runs import get, started

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings

WORK, REVIEW = "seg-2-writer", "seg-review1"
OPENED = {"await_input": {"opened_at": "2026-10-20T10:00:00+00:00"}}


@pytest.fixture
async def owner():
    return await seed_auth()


@pytest.fixture(autouse=True)
def _fresh_hold():
    service._hold_cache.clear()
    service._hold_reads.clear()
    yield
    service._hold_cache.clear()
    service._hold_reads.clear()


def _adapter(tasks: dict[str, dict]) -> SwarmCloudRuntime:
    """The real SwarmCloud adapter over a workflow page: step id -> its task's fields
    (no ``id``: the step's row names a task the page does not have)."""
    rt = object.__new__(SwarmCloudRuntime)

    async def read(workflow_id):
        return {
            "workflow": {
                "state": "running",
                "steps": [{"step_id": k, "task_id": f"t_{k}"} for k in tasks],
            },
            "tasks": [{"id": f"t_{k}", **v} for k, v in tasks.items() if v is not None],
        }

    rt._read = read
    return rt


async def _hold(monkeypatch, runtime, reviews=((REVIEW, WORK),)) -> str | None:
    monkeypatch.setattr(service, "get_runtime", lambda: runtime)
    service._hold_cache.clear()
    return await service._live_hold(uuid.uuid4(), "wf_1", tuple(reviews))


_DEP_PARKED = {"state": "PARKED", "park_reason": "DEPENDENCY_INCOMPLETE"}


# --------------------------------------------------------------------------- the rule


async def test_a_forged_dependency_park_on_a_review_whose_predecessor_succeeded_holds(
    monkeypatch,
):
    rt = _adapter({WORK: {"state": "SUCCEEDED"}, REVIEW: dict(_DEP_PARKED)})
    status = await rt.status("wf_1")
    assert status.step(REVIEW).park_reason == "DEPENDENCY_INCOMPLETE"
    assert await _hold(monkeypatch, rt) == service.HOLD_DECISION


async def test_a_dependency_park_on_a_review_whose_predecessor_runs_releases(monkeypatch):
    rt = _adapter({WORK: {"state": "RUNNING"}, REVIEW: dict(_DEP_PARKED)})
    assert await _hold(monkeypatch, rt) is None


async def test_a_task_with_no_state_of_its_own_holds(monkeypatch):
    # The row says PARKED and the task says why, but the task itself has no state.
    rt = _adapter({WORK: {"state": "RUNNING"}, REVIEW: {"park_reason": "DEPENDENCY_INCOMPLETE"}})
    status = await rt.status("wf_1")
    assert status.step(REVIEW).task_read is False
    assert await _hold(monkeypatch, rt) == service.HOLD_DECISION


async def test_a_predecessor_with_no_state_or_no_task_holds(monkeypatch):
    for before in ({}, None):
        rt = _adapter({WORK: before, REVIEW: dict(_DEP_PARKED)})
        assert await _hold(monkeypatch, rt) == service.HOLD_DECISION, before


async def test_a_review_with_no_known_predecessor_holds(monkeypatch):
    rt = _adapter({WORK: {"state": "RUNNING"}, REVIEW: dict(_DEP_PARKED)})
    assert await _hold(monkeypatch, rt, ((REVIEW, None),)) == service.HOLD_DECISION


def test_task_read_defaults_to_false_and_holds():
    assert StepStatus("s").task_read is False
    step = StepStatus(REVIEW, "t", "PARKED", park_reason="DEPENDENCY_INCOMPLETE")
    before = StepStatus(WORK, "t0", "RUNNING", task_read=True)
    assert not_reached(step, before) is False


async def test_a_status_with_task_read_omitted_holds(monkeypatch):
    class Runtime:
        async def status(self, workflow_id):
            return WorkflowStatus(
                "running",
                steps=(
                    StepStatus(WORK, "t0", "RUNNING", task_read=True),
                    StepStatus(REVIEW, "t1", "PARKED", park_reason="DEPENDENCY_INCOMPLETE"),
                ),
            )

    assert await _hold(monkeypatch, Runtime()) == service.HOLD_DECISION


async def test_the_adapter_sets_task_read_only_for_a_task_it_read():
    rt = _adapter({WORK: {"state": "RUNNING"}, REVIEW: None})
    status = await rt.status("wf_1")
    assert status.step(WORK).task_read is True
    assert status.step(REVIEW).task_read is False


@pytest.mark.parametrize("state", ["PENDING", "SKIPPED", "pending", "READY"])
async def test_pending_or_skipped_from_the_real_adapter_holds(monkeypatch, state):
    rt = _adapter({WORK: {"state": "RUNNING"}, REVIEW: {"state": state}})
    assert await _hold(monkeypatch, rt) == service.HOLD_DECISION


def test_no_state_list_releases_the_hold():
    from oracle.swarm import runtime as swarm_runtime

    assert not hasattr(swarm_runtime, "NOT_REACHED_STATES")
    before = StepStatus(WORK, "t0", "RUNNING", task_read=True)
    for state in ("PENDING", "SKIPPED"):
        assert not_reached(StepStatus(REVIEW, "t", state, task_read=True), before) is False


async def test_an_opened_wait_holds_from_the_live_read(monkeypatch):
    rt = _adapter(
        {
            WORK: {"state": "SUCCEEDED"},
            REVIEW: {"state": "PARKED", "park_reason": "AWAITING_INPUT", "metadata": OPENED},
        }
    )
    assert await _hold(monkeypatch, rt) == service.HOLD_DECISION
    # Its predecessor forged back to running does not release an opened wait.
    rt = _adapter(
        {
            WORK: {"state": "RUNNING"},
            REVIEW: {**_DEP_PARKED, "metadata": OPENED},
        }
    )
    assert await _hold(monkeypatch, rt) == service.HOLD_DECISION


async def test_a_work_step_running_with_later_reviews_dependency_parked_releases(monkeypatch):
    rt = _adapter(
        {
            "a-1-analyst": {"state": "SUCCEEDED"},
            "a-2-writer": {"state": "RUNNING"},
            "a-review1": dict(_DEP_PARKED),
            "b-1-writer": dict(_DEP_PARKED),
            "b-review1": dict(_DEP_PARKED),
            "b-revise1": dict(_DEP_PARKED),
            "b-review2": dict(_DEP_PARKED),
        }
    )
    reviews = (("a-review1", "a-2-writer"), ("b-review1", "b-1-writer"), ("b-review2", "b-revise1"))
    assert await _hold(monkeypatch, rt, reviews) is None
    # The first segment's work succeeds: its review is reached, whatever it reads.
    rt = _adapter(
        {
            "a-2-writer": {"state": "SUCCEEDED"},
            "a-review1": dict(_DEP_PARKED),
            "b-1-writer": dict(_DEP_PARKED),
            "b-review1": dict(_DEP_PARKED),
            "b-revise1": dict(_DEP_PARKED),
            "b-review2": dict(_DEP_PARKED),
        }
    )
    assert await _hold(monkeypatch, rt, reviews) == service.HOLD_DECISION


# --------------------------------------------------------------------------- end to end


def _predecessor(swarm, review: str) -> str:
    (before,) = swarm.workflows["wf_1"].step(review).depends_on
    return before


async def test_the_hold_plan_names_each_reviews_predecessor(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    from oracle.runs.models import Run
    from oracle.tenancy import tenant_session

    async with tenant_session(owner[0]) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        plan = await service._hold_plan(s, row.id)
    assert plan.reviews
    for review, before in plan.reviews:
        assert before == _predecessor(swarm, review), review


async def test_a_forged_review_row_cannot_release_the_hold_end_to_end(client, owner):
    """SwarmCloud's work step succeeded; a worker rewrote the review's task back to
    PARKED/DEPENDENCY_INCOMPLETE before Oracle's tick recorded the wait: held."""
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    token = token_of(swarm)
    review = "baseline-review1"
    before = _predecessor(swarm, review)
    assert await _run_token_writes(token) is False  # #112: work step not done, writes

    swarm.forged[before] = {"state": "SUCCEEDED"}
    service._hold_cache.clear()
    assert await _run_token_writes(token) is True
    assert (await get(client, auth, run["id"]))["status"] != "awaiting_checkpoint"


async def test_an_opened_wait_holds_before_oracle_records_its_checkpoint(client, owner):
    _, auth = owner
    swarm = on()
    use(swarm)
    swarm.steps_per_poll = 0
    run = await started(client, auth)
    token = token_of(swarm)
    assert await _run_token_writes(token) is False
    # SwarmCloud runs the work step and opens the wait; Oracle has not ticked.
    swarm.steps_per_poll = None
    service._hold_cache.clear()
    assert await _run_token_writes(token) is True
    assert swarm.workflows["wf_1"].step("baseline-review1").park_reason == "AWAITING_INPUT"
    assert (await get(client, auth, run["id"]))["status"] != "awaiting_checkpoint"
