"""The agent runtimes: FakeRuntime behaviour and SwarmCloudRuntime against a mocked API."""

import json
import time
from decimal import Decimal

import httpx
import jwt
import pytest

from oracle.swarm import (
    AgentRuntime,
    FakeRuntime,
    McpAccess,
    Outcome,
    RuntimeUnavailable,
    StepSpec,
    SwarmCloudRuntime,
    UnconfiguredSwarmCloud,
    WorkflowSpec,
    get_runtime,
    set_runtime,
)
from oracle.swarm.settings import RuntimeSettings, get_runtime_settings
from oracle.swarm.swarmcloud import (
    NO_MCP_NOTE,
    GoogleAccessToken,
    GoogleIdToken,
    StaticBearer,
    auth_from_settings,
)

SPEC = WorkflowSpec(
    name="oracle-baseline_to_prd-baseline",
    steps=(
        StepSpec("baseline-1-researcher", "researcher", "claude-code", "Research."),
        StepSpec(
            "baseline-2-analyst",
            "analyst",
            "claude-code",
            "Analyse.",
            depends_on=("baseline-1-researcher",),
            input_from={"baseline-1-researcher": "researcher.md"},
        ),
    ),
    outputs=("baseline.yaml",),
    mcp=McpAccess("http://oracle.test/mcp", "ort_secret-run-token", ("read:sources",)),
    labels={"run_id": "r1", "segment": "baseline", "attempt": "1", "estimate_usd": "7.00"},
)


async def test_fake_runtime_defaults_and_scripts():
    fake = FakeRuntime({"baseline": [Outcome(polls=1, cost_usd=Decimal(3))]})
    assert isinstance(fake, AgentRuntime)
    wid = await fake.submit(SPEC)
    assert (await fake.status(wid)).state == "running"
    assert (await fake.status(wid)).state == "succeeded"
    assert await fake.cost(wid) == Decimal(3)
    assert set(await fake.artifacts(wid)) == {"baseline.yaml", "summary.md"}

    # Exhausted script: the default (succeeds at once, 90% of the estimate).
    wid2 = await fake.submit(SPEC)
    status = await fake.status(wid2)
    assert status.state == "succeeded" and status.cost_usd == Decimal("6.3")


async def test_fake_runtime_answers_for_ids_another_process_submitted():
    wid = await FakeRuntime().submit(
        WorkflowSpec(
            name="x",
            steps=SPEC.steps,
            labels={"segment": "prd_draft", "attempt": "2", "estimate_usd": "9"},
        )
    )
    other = FakeRuntime()
    assert (await other.status(wid)).cost_usd == Decimal("8.1")
    prd = (await other.artifacts(wid))["prd.md"]
    assert "Draft 2" in prd and prd.startswith("---\ntitle:")
    with pytest.raises(LookupError):
        await other.status("not-a-fake-id")


async def test_runtime_is_chosen_by_settings(monkeypatch):
    # SwarmCloud by default; without its settings it says what is missing.
    for key in ("ORACLE_RUNTIME", "ORACLE_SWARMCLOUD_URL", "ORACLE_SWARMCLOUD_TOKEN"):
        monkeypatch.delenv(key, raising=False)
    get_runtime_settings.cache_clear()
    set_runtime(None)
    try:
        runtime = get_runtime()
        assert runtime.name == "swarmcloud"
        assert isinstance(runtime, UnconfiguredSwarmCloud)
        assert "ORACLE_SWARMCLOUD_URL" in runtime.notes()[0]
        with pytest.raises(RuntimeUnavailable, match="not configured"):
            await runtime.submit(SPEC)

        monkeypatch.setenv("ORACLE_SWARMCLOUD_URL", "https://swarm.example.com")
        monkeypatch.setenv("ORACLE_SWARMCLOUD_TOKEN", "t0k")
        get_runtime_settings.cache_clear()
        set_runtime(None)
        assert isinstance(get_runtime(), SwarmCloudRuntime)

        # The FakeRuntime only where a test (or a local demo) chooses it.
        monkeypatch.setenv("ORACLE_RUNTIME", "fake")
        get_runtime_settings.cache_clear()
        set_runtime(None)
        assert get_runtime().name == "fake"
    finally:
        get_runtime_settings.cache_clear()
        set_runtime(None)


