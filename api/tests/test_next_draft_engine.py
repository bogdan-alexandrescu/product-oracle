"""D12: one Build next draft that picks the engine and says why.

``choose_engine`` holds the rule: the agents (a feedback-loop run in SwarmCloud) when any
chosen item was staged for the agents or a chosen text change's section is gone; else
Oracle's own refinement batch. The plan route says which and why; the run route starts
the feedback loop with exactly the chosen items (accepted text included); the built-in
route refuses inputs that need the agents. Approvers stage feedback without section text
for the agents; the run's draft closes those items and applies the text it was sent.
"""

import uuid
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import select

from oracle.docs.models import Document
from oracle.jobs.models import LlmJob, LlmSuggestion
from oracle.jobs.next_draft import choose_engine
from oracle.jobs.schemas import AgentItem, StagedChange
from oracle.review.models import FeedbackItem
from oracle.runs import flows
from oracle.swarm.fake import Outcome
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_runs import as_user, get, runtime, tick  # noqa: F401

SLUG = "checkout-redesign"
DOC = f"/v1/documents/{SLUG}"
GOAL_TEXT = "Serves G1 activation: buyers who finish checkout in one visit."
PROBLEM_TEXT = "Most buyers drop off when the total changes at the last step."
REMARK = "The draft never says who the buyer is."


# --- the rule ----------------------------------------------------------------------------


def change(key: str = "goal-trace", *, gone: bool = False, locked: bool = False) -> StagedChange:
    return StagedChange(
        suggestion_id=uuid.uuid4(),
        feedback_item_id=uuid.uuid4(),
        section_key=key,
        section_heading=key.title(),
        feedback_summary="Change it",
        text="New text",
        raised_on_version=1,
        suggested_on_version=1,
        section_gone=gone,
        section_locked=locked,
    )


def agent_item(key: str | None = None) -> AgentItem:
    return AgentItem(feedback_id=uuid.uuid4(), summary="Rework it", section_key=key)


PRD = SimpleNamespace(kind="prd")
ROADMAP = SimpleNamespace(kind="roadmap")


def test_only_text_changes_go_to_oracle():
    plan = choose_engine([change("goal-trace"), change("problem")], [], PRD)
    assert (plan.engine, plan.why) == ("oracle", [])


def test_a_whole_draft_remark_goes_to_the_agents_and_says_so():
    item = agent_item(None)
    plan = choose_engine([change()], [item], PRD)
    assert plan.engine == "agents"
    [why] = plan.why
    assert (why.code, why.text, why.feedback_ids) == (
        "whole_draft",
        "1 remark is about the whole draft",
        [item.feedback_id],
    )


def test_section_items_staged_for_the_agents_need_more_than_text():
    plan = choose_engine([], [agent_item("problem"), agent_item("users")], PRD)
    assert plan.engine == "agents"
    assert [(w.code, w.text) for w in plan.why] == [
        ("structure", "2 items need more than a section's text changed")
    ]


def test_a_text_change_whose_section_is_gone_goes_to_the_agents():
    a, b = change("solution", gone=True), change("solution", gone=True)
    plan = choose_engine([change("goal-trace"), a, b], [], PRD)
    assert plan.engine == "agents"
    [why] = plan.why
    assert (why.code, why.text) == ("section_gone", "1 section to change is gone")
    assert why.suggestion_ids == [a.suggestion_id, b.suggestion_id]


def test_every_reason_is_listed_in_plain_words():
    plan = choose_engine(
        [change("risks", gone=True), change("users", gone=True)],
        [agent_item(None), agent_item(None), agent_item("problem")],
        PRD,
    )
    assert plan.engine == "agents"
    assert [w.text for w in plan.why] == [
        "2 remarks are about the whole draft",
        "1 item needs more than a section's text changed",
        "2 sections to change are gone",
    ]


def test_locked_sections_and_roadmaps_do_not_change_the_engine_by_themselves():
    # A locked section is the built-in path's refusal (the plan's), not a reason for agents.
    assert choose_engine([change(locked=True)], [], PRD).engine == "oracle"
    assert choose_engine([change("now")], [], ROADMAP).engine == "oracle"


# --- setup -------------------------------------------------------------------------------


