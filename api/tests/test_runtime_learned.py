"""What Oracle learned about SwarmCloud's features survives a restart (UI test finding
E3, 2026-10-20).

A submission or an answer teaches Oracle that a feature is on or off (caller MCP accepted
a registration or a run token, await-input refused, service answers refused). That used
to live in one process's memory: after every deploy, and on every other Cloud Run
instance, the runtime status and the New run form said caller MCP was "switched off or
not confirmed" until the next run was submitted, though it was on. It now lives in the
database, the instances' shared truth, with the same lifetimes as before: a learned state
lasts the features cache's TTL, a sticky one until SwarmCloud reports the feature on, and
caller MCP stays confirmed until something shows it off.
"""

import logging
import time
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from oracle.runs import workflow
from oracle.swarm import (
    McpAccess,
    RuntimeUnavailable,
    StepSpec,
    SwarmCloudRuntime,
    WorkflowSpec,
    set_runtime,
    swarmcloud,
)
from oracle.swarm.learned import DatabaseLearnedStore, LearnedFeature
from oracle.swarm.settings import RuntimeSettings, get_runtime_settings
from oracle.swarm.swarmcloud import NO_MCP_NOTE
from oracle.tenancy import unscoped_session
from tests.fixtures import seed_auth
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_runs import create

PUBLIC = "https://oracle.swarm.saga.xyz"
MCP_URL = PUBLIC + "/mcp"


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setenv("ORACLE_PUBLIC_URL", PUBLIC)
    get_runtime_settings.cache_clear()
    yield
    get_runtime_settings.cache_clear()
    set_runtime(None)


def on(**kw) -> FakeSwarmCloud:
    return FakeSwarmCloud(mcp=True, await_input=True, service_answer=True, **kw)


def process(swarm: FakeSwarmCloud, **kw) -> SwarmCloudRuntime:
    """A new Oracle process (a deploy, or another Cloud Run instance): a new runtime
    object with nothing in memory, over the same database."""
    return swarm.runtime(learned_store=DatabaseLearnedStore(), **kw)


def attached_spec() -> WorkflowSpec:
    return WorkflowSpec(
        name="x",
        steps=(StepSpec("a", "writer", "claude-code", "Write a.md."),),
        mcp=McpAccess(MCP_URL, "ort_secret", ("read:sources",), expires_in=3600, attach=True),
        label="oracle-x-a-1",
    )


def later(seconds: float, monkeypatch) -> None:
    """Move Oracle's clocks (wall and monotonic) forward."""
    wall, mono = time.time() + seconds, time.monotonic() + seconds
    monkeypatch.setattr(
        swarmcloud, "time", SimpleNamespace(time=lambda: wall, monotonic=lambda: mono)
    )


async def rows() -> dict[str, LearnedFeature]:
    async with unscoped_session() as s:
        return {r.feature: r for r in await s.scalars(select(LearnedFeature))}


# --------------------------------------------------------------------------- survival


async def test_a_learned_on_survives_a_new_runtime_object():
    swarm = on()
    first = process(swarm)
    feats = await first.features()
    # Never confirmed: reads alone prove nothing, so it truly is not confirmed.
    assert feats.mcp == "unknown" and "not confirmed" in feats.reasons["mcp"]
    assert first.notes() == [NO_MCP_NOTE]
    assert await first.ensure_mcp_server(MCP_URL) == "created"
    assert (await first.features()).mcp == "on"
    saved = (await rows())["mcp"]
    assert (saved.state, saved.reason) == ("on", "")
    assert saved.learned_at is not None and saved.expires_at is not None

    second = process(swarm)
    feats = await second.features()
    assert feats.mcp == "on" and "mcp" not in feats.reasons
    assert second.can_reach_oracle is True and second.notes() == []
    # Confirmed: the registration is current and is not written again.
    writes = [r for r in swarm.requests if r.method != "GET"]
    assert await second.ensure_mcp_server(MCP_URL) == "unchanged"
    assert [r for r in swarm.requests if r.method != "GET"] == writes


async def test_caller_mcp_stays_confirmed_past_the_cache_ttl(monkeypatch):
    """As in one process before: a confirmed caller MCP stays on until something shows it
    off; only the learned overlay itself lasts the TTL."""
    swarm = on()
    await process(swarm, features_ttl=60).ensure_mcp_server(MCP_URL)
    later(3600, monkeypatch)
    feats = await process(swarm, features_ttl=60).features()
    assert feats.mcp == "on"