def test_auth_from_settings():
    s = RuntimeSettings(swarmcloud_auth="bearer", swarmcloud_token="t0k")
    assert auth_from_settings(s) == StaticBearer("t0k")
    s = RuntimeSettings(swarmcloud_auth="google_id_token", swarmcloud_audience="aud")
    assert isinstance(auth_from_settings(s), GoogleIdToken)
    with pytest.raises(ValueError):
        auth_from_settings(RuntimeSettings(swarmcloud_auth="bearer"))
    with pytest.raises(ValueError):
        auth_from_settings(RuntimeSettings(swarmcloud_auth="google_id_token"))
    with pytest.raises(ValueError):
        SwarmCloudRuntime("", StaticBearer("x"))
    s = RuntimeSettings(swarmcloud_auth="google_access_token")
    assert isinstance(auth_from_settings(s), GoogleAccessToken)


async def test_access_token_from_metadata_is_cached_and_never_leaks():
    calls: list[httpx.Request] = []

    def metadata(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        assert request.headers["metadata-flavor"] == "Google"
        return httpx.Response(200, json={"access_token": "ya29.example", "expires_in": 3599})

    auth = GoogleAccessToken()
    async with httpx.AsyncClient(transport=httpx.MockTransport(metadata)) as client:
        assert await auth.header(client) == "Bearer ya29.example"
        assert await auth.header(client) == "Bearer ya29.example"
    assert len(calls) == 1
    assert "ya29" not in repr(auth)

    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    async with httpx.AsyncClient(transport=httpx.MockTransport(broken)) as client:
        with pytest.raises(RuntimeUnavailable) as exc:
            await GoogleAccessToken().header(client)
    assert "HTTP 500" in str(exc.value)


class FakeSwarm:
    """Answers SwarmCloud's workflow and task routes; records every request."""

    def __init__(self, state="RUNNING"):
        self.state = state
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path, method = request.url.path, request.method
        if method == "POST" and path == "/v1/workflows":
            return httpx.Response(201, json={"workflow": {"workflow_id": "wf_1"}, "dispatch": {}})
        if method == "GET" and path == "/v1/workflows/wf_1":
            return httpx.Response(
                200,
                json={
                    "workflow": {
                        "workflow_id": "wf_1",
                        "state": self.state,
                        "steps": [
                            {"step_id": "a", "task_id": "t1"},
                            {"step_id": "b", "task_id": "t2"},
                        ],
                    },
                    "tasks": [
                        {"id": "t1", "state": "SUCCEEDED", "cost_usd_total": 1.25},
                        {
                            "id": "t2",
                            "state": "FAILED" if self.state == "FAILED" else "SUCCEEDED",
                            "cost_usd_total": 2.5,
                            "last_error": "agent exited 1",
                        },
                    ],
                },
            )
        if method == "POST" and path == "/v1/workflows/wf_1/cancel":
            return httpx.Response(200, json={"tasks_cancelled": ["t2"]})
        if method == "GET" and path.endswith("/artifacts"):
            task = path.split("/")[3]
            names = {"t1": ["researcher.md", "prd.md"], "t2": ["prd.md", "agent.log"]}[task]
            rows = [{"name": n, "role": None} for n in names]
            rows.append({"name": "stdout.txt", "role": "agent_stdout"})
            return httpx.Response(200, json={"artifacts": rows, "complete": True})
        if method == "GET" and path.endswith("/artifacts/raw"):
            task = path.split("/")[3]
            return httpx.Response(200, text=f"{request.url.params['name']} from {task}")
        return httpx.Response(404, json={"detail": "no route"})


def _runtime(swarm: FakeSwarm, auth=None) -> SwarmCloudRuntime:
    return SwarmCloudRuntime(
        "https://swarm.test/",
        auth or StaticBearer("sc-bearer"),
        transport=httpx.MockTransport(swarm),
    )


async def test_swarmcloud_submit_maps_steps_and_never_sends_the_run_token():
    swarm = FakeSwarm()
    rt = _runtime(swarm)
    assert rt.can_reach_oracle is False and rt.notes() == [NO_MCP_NOTE]
    assert "#1433" in NO_MCP_NOTE
    assert await rt.submit(SPEC) == "wf_1"
    req = swarm.requests[0]
    assert req.headers["Authorization"] == "Bearer sc-bearer"
    body = json.loads(req.content)
    assert [s["step_id"] for s in body["steps"]] == ["baseline-1-researcher", "baseline-2-analyst"]
    assert body["steps"][1]["depends_on"] == ["baseline-1-researcher"]
    assert body["steps"][1]["input_from"] == {"baseline-1-researcher": "researcher.md"}
    assert body["steps"][0]["runner_profile"] == "claude-code"
    assert body["steps"][0]["input"] == {"prompt": "Research."}
    assert body["metadata"]["run_id"] == "r1"
    assert "ort_secret-run-token" not in req.content.decode()


async def test_swarmcloud_status_cost_artifacts_cancel():
    swarm = FakeSwarm("RUNNING")
    rt = _runtime(swarm)
    status = await rt.status("wf_1")
    assert status.state == "running" and status.cost_usd == Decimal("3.75")
    swarm.state = "SUCCEEDED"
    assert (await rt.status("wf_1")).terminal
    assert await rt.cost("wf_1") == Decimal("3.75")
    files = await rt.artifacts("wf_1")
    # Text files only, agent streams skipped, the later step's prd.md wins.
    assert files == {"researcher.md": "researcher.md from t1", "prd.md": "prd.md from t2"}
    await rt.cancel("wf_1")
    assert swarm.requests[-1].url.path == "/v1/workflows/wf_1/cancel"

    swarm.state = "FAILED"
    status = await rt.status("wf_1")
    assert status.state == "failed" and status.error == "agent exited 1"
    swarm.state = "CANCELLED"
    assert (await rt.status("wf_1")).state == "cancelled"


async def test_swarmcloud_errors_never_carry_the_token():
    rt = _runtime(FakeSwarm())
    with pytest.raises(RuntimeUnavailable) as exc:
        await rt.status("wf_missing")
    assert "404" in str(exc.value) and "sc-bearer" not in str(exc.value)

    def down(request):
        raise httpx.ConnectError("refused")

    rt = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("sc-bearer"), transport=httpx.MockTransport(down)
    )
    with pytest.raises(RuntimeUnavailable) as exc:
        await rt.submit(SPEC)
    assert "sc-bearer" not in str(exc.value)


