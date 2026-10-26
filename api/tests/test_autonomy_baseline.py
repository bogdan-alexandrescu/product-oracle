"""H11 Autonomy wired into the two behaviours that exist today: a run's baseline.yaml merge
(``baseline``) and the review-feedback jobs (``feedback_triage``), plus propose_change
from a run token at observe.

Each test's docstring is its card: protects=...; fails_when=...; no_claim=..."""

import uuid

import pytest

from oracle.baseline import service as baseline_service
from oracle.llm import gateway
from oracle.seed import seed
from oracle.swarm import FakeRuntime, Outcome, set_runtime
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, window
from tests.connection_helpers import make_person
from tests.fixtures import seed_auth
from tests.test_llm_jobs import DRAFT_V1, SLUG, FakeClaude, comment, import_draft, jobs
from tests.test_mcp import mcp_client, run_token, text_of
from tests.test_runs import RUN_BASELINE, get, pending, started, tick

SUPERSEDED = "Superseded: the same run later applied this change directly"

OBSERVE_NOTE = "Baseline merge skipped: Oracle is set to observe the baseline"


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
async def owner():
    return await seed_auth()


async def set_level(client, headers, key: str, level: str) -> None:
    r = await client.put(
        f"/v1/autonomy/{key}", json={"level": level, "reason": "test"}, headers=headers
    )
    assert r.status_code == 200, r.text


async def unlocked_checkout(tenant_id) -> None:
    """An agent's earlier write: unlocked, so today a run may change it directly."""
    async with tenant_session(tenant_id) as s:
        writer = baseline_service.Writer(None, "agent", reason="earlier run")
        await baseline_service.create_entity(
            s, writer, type_="feature", key="checkout", title="Checkout"
        )
        await s.commit()


async def run_baseline(client, auth, runtime) -> dict:
    runtime.script["baseline"] = [
        Outcome(artifacts={"baseline.yaml": RUN_BASELINE, "summary.md": "# Summary\n"})
    ]
    run = await started(client, auth)
    await tick(client, auth)
    return await get(client, auth, run["id"])


async def test_at_act_an_unlocked_entity_changes_directly(client, owner, runtime):
    """protects=acceptance 4, act (the default): today's behaviour, the unlocked entity
    changes and no proposal is made; fails_when=the default turns agent writes into
    proposals or adds a note; no_claim=locked entities (test_runs covers them)."""
    tenant_id, auth = owner
    await unlocked_checkout(tenant_id)
    run = await run_baseline(client, auth, runtime)
    merged = pending(run)["payload"]["baseline_import"]
    assert merged["updated"] == 1 and merged["proposals"] == 0 and merged["created"] == 3
    assert "autonomy" not in merged
    assert run["segments"][0]["autonomy_note"] is None
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    titles = {e["key"]: e["title"] for e in graph["entities"]}
    assert titles["checkout"] == "Checkout, as the agent sees it"


async def test_at_recommend_every_agent_write_becomes_a_proposal(client, owner, runtime):
    """protects=acceptance 4, recommend: a run's change to an unlocked entity becomes a
    proposal and the entity stays as it was; new entities are proposed too, and the
    segment says why; fails_when=the entity changes, an entity or edge is created, or the
    run page says nothing; no_claim=accepting those proposals (B1's own tests)."""
    tenant_id, auth = owner
    await unlocked_checkout(tenant_id)
    await set_level(client, auth, "baseline", "recommend")
    run = await run_baseline(client, auth, runtime)
    assert run["status"] == "awaiting_checkpoint"
    merged = pending(run)["payload"]["baseline_import"]
    assert merged["created"] == 0 and merged["updated"] == 0
    assert merged["proposals"] == 3  # checkout's change, the goal and guided-setup
    assert merged["autonomy"]["level"] == "recommend"
    assert run["segments"][0]["autonomy_note"] == (
        "Baseline changes became proposals: Oracle is set to recommend for the baseline"
    )
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    assert [(e["key"], e["title"]) for e in graph["entities"]] == [("checkout", "Checkout")]
    assert graph["edges"] == []
    proposals = (await client.get("/v1/baseline/proposals", headers=auth)).json()
    assert sorted((p["payload"]["op"], p["payload"]["fields"]["title"]) for p in proposals) == [
        ("create", "Guided setup"),
        ("create", "Raise activation"),
        ("update", "Checkout, as the agent sees it"),
    ]
    assert all(p["run_id"] == run["id"] for p in proposals)


async def test_at_observe_the_merge_is_skipped_and_the_segment_says_why(client, owner, runtime):
    """protects=acceptance 4, observe: the merge is skipped, the run goes on, the segment
    keeps its summary.md and records why; fails_when=anything is written to the
    baseline, the run fails, or the reason is missing; no_claim=the run page's link."""
    tenant_id, auth = owner
    await unlocked_checkout(tenant_id)
    await set_level(client, auth, "baseline", "observe")
    run = await run_baseline(client, auth, runtime)
    assert run["status"] == "awaiting_checkpoint"
    merged = pending(run)["payload"]["baseline_import"]
    assert merged["skipped"] is True and merged["autonomy"]["level"] == "observe"
    assert run["segments"][0]["autonomy_note"] == OBSERVE_NOTE
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    assert [(e["key"], e["title"]) for e in graph["entities"]] == [("checkout", "Checkout")]
    assert (await client.get("/v1/baseline/proposals", headers=auth)).json() == []
    art = await client.get(f"/v1/runs/{run['id']}/segments/1/artifacts/summary.md", headers=auth)
    assert art.status_code == 200 and art.text == "# Summary\n"


