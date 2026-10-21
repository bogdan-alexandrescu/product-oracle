"""ParseBusy on the tick paths (owner decision 2026-10-20): a parse the pool would not take
never fails a run or refuses an import. The tick rolls back, records ``run <id>: parse_busy``
and the next tick retries, on a first advance and on a resumed one alike."""

import pytest

from oracle import safe_yaml
from oracle.roadmap import items as roadmap_items
from oracle.specs import contract
from oracle.swarm import FakeRuntime, set_runtime
from tests.specs_helpers import (
    get_run,
    make_world,
    pending,
    request_spec,
    start,
)


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def test_a_spec_import_that_hits_parse_busy_retries_on_the_next_tick(
    client, runtime, monkeypatch
):
    world = await make_world(client)
    owner = world.ctx.as_("owner")
    created = await request_spec(client, world, depth="brief", screens=2)
    await start(client, world.ctx.as_("approver"), created["run_id"])
    real = safe_yaml.run_parse_within
    busy = {"left": 7}

    async def maybe_busy(fn, *args, **kwargs):
        # The spec render (compose) finds no worker, more times in a row than a failing
        # resume is allowed (RESUME_TRIES).
        if fn is contract.compose and busy["left"] > 0:
            busy["left"] -= 1
            raise safe_yaml.ParseBusy("parse_busy")
        return await real(fn, *args, **kwargs)

    monkeypatch.setattr(safe_yaml, "run_parse_within", maybe_busy)
    for _ in range(7):
        resp = await client.post("/v1/internal/tick", headers=owner)
        assert resp.status_code == 200, resp.text
        assert resp.json()["errors"] == [f"run {created['run_id']}: parse_busy"], resp.json()
        run = await get_run(client, owner, created["run_id"])
        assert run["status"] != "failed", run.get("error")
    resp = await client.post("/v1/internal/tick", headers=owner)
    assert resp.status_code == 200 and resp.json()["errors"] == [], resp.text
    run = await get_run(client, owner, created["run_id"])
    imported = pending(run)["payload"]["import"]
    assert "error" not in imported, imported
    assert busy["left"] == 0


async def test_a_roadmap_version_import_does_not_swallow_parse_busy(monkeypatch):
    class Db:
        def begin_nested(self):
            return self

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    async def found(db, document):
        return "items", object()

    async def busy(*args, **kwargs):
        raise safe_yaml.ParseBusy("parse_busy")

    monkeypatch.setattr(roadmap_items, "run_items_file", found)
    monkeypatch.setattr(roadmap_items, "import_items", busy)
    with pytest.raises(safe_yaml.ParseBusy):
        await roadmap_items.on_roadmap_version(Db(), object(), object())