async def setup(client, extra_open: bool = True) -> dict:
    """Version 1 with two accepted section-text suggestions (staged text changes), a
    whole-draft remark, a comment answered by Oracle (suggestion ``answer``) and, with
    ``extra_open``, an open item nobody staged."""
    tenant_id, auth = await seed_auth()
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    ids: dict = {"tenant_id": tenant_id, "auth": auth}
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))

        def item(key: str | None, summary: str, kind: str = "comment") -> FeedbackItem:
            f = FeedbackItem(
                document_id=doc.id,
                raised_on_version=1,
                kind=kind,
                section_key=key,
                summary=summary,
                status="open",
                created_at=datetime.now(UTC),
            )
            s.add(f)
            return f

        goal = item("goal-trace", "Name the activation metric.")
        problem = item("problem", "Say 'most', not 'half'.")
        general = item(None, REMARK, kind="general")
        asked = item("users", "Do we cover guest checkout?")
        other = item("risks", "Add a fraud risk.") if extra_open else None
        await s.flush()
        for f, text in ((goal, GOAL_TEXT), (problem, PROBLEM_TEXT)):
            sug = LlmSuggestion(
                document_id=doc.id,
                feedback_item_id=f.id,
                version_number=1,
                classification="change_request",
                kind="section_text",
                section_key=f.section_key,
                text=text,
                status="accepted",
                decided_at=datetime.now(UTC),
            )
            s.add(sug)
            await s.flush()
            ids[f"{f.section_key}_s"] = str(sug.id)
        s.add(
            LlmSuggestion(
                document_id=doc.id,
                feedback_item_id=asked.id,
                version_number=1,
                classification="question",
                kind="answer",
                section_key="users",
                text="Yes: guests pay without an account.",
                status="open",
            )
        )
        await s.commit()
        ids.update(
            goal=str(goal.id),
            problem=str(problem.id),
            general=str(general.id),
            asked=str(asked.id),
            other=str(other.id) if other else None,
        )
    return ids


async def stage(client, auth, fid: str, method: str = "POST"):
    return await client.request(method, f"/v1/feedback/{fid}/stage-for-agents", headers=auth)


async def plan(client, auth, **body) -> dict:
    resp = await client.post(f"{DOC}/next-draft/plan", json=body, headers=auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- the plan and the two engines --------------------------------------------------------


async def test_only_text_changes_plan_oracle_and_build_the_refinement_batch(client):
    ids = await setup(client)
    auth = ids["auth"]

    p = await plan(client, auth)

    assert p["engine"] == "oracle" and p["why"] == []
    assert (p["text_changes"], p["agent_items"], p["sections"], p["next_version"]) == (2, 0, 2, 2)
    assert (p["estimate_usd"], p["needs_owner_approval"], p["refused"]) == (None, False, None)
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=auth)
    assert resp.status_code == 201, resp.text
    assert resp.json()["kind"] == "refinement_batch"
    resp = await client.post(f"{DOC}/next-draft/run", json={}, headers=auth)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "these changes need no agents; build them with Oracle"


async def test_staging_for_the_agents_moves_an_answered_comment_to_staged(client):
    ids = await setup(client)
    auth = ids["auth"]
    commenter = await as_user(ids["tenant_id"], "commenter")
    assert (await stage(client, commenter, ids["asked"])).status_code == 403

    # An item with an accepted section-text change is already staged, as a text change.
    resp = await stage(client, auth, ids["goal"])
    assert resp.status_code == 409 and "already staged as a text change" in resp.json()["detail"]

    resp = await stage(client, auth, ids["asked"])
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert (out["state"], out["staged_for_version"], out["status"]) == ("staged", 2, "open")
    assert out["staged_for_agents"] is True

    staged = (await client.get(f"{DOC}/staged-changes", headers=auth)).json()
    [row] = staged["agent_items"]
    assert (row["feedback_id"], row["section_key"]) == (ids["asked"], "users")
    assert row["summary"] == "Do we cover guest checkout?"
    assert row["staged_by_name"] and row["staged_at"]
    inbox = (await client.get("/v1/inbox", headers=auth)).json()
    [doc_row] = inbox["staged"]
    assert doc_row["count"] == 3
    asked = next(i for i in inbox["items"] if i["id"] == ids["asked"])
    assert asked["state"] == "staged" and asked["staged_for_agents"] is True

    resp = await stage(client, auth, ids["asked"], "DELETE")
    assert resp.status_code == 200 and resp.json()["state"] == "open"
    assert (await client.get(f"{DOC}/staged-changes", headers=auth)).json()["agent_items"] == []

    resp = await client.patch(
        f"/v1/feedback/{ids['other']}", json={"status": "declined"}, headers=auth
    )
    assert resp.status_code == 200
    resp = await stage(client, auth, ids["other"])
    assert resp.status_code == 409 and "not open" in resp.json()["detail"]