async def test_what_one_instance_learns_the_others_read():
    swarm = on()
    a, b = process(swarm), process(swarm)
    await a.ensure_mcp_server(MCP_URL)
    assert (await b.features()).mcp == "on"
    assert (await a.features()).mcp == "on"

    # Caller MCP is switched off; instance b's submission is refused.
    swarm.mcp = False
    with pytest.raises(RuntimeUnavailable) as exc:
        await b.submit(attached_spec())
    assert exc.value.code == "mcp_unavailable"
    # Instance a's reading is still cached, but what b learned applies at once.
    feats = await a.features()
    assert feats.mcp == "off" and "mcp_unavailable" in feats.reasons["mcp"]
    assert a.can_reach_oracle is False and a.notes() == [NO_MCP_NOTE]
    # A restart keeps it off, not "on" from the earlier confirmation.
    c = process(swarm)
    assert (await c.features()).mcp == "off"


# --------------------------------------------------------------------------- lifetimes


async def test_a_learned_state_still_expires_after_the_ttl(monkeypatch):
    swarm = on(report_capacity=False)
    first = process(swarm, features_ttl=60)
    await first.ensure_mcp_server(MCP_URL)
    spec = WorkflowSpec(
        name="x",
        steps=(
            StepSpec("a", "writer", "claude-code", "Write these files as artifacts: a.md.\n"),
            StepSpec(
                "r",
                "reviewer",
                "await-input",
                "ok",
                ("a",),
                {"a": "a.md"},
                await_input=workflow.await_input(1, RuntimeSettings()),
            ),
        ),
        label="k",
    )
    await first.submit(spec)
    # SwarmCloud does not report await-input; the submission taught it is on.
    assert (await process(swarm, features_ttl=60).features()).await_input == "on"
    row = (await rows())["await_input"]
    assert (row.expires_at - row.learned_at).total_seconds() == pytest.approx(60, abs=1)

    later(61, monkeypatch)
    feats = await process(swarm, features_ttl=60).features()
    assert feats.await_input == "unknown"
    assert "learned at submit or answer" in feats.reasons["await_input"]
    assert feats.mcp == "on"


async def test_a_sticky_state_survives_until_swarmcloud_reports_the_feature_on(monkeypatch):
    swarm = on(report_capacity=False)
    first = process(swarm, features_ttl=60)
    first.learn("service_answer", "off", "SwarmCloud answered 403 person_required", sticky=True)
    await first.features()
    row = (await rows())["service_answer"]
    assert row.state == "off" and row.expires_at is None

    later(3600, monkeypatch)
    feats = await process(swarm, features_ttl=60).features()
    assert feats.service_answer == "off" and "person_required" in feats.reasons["service_answer"]

    # SwarmCloud reports service answers on: the sticky state is over, for every instance.
    swarm.report_capacity = True
    assert (await process(swarm, features_ttl=60).features()).service_answer == "on"
    assert "service_answer" not in await rows()
    swarm.report_capacity = False
    feats = await process(swarm, features_ttl=60).features()
    assert feats.service_answer == "unknown"


# --------------------------------------------------------------------------- the API


async def test_status_and_the_new_run_form_say_on_after_a_restart(client):
    _, auth = await seed_auth()
    swarm = on()
    set_runtime(process(swarm))
    body = (await client.get("/v1/runtime/status", headers=auth)).json()
    assert body["features"]["mcp"] == "unknown"
    assert "not confirmed" in body["feature_reasons"]["mcp"]
    assert (await client.post("/v1/runtime/mcp-server", headers=auth)).status_code == 200

    # A deploy: a new process, nothing in memory. The New run form's catalog, a draft
    # run and the status each read what was learned before it.
    set_runtime(process(swarm))
    flows = (await client.get("/v1/flows", headers=auth)).json()
    assert flows["runtime_notes"] == []

    set_runtime(process(swarm))
    run = await create(client, auth)
    assert NO_MCP_NOTE not in run["notes"]

    set_runtime(process(swarm))
    body = (await client.get("/v1/runtime/status", headers=auth)).json()
    assert body["features"]["mcp"] == "on", body
    assert "mcp" not in body["feature_reasons"]
    assert body["can_reach_oracle"] is True and body["notes"] == []


def test_the_configured_runtime_keeps_what_it_learns_in_the_database():
    runtime = SwarmCloudRuntime.from_settings(
        RuntimeSettings(swarmcloud_url="https://swarm.test", swarmcloud_token="x")
    )
    assert isinstance(runtime.learned_store, DatabaseLearnedStore)


async def test_a_database_failure_keeps_this_process_s_learning(caplog, monkeypatch):
    class Broken:
        async def sync(self, save, forget):
            raise OSError("database unreachable")

    # The test session's in-process `alembic upgrade` (logging.config.fileConfig) disables
    # the loggers that exist by then.
    monkeypatch.setattr(logging.getLogger("oracle.swarm.swarmcloud"), "disabled", False)
    swarm = on()
    runtime = swarm.runtime(learned_store=Broken())
    with caplog.at_level(logging.WARNING):
        assert await runtime.ensure_mcp_server(MCP_URL) == "created"
        assert (await runtime.features()).mcp == "on"
    assert "database unreachable" in caplog.text
    async with unscoped_session() as s:
        assert await s.scalar(select(func.count()).select_from(LearnedFeature)) == 0
