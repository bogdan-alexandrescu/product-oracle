"""The parse queue (owner decision 2026-10-20): at most 2 parses running or queued per person,
a wait of more than 10 s for a free worker is a 503, and a tick that gets no worker retries on
the next tick."""

import asyncio
import threading
import time
import uuid

import pytest

from oracle import safe_yaml
from oracle.docs import parser
from oracle.runs import flows
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_mcp import api_token
from tests.test_runs import get, started

PRD = draft("prd_v1.md")
BUSY_YOU = {
    "code": "parse_busy_you",
    "message": "Another import of yours is still being checked. Try again when it finishes.",
}
BUSY = {
    "code": "parse_busy",
    "message": "Oracle is busy checking other imports. Try again in a moment.",
}


class Gate:
    """A parse_draft that blocks (on a pool thread) for text starting with 'BLOCK'."""

    def __init__(self, monkeypatch):
        self.release = threading.Event()
        self.running = 0
        self.lock = threading.Lock()
        real = parser.parse_draft

        def fake(markdown):
            if markdown.startswith("BLOCK"):
                with self.lock:
                    self.running += 1
                self.release.wait(30)
                with self.lock:
                    self.running -= 1
                return real(PRD)
            return real(markdown)

        monkeypatch.setattr(parser, "parse_draft", fake)

    async def until(self, n: int):
        for _ in range(500):
            if self.running >= n:
                return
            await asyncio.sleep(0.01)
        raise AssertionError(f"only {self.running} parses running")


def bearer(raw: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw}"}


async def test_one_person_has_two_parses_and_the_rest_get_429(client, monkeypatch):
    tenant, auth = await seed_auth()
    other = bearer(await api_token(tenant))
    gate = Gate(monkeypatch)
    posts = [asyncio.create_task(import_draft(client, auth, f"BLOCK {i}")) for i in range(8)]
    await gate.until(2)
    done, pending = await asyncio.wait(posts, timeout=5, return_when=asyncio.ALL_COMPLETED)
    refused = [t.result() for t in done]
    assert len(pending) == 2 and len(refused) == 6
    assert all(r.status_code == 429 and r.json() == BUSY_YOU for r in refused), refused[0].text
    # Another person's small import starts at once.
    start = time.perf_counter()
    resp = await import_draft(client, other, PRD)
    assert resp.status_code == 201 and time.perf_counter() - start < 2, resp.text[:200]
    gate.release.set()
    await asyncio.gather(*pending)


async def test_a_wait_for_a_worker_past_the_limit_is_503(client, monkeypatch):
    tenant, auth = await seed_auth()
    monkeypatch.setattr(safe_yaml, "QUEUE_SECONDS", 0.5)
    gate = Gate(monkeypatch)
    holders = [
        asyncio.create_task(import_draft(client, bearer(await api_token(tenant)), f"BLOCK {i}"))
        for i in range(4)
    ]
    await gate.until(4)  # the pool of 4 is full
    start = time.perf_counter()
    resp = await import_draft(client, bearer(await api_token(tenant)), PRD)
    took = time.perf_counter() - start
    assert resp.status_code == 503 and resp.json() == BUSY, resp.text[:200]
    assert 0.4 < took < 5, took
    gate.release.set()
    await asyncio.gather(*holders)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_a_tick_without_a_worker_retries_on_the_next_tick(client, runtime, monkeypatch):
    from oracle.docs import service as docs_service

    _, auth = await seed_auth()
    prd = PRD.replace("checkout-redesign", "example-prd")
    runtime.script["prd_draft"] = [Outcome(artifacts={"prd.md": prd})]
    off = dict.fromkeys(flows.FLOWS["baseline_to_prd"].checkpoints, False)
    run = await started(client, auth, checkpoints=off)
    real = docs_service.parse_draft_async
    calls = {"n": 0}

    async def busy_once(markdown):
        calls["n"] += 1
        if calls["n"] == 1:
            raise safe_yaml.ParseBusy("parse_busy")
        return await real(markdown)

    monkeypatch.setattr(docs_service, "parse_draft_async", busy_once)
    saw_busy = False
    for _ in range(8):
        resp = await client.post("/v1/internal/tick", headers=auth)
        assert resp.status_code == 200, resp.text
        saw_busy = saw_busy or bool(resp.json()["errors"])
        current = await get(client, auth, run["id"])
        assert current["status"] != "failed", current.get("error")
    assert saw_busy and calls["n"] >= 2
    assert current["segments"][3]["draft_import"]["version"] is not None


async def test_cancelled_callers_keep_the_slot_until_the_workers_finish():
    release = threading.Event()
    running = []

    def work():
        running.append(1)
        release.wait(30)
        return 1

    with safe_yaml.parse_owner("r126e-cancel"):
        tasks = [asyncio.create_task(safe_yaml.run_parse(work)) for _ in range(2)]
        for _ in range(500):
            if len(running) == 2:
                break
            await asyncio.sleep(0.01)
        assert len(running) == 2
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        with pytest.raises(safe_yaml.ParseBusy) as busy:
            await safe_yaml.run_parse(lambda: 1)
        assert busy.value.status == 429
        release.set()
        for _ in range(500):
            if "r126e-cancel" not in safe_yaml._active:
                break
            await asyncio.sleep(0.01)
        assert await safe_yaml.run_parse(lambda: 2) == 2


