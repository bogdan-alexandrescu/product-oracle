"""C6 Feature set and PRD scope, end to end against Postgres with the FakeRuntime (and,
for the console gate, the fake SwarmCloud): the feature-set segment's end checks
feature_set.yaml and writes a proposed scope; approving it is refused on every path
while a blocking problem is open; an approved scope binds later segments, the document
and the curated MCP tool.

Test cards (protects / fails_when / no_claim):

- test_segment_end_writes_the_proposed_scope_and_the_check: protects=at the stop the
  scope is stored as proposed, one row per feature and requirement in file order, and the
  check is on the segment and the checkpoint; fails_when=a row is missing, out of order,
  or the check is absent; no_claim=how C7 Scope review edits it.
- test_approve_refused_with_blocking: protects=call c3 Blocking problems disable Approve
  on every approval path (REST, MCP decide_checkpoint); fails_when=any path approves while
  a blocking problem is open; no_claim=waivers (pick C7 Scope review).
- test_console_approval_with_blocking_is_recorded_not_followed: protects=D3 "Console
  gate": a counted console approval is held (needs confirm), nothing is posted, the token
  stays read-only, confirm is refused; fails_when=the checkpoint is approved or the token
  may write; no_claim=what SwarmCloud's workflow does with its own console answer.
- test_approving_a_clean_scope_supersedes_and_continues: protects=approval binds the
  scope and supersedes the document's earlier approved one; fails_when=the scope stays
  proposed, two approved scopes share a document, or the run does not go on;
  no_claim=the Engineering check (pick F4, not merged).
- test_stop_off_*: protects=rule 5; fails_when=a blocking file passes silently or a clean
  one is not approved by Oracle; no_claim=the file's quality.
- test_draft_reads_scope: protects=the draft is bound to the approved scope;
  fails_when=the prompt omits the tool or the pasted scope; no_claim=that the agent obeys
  it.
- test_get_prd_scope_*: protects=the curated tool reads the token's own run, falls back
  to the document's approved scope, and is refused to people; fails_when=another run's
  scope or a person gets through; no_claim=SwarmCloud's MCP transport.
"""

import uuid

from oracle.runs.scope_models import PrdScope, PrdScopeItem
from sqlalchemy import select

from oracle.baseline.models import Entity, Proposal
from oracle.models import AuditEvent
from oracle.runs import feature_set as fs
from oracle.runtokens import mint_run_token
from oracle.swarm import Outcome
from oracle.tenancy import tenant_session
from tests.test_mcp import api_token, mcp_client, text_of
from tests.test_runs import (  # noqa: F401 - fixtures
    as_user,
    decide,
    get,
    owner,
    pending,
    runtime,
    started,
    tick,
)

DOC = "saved-addresses"

CLEAN = """\
version: 1
document: saved-addresses
features:
  - key: saved-addresses
    title: Saved addresses
    summary: Returning buyers pick a saved address at checkout
    goals:
      - {key: activation, contribution: 2}
    depends_on: [address-lookup]
    blockers: [card-vault-limits]
    confidence: 0.7
    requirements:
      - key: saved-addresses-pick
        text: The buyer picks one of up to five saved addresses
        acceptance: ["Five addresses at most", "The last used one is preselected"]
      - key: saved-addresses-default
        text: The last used address is preselected
  - key: address-lookup
    title: Address lookup
    goals: [{key: activation, contribution: 1}]
    confidence: 0.9
    requirements:
      - {key: address-lookup-postcode, text: The buyer finds an address by postcode}
  - key: bulk-edit
    title: Bulk edit
    goals: []
    confidence: 0.8
    requirements: []
excluded:
  - key: address-sharing
    reason: Serves no confirmed goal
"""
BLOCKING = CLEAN.replace("depends_on: [address-lookup]", "depends_on: [address-sharing]")
REQS = ("saved-addresses-pick", "saved-addresses-default", "address-lookup-postcode")


