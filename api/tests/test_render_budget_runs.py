"""A run's tick never fails a run because a roadmap's dates are still being found
(security review of PR #134, 2026-10-20): the tick gives up on that run, and the next tick
tries again. Not a failed try of a resumed advance (``RESUME_TRIES``)."""

from oracle.roadmap import doc_dates
from oracle.runs import service
from tests.fixtures import seed_auth
from tests.test_adapter_v2 import _tick_errors, on, use
from tests.test_adapter_v2 import settings as _v2_settings
from tests.test_adapter_v2_round9 import _segment
from tests.test_runs import get, started

# The same environment as test_adapter_v2 (Oracle's public URL, default timings).
settings = _v2_settings


async def test_dates_still_being_found_in_a_tick_retry_and_never_fail_the_run(client, monkeypatch):
    tenant_id, auth = await seed_auth()
    use(on())
    run = await started(client, auth)
    real = service._import_baseline
    calls = [0]

    async def pending(db, r, text):
        # A read of a roadmap version in the advance, whose dates are still being found.
        calls[0] += 1
        if calls[0] <= service.RESUME_TRIES + 1:
            raise doc_dates.DatesUnavailable(pending=True)
        return await real(db, r, text)

    monkeypatch.setattr(service, "_import_baseline", pending)
    for n in range(1, service.RESUME_TRIES + 2):
        errors = await _tick_errors(client, auth)
        assert errors == [f"run {run['id']}: dates_pending"], errors
        assert calls[0] == n
        seg = await _segment(tenant_id, run["id"])
        assert seg.status != "failed"
        assert "resume_failures" not in seg.artifacts["attempts"][-1]
    # The dates are found by now: the next tick imports and the run goes on.
    assert await _tick_errors(client, auth) == []
    assert calls[0] == service.RESUME_TRIES + 2
    got = await get(client, auth, run["id"])
    assert got["status"] == "awaiting_checkpoint" and got["waiting_on"] == "baseline_confirm"
