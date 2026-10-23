"""H1 Decision log: decisions Oracle records on its own (judgement calls and checkpoint
records), the class filters, and run tokens.

Each test states its card (protects / fails_when / no_claim). Synthetic placeholders only.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text

from oracle.auth.models import User
from oracle.baseline.models import Entity
from oracle.decisions import capture
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.jobs.models import LlmSuggestion
from oracle.runs.models import Checkpoint
from oracle.seed import seed
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import add_option, approve_compliance, create_blocker
from tests.decision_helpers import clock, decide_body, propose, rows, today  # noqa: F401
from tests.intake_helpers import gaps_by_category, intake_with_source, summary
from tests.test_mcp import mcp_client, run_token, text_of, user_with_role
from tests.test_review import add_version
from tests.test_runs import as_user, get, pending, started, tick

LATER = (datetime.now(UTC) + timedelta(days=30)).isoformat()


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


async def _source(tenant_id, kind: str) -> list[Decision]:
    return [d for d in await rows(tenant_id) if d.source_kind == kind]


# --- judgement calls ---------------------------------------------------------------------


async def test_first_version_approval_is_captured_once(client):
    """protects=approving a version the first time creates one decided record (origin
    version_approval, source_id = the version id, approver = who approved); approving it
    again creates none; fails_when=no record, or a second one on re-approval; no_claim=the
    version is inserted directly, not imported."""
    r = await seed(token_name="test")
    headers = {"Authorization": f"Bearer {r.token}"}
    async with tenant_session(r.tenant_id) as s:
        doc = Document(slug="checkout-redesign", title="Checkout redesign PRD")
        s.add(doc)
        await s.commit()
    version_id = await add_version(r.tenant_id, doc.id, 1)
    path = "/v1/documents/checkout-redesign/versions/1/approve"
    assert (await client.post(path, headers=headers)).status_code == 200
    assert (await client.post(path, headers=headers)).status_code == 200
    [d] = await rows(r.tenant_id)
    assert (d.origin, d.class_, d.status) == ("version_approval", "judgement", "decided")
    assert d.source_kind == "document_version" and d.source_id == version_id
    assert d.title == "Publish Checkout redesign PRD v1"
    assert [o["key"] for o in d.options] == ["publish", "keep_in_review"]
    assert d.chosen_option == "publish"
    async with tenant_session(r.tenant_id) as s:
        admin = await s.scalar(select(User.id).where(User.email == "admin@example.com"))
    assert d.approver_id == admin
    assert d.expected_outcome == "See the document's success metrics"
    assert d.review_at == today() + timedelta(days=90)
    assert {"kind": "document_version", "id": str(version_id)}.items() <= d.subjects[0].items()


async def test_accepted_gap_risk_is_captured_with_its_review_date(client):
    """protects=accepting a gap's risk creates one record (origin assumption) carrying the
    gap decision's review_at; a validate decision creates none; fails_when=the review date
    is lost or a validate is logged; no_claim=none beyond protects."""
    ctx = await make_ctx()
    out = await intake_with_source(client, ctx)
    gaps = gaps_by_category(await summary(client, ctx, out["intake"]["id"]))
    gap = gaps["release_rollout"]
    review_at = (datetime.now(UTC) + timedelta(days=20)).replace(microsecond=0)
    resp = await client.post(
        f"/v1/gaps/{gap['id']}/decisions",
        json={
            "decision": "accept_risk",
            "rationale": "Roll out to one region first.",
            "review_at": review_at.isoformat(),
        },
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    [d] = await rows(ctx.tenant_id)
    assert (d.origin, d.status, d.class_) == ("assumption", "decided", "judgement")
    assert d.source_kind == "assumption_decision"
    assert str(d.source_id) == resp.json()["decision"]["id"]
    assert d.rationale == "Roll out to one region first."
    assert d.review_at == review_at.date()
    assert d.approver_id == ctx.users["owner"].id
    other = gaps["evaluation_criteria"]
    resp = await client.post(
        f"/v1/gaps/{other['id']}/decisions",
        json={"decision": "validate", "rationale": "Measured last quarter."},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    assert len(await rows(ctx.tenant_id)) == 1


async def test_pushback_override_is_captured_with_its_reason(client):
    """protects=accepting a pushback-flagged suggestion with a reason creates one record
    (origin pushback_override) whose rationale is that reason; fails_when=no record or the
    reason is lost; no_claim=the suggestion row is inserted directly, as review_comments
    would leave it."""
    r = await seed(token_name="test")
    headers = {"Authorization": f"Bearer {r.token}"}
    async with tenant_session(r.tenant_id) as s:
        doc = Document(slug="checkout-redesign", title="Checkout redesign PRD")
        s.add(doc)
        await s.commit()
    await add_version(r.tenant_id, doc.id, 1)
    resp = await client.post(
        "/v1/documents/checkout-redesign/versions/1/comments",
        json={
            "section_key": "goal-trace",
            "anchor": {"exact": "shipping step", "prefix": "abandon at the ", "suffix": "."},
            "body": "Drop the shipping step.",
        },
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    async with tenant_session(r.tenant_id) as s:
        row = LlmSuggestion(
            document_id=doc.id,
            feedback_item_id=uuid.UUID(resp.json()["feedback_item_id"]),
            version_number=1,
            classification="change_request",
            kind="none",
            status="open",
            pushback={
                "reason": "Evidence says the shipping step is where buyers drop.",
                "sources": [
                    {
                        "ref": "ev:1",
                        "kind": "evidence",
                        "title": "Checkout funnel study",
                        "url": "https://example.com/study",
                    }
                ],
            },
        )
        s.add(row)
        await s.commit()
        sid = row.id
    resp = await client.post(
        f"/v1/suggestions/{sid}/accept",
        json={"reason": "Support load is too high."},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    [d] = await rows(r.tenant_id)
    assert (d.origin, d.source_kind, d.source_id) == ("pushback_override", "llm_suggestion", sid)
    assert d.rationale == "Support load is too high."
    assert d.chosen_option == "keep_reviewers_call"
    assert [o["key"] for o in d.options] == ["keep_reviewers_call", "take_oracles_advice"]
    assert "shipping step is where buyers drop" in (d.context or "")


async def test_blocker_decisions_are_captured(client):
    """protects=a blocker's selected option, accepted risk and approved feasibility scope
    each create one record (origin blocker) whose options are the blocker's; fails_when=a
    resolution event is not logged or logged twice; no_claim=none beyond protects."""
    ctx = await make_ctx()
    b = (await create_blocker(client, ctx, severity="medium", type="soft"))["blocker"]
    opt = (await add_option(client, ctx, b["id"])).json()
    opt = await approve_compliance(client, ctx, opt)
    resp = await client.post(
        f"/v1/blocker-options/{opt['id']}/select",
        json={"lock_version": opt["lock_version"], "reason": "Within the quota"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    [selected] = await rows(ctx.tenant_id)
    assert (selected.origin, selected.source_kind) == ("blocker", "blocker_event")
    assert selected.chosen_option == opt["id"]
    assert opt["id"] in [o["key"] for o in selected.options]
    assert selected.rationale == "Within the quota"

    resp = await client.post(
        f"/v1/blockers/{b['id']}/accept-risk",
        json={"reason": "A single region first", "review_at": LATER},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    decisions = await rows(ctx.tenant_id)
    assert len(decisions) == 2
    risk = decisions[1]
    assert risk.chosen_option == "accept_risk" and risk.review_at.isoformat() == LATER[:10]
    assert risk.approver_id == ctx.users["owner"].id

    exp = await client.post(
        f"/v1/blockers/{b['id']}/experiments",
        json={
            "hypothesis": "Caching keeps us under the limit",
            "owner_id": str(ctx.users["approver"].id),
            "success_threshold": "Under 60 calls a minute",
            "decision_gate_at": LATER,
        },
        headers=ctx.as_("approver"),
    )
    assert exp.status_code == 201, exp.text
    resp = await client.post(
        f"/v1/blockers/{b['id']}/feasibility-scope",
        json={"experiment_id": exp.json()["id"], "reason": "Try it for a month"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 200, resp.text
    decisions = await rows(ctx.tenant_id)
    assert len(decisions) == 3 and decisions[2].chosen_option == "feasibility_scope"
    assert len({d.source_id for d in decisions}) == 3


async def test_capture_is_idempotent_per_source(tenant_id):
    """protects=one row per (source_kind, source_id), however often a hook fires;
    fails_when=a retried hook adds a second record or a second number; no_claim=the hook
    is called directly with a synthetic source."""
    from oracle.auth.models import User

    source = uuid.uuid4()
    async with tenant_session(tenant_id) as s:
        user = User(email="owner@example.com", password_hash="x", role="owner")
        s.add(user)
        await s.flush()
        for _ in range(2):
            await capture.capture(
                s,
                None,
                origin="priority_override",
                source_kind="priority_snapshot",
                source_id=source,
                title="Move usage caps above detection",
                options=[{"key": "move", "label": "Move it"}],
                chosen_option="move",
                rationale="Finance needs caps this quarter",
                approver_id=user.id,
            )
        await s.commit()
    [d] = await rows(tenant_id)
    assert d.number == 1 and d.origin == "priority_override" and d.status == "decided"


# --- checkpoint records ---------------------------------------------------------------------


async def _decide(client, headers, run_id, cp_id, decision="approved", note=None):
    return await client.post(
        f"/v1/runs/{run_id}/checkpoints/{cp_id}/decide",
        json={"decision": decision, "note": note},
        headers=headers,
    )


@pytest.fixture
async def run_ctx(tenant_id, runtime):
    headers = await as_user(tenant_id, "owner", "founder@example.com")
    return tenant_id, headers


async def test_checkpoint_approvals_and_send_backs_are_recorded(client, run_ctx):
    """protects=each decided stop is one decided checkpoint record (origin checkpoint,
    class checkpoint, source_id = the checkpoint, run_id set, review_at null); a retry
    adds none; a send-back keeps its note and the next attempt's approval is a second
    record; fails_when=a stop is missing, doubled, or gets a review date; no_claim=the
    fake runtime stands in for SwarmCloud."""
    tenant_id, h = run_ctx
    run = await started(client, h)
    await tick(client, h)
    run = await get(client, h, run["id"])
    cp = pending(run)
    assert (await _decide(client, h, run["id"], cp["id"], note="Goals read right")).is_success
    retry = await _decide(client, h, run["id"], cp["id"])
    assert not retry.is_success
    [first] = await rows(tenant_id)
    assert (first.origin, first.class_, first.status) == ("checkpoint", "checkpoint", "decided")
    assert first.source_kind == "checkpoint" and str(first.source_id) == cp["id"]
    assert first.chosen_option == "approve" and first.rationale == "Goals read right"
    assert str(first.run_id) == run["id"] and first.review_at is None
    assert first.decided_via == "oracle" and first.decided_actor == "user"
    assert first.title.startswith("Approve Baseline confirm · ")
    assert [o["key"] for o in first.options] == ["approve", "request_changes"]

    await tick(client, h)
    run = await get(client, h, run["id"])
    cp = pending(run)
    assert cp["kind"] == "feature_set"
    resp = await _decide(client, h, run["id"], cp["id"], "changes_requested", "Size export again")
    assert resp.is_success, resp.text
    sent_back = (await rows(tenant_id))[-1]
    assert sent_back.chosen_option == "request_changes"
    assert sent_back.rationale == "Size export again"
    assert sent_back.title.startswith("Send back Feature set · ")

    await tick(client, h)
    run = await get(client, h, run["id"])
    again = pending(run)
    assert again["kind"] == "feature_set" and again["id"] != cp["id"]
    assert (await _decide(client, h, run["id"], again["id"])).is_success
    records = await _source(tenant_id, "checkpoint")
    assert len(records) == 3
    assert records[-1].chosen_option == "approve"
    assert records[-1].rationale == "Approved with no note"
    assert str(records[-1].source_id) == again["id"]


async def test_skipped_and_held_stops_are_not_recorded_until_confirmed(client, run_ctx):
    """protects=a stop switched off records nothing; a console answer that waits for an
    approver's confirmation records nothing until it is confirmed, then one record with
    decided_via swarmcloud_console; fails_when=a skipped or held stop is logged;
    no_claim=the console answer is written onto the checkpoint directly, as the tick
    would after reading SwarmCloud."""
    tenant_id, h = run_ctx
    run = await started(client, h, checkpoints={"baseline_confirm": False})
    await tick(client, h)  # baseline done, its stop skipped, feature set submitted
    await tick(client, h)
    run = await get(client, h, run["id"])
    cp = pending(run)
    assert cp["kind"] == "feature_set"
    assert await rows(tenant_id) == []
    async with tenant_session(tenant_id) as s:
        row = await s.get(Checkpoint, uuid.UUID(cp["id"]))
        wait = dict((row.payload or {}).get("wait") or {})
        wait["console"] = {
            "answered_by": "outside@example.com",
            "verdict": "MERGE",
            "counted": False,
            "reason": "not an Oracle member",
            "needs": "confirm",
            "findings": [],
        }
        row.payload = {**(row.payload or {}), "wait": wait}
        await s.commit()
    assert await rows(tenant_id) == []
    resp = await _decide(client, h, run["id"], cp["id"], "confirm")
    assert resp.is_success, resp.text
    [d] = await rows(tenant_id)
    assert d.decided_via == "swarmcloud_console" and d.chosen_option == "approve"
    assert str(d.source_id) == cp["id"]


class _DecisionLockProbe:
    """A runtime that checks, before each call it forwards to SwarmCloud, that the
    company's D-number lock (oracle.decisions.service.next_number) is free: tried from
    another connection, as tests/test_runs_round7.py's Probe tries the gate."""

    def __init__(self, inner, tenant_id) -> None:
        self.inner, self.tenant_id, self.held, self.calls = inner, tenant_id, [], []

    def __getattr__(self, name):
        import inspect

        attr = getattr(self.inner, name)
        if not inspect.iscoroutinefunction(attr):
            return attr

        async def call(*args, **kwargs):
            self.calls.append(name)
            async with tenant_session(self.tenant_id) as s:
                free = await s.scalar(
                    text("SELECT pg_try_advisory_xact_lock(hashtext('decisions:' || :t))"),
                    {"t": str(self.tenant_id)},
                )
                if not free:
                    self.held.append(name)
                await s.rollback()
            return await attr(*args, **kwargs)

        return call


