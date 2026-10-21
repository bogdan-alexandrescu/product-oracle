"""The parse queue (owner decision 2026-10-20): at most 2 parses running or queued per person,
a wait of more than 10 s for a free worker is a 503, and a tick that gets no worker retries on
the next tick."""

import asyncio
import threading
import time

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