async def test_submit_failure_frees_the_slot(monkeypatch):
    class Dead:
        def submit(self, *a, **k):
            raise RuntimeError("cannot schedule new futures after shutdown")

    monkeypatch.setattr(safe_yaml, "_EXECUTOR", Dead())
    with safe_yaml.parse_owner("r126e-submit"):
        with pytest.raises(RuntimeError):
            await safe_yaml.run_parse(lambda: 1)
    assert "r126e-submit" not in safe_yaml._active


async def test_busy_response_has_retry_after(client, monkeypatch):
    tenant, auth = await seed_auth()
    gate = Gate(monkeypatch)
    posts = [asyncio.create_task(import_draft(client, auth, f"BLOCK {i}")) for i in range(3)]
    await gate.until(2)
    done, pending = await asyncio.wait(posts, timeout=5, return_when=asyncio.FIRST_COMPLETED)
    resp = next(iter(done)).result()
    assert resp.status_code == 429 and resp.headers["retry-after"] == "5"
    gate.release.set()
    await asyncio.gather(*pending)


def test_nested_citation_markers_are_stripped_to_nothing():
    from oracle.docs.parser import strip_citations

    assert strip_citations("claim [c:[c:x]a] end") == "claim end"
    assert strip_citations("plain [c:x]") == "plain"


def test_blocker_lines_strip_nested_citation_markers():
    from oracle.blockers.render import _inline

    assert _inline("claim [c:[c:x]a] end") == "claim end"


async def test_the_budget_is_in_force_inside_the_parse():
    from oracle import parse_budget

    assert await safe_yaml.run_parse_within(parse_budget.active, seconds=1) is True


async def test_a_parse_past_its_budget_is_refused_near_the_cap_and_frees_the_slot():
    from oracle import parse_budget

    ended = threading.Event()

    def spin():
        # Busy CPU work between budget checks; gives up on its own after 3 s so a broken
        # budget can not hold the worker for the rest of the session.
        try:
            stop = time.perf_counter() + 3
            while time.perf_counter() < stop:
                parse_budget.check()
            return "ran to the end"
        finally:
            ended.set()

    with safe_yaml.parse_owner("r126f-budget"):
        start = time.perf_counter()
        with pytest.raises(safe_yaml.ParseTimeout):
            await safe_yaml.run_parse_within(spin, seconds=0.2)
        took = time.perf_counter() - start
    # Refused by the CPU budget (0.2 s), not by the caller's wall (4 x 0.2 s).
    assert took < 0.5, took
    assert ended.wait(1)
    for _ in range(100):
        if "r126f-budget" not in safe_yaml._active:
            break
        await asyncio.sleep(0.01)
    assert "r126f-budget" not in safe_yaml._active


async def test_a_caller_cancelled_while_queued_does_not_run_its_parse(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    pool = ThreadPoolExecutor(max_workers=1)
    monkeypatch.setattr(safe_yaml, "_EXECUTOR", pool)
    release = threading.Event()
    ran = []
    try:
        busy = asyncio.create_task(safe_yaml.run_parse(release.wait, 30))
        await asyncio.sleep(0.05)
        queued = asyncio.create_task(safe_yaml.run_parse(lambda: ran.append(1)))
        await asyncio.sleep(0.05)
        queued.cancel()
        await asyncio.gather(queued, return_exceptions=True)
        release.set()
        await busy
        await asyncio.get_running_loop().run_in_executor(pool, lambda: None)
        assert ran == []
    finally:
        release.set()
        pool.shutdown(wait=True)


async def test_a_submit_that_fails_after_queueing_does_not_run_the_parse(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor

    pool = ThreadPoolExecutor(max_workers=1)
    release = threading.Event()
    pool.submit(release.wait, 30)
    queued = []

    class Flaky:
        def submit(self, fn, *a, **k):
            queued.append(pool.submit(fn, *a, **k))  # queued behind the blocker ...
            raise RuntimeError("can't start new thread")  # ... then submit fails

    monkeypatch.setattr(safe_yaml, "_EXECUTOR", Flaky())
    ran = []
    try:
        with safe_yaml.parse_owner("r126f-submit"):
            with pytest.raises(RuntimeError):
                await safe_yaml.run_parse(lambda: ran.append(1))
        assert "r126f-submit" not in safe_yaml._active
        release.set()
        with pytest.raises(safe_yaml.ParseBusy):
            queued[0].result(5)
        assert ran == []
    finally:
        release.set()
        pool.shutdown(wait=True)


def test_the_design_check_stops_at_its_budget():
    # The design check refuses as 'took over N seconds' (specs.service): it must check the
    # budget as it goes, or that refusal only comes at the caller's wall (4 x N).
    from oracle import parse_budget
    from oracle.specs.design import check_design
    from oracle.specs.sanitize import sanitize_svg, sanitize_wireframe
    from tests.specs_helpers import FLOW_SVG, design_json, wireframe_html

    reqs, sections = [str(uuid.uuid4())], ["s-1"]
    text = design_json(reqs, sections, screens=2)
    with parse_budget.limit(-1):
        with pytest.raises(parse_budget.Exceeded):
            check_design(text, prd_sections=set(sections), requirement_ids=set(reqs), screens=2)
        with pytest.raises(parse_budget.Exceeded):
            sanitize_svg(FLOW_SVG, title="t")
        with pytest.raises(parse_budget.Exceeded):
            sanitize_wireframe(wireframe_html(1), title="t", annotations=[])