async def test_mixed_items_go_to_the_agents_with_exactly_the_chosen_items(client, runtime):  # noqa: F811
    ids = await setup(client)
    auth = ids["auth"]
    assert (await stage(client, auth, ids["general"])).status_code == 200

    p = await plan(client, auth)

    assert p["engine"] == "agents"
    assert p["why"] == [
        {
            "code": "whole_draft",
            "text": "1 remark is about the whole draft",
            "feedback_ids": [ids["general"]],
            "suggestion_ids": [],
        }
    ]
    assert (p["text_changes"], p["agent_items"], p["next_version"]) == (2, 1, 2)
    assert (p["estimate_usd"], p["needs_owner_approval"], p["refused"]) == (9.0, False, None)

    resp = await client.post(f"{DOC}/next-draft/run", json={}, headers=auth)

    assert resp.status_code == 201, resp.text
    run = resp.json()
    assert (run["flow"], run["status"], run["estimate_usd"]) == ("feedback_loop", "running", 9.0)
    prompt = runtime.submitted[0].steps[-1].prompt
    listed = [line for line in prompt.splitlines() if line.startswith("- ") and "[" in line]
    assert sorted(listed) == sorted(
        [
            f"- {ids['goal']} [goal-trace]: Name the activation metric.",
            f"- {ids['problem']} [problem]: Say 'most', not 'half'.",
            f"- {ids['general']} [general]: {REMARK}",
        ]
    )
    assert (
        f"- {ids['goal']} [goal-trace]: Name the activation metric.\n"
        f"  Accepted change for this section: {GOAL_TEXT}"
    ) in prompt
    assert f"  Accepted change for this section: {PROBLEM_TEXT}" in prompt
    assert "Add a fraud risk." not in prompt and "guest checkout" not in prompt


async def test_the_built_in_path_refuses_agent_items_and_the_run_refuses_text_only(client):
    ids = await setup(client)
    auth = ids["auth"]
    assert (await stage(client, auth, ids["general"])).status_code == 200

    resp = await client.post(
        f"{DOC}/next-draft", json={"feedback_ids": [ids["general"]]}, headers=auth
    )
    assert resp.status_code == 409
    body = resp.json()
    assert body["code"] == "needs_agents"
    assert [w["code"] for w in body["why"]] == ["whole_draft"]
    # Every staged item by default: the same refusal.
    assert (await client.post(f"{DOC}/next-draft", json={}, headers=auth)).status_code == 409
    async with tenant_session(ids["tenant_id"]) as s:
        assert (await s.scalar(select(LlmJob).where(LlmJob.kind == "refinement_batch"))) is None

    # Unticked, the text changes build with Oracle; the run route refuses them alone.
    resp = await client.post(f"{DOC}/next-draft/run", json={"feedback_ids": []}, headers=auth)
    assert resp.status_code == 409
    resp = await client.post(f"{DOC}/next-draft", json={"feedback_ids": []}, headers=auth)
    assert resp.status_code == 201, resp.text
    # Only staged items can be chosen.
    resp = await client.post(
        f"{DOC}/next-draft/plan", json={"feedback_ids": [ids["other"]]}, headers=auth
    )
    assert resp.status_code == 422


async def test_an_estimate_over_the_threshold_needs_an_owner(client, runtime, monkeypatch):  # noqa: F811
    ids = await setup(client)
    auth = ids["auth"]
    assert (await stage(client, auth, ids["general"])).status_code == 200
    deep = await plan(client, auth, depth="deep")
    assert (deep["estimate_usd"], deep["needs_owner_approval"]) == (18.0, False)

    monkeypatch.setattr(flows, "APPROVAL_THRESHOLD_USD", Decimal(5))
    p = await plan(client, auth)
    assert (p["engine"], p["estimate_usd"], p["needs_owner_approval"]) == ("agents", 9.0, True)
    resp = await client.post(f"{DOC}/next-draft/run", json={}, headers=auth)
    assert resp.status_code == 201, resp.text
    assert resp.json()["status"] == "awaiting_approval"
    assert runtime.submitted == []