async def test_google_id_token_auth_is_minted_and_cached():
    token = jwt.encode(
        {"aud": "swarm-aud", "exp": int(time.time()) + 3600}, "k" * 32, algorithm="HS256"
    )
    swarm = FakeSwarm()
    minted = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "metadata.google.internal":
            minted.append(request)
            assert request.headers["Metadata-Flavor"] == "Google"
            assert request.url.params["audience"] == "swarm-aud"
            return httpx.Response(200, text=token)
        return swarm(request)

    rt = SwarmCloudRuntime(
        "https://swarm.test", GoogleIdToken("swarm-aud"), transport=httpx.MockTransport(handler)
    )
    await rt.status("wf_1")
    await rt.status("wf_1")
    assert len(minted) == 1
    assert swarm.requests[0].headers["Authorization"] == f"Bearer {token}"


async def test_swarmcloud_mode_says_so_in_the_runs_notes(client):
    from tests.fixtures import seed_auth

    _, auth = await seed_auth()
    set_runtime(_runtime(FakeSwarm()))
    try:
        run = (
            await client.post(
                "/v1/runs",
                json={"flow": "baseline_to_prd", "document": "example-prd"},
                headers=auth,
            )
        ).json()
        assert run["runtime"] == "swarmcloud"
        assert NO_MCP_NOTE in run["notes"]
        await client.post(f"/v1/runs/{run['id']}/estimate", headers=auth)
        run = (await client.post(f"/v1/runs/{run['id']}/start", headers=auth)).json()
        assert run["segments"][0]["workflow_id"] == "wf_1"
        assert NO_MCP_NOTE in run["notes"]
        flows_ = (await client.get("/v1/flows", headers=auth)).json()
        assert flows_["runtime_notes"] == [NO_MCP_NOTE]
    finally:
        set_runtime(None)