async def test_a_console_answer_cancels_with_the_decision_lock_free(client):
    """protects=a counted console approval taken by the tick records the checkpoint's
    decision, and the cancel of the workflow's rest (and every other SwarmCloud call)
    is made while the company's D-number lock is free, so a slow SwarmCloud never holds
    up creating or deciding decisions in that company; fails_when=the lock is held across
    a call; no_claim=the SwarmCloud fake stands in for SwarmCloud, a second connection's
    try-lock stands in for a concurrent create."""
    from tests.fixtures import seed_auth
    from tests.test_adapter_v2 import _waiting, on

    tenant_id, auth = await seed_auth()
    swarm = on()
    await as_user(tenant_id, "approver", "lead@example.com")  # an Oracle approver (W5)
    run = await _waiting(client, auth, tenant_id, swarm)
    cp = pending(run)
    probe = _DecisionLockProbe(swarm.runtime(), tenant_id)
    set_runtime(probe)
    try:
        swarm.console_answer("wf_1", "next_draft-review1", "MERGE", by="lead@example.com")
        await tick(client, auth)
    finally:
        set_runtime(None)
    assert swarm.workflows["wf_1"].state == "CANCELLED" and "cancel" in probe.calls
    assert probe.held == []
    [record] = await _source(tenant_id, "checkpoint")
    assert str(record.source_id) == cp["id"]
    assert record.decided_via == "swarmcloud_console" and record.chosen_option == "approve"