async def seed_baseline(tenant_id) -> None:
    async with tenant_session(tenant_id) as s:
        s.add(
            Entity(
                type="goal", key="activation", title="Activation", status="confirmed", origin="user"
            )
        )
        s.add(
            Entity(
                type="goal", key="retention", title="Retention", status="proposed", origin="agent"
            )
        )
        for key, title in (
            ("saved-addresses", "Saved addresses"),
            ("address-lookup", "Address lookup"),
            ("address-sharing", "Address sharing"),
        ):
            s.add(Entity(type="feature", key=key, title=title, status="confirmed", origin="user"))
        for key in REQS:
            s.add(Entity(type="requirement", key=key, title=key, status="proposed", origin="user"))
        s.add(
            Entity(
                type="constraint",
                key="card-vault-limits",
                title="Card vault limits",
                status="confirmed",
                origin="user",
            )
        )
        await s.commit()  # fmt: skip


async def propose_feature(tenant_id, run_id, key="bulk-edit", title="Bulk edit") -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        p = Proposal(
            run_id=uuid.UUID(str(run_id)) if run_id else None,
            payload={
                "op": "create",
                "kind": "entity",
                "fields": {"type": "feature", "key": key, "title": title},
                "origin": "agent",
            },
            status="open",
        )
        s.add(p)
        await s.commit()
        return p.id


async def at_feature_set(client, owner, runtime, text=CLEAN, **knobs) -> dict:  # noqa: F811
    """A baseline_to_prd run whose feature-set segment left ``text``, past its end."""
    tenant_id, auth = owner
    await seed_baseline(tenant_id)
    runtime.script["feature_set"] = [
        Outcome(artifacts={"feature_set.yaml": text, "design.md": "# Design\n"})
    ]
    run = await started(client, auth, document=DOC, **knobs)
    await propose_feature(tenant_id, run["id"])
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    if run["status"] == "awaiting_checkpoint":
        run = await decide(client, auth, run)
    await tick(client, auth)
    return await get(client, auth, run["id"])


async def scopes(tenant_id, run_id=None) -> list[PrdScope]:
    async with tenant_session(tenant_id) as s:
        q = select(PrdScope).order_by(PrdScope.created_at)
        if run_id:
            q = q.where(PrdScope.run_id == uuid.UUID(str(run_id)))
        return list(await s.scalars(q))


# --------------------------------------------------------------------------- the stop