async def test_the_plan_says_why_a_built_in_build_cannot_start(client):
    ids = await setup(client)
    auth = ids["auth"]
    resp = await client.put(
        f"{DOC}/versions/1/sections/goal-trace/review",
        json={"verdict": "approved"},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    p = await plan(client, auth)
    assert p["engine"] == "oracle"
    assert "approved and locked" in p["refused"] and "goal-trace" in p["refused"]

    p = await plan(client, auth, suggestion_ids=[ids["problem_s"]])
    assert p["refused"] is None
    resp = await client.put(f"{DOC}/llm-jobs/settings", json={"refinement": False}, headers=auth)
    assert resp.status_code == 200, resp.text
    p = await plan(client, auth, suggestion_ids=[ids["problem_s"]])
    assert p["refused"] == "Refinement is turned off for this document"


async def test_a_gone_section_chosen_goes_to_the_agents(client):
    ids = await setup(client)
    auth = ids["auth"]
    no_problem = draft("prd_v1.md").replace("## 2. Problem {#problem}", "## 2. Context {#context}")
    assert (await import_draft(client, auth, no_problem)).status_code == 201

    # By default a change whose section is gone is left out, as before.
    p = await plan(client, auth)
    assert (p["engine"], p["text_changes"], p["next_version"]) == ("oracle", 1, 3)
    p = await plan(client, auth, suggestion_ids=[ids["goal-trace_s"], ids["problem_s"]])
    assert p["engine"] == "agents"
    assert [(w["code"], w["text"]) for w in p["why"]] == [
        ("section_gone", "1 section to change is gone")
    ]
    assert p["why"][0]["suggestion_ids"] == [ids["problem_s"]]


async def test_the_runs_draft_closes_the_items_and_applies_the_text_it_was_sent(
    client,
    runtime,  # noqa: F811
):
    ids = await setup(client)
    auth = ids["auth"]
    assert (await stage(client, auth, ids["general"])).status_code == 200
    sent = [ids["goal"], ids["problem"], ids["general"]]
    resolutions = "resolutions:\n" + "".join(
        f"  - feedback_id: {f}\n    status: addressed\n    note: Done.\n" for f in sent
    )
    markdown = (
        draft("prd_v1.md")
        .replace("---\n", "---\n" + resolutions, 1)
        .replace("Serves G1 (activation): more first-time buyers complete a purchase", GOAL_TEXT)
        .replace("Too many shoppers leave checkout before paying.", PROBLEM_TEXT)
    )
    runtime.script["next_draft"] = [Outcome(artifacts={"prd.md": markdown})]

    run = (await client.post(f"{DOC}/next-draft/run", json={}, headers=auth)).json()
    await tick(client, auth)
    run = await get(client, auth, run["id"])

    assert run["segments"][0]["draft_import"]["version"] == 2
    fb = {f["id"]: f for f in (await client.get(f"{DOC}/feedback", headers=auth)).json()}
    for fid in (ids["goal"], ids["problem"]):
        assert (fb[fid]["status"], fb[fid]["state"]) == ("addressed", "done"), fid
    # An agent never closes a whole-draft item itself (a person confirms it in the
    # version's review); answered by the draft, it leaves Staged.
    general = fb[ids["general"]]
    assert (general["status"], general["state"], general["staged_for_agents"]) == (
        "open",
        "open",
        False,
    )
    assert fb[ids["other"]]["state"] == "open"
    async with tenant_session(ids["tenant_id"]) as s:
        rows = list(
            await s.scalars(select(LlmSuggestion).where(LlmSuggestion.kind == "section_text"))
        )
        assert {(r.status, r.applied_in_version) for r in rows} == {("applied", 2)}
        item = await s.get(FeedbackItem, uuid.UUID(ids["general"]))
        assert item.staged_for_agents_at is None
    staged = (await client.get(f"{DOC}/staged-changes", headers=auth)).json()
    assert (staged["items"], staged["agent_items"]) == ([], [])
    assert (await client.get("/v1/inbox", headers=auth)).json()["staged"] == []


async def test_the_new_run_dialog_offers_only_its_flows_and_points_at_the_others(
    client,
    runtime,  # noqa: F811
):
    ids = await setup(client)
    auth = ids["auth"]
    flows_out = {f["key"]: f for f in (await client.get("/v1/flows", headers=auth)).json()["flows"]}
    assert [k for k, f in flows_out.items() if f["in_new_run_dialog"]] == ["baseline_to_prd"]
    assert flows_out["feedback_loop"]["starts_from"] == {
        "label": "Build next draft · open a PRD or roadmap and use Build next draft",
        "href": None,
    }
    assert flows_out["prd_to_roadmap"]["starts_from"] == {
        "label": "PRD to roadmap · Plan",
        "href": "/roadmap",
    }
    assert flows_out["baseline_to_prd"]["starts_from"] is None

    # The flow stays in the API; started directly it still reads every open item.
    resp = await client.post(
        "/v1/runs", json={"flow": "feedback_loop", "document": SLUG}, headers=auth
    )
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=auth)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=auth)).status_code == 200
    prompt = runtime.submitted[0].steps[-1].prompt
    assert "Add a fraud risk." in prompt and REMARK in prompt