async def test_checkpoint_records_raise_nothing_and_are_read_only(client, run_ctx):
    """protects=checkpoint records add no Inbox row, are never review_due, create no
    baseline entity, and PATCH/decide/reviews/withdraw on one return 409; the class and
    run filters split them from judgement calls; fails_when=a checkpoint record reaches
    the Inbox or the graph, or a filter mixes classes; no_claim=none beyond protects."""
    tenant_id, h = run_ctx
    before = (await client.get("/v1/inbox", headers=h)).json()
    run = await started(client, h)
    await tick(client, h)
    run = await get(client, h, run["id"])
    assert (await _decide(client, h, run["id"], pending(run)["id"], note="ok")).is_success
    judgement = await client.post(
        "/v1/decisions",
        json={
            "title": "Ship caps first",
            "options": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}],
            "approver_id": (await client.get("/v1/me", headers=h)).json()["user_id"],
        },
        headers=h,
    )
    assert judgement.status_code == 201, judgement.text
    [record] = await _source(tenant_id, "checkpoint")

    after = (await client.get("/v1/inbox", headers=h)).json()
    # Only the judgement call's needs_decision row is new; the stop adds none.
    assert [(x["id"], x["reason"]) for x in after["decisions"]] == [
        (judgement.json()["id"], "needs_decision")
    ]
    assert after["needs_me"] == before["needs_me"] + 1
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(Entity).where(Entity.type == "decision")) is None

    base = f"/v1/decisions/{record.id}"
    msg = "A checkpoint record is not edited; it records the run's decision"
    for method, path, body in [
        ("PATCH", "", {"lock_version": record.lock_version, "title": "x"}),
        ("POST", "/decide", decide_body(option_key="approve")),
        ("POST", "/reviews", {"verdict": "reversed", "note": "x"}),
        ("POST", "/withdraw", {"reason": "x"}),
    ]:
        resp = await client.request(method, base + path, json=body, headers=h)
        assert resp.status_code == 409, (path, resp.text)
        assert resp.json()["detail"] == msg

    async def ids(query: str) -> set[str]:
        resp = await client.get(f"/v1/decisions{query}", headers=h)
        assert resp.status_code == 200, resp.text
        return {x["id"] for x in resp.json()}

    jid = judgement.json()["id"]
    assert await ids("?class=judgement") == {jid}
    assert await ids("?class=checkpoint") == {str(record.id)}
    assert await ids("") == {jid, str(record.id)}
    assert await ids("?class=all") == {jid, str(record.id)}
    assert await ids(f"?run_id={run['id']}") == {str(record.id)}
    assert await ids("?origin=checkpoint") == {str(record.id)}
    assert await ids("?due=true") == set()
    got = (await client.get(base, headers=h)).json()
    assert got["class"] == "checkpoint" and got["review_at"] is None
    assert got["source"]["kind"] == "checkpoint" and got["source"]["id"] == str(record.source_id)
    assert got["source"]["checkpoint_kind"] == "baseline_confirm"
    assert {"kind": "run", "id": run["id"]}.items() <= got["subjects"][0].items()