async def test_segment_end_writes_the_proposed_scope_and_the_check(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_feature_set(client, owner, runtime)
    assert run["status"] == "awaiting_checkpoint" and run["waiting_on"] == "feature_set"
    check = run["segments"][1]["feature_set_check"]
    assert check == {
        "features": 3,
        "requirements": 3,
        "excluded": 1,
        "problems": [],
        "flags": {"bulk-edit": ["serves_no_goal", "new_feature"]},
    }
    cp = pending(run)
    assert cp["payload"]["feature_set_check"] == check
    assert cp["cannot_approve"] is None

    (scope,) = await scopes(tenant_id, run["id"])
    assert scope.status == "proposed" and scope.attempt == 1 and scope.segment_seq == 2
    assert str(scope.checkpoint_id) == cp["id"]
    assert scope.document_id is None  # the PRD does not exist yet
    async with tenant_session(tenant_id) as s:
        items = list(
            await s.scalars(
                select(PrdScopeItem)
                .where(PrdScopeItem.scope_id == scope.id)
                .order_by(PrdScopeItem.kind, PrdScopeItem.position)
            )
        )
        feature_ids = {
            e.key: e.id for e in await s.scalars(select(Entity).where(Entity.type == "feature"))
        }
        proposal = await s.scalar(select(Proposal).where(Proposal.run_id == scope.run_id))
    features = [i for i in items if i.kind == "feature"]
    reqs = [i for i in items if i.kind == "requirement"]
    assert [(f.key, f.decision, f.position) for f in features] == [
        ("saved-addresses", "include", 0),
        ("address-lookup", "include", 1),
        ("bulk-edit", "include", 2),
        ("address-sharing", "exclude", 3),
    ]
    assert features[3].decision_reason == "Serves no confirmed goal"
    assert features[0].entity_id == feature_ids["saved-addresses"]
    assert features[2].entity_id is None and features[2].proposal_id == proposal.id
    assert features[2].flags == ["serves_no_goal", "new_feature"]
    assert features[0].goals[0]["key"] == "activation" and features[0].goals[0]["goal_id"]
    assert features[0].depends_on == ["address-lookup"]
    assert features[0].blocker_keys == ["card-vault-limits"]
    assert {r.key: r.decision for r in reqs} == dict.fromkeys(REQS, "keep")
    pick = next(r for r in reqs if r.key == "saved-addresses-pick")
    assert pick.parent_id == features[0].id and pick.position == 0
    assert pick.acceptance == ["Five addresses at most", "The last used one is preselected"]

    out = (await client.get(f"/v1/runs/{run['id']}/scope", headers=auth)).json()
    assert out["status"] == "proposed" and out["check"] == check
    assert [f["key"] for f in out["features"]] == [
        "saved-addresses",
        "address-lookup",
        "bulk-edit",
        "address-sharing",
    ]
    assert [r["key"] for r in out["features"][0]["requirements"]] == [
        "saved-addresses-pick",
        "saved-addresses-default",
    ]


async def test_approve_refused_with_blocking(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_feature_set(client, owner, runtime, BLOCKING)
    cp = pending(run)
    reason = "The feature set has 1 blocking problem; send it back with Request changes"
    assert cp["cannot_approve"] == reason
    (p,) = cp["payload"]["feature_set_check"]["problems"]
    assert p["code"] == "depends_on_excluded" and p["feature"] == "saved-addresses"
    url = f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide"
    # REST, as an owner and as an approver.
    for headers in (auth, await as_user(tenant_id, "approver")):
        resp = await client.post(url, json={"decision": "approved"}, headers=headers)
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"] == reason
    # MCP decide_checkpoint (the same route, a person's client).
    async with mcp_client(await api_token(tenant_id)) as c:
        out = await c.call_tool(
            "decide_checkpoint",
            {"run_id": run["id"], "checkpoint_id": cp["id"], "body": {"decision": "approved"}},
        )
        assert out.is_error and reason in text_of(out)
    run = await get(client, auth, run["id"])
    assert pending(run)["id"] == cp["id"] and run["status"] == "awaiting_checkpoint"
    (scope,) = await scopes(tenant_id, run["id"])
    assert scope.status == "proposed"
    async with tenant_session(tenant_id) as s:
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert "checkpoint.approved" not in actions

    # Request changes stays: the proposed scope is superseded, the re-run writes attempt 2.
    resp = await client.post(
        url, json={"decision": "changes_requested", "note": "Keep sharing out"}, headers=auth
    )
    assert resp.status_code == 200, resp.text
    (first,) = await scopes(tenant_id, run["id"])
    assert first.status == "superseded"
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "feature_set"
    first, second = await scopes(tenant_id, run["id"])
    assert (first.status, second.status, second.attempt) == ("superseded", "proposed", 2)


async def test_a_rerun_attempt_supersedes_the_proposed_scope(client, owner):  # noqa: F811
    """Rule 2 on its own: write_scope for a later attempt marks the earlier proposed one
    superseded (a request that did not go through decide, e.g. a console change)."""
    tenant_id, _ = owner
    await seed_baseline(tenant_id)
    async with tenant_session(tenant_id) as s:
        from oracle.runs.models import Run

        run = Run(flow="baseline_to_prd", knobs={"document_slug": DOC})
        s.add(run)
        await s.flush()
        known = await fs.known_for_run(s, run.id)
        check = fs.check_feature_set(CLEAN, document=DOC, known=known)
        a = await fs.write_scope(s, run, segment_seq=2, attempt=1, check=check, known=known)
        b = await fs.write_scope(s, run, segment_seq=2, attempt=2, check=check, known=known)
        # Written again for the same attempt (a resumed segment end): replaced, not doubled.
        c = await fs.write_scope(s, run, segment_seq=2, attempt=2, check=check, known=known)
        await s.commit()
        rows = list(await s.scalars(select(PrdScope).where(PrdScope.run_id == run.id)))
    assert a.status == "superseded" and c.status == "proposed"
    assert {r.attempt: r.status for r in rows} == {1: "superseded", 2: "proposed"}
    assert b.id != a.id


async def test_known_reads_this_runs_proposals_and_confirmed_goals_only(client, owner):  # noqa: F811
    """Criteria 2 and 3: an open create-proposal of type feature from this run is accepted
    and flagged new_feature, one from another run is unknown_feature; a proposed goal is
    unknown_goal."""
    tenant_id, _ = owner
    await seed_baseline(tenant_id)
    async with tenant_session(tenant_id) as s:
        from oracle.runs.models import Run

        mine, other = Run(flow="baseline_to_prd"), Run(flow="baseline_to_prd")
        s.add_all([mine, other])
        await s.commit()
    await propose_feature(tenant_id, mine.id, "bulk-edit")
    await propose_feature(tenant_id, other.id, "their-edit", "Their edit")
    text = CLEAN.replace("{key: activation, contribution: 1}", "{key: retention, contribution: 1}")
    text += "  - {key: their-edit, reason: Not ours}\n"
    async with tenant_session(tenant_id) as s:
        known = await fs.known_for_run(s, mine.id)
    out = fs.check_feature_set(text, document=DOC, known=known)
    assert sorted((p["code"], p["feature"]) for p in out.problems) == [
        ("unknown_feature", "their-edit"),
        ("unknown_goal", "address-lookup"),
    ]
    assert "new_feature" in out.flags["bulk-edit"]
    assert known.goals.keys() == {"activation"}


# --------------------------------------------------------------------------- approval


async def test_approving_a_clean_scope_supersedes_and_continues(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_feature_set(client, owner, runtime)
    # An earlier approved scope of the same document (another run's), with its document.
    (scope,) = await scopes(tenant_id, run["id"])
    async with tenant_session(tenant_id) as s:
        from oracle.docs.models import Document

        doc = Document(slug=DOC, title="Saved addresses", kind="prd")
        s.add(doc)
        await s.flush()
        earlier = PrdScope(run_id=scope.run_id, segment_seq=2, attempt=99, status="approved",
                           document_id=doc.id, check_result={})  # fmt: skip
        s.add(earlier)
        row = await s.get(PrdScope, scope.id)
        row.document_id = doc.id
        await s.commit()
    run = await decide(client, auth, run, note="Good set")
    assert run["status"] == "running"
    assert [s["status"] for s in run["segments"]][:3] == ["succeeded", "succeeded", "running"]
    by_attempt = {s.attempt: s for s in await scopes(tenant_id, run["id"])}
    assert by_attempt[1].status == "approved" and by_attempt[1].approved_at is not None
    assert by_attempt[1].approved_by is not None
    assert by_attempt[99].status == "superseded"
    async with tenant_session(tenant_id) as s:
        actions = set(await s.scalars(select(AuditEvent.action)))
    assert "prd_scope.approved" in actions


async def test_stop_off_approves_a_clean_scope_by_oracle(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    off = {"baseline_confirm": False, "feature_set": False}
    run = await at_feature_set(client, owner, runtime, checkpoints=off)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] in ("running", "awaiting_checkpoint") and run["error"] is None
    (scope,) = await scopes(tenant_id, run["id"])
    assert scope.status == "approved" and scope.approved_by is None
    async with tenant_session(tenant_id) as s:
        ev = await s.scalar(select(AuditEvent).where(AuditEvent.action == "prd_scope.approved"))
    assert ev.actor == "oracle"
    assert ev.data["by"] == "oracle" and ev.data["reason"] == "stop off"


async def test_stop_off_fails_the_run_on_a_blocking_problem(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    off = {"baseline_confirm": False, "feature_set": False}
    run = await at_feature_set(client, owner, runtime, BLOCKING, checkpoints=off)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["status"] == "failed"
    assert run["error"].startswith("feature_set.yaml was rejected: [depends_on_excluded]")
    (scope,) = await scopes(tenant_id, run["id"])
    assert scope.status == "proposed"


# --------------------------------------------------------------------------- reading it


async def test_draft_reads_scope(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_feature_set(client, owner, runtime)
    run = await decide(client, auth, run)
    priority = runtime.submitted[-1].steps[-1].prompt
    await tick(client, auth)
    run = await decide(client, auth, await get(client, auth, run["id"]))
    draft = runtime.submitted[-1].steps[-1].prompt
    for prompt in (priority, draft):
        assert "get_prd_scope" in prompt
        # MCP is not attached here (the local runtime): the approved scope is pasted.
        assert "Approved PRD scope" in prompt
        assert "saved-addresses-pick" in prompt
        assert "address-sharing" in prompt and "Serves no confirmed goal" in prompt
    assert "Order only the features included in the approved PRD scope" in priority
    assert "and nothing it excludes or defers" in draft

    # The draft imports: the run's scope gets the document, which serves it.
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["document_id"]
    (scope,) = await scopes(tenant_id, run["id"])
    assert str(scope.document_id) == run["document_id"]
    out = await client.get(f"/v1/documents/{DOC}/scope", headers=auth)
    assert out.status_code == 200, out.text
    assert out.json()["id"] == str(scope.id) and out.json()["status"] == "approved"
    assert out.json()["document_id"] == run["document_id"]


def test_prompts_name_the_tool_and_paste_the_scope():
    from oracle.runs import flows

    flow = flows.FLOWS["baseline_to_prd"]
    knobs = flows.resolve_knobs(flow, {})
    pasted = "features:\n- key: saved-addresses\nexcluded:\n- key: address-sharing\n"
    for attached in (False, True):
        ctx = flows.PromptContext(
            run_id="r1",
            document=DOC,
            snapshot_as_of=None,
            low_confidence=0.4,
            mcp_attached=attached,
            scope_yaml=pasted,
        )
        for name in ("priority", "prd_draft"):
            seg = flow.segment(name)
            assert "get_prd_scope" in seg.tools
            prompt = flows.build_steps(flow, seg, knobs, ctx)[-1][2]
            assert "get_prd_scope" in prompt
            assert ("key: address-sharing" in prompt) is (not attached)
    fs_task = flow.segment("feature_set").task
    assert "version: 1" in fs_task and "excluded" in fs_task and "acceptance" in fs_task
    assert "Every included feature lists at least one confirmed goal or `goals: []`" in fs_task
    nd = flows.FLOWS["feedback_loop"].segment("next_draft")
    assert "get_prd_scope" in nd.tools and "approved scope (get_prd_scope)" in nd.task
    assert "get_prd_scope" in flows.MCP_TOOLS


async def test_document_scope_is_404_without_an_approved_one(client, owner):  # noqa: F811
    _, auth = owner
    resp = await client.get(f"/v1/documents/{DOC}/scope", headers=auth)
    assert resp.status_code == 404


async def test_run_scope_is_404_without_one(client, owner, runtime):  # noqa: F811
    _, auth = owner
    run = await started(client, auth, document=DOC)
    resp = await client.get(f"/v1/runs/{run['id']}/scope", headers=auth)
    assert resp.status_code == 404


async def test_get_prd_scope_reads_the_tokens_run_and_refuses_people(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_feature_set(client, owner, runtime)
    async with tenant_session(tenant_id) as s:
        raw = await mint_run_token(s, uuid.UUID(run["id"]), ["read:baseline"], ttl_seconds=600)
        await s.commit()
    async with mcp_client(raw) as c:
        out = await c.call_tool("get_prd_scope", {})
        assert not out.is_error, text_of(out)
        assert out.structured_content["run_id"] == run["id"]
        assert out.structured_content["status"] == "proposed"
    async with mcp_client(await api_token(tenant_id)) as c:
        out = await c.call_tool("get_prd_scope", {})
        assert out.is_error
        assert "get_prd_scope is for a run's own agents" in text_of(out)


async def test_get_prd_scope_falls_back_to_the_documents_approved_scope(client, owner, runtime):  # noqa: F811
    tenant_id, auth = owner
    run = await at_feature_set(client, owner, runtime)
    run = await decide(client, auth, run)
    await tick(client, auth)
    run = await decide(client, auth, await get(client, auth, run["id"]))
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    (scope,) = await scopes(tenant_id, run["id"])
    # A feedback-loop run on the document has no scope of its own.
    loop = await started(client, auth, flow="feedback_loop", document=DOC)
    async with tenant_session(tenant_id) as s:
        raw = await mint_run_token(s, uuid.UUID(loop["id"]), ["read:documents"], ttl_seconds=600)
        await s.commit()
    async with mcp_client(raw) as c:
        out = await c.call_tool("get_prd_scope", {})
        assert not out.is_error, text_of(out)
        assert out.structured_content["id"] == str(scope.id)
    prompt = runtime.submitted[-1].steps[-1].prompt
    assert "get_prd_scope" in prompt and "address-sharing" in prompt