async def test_at_observe_propose_change_is_refused_for_run_tokens_only(client):
    """protects=acceptance 5: a run token's propose_change gets 403 'Oracle is set to
    observe the baseline' at observe, and a person's proposal still works;
    fails_when=the run's proposal is created, or a person's is refused;
    no_claim=other run writes (push_draft is not baseline)."""
    from oracle.swarm import FakeRuntime as _Fake

    set_runtime(_Fake())
    try:
        r = await seed(token_name="test")
        tenant_id = r.tenant_id
        person = await make_person(tenant_id, "pm@example.com", "owner")
        await set_level(client, person.headers, "baseline", "observe")
        change = {
            "op": "create",
            "kind": "entity",
            "fields": {"type": "goal", "key": "activation", "title": "Activation"},
            "reason": "seen in interviews",
        }
        token = await run_token(tenant_id, ["write:proposals"], person.user.id)
        async with mcp_client(token) as c:
            refused = await c.call_tool("propose_change", {"body": change})
        assert refused.is_error and "Oracle is set to observe the baseline" in text_of(refused)
        assert (await client.get("/v1/baseline/proposals", headers=person.headers)).json() == []
        resp = await client.post("/v1/baseline/proposals", json=change, headers=person.headers)
        assert resp.status_code == 201, resp.text
        await set_level(client, person.headers, "baseline", "recommend")
        async with mcp_client(token) as c:
            ok = await c.call_tool("propose_change", {"body": change})
        assert not ok.is_error, text_of(ok)
    finally:
        set_runtime(None)


# --- feedback triage -------------------------------------------------------------------------


@pytest.fixture
def fake():
    claude = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
    yield claude
    gateway.set_transports(previous)


@pytest.fixture
async def ctx():
    r = await seed(token_name="test")
    return {"tenant_id": r.tenant_id, "headers": {"Authorization": f"Bearer {r.token}"}}


@pytest.fixture
async def pool(ctx):
    return await add_account(ctx["tenant_id"], "personal", windows={"five_hour": window(0.2)})


async def test_at_observe_no_feedback_job_is_queued_on_any_document(client, ctx, pool, fake):
    """protects=acceptance 6: at observe a new comment queues no review-comments job and
    a new version no reporting job, and a person cannot queue one either;
    fails_when=any review-comments or reporting job is queued; no_claim=refinement jobs
    (a person's request, not triage)."""
    await import_draft(client, ctx)
    await set_level(client, ctx["headers"], "feedback_triage", "observe")
    await comment(client, ctx, "problem", "Why half?")
    await import_draft(client, ctx, DRAFT_V1.replace("Owner: product.", "Owner: growth."))
    assert await jobs(client, ctx) == []
    resp = await client.post(
        f"/v1/documents/{SLUG}/llm-jobs", json={"kind": "review_comments"}, headers=ctx["headers"]
    )
    assert resp.status_code == 409
    assert "Oracle is set to observe review feedback" in resp.json()["detail"]


async def test_back_at_recommend_only_documents_switched_on_queue_again(client, ctx, pool, fake):
    """protects=acceptance 6: back at recommend, jobs queue again only where the
    document's own switch is on (the company level turns jobs off, never on);
    fails_when=a document switched off queues a job, or one switched on does not;
    no_claim=the job's own run (test_llm_jobs)."""
    await import_draft(client, ctx)
    settings = f"/v1/documents/{SLUG}/llm-jobs/settings"
    await set_level(client, ctx["headers"], "feedback_triage", "observe")
    resp = await client.put(settings, json={"review_comments": False}, headers=ctx["headers"])
    assert resp.status_code == 200
    await set_level(client, ctx["headers"], "feedback_triage", "recommend")
    await comment(client, ctx, "problem", "Why half?")
    assert await jobs(client, ctx) == []
    resp = await client.put(settings, json={"review_comments": True}, headers=ctx["headers"])
    assert resp.status_code == 200
    await comment(client, ctx, "solution", "Make it skippable.")
    assert [j["kind"] for j in await jobs(client, ctx)] == ["review_comments"]


async def test_a_later_merge_at_act_closes_the_same_run_s_proposals(client, owner, runtime):
    """protects=hardening 2026-10-20 (a run's baseline.yaml): the run proposed below Act,
    then its file is merged again at Act (a retried import): what it now writes directly
    closes the run's matching open proposals as superseded; fails_when=a proposal the
    applied change superseded stays open for a person to decide; no_claim=another run's
    proposals, or a proposal on a locked item (it stays open)."""
    from oracle.runs import service as runs_service
    from oracle.runs.models import Run

    tenant_id, auth = owner
    await unlocked_checkout(tenant_id)
    await set_level(client, auth, "baseline", "recommend")
    run = await run_baseline(client, auth, runtime)
    open_before = (await client.get("/v1/baseline/proposals", headers=auth)).json()
    assert len(open_before) == 3 and all(p["status"] == "open" for p in open_before)

    await set_level(client, auth, "baseline", "act")
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        merged = await runs_service._import_baseline(s, row, RUN_BASELINE)
    assert merged["proposals"] == 0 and merged["updated"] == 1 and merged["created"] == 3
    graph = (await client.get("/v1/baseline/graph", headers=auth)).json()
    titles = {e["key"]: e["title"] for e in graph["entities"]}
    assert titles["checkout"] == "Checkout, as the agent sees it"
    proposals = (await client.get("/v1/baseline/proposals", headers=auth)).json()
    assert sorted((p["payload"]["op"], p["status"]) for p in proposals) == [
        ("create", "rejected"),
        ("create", "rejected"),
        ("update", "rejected"),
    ]
    assert all(p["payload"]["note"] == SUPERSEDED for p in proposals)