async def test_runtime_status_reports_the_tenant_and_never_the_token(client):
    from oracle.swarm import UnconfiguredSwarmCloud
    from tests.fixtures import seed_auth
    from tests.test_priorities import _token

    _, owner = await seed_auth()

    def me(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/tenants/me"
        assert "x-swarm-tenant" not in request.headers  # the service tenant is the default
        return httpx.Response(200, json={"tenant": {"tenant_id": "u-or-9a0792", "kind": "user"}})

    def refused(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="Audience doesn't match the allowlisted oauth clients")

    try:
        set_runtime(
            SwarmCloudRuntime(
                "https://swarm.test", StaticBearer("sc-bearer"), transport=httpx.MockTransport(me)
            )
        )
        body = (await client.get("/v1/runtime/status", headers=owner)).json()
        assert body["runtime"] == "swarmcloud" and body["reachable"] is True
        assert body["tenant_id"] == "u-or-9a0792" and body["error"] is None

        set_runtime(
            SwarmCloudRuntime(
                "https://swarm.test",
                StaticBearer("sc-bearer"),
                transport=httpx.MockTransport(refused),
            )
        )
        resp = await client.get("/v1/runtime/status", headers=owner)
        body = resp.json()
        assert resp.status_code == 200 and body["reachable"] is False
        assert "401" in body["error"] and "sc-bearer" not in resp.text

        set_runtime(UnconfiguredSwarmCloud("ORACLE_SWARMCLOUD_URL is required"))
        body = (await client.get("/v1/runtime/status", headers=owner)).json()
        assert body["reachable"] is False and "not configured" in body["error"]

        set_runtime(FakeRuntime())
        body = (await client.get("/v1/runtime/status", headers=owner)).json()
        assert body == {
            "runtime": "fake",
            "auth": None,
            "reachable": True,
            "tenant_id": "fake",
            "can_reach_oracle": True,
            "notes": FakeRuntime().notes(),
            "error": None,
        }
        tenant_id = (await client.get("/v1/me", headers=owner)).json()["tenant_id"]
        approver = await _token(tenant_id, "approver")
        assert (await client.get("/v1/runtime/status", headers=approver)).status_code == 403
    finally:
        set_runtime(None)


async def test_whoami_has_one_deadline_and_never_echoes_a_token():
    import asyncio

    from oracle.swarm import RuntimeUnavailable

    async def slow(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(2)
        return httpx.Response(200, json={"tenant": {"tenant_id": "u-or-9a0792"}})

    runtime = SwarmCloudRuntime(
        "https://swarm.test",
        StaticBearer("sc-bearer"),
        timeout=0.2,
        transport=httpx.MockTransport(slow),
    )
    started = asyncio.get_running_loop().time()
    with pytest.raises(RuntimeUnavailable, match="within 0.2 s"):
        await runtime.whoami()
    assert asyncio.get_running_loop().time() - started < 1

    def echo(request: httpx.Request) -> httpx.Response:
        auth = request.headers["Authorization"]
        return httpx.Response(403, json={"detail": f"refused {auth} eyJhbGciOiJSUzI1NiJ9.e30.sig"})

    runtime = SwarmCloudRuntime(
        "https://swarm.test", StaticBearer("sc-bearer"), transport=httpx.MockTransport(echo)
    )
    with pytest.raises(RuntimeUnavailable) as err:
        await runtime.whoami()
    assert "sc-bearer" not in str(err.value) and "eyJ" not in str(err.value)
    assert "<withheld>" in str(err.value)

    for body in ([1, 2], "text", {"tenant": {"tenant_id": 42}}):
        runtime = SwarmCloudRuntime(
            "https://swarm.test",
            StaticBearer("sc-bearer"),
            transport=httpx.MockTransport(lambda r, b=body: httpx.Response(200, json=b)),
        )
        if isinstance(body, dict):
            assert await runtime.whoami() == {"tenant_id": "42"}
        else:
            with pytest.raises(RuntimeUnavailable, match="unexpected body"):
                await runtime.whoami()


@pytest.mark.parametrize(
    "echo",
    [
        "Bearer sc-secret",
        "Bearer:sc-secret",
        "bearer=sc-secret",
        "Authorization: Bearer:  sc-secret",
    ],
)
def test_error_detail_withholds_bearer_values_however_written(echo):
    from oracle.swarm.swarmcloud import _detail

    detail = _detail(httpx.Response(403, json={"detail": f"refused {echo} for u-or"}))
    assert "sc-secret" not in detail
    assert "<withheld>" in detail


def test_error_detail_is_bounded_before_redaction():
    from oracle.swarm.swarmcloud import _DETAIL_SCAN_CHARS, _detail

    huge = "Bearer sc-secret " + "x" * 2_000_000
    detail = _detail(httpx.Response(500, json={"detail": huge}))
    assert len(detail) <= 200 and "sc-secret" not in detail
    assert _DETAIL_SCAN_CHARS < len(huge)