# --- run tokens ---------------------------------------------------------------------------


async def test_run_tokens_read_and_propose_but_never_decide(client, tenant_id, runtime):
    """protects=a run token with read:baseline lists decisions; with write:proposals it
    proposes one whose driver is oracle; its decide call is refused; fails_when=a run
    reads without the scope, proposes as a person, or decides; no_claim=the MCP client
    drives the in-process app."""
    approver = await user_with_role(tenant_id, "approver", "approver@example.com")
    founder = await user_with_role(tenant_id, "owner", "founder@example.com")
    body = {
        "title": "Ship usage caps before detection",
        "options": [{"key": "a", "label": "Caps first"}, {"key": "b", "label": "Together"}],
        "approver_id": str(approver.id),
    }
    token = await run_token(tenant_id, ["read:baseline", "write:proposals"], founder.id)
    async with mcp_client(token) as c:
        names = {t.name for t in (await c.list_tools()).tools}
        assert {"list_decisions", "create_decision", "get_decision"} <= names
        assert "decide_decision" not in names
        created = await c.call_tool("create_decision", {"body": body})
        assert not created.is_error, text_of(created)
        assert created.structured_content["driver"] == "oracle"
        assert created.structured_content["origin"] == "oracle"
        listed = await c.call_tool("list_decisions", {"class": "judgement"})
        assert not listed.is_error, text_of(listed)
        refused = await c.call_tool(
            "decide_decision",
            {"decision": "1", "body": decide_body(option_key="a")},
        )
        assert refused.is_error
    only_read = await run_token(tenant_id, ["read:documents"], founder.id)
    async with mcp_client(only_read) as c:
        r = await c.call_tool("list_decisions", {})
        assert r.is_error
    [d] = await rows(tenant_id)
    assert d.status == "proposed"


