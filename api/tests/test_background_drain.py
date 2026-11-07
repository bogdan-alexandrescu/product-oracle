"""drain() of the work sent off after a response (the intake read's submission, an
invite's email) returns once that work is done, even when it finished before its done
callback (which forgets it) had its turn.

On CI a test hung 15 minutes in ``create_intake``'s ``intake_read.drain()``: Python 3.12's
``gather`` over tasks that are all done completes at once, ``await`` on it then never
yields, so the callback that empties the set never runs and ``while`` spins for ever.

Each case runs on a loop of its own in a thread, so a drain that spins fails the test
in seconds instead of hanging the worker.

Synthetic placeholders only.
"""

import asyncio
import threading
import uuid

from oracle.intake import read as intake_read
from oracle.members import delivery
from oracle.v2.models import ProductIntake

SECONDS = 5


def _drains(scenario, pending: set) -> bool:
    finished = threading.Event()

    def run() -> None:
        asyncio.run(scenario())
        finished.set()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    ok = finished.wait(SECONDS)
    # Frees a drain that spins (it loops while the set is not empty).
    pending.clear()
    thread.join(SECONDS)
    return ok


# protects=api-suite-hang: POST /v1/intakes' read submitted after the response, then
# drained (tests, shutdown); fails_when=drain() spins without yielding when the submission
# finished before its done callback ran; no_claim=what the submission does.
def test_drain_returns_when_the_read_finished_before_its_callback_ran(monkeypatch):
    async def done_at_once(tenant_id, intake_id, read) -> None:
        return None

    monkeypatch.setattr(intake_read, "_submit_in", done_at_once)
    intake = ProductIntake(
        id=uuid.uuid4(),
        analysis={"extraction": {"read": {"path": "swarmcloud", "run_id": str(uuid.uuid4())}}},
    )

    async def scenario() -> None:
        intake_read.submit_later(uuid.uuid4(), intake)
        # The submission runs and ends here; its done callback waits behind this task.
        await asyncio.sleep(0)
        await intake_read.drain()

    assert _drains(scenario, intake_read._LATER), "drain() did not return"


# protects=api-suite-hang: an invite's email sent after the response, then drained;
# fails_when=drain() spins when the send finished before its done callback ran.
def test_drain_returns_when_the_send_finished_before_its_callback_ran(monkeypatch):
    async def done_at_once(tenant_id, invite_id) -> None:
        return None

    monkeypatch.setattr(delivery, "_deliver_logged", done_at_once)

    async def scenario() -> None:
        delivery.schedule(uuid.uuid4(), uuid.uuid4())
        await asyncio.sleep(0)
        await delivery.drain()

    assert _drains(scenario, delivery._tasks), "drain() did not return"


def test_drain_still_waits_for_work_under_way(monkeypatch):
    seen: list[str] = []

    async def slow(tenant_id, intake_id, read) -> None:
        await asyncio.sleep(0.05)
        seen.append("submitted")

    monkeypatch.setattr(intake_read, "_submit_in", slow)
    intake = ProductIntake(
        id=uuid.uuid4(),
        analysis={"extraction": {"read": {"path": "swarmcloud", "run_id": str(uuid.uuid4())}}},
    )

    async def scenario() -> None:
        intake_read.submit_later(uuid.uuid4(), intake)
        await intake_read.drain()
        seen.append("drained")

    assert _drains(scenario, intake_read._LATER)
    assert seen == ["submitted", "drained"]
