"""A step's listed file that SwarmCloud will not serve: a refusal that will not change
(a 4xx such as 422) skips that file and the step's results are imported without it, noted
once on the segment; a refusal that may pass (a 5xx) is read again; a file the import
needs that SwarmCloud refuses holds the import with a note and a tick error in words."""

import httpx
import pytest

from oracle.swarm import RuntimeUnavailable, set_runtime
from oracle.swarm.settings import get_runtime_settings
from oracle.swarm.swarmcloud import StaticBearer, SwarmCloudRuntime
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_runs import get, started

PUBLIC = "https://oracle.example.com"


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv("ORACLE_PUBLIC_URL", PUBLIC)
    for key in (
        "ORACLE_CHECKPOINT_WAIT_SECONDS",
        "ORACLE_CHECKPOINT_TAIL_SECONDS",
        "ORACLE_STEP_SECONDS",
        "ORACLE_TRUSTED_PROXY_HOPS",
    ):
        monkeypatch.delenv(key, raising=False)
    get_runtime_settings.cache_clear()
    yield
    get_runtime_settings.cache_clear()
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


def _transport(status: int) -> httpx.MockTransport:
    """One succeeded step whose task lists two text files; SwarmCloud answers ``status``
    to a raw read of ``_export.yaml``."""

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/v1/workflows/wf_1":
            return httpx.Response(
                200,
                json={
                    "workflow": {
                        "state": "SUCCEEDED",
                        "steps": [{"step_id": "s1", "task_id": "t1", "state": "SUCCEEDED"}],
                    }
                },
            )
        if path == "/v1/tasks/t1/artifacts":
            rows = [{"name": "notes.md", "role": None}, {"name": "_export.yaml", "role": None}]
            return httpx.Response(200, json={"artifacts": rows})
        if path == "/v1/tasks/t1/artifacts/raw":
            if request.url.params["name"] == "_export.yaml":
                return httpx.Response(
                    status,
                    json={
                        "code": "validation_error" if status < 500 else "unavailable",
                        "message": "artifact name not allowed",
                        "detail": {"reason": "invalid_name"},
                    },
                )
            return httpx.Response(200, text="Some notes.")
        return httpx.Response(404, json={"detail": "Not Found"})

    return httpx.MockTransport(handle)


def _runtime(status: int) -> SwarmCloudRuntime:
    return SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("sc-bearer"), transport=_transport(status)
    )


@pytest.mark.parametrize("status", [400, 403, 410, 413, 422])
async def test_a_file_refused_for_good_is_skipped_and_reported(status):
    skipped: dict[str, str] = {}
    files = await _runtime(status).artifacts("wf_1", skipped=skipped)
    assert files == {"notes.md": "Some notes."}
    assert list(skipped) == ["_export.yaml"]
    assert str(status) in skipped["_export.yaml"]
    assert "artifact name not allowed" in skipped["_export.yaml"]
    # Existing callers: the same answer, without the report.
    assert await _runtime(status).artifacts("wf_1") == {"notes.md": "Some notes."}


@pytest.mark.parametrize("status", [500, 503, 429])
async def test_a_file_refused_for_now_is_still_read_again(status):
    skipped: dict[str, str] = {}
    with pytest.raises(RuntimeUnavailable) as exc:
        await _runtime(status).artifacts("wf_1", skipped=skipped)
    assert exc.value.retryable and skipped == {}


def _swarm(refused: str, status: int) -> FakeSwarmCloud:
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    swarm.extra_files = {"_export.yaml": "rows: []\n"}
    swarm.raw_refusals = {refused: status}
    set_runtime(swarm.runtime())
    return swarm


async def _tick(client, auth) -> dict:
    resp = await client.post("/v1/internal/tick", headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _naming(run: dict, name: str) -> list[str]:
    return [n for n in run["notes"] if name in n]


async def test_a_refused_extra_file_is_skipped_and_the_segment_reaches_its_checkpoint(
    client, owner
):
    _, auth = owner
    _swarm("_export.yaml", 422)
    run = await started(client, auth)
    assert (await _tick(client, auth))["errors"] == []
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint", run["notes"]
    seg = run["segments"][0]
    assert seg["status"] == "succeeded"
    notes = _naming(run, "_export.yaml")
    assert len(notes) == 1, run["notes"]
    assert "422" in notes[0] and "artifact name not allowed" in notes[0]
    await _tick(client, auth)
    run = await get(client, auth, run["id"])
    assert len(_naming(run, "_export.yaml")) == 1, run["notes"]


async def test_a_file_refused_for_now_is_read_again_without_a_note(client, owner):
    _, auth = owner
    swarm = _swarm("_export.yaml", 503)
    run = await started(client, auth)
    out = await _tick(client, auth)
    assert out["errors"], out
    run = await get(client, auth, run["id"])
    assert run["status"] == "running"
    assert _naming(run, "_export.yaml") == []
    swarm.raw_refusals = {}
    assert (await _tick(client, auth))["errors"] == []
    run = await get(client, auth, run["id"])
    assert run["status"] == "awaiting_checkpoint"
    assert _naming(run, "_export.yaml") == []


async def test_a_refused_file_the_import_needs_holds_it_with_a_note_in_words(client, owner):
    _, auth = owner
    _swarm("baseline.yaml", 422)
    run = await started(client, auth)
    out = await _tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "running"
    assert run["segments"][0]["status"] == "running"
    # The check's answer says which file SwarmCloud refused and why, in words.
    assert len(out["errors"]) == 1, out
    error = out["errors"][0]
    assert "baseline.yaml" in error and "422" in error and "artifact name not allowed" in error
    assert "SwarmCloud" in error
    notes = _naming(run, "baseline.yaml")
    assert len(notes) == 1, run["notes"]
    assert "422" in notes[0] and "artifact name not allowed" in notes[0]
    out = await _tick(client, auth)
    assert "baseline.yaml" in out["errors"][0]
    run = await get(client, auth, run["id"])
    assert len(_naming(run, "baseline.yaml")) == 1, run["notes"]