async def test_a_proposal_from_a_person_is_manual(client):
    """protects=a person's proposal keeps origin manual and driver user:<id>; fails_when=a
    person's proposal is marked as Oracle's; no_claim=none beyond protects."""
    ctx = await make_ctx()
    d = await propose(client, ctx, who="approver")
    assert d["driver"] == f"user:{ctx.users['approver'].id}" and d["origin"] == "manual"


def test_scopes_and_segment_tools():
    """protects=run tokens read decisions with read:baseline and only create them with
    write:proposals; the drafting segments are told to read decided judgement calls;
    fails_when=decide, review or reassign map to a scope, or a drafting segment lacks the
    tool; no_claim=none beyond protects."""
    from oracle.mcp.scopes import required_scope
    from oracle.runs import flows

    assert required_scope("GET", "/v1/decisions") == "read:baseline"
    assert required_scope("GET", "/v1/decisions/{decision}") == "read:baseline"
    assert required_scope("POST", "/v1/decisions") == "write:proposals"
    for leaf in ("decide", "reviews", "reassign", "withdraw", "options-job"):
        assert required_scope("POST", f"/v1/decisions/{{decision}}/{leaf}") is None
    assert required_scope("PATCH", "/v1/decisions/{decision}") is None
    assert "list_decisions" in flows.MCP_TOOLS
    for flow in flows.FLOWS.values():
        for segment in flow.segments:
            if segment.name in ("prd_draft", "next_draft", "roadmap_items", "roadmap_draft"):
                assert "list_decisions" in segment.tools, segment.name
                assert "class=judgement" in segment.task, segment.name
