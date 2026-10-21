"""C1e: accepted suggestions are staged; one built-in job writes the next draft from them.

Staging (an accepted, not yet applied section-text suggestion), the staged list across
versions, the one ``refinement_batch`` job, its combined preview, apply (exactly one new
version, dropped sections stay staged), discard, the Inbox states and the MCP tools.
"""

import uuid

import pytest
from sqlalchemy import func, select

from oracle.docs.models import DocumentVersion
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.main import app
from oracle.mcp.scopes import required_scope
from oracle.mcp.tools import app_operations
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.claude_account_helpers import add_account, window
from tests.test_llm_jobs import (
    DRAFT_V1,
    SLUG,
    FakeClaude,
    V,
    comment,
    feedback,
    import_draft,
    jobs,
    review_answer,
    tick,
    verdict,
)
from tests.test_members import token_with_role

DOC = f"/v1/documents/{SLUG}"


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


def suggest(fid: str, key: str, text: str) -> dict:
    return {
        "feedback_id": fid,
        "classification": "change_request",
        "suggestion": {"kind": "section_text", "section_key": key, "text": text},
    }


async def staged_setup(client, ctx, fake) -> dict[str, str]:
    """Version 1 with two accepted (staged) items, one declined and one still open."""
    await import_draft(client, ctx)
    goal = await comment(client, ctx, "goal-trace", "Name the activation metric.")
    sol = await comment(client, ctx, "solution", "Make the checklist skippable.")
    drop = await comment(client, ctx, "problem", "Say 'most', not 'half'.")
    still = await comment(client, ctx, "problem", "Which cohort is this?")
    fake.script["review_comments"].append(
        review_answer(
            [
                suggest(goal, "goal-trace", "Serves activation: teams reaching a first report."),
                suggest(sol, "solution", "A guided checklist that teams can skip."),
                suggest(drop, "problem", "Most new teams never invite a teammate."),
                suggest(still, "problem", "Half of new teams (2026 cohort) never invite."),
            ]
        )
    )
    await tick(client, ctx)
    fb = await feedback(client, ctx)
    ids = {"goal": goal, "sol": sol, "drop": drop, "still": still}
    out = {k: v for k, v in ids.items()}
    for k, fid in ids.items():
        out[f"{k}_s"] = fb[fid]["suggestion"]["id"]
    for k in ("goal", "sol"):
        resp = await client.post(
            f"/v1/suggestions/{out[f'{k}_s']}/accept", json={}, headers=ctx["headers"]
        )
        assert resp.status_code == 200, resp.text
    resp = await client.post(
        f"/v1/suggestions/{out['drop_s']}/dismiss",
        json={"reason": "Half is what the funnel shows.", "decline": True},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    return out


async def staged(client, ctx, **params) -> dict:
    resp = await client.get(f"{DOC}/staged-changes", params=params, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return resp.json()


def batch_answer(payload: dict) -> dict:
    by_key: dict[str, list[str]] = {}
    for s in payload["suggestions"]:
        by_key.setdefault(s["section_key"], []).append(s["feedback_id"])
    texts = {
        "goal-trace": "Serves activation: the share of new teams reaching a first report.",
        "solution": "A guided checklist [c:c1] that teams can skip; see https://e.x/s.",
        "problem": "Most new teams never invite a teammate.",
    }
    return {
        "notes": "Both changes in one pass.",
        "sections": [
            {
                "section_key": key,
                "heading": next(
                    s["heading"] for s in payload["sections"] if s["section_key"] == key
                ),
                "body_md": texts[key],
                "notes": f"Revised {key}.",
                "data_points": [{"value": "45% finish", "as_of": "October", "source": "Study"}]
                if key == "solution"
                else [],
                "resolutions": [
                    {"feedback_id": f, "status": "addressed", "note": "Done."} for f in fids
                ],
            }
            for key, fids in by_key.items()
        ],
    }


async def build(client, ctx, fake, body: dict | None = None) -> dict:
    resp = await client.post(f"{DOC}/next-draft", json=body or {}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    fake.script["refinement_batch"].append(batch_answer)
    await tick(client, ctx)
    return resp.json()


async def version_count(tenant_id) -> int:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(func.count()).select_from(DocumentVersion))


# --- 1. staging ----------------------------------------------------------------------------


async def test_accepting_stages_the_item_and_the_staged_list_says_who_and_where(
    client, ctx, pool, fake
):
    ids = await staged_setup(client, ctx, fake)
    fb = await feedback(client, ctx)
    assert (fb[ids["goal"]]["state"], fb[ids["goal"]]["staged_for_version"]) == ("staged", 2)
    assert fb[ids["sol"]]["state"] == "staged"
    assert (fb[ids["drop"]]["state"], fb[ids["drop"]]["staged_for_version"]) == ("declined", None)
    assert fb[ids["still"]]["state"] == "open"
    # Staging changes nothing in the document.
    assert fb[ids["goal"]]["status"] == "open"

    out = await staged(client, ctx)
    assert (out["latest_version"], out["next_version"], out["gone_count"]) == (1, 2, 0)
    assert out["draft_job"] is None
    rows = {r["suggestion_id"]: r for r in out["items"]}
    assert set(rows) == {ids["goal_s"], ids["sol_s"]}
    g = rows[ids["goal_s"]]
    assert g["feedback_item_id"] == ids["goal"]
    assert (g["section_key"], g["section_heading"]) == ("goal-trace", "Goal trace")
    assert g["feedback_summary"] == "Name the activation metric."
    assert g["raised_on_version"] == 1 and g["suggested_on_version"] == 1
    assert g["accepted_by"] and g["accepted_at"] and g["accepted_by_name"] == "admin@example.com"
    assert g["text"].startswith("Serves activation")
    assert (g["section_gone"], g["section_locked"]) == (False, False)


async def test_items_staged_on_an_earlier_draft_stay_staged_for_the_latest(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    # Draft 2 arrives by another path (an agent's import), without the staged changes,
    # and without the Proposed solution section.
    no_solution = DRAFT_V1.replace(
        "## Proposed solution {#solution}\n\nA guided checklist on the first screen.\n\n", ""
    ).replace("Owner: product.", "Owner: growth.")
    await import_draft(client, ctx, no_solution)
    out = await staged(client, ctx)
    assert (out["latest_version"], out["next_version"], out["gone_count"]) == (2, 3, 1)
    assert [r["suggestion_id"] for r in out["items"]] == [ids["goal_s"]]
    assert out["items"][0]["raised_on_version"] == 1
    every = await staged(client, ctx, include_gone="true")
    gone = next(r for r in every["items"] if r["suggestion_id"] == ids["sol_s"])
    assert gone["section_gone"] is True and gone["section_heading"] == "Proposed solution"
    fb = await feedback(client, ctx)
    assert fb[ids["goal"]]["staged_for_version"] == 3

    # A gone section is not built: excluded by default, refused when asked for.
    resp = await client.post(
        f"{DOC}/next-draft", json={"suggestion_ids": [ids["sol_s"]]}, headers=ctx["headers"]
    )
    assert resp.status_code == 422 and "no longer" in resp.json()["detail"]
    job = await build(client, ctx, fake)
    assert job["input"]["suggestion_ids"] == [ids["goal_s"]]
    _, payload = fake.calls[-1]
    assert payload["document"]["version"] == 2


# --- 2. one batch job ------------------------------------------------------------------------


async def test_build_queues_one_batch_job_over_the_latest_version(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    job = resp.json()
    assert (job["kind"], job["status"], job["version_number"]) == ("refinement_batch", "queued", 1)
    assert sorted(job["input"]["suggestion_ids"]) == sorted([ids["goal_s"], ids["sol_s"]])
    # One build at a time.
    again = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert again.status_code == 409
    out = await staged(client, ctx)
    assert out["draft_job"]["id"] == job["id"]

    fake.script["refinement_batch"].append(batch_answer)
    summary = await tick(client, ctx)
    assert summary["succeeded"] >= 1
    kind, payload = fake.calls[-1]
    assert kind == "refinement_batch"
    # Every section is in view; the affected ones are flagged; both suggestions in one call.
    assert [s["section_key"] for s in payload["sections"]] == [
        "title",
        "goal-trace",
        "problem",
        "solution",
        "sources",
    ]
    assert {s["section_key"] for s in payload["sections"] if s["affected"]} == {
        "goal-trace",
        "solution",
    }
    assert {s["feedback_id"] for s in payload["suggestions"]} == {ids["goal"], ids["sol"]}
    assert [c[0] for c in fake.calls].count("refinement_batch") == 1
    [done] = [j for j in await jobs(client, ctx) if j["kind"] == "refinement_batch"]
    # Same accounting as every built-in job.
    assert done["status"] == "succeeded" and done["cost_usd"] == 0.0421
    assert done["account_label"] == "personal"


async def test_build_respects_roles_the_job_switch_and_locked_sections(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    for role in ("viewer", "commenter"):
        headers = await token_with_role(ctx["tenant_id"], role)
        assert (await client.get(f"{DOC}/staged-changes", headers=headers)).status_code == 200
        resp = await client.post(f"{DOC}/next-draft", json={}, headers=headers)
        assert resp.status_code == 403
    resp = await client.put(
        f"{DOC}/llm-jobs/settings", json={"refinement": False}, headers=ctx["headers"]
    )
    assert resp.status_code == 200
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert resp.status_code == 409
    assert (
        resp.json()["detail"]
        == '"Rewrite sections and build drafts" is turned off for this document'
    )
    await client.put(f"{DOC}/llm-jobs/settings", json={"refinement": True}, headers=ctx["headers"])

    await verdict(client, ctx, "goal-trace", "approved")
    out = await staged(client, ctx)
    assert {r["suggestion_id"]: r["section_locked"] for r in out["items"]}[ids["goal_s"]] is True
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert resp.status_code == 409
    assert "Goal trace" in resp.json()["detail"] and "goal-trace" in resp.json()["detail"]
    # Without the locked one it builds.
    resp = await client.post(
        f"{DOC}/next-draft", json={"suggestion_ids": [ids["sol_s"]]}, headers=ctx["headers"]
    )
    assert resp.status_code == 201

    other = str(uuid.uuid4())
    resp = await client.post(
        f"{DOC}/next-draft", json={"suggestion_ids": [other]}, headers=ctx["headers"]
    )
    assert resp.status_code in (409, 422)


async def test_build_with_nothing_staged_is_refused(client, ctx, pool, fake):
    await import_draft(client, ctx)
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    assert resp.status_code == 422 and "nothing" in resp.json()["detail"].lower()


# --- 3. preview, apply, discard ----------------------------------------------------------------


async def test_preview_then_apply_makes_exactly_one_version(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    job = await build(client, ctx, fake)
    resp = await client.get(f"{DOC}/next-draft/{job['id']}", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    preview = resp.json()
    assert preview["job"]["status"] == "succeeded"
    assert (preview["base_version"], preview["next_version"], preview["stale"]) == (1, 2, False)
    assert preview["notes"] == "Both changes in one pass."
    sections = {s["section_key"]: s for s in preview["sections"]}
    assert set(sections) == {"goal-trace", "solution"}
    sol = sections["solution"]
    assert sol["before_body_md"] == "A guided checklist on the first screen."
    # O1c holds on the batch too.
    assert "[c:" not in sol["body_md"] and "https://" not in sol["body_md"]
    assert set(sol["o1c_fixes"]) >= {"citation_markers", "urls"}
    assert sol["data_points"][0]["value"] == "45% finish"
    assert sol["notes"] == "Revised solution."
    assert [r["feedback_id"] for r in sol["resolutions"]] == [ids["sol"]]
    assert [f["id"] for f in sol["feedback"]] == [ids["sol"]]
    assert any(w["op"] == "insert" for w in sol["words"])

    before = await version_count(ctx["tenant_id"])
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    v2 = resp.json()
    assert v2["number"] == 2
    assert await version_count(ctx["tenant_id"]) == before + 1
    bodies = {s["section_key"]: s["body_md"] for s in v2["sections"]}
    assert bodies["goal-trace"].startswith("Serves activation: the share")
    assert bodies["solution"].startswith("A guided checklist that teams can skip")
    assert "45% finish" in bodies["sources"]
    assert bodies["problem"] == "Half of new teams never invite a teammate."

    fb = await feedback(client, ctx)
    for k in ("goal", "sol"):
        assert (fb[ids[k]]["status"], fb[ids[k]]["addressed_in_version"]) == (
            "addressed",
            2,
        )
        assert fb[ids[k]]["state"] == "done"
        assert fb[ids[k]]["suggestion"]["applied_in_version"] == 2
    assert fb[ids["still"]]["state"] == "open"
    out = await staged(client, ctx)
    assert out["items"] == [] and out["draft_job"] is None
    again = await client.post(
        f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"]
    )
    assert again.status_code == 409
    # 'What changed' is reported on the new version.
    assert "reporting" in [j["kind"] for j in await jobs(client, ctx)]


async def test_dropping_a_section_keeps_its_item_staged_and_edits_win(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    job = await build(client, ctx, fake)
    resp = await client.post(
        f"{DOC}/next-draft/{job['id']}/apply",
        json={
            "drop_sections": ["solution"],
            "edits": {"goal-trace": "Serves activation, my words [c:c1]."},
        },
        headers=ctx["headers"],
    )
    assert resp.status_code == 201, resp.text
    v2 = resp.json()
    bodies = {s["section_key"]: s["body_md"] for s in v2["sections"]}
    assert bodies["goal-trace"] == "Serves activation, my words."
    assert bodies["solution"] == "A guided checklist on the first screen."
    # The dropped section's data points do not land either.
    assert "45% finish" not in bodies["sources"]
    fb = await feedback(client, ctx)
    assert fb[ids["goal"]]["state"] == "done"
    assert (fb[ids["sol"]]["state"], fb[ids["sol"]]["staged_for_version"]) == ("staged", 3)
    out = await staged(client, ctx)
    assert [r["suggestion_id"] for r in out["items"]] == [ids["sol_s"]]
    assert out["next_version"] == 3


async def test_apply_validates_its_input(client, ctx, pool, fake):
    await staged_setup(client, ctx, fake)
    job = await build(client, ctx, fake)
    url = f"{DOC}/next-draft/{job['id']}/apply"
    resp = await client.post(
        url, json={"drop_sections": ["goal-trace", "solution"]}, headers=ctx["headers"]
    )
    assert resp.status_code == 422
    resp = await client.post(url, json={"edits": {"problem": "x"}}, headers=ctx["headers"])
    assert resp.status_code == 422
    commenter = await token_with_role(ctx["tenant_id"], "commenter")
    assert (await client.post(url, json={}, headers=commenter)).status_code == 403
    assert (
        await client.post(f"{DOC}/next-draft/{job['id']}/discard", headers=commenter)
    ).status_code == 403


async def test_apply_is_refused_when_a_newer_version_appeared(client, ctx, pool, fake):
    await staged_setup(client, ctx, fake)
    job = await build(client, ctx, fake)
    await import_draft(client, ctx, DRAFT_V1.replace("Owner: product.", "Owner: growth."))
    preview = (await client.get(f"{DOC}/next-draft/{job['id']}", headers=ctx["headers"])).json()
    assert preview["stale"] is True
    before = await version_count(ctx["tenant_id"])
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 409 and "newer version" in resp.json()["detail"]
    assert await version_count(ctx["tenant_id"]) == before
    assert len((await staged(client, ctx))["items"]) == 2


async def test_apply_refuses_a_section_locked_since_the_build(client, ctx, pool, fake):
    await staged_setup(client, ctx, fake)
    job = await build(client, ctx, fake)
    await verdict(client, ctx, "solution", "approved")
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 409 and "Proposed solution" in resp.json()["detail"]


async def test_discard_keeps_everything_staged(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    job = await build(client, ctx, fake)
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/discard", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    out = await staged(client, ctx)
    assert {r["suggestion_id"] for r in out["items"]} == {ids["goal_s"], ids["sol_s"]}
    assert out["draft_job"] is None
    preview = (await client.get(f"{DOC}/next-draft/{job['id']}", headers=ctx["headers"])).json()
    assert preview["discarded"] is True
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 409
    # A queued build is cancelled by discard.
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    queued = resp.json()
    resp = await client.post(f"{DOC}/next-draft/{queued['id']}/discard", headers=ctx["headers"])
    assert resp.status_code == 200 and resp.json()["status"] == "cancelled"


async def test_a_running_build_previews_its_status_only(client, ctx, pool, fake):
    await staged_setup(client, ctx, fake)
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    job = resp.json()
    preview = (await client.get(f"{DOC}/next-draft/{job['id']}", headers=ctx["headers"])).json()
    assert preview["job"]["status"] == "queued" and preview["sections"] == []
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 409


async def test_a_section_missing_from_the_answer_stays_staged(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    job = resp.json()

    def only_goal(payload):
        out = batch_answer(payload)
        out["sections"] = [s for s in out["sections"] if s["section_key"] == "goal-trace"]
        return out

    fake.script["refinement_batch"].append(only_goal)
    await tick(client, ctx)
    preview = (await client.get(f"{DOC}/next-draft/{job['id']}", headers=ctx["headers"])).json()
    assert [s["section_key"] for s in preview["sections"]] == ["goal-trace"]
    assert [s["section_key"] for s in preview["skipped"]] == ["solution"]
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 201
    fb = await feedback(client, ctx)
    assert fb[ids["sol"]]["state"] == "staged"


async def test_a_section_past_the_200k_cap_is_skipped_with_its_reason(client, ctx, pool, fake):
    # Model output is capped like an approver's edit: the house rules never read more.
    await staged_setup(client, ctx, fake)
    resp = await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    job = resp.json()

    def long_solution(payload):
        out = batch_answer(payload)
        for s in out["sections"]:
            if s["section_key"] == "solution":
                s["body_md"] = "a" * 200_001
        return out

    fake.script["refinement_batch"].append(long_solution)
    await tick(client, ctx)
    preview = (await client.get(f"{DOC}/next-draft/{job['id']}", headers=ctx["headers"])).json()
    assert [s["section_key"] for s in preview["sections"]] == ["goal-trace"]
    [skipped] = preview["skipped"]
    assert skipped["section_key"] == "solution", skipped
    assert "200,000 characters" in skipped["reason"], skipped


async def test_single_section_refine_and_apply_still_work(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    resp = await client.post(V(1, "/sections/solution/refine"), json={}, headers=ctx["headers"])
    assert resp.status_code == 201
    fake.script["refinement"].append(
        {"heading": "Proposed solution", "body_md": "Skippable checklist.", "resolutions": []}
    )
    await tick(client, ctx)
    job = next(j for j in await jobs(client, ctx) if j["kind"] == "refinement")
    resp = await client.post(f"/v1/llm-jobs/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 201
    out = await staged(client, ctx)
    assert [r["suggestion_id"] for r in out["items"]] == [ids["goal_s"]]


# --- 4. MCP ------------------------------------------------------------------------------------


def test_next_draft_operations_are_mcp_tools_with_strict_scopes():
    ops = {op.operation_id: op for op in app_operations(app)}
    expected = {
        "list_staged_changes": ("GET", "read:documents"),
        "preview_next_draft": ("GET", "read:documents"),
        "build_next_draft": ("POST", None),
        "apply_next_draft": ("POST", None),
        "discard_next_draft": ("POST", None),
    }
    for op_id, (method, scope) in expected.items():
        op = ops[op_id]
        assert op.excluded is None and op.tool_name == op_id
        assert op.method == method
        assert required_scope(op.method, op.path) == scope, op_id
    # Run tokens never apply drafts this way (write:drafts covers importing a version only).
    assert required_scope("POST", "/v1/llm-jobs/{job_id}/apply") is None
    inbox = ops["get_inbox"]
    assert "mark_seen" in {p.name for p in inbox.params}


# --- 5. Inbox ---------------------------------------------------------------------------------


async def test_inbox_states_new_and_staged_rows(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    resp = await client.get("/v1/inbox", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    inbox = resp.json()
    states = {i["id"]: i["state"] for i in inbox["items"]}
    # Never visited: open items are new.
    assert states == {
        ids["goal"]: "staged",
        ids["sol"]: "staged",
        ids["drop"]: "declined",
        ids["still"]: "new",
    }
    assert inbox["counts"] == {"new": 1, "open": 0, "staged": 2, "declined": 1, "done": 0}
    assert inbox["needs_me"] == 1
    assert inbox["last_seen_at"] is None
    [row] = inbox["staged"]
    assert (row["slug"], row["count"], row["next_version"], row["latest_version"]) == (
        SLUG,
        2,
        2,
        1,
    )
    declined = next(i for i in inbox["items"] if i["id"] == ids["drop"])
    assert declined["resolution_note"] == "Half is what the funnel shows."
    assert declined["slug"] == SLUG and declined["title"] and declined["latest_version"] == 1
    new = next(i for i in inbox["items"] if i["id"] == ids["still"])
    assert new["suggestion_status"] == "open"
    # Open feedback no longer counts staged or declined items.
    [doc] = inbox["feedback"]
    assert doc["open_count"] == 1 and [i["id"] for i in doc["items"]] == [ids["still"]]

    # Visiting marks seen; the response of that visit still shows New.
    seen = (await client.get("/v1/inbox?mark_seen=true", headers=ctx["headers"])).json()
    assert seen["counts"]["new"] == 1
    after = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    assert after["last_seen_at"] is not None
    assert after["counts"]["new"] == 0 and after["counts"]["open"] == 1
    assert after["needs_me"] == 1
    # A later comment is new again.
    later = await comment(client, ctx, "title", "Add a one-line summary.")
    after = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    assert {i["id"]: i["state"] for i in after["items"]}[later] == "new"
    assert after["items"][0]["id"] == later  # newest first

    # Last seen is per user: another approver still sees everything open as new.
    approver = await token_with_role(ctx["tenant_id"], "approver")
    theirs = (await client.get("/v1/inbox", headers=approver)).json()
    assert theirs["counts"]["new"] == 2


async def test_inbox_done_after_apply(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    job = await build(client, ctx, fake)
    await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    states = {i["id"]: i["state"] for i in inbox["items"]}
    assert states[ids["goal"]] == "done" and states[ids["sol"]] == "done"
    done = next(i for i in inbox["items"] if i["id"] == ids["goal"])
    assert done["addressed_in_version"] == 2
    assert inbox["staged"] == []
    assert inbox["counts"]["staged"] == 0 and inbox["counts"]["done"] == 2


async def test_commenters_get_no_feedback_states(client, ctx, pool, fake):
    await staged_setup(client, ctx, fake)
    commenter = await token_with_role(ctx["tenant_id"], "commenter")
    inbox = (await client.get("/v1/inbox", headers=commenter)).json()
    assert inbox["items"] == [] and inbox["staged"] == [] and inbox["needs_me"] == 0


async def test_the_batch_job_kind_is_allowed_by_the_database(client, ctx, pool, fake):
    await staged_setup(client, ctx, fake)
    await client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"])
    async with tenant_session(ctx["tenant_id"]) as s:
        kinds = set(await s.scalars(select(LlmJob.kind)))
    assert "refinement_batch" in kinds


async def test_inbox_total_counts_each_new_or_open_item(client, ctx, pool, fake):
    """Owner, 2026-10-20: the badge counts each new or open item (= New + Open), never
    staged, declined or done; one open rule, so the document row leaves staged items out."""
    ids = await staged_setup(client, ctx, fake)
    second = await comment(client, ctx, "solution", "Who owns the checklist?")
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    counts = inbox["counts"]
    assert (counts["new"], counts["staged"], counts["declined"]) == (2, 2, 1)
    # Two open items on one document count two, not one per document.
    assert inbox["total"] == counts["new"] + counts["open"] == 2
    [doc] = inbox["feedback"]
    assert {i["id"] for i in doc["items"]} == {ids["still"], second}
    assert doc["counts"]["accepted"] == 0
    # The first open item's section, never a staged one's (goal-trace, solution's goal).
    assert doc["first_section_key"] in ("problem", "solution")
    assert ids["goal"] not in {i["id"] for i in doc["items"]}


async def test_inbox_document_with_only_staged_items_has_no_open_row(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    resp = await client.post(
        f"/v1/suggestions/{ids['still_s']}/accept", json={}, headers=ctx["headers"]
    )
    assert resp.status_code == 200, resp.text
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    assert inbox["feedback"] == [] and inbox["total"] == 0 and inbox["needs_me"] == 0
    [row] = inbox["staged"]
    assert row["count"] == 3


async def test_dismissing_a_suggestion_without_declining_keeps_the_item_open(
    client, ctx, pool, fake
):
    """Owner, 2026-10-20: dismissing Oracle's suggestion is not declining the reviewer's point."""
    ids = await staged_setup(client, ctx, fake)
    resp = await client.post(
        f"/v1/suggestions/{ids['still_s']}/dismiss",
        json={"reason": "Not this wording.", "decline": False},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    assert {i["id"]: i["state"] for i in inbox["items"]}[ids["still"]] == "new"
    assert inbox["total"] == 1
    fb = await feedback(client, ctx)
    assert fb[ids["still"]]["state"] == "open"


# --- review fixes: one build at a time, resolve closes the item, dismissed-in-build ---------


async def test_two_concurrent_builds_queue_exactly_one_job(client, ctx, pool, fake):
    import asyncio

    await staged_setup(client, ctx, fake)
    a, b = await asyncio.gather(
        client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"]),
        client.post(f"{DOC}/next-draft", json={}, headers=ctx["headers"]),
    )
    assert sorted([a.status_code, b.status_code]) == [201, 409], (a.text, b.text)
    ok, refused = (a, b) if a.status_code == 201 else (b, a)
    assert ok.json()["id"] in refused.json()["detail"]
    async with tenant_session(ctx["tenant_id"]) as s:
        n = await s.scalar(
            select(func.count()).select_from(LlmJob).where(LlmJob.kind == "refinement_batch")
        )
    assert n == 1


async def test_resolving_a_thread_closes_its_item_and_reopening_reopens_it(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    assert (await client.get("/v1/inbox", headers=ctx["headers"])).json()["total"] == 1
    cid = (await feedback(client, ctx))[ids["still"]]["comment_id"]
    resp = await client.patch(
        f"/v1/comments/{cid}", json={"resolved": True}, headers=ctx["headers"]
    )
    assert resp.status_code == 200, resp.text
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    assert inbox["total"] == 0 and inbox["feedback"] == []
    resp = await client.patch(
        f"/v1/comments/{cid}", json={"resolved": False}, headers=ctx["headers"]
    )
    assert resp.status_code == 200, resp.text
    assert (await client.get("/v1/inbox", headers=ctx["headers"])).json()["total"] == 1


async def test_apply_skips_a_suggestion_dismissed_during_the_build(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    job = await build(client, ctx, fake)
    resp = await client.post(
        f"/v1/suggestions/{ids['sol_s']}/dismiss",
        json={"reason": "Changed my mind.", "decline": False},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    bodies = {s["section_key"]: s["body_md"] for s in resp.json()["sections"]}
    assert bodies["goal-trace"].startswith("Serves activation")
    assert bodies["solution"] == "A guided checklist on the first screen."
    assert "45% finish" not in bodies["sources"]
    fb = await feedback(client, ctx)
    assert fb[ids["goal"]]["state"] == "done"
    assert fb[ids["sol"]]["suggestion"]["status"] == "dismissed"
    assert fb[ids["sol"]]["suggestion"]["applied_in_version"] is None
    assert fb[ids["sol"]]["state"] != "done"


# --- UI test finding E4 (owner, 2026-10-20): staged changes carry into the next draft ------


async def test_approving_a_version_keeps_accepted_unapplied_suggestions_staged(
    client, ctx, pool, fake
):
    """An accepted suggestion not applied in any draft stays Staged until a draft applies
    it or someone discards it, whatever its feedback item's status: draft 2 closing the
    items (its resolutions, as a run's draft does) and being approved does not hide them.
    The Inbox, the review panel and the build action count the same changes."""
    ids = await staged_setup(client, ctx, fake)
    resolutions = "".join(
        f"  - feedback_id: {ids[k]}\n    status: addressed\n    note: Covered in v2.\n"
        for k in ("goal", "sol")
    )
    v2 = DRAFT_V1.replace("---\n\n# Onboarding", f"resolutions:\n{resolutions}---\n\n# Onboarding")
    await import_draft(client, ctx, v2)
    resp = await client.post(f"{DOC}/versions/2/approve", headers=ctx["headers"])
    assert resp.status_code == 200, resp.text

    # The review panel (the document's feedback).
    fb = await feedback(client, ctx)
    for k in ("goal", "sol"):
        assert fb[ids[k]]["status"] == "addressed"
        assert (fb[ids[k]]["state"], fb[ids[k]]["staged_for_version"]) == ("staged", 3)
    assert fb[ids["drop"]]["state"] == "declined" and fb[ids["still"]]["state"] == "open"

    # The build action ("Build draft 3 · 2 staged").
    out = await staged(client, ctx)
    assert (out["latest_version"], out["next_version"]) == (2, 3)
    assert {r["suggestion_id"] for r in out["items"]} == {ids["goal_s"], ids["sol_s"]}

    # The Inbox: Staged lists them and counts what the build action counts; Done does not.
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    states = {i["id"]: i["state"] for i in inbox["items"]}
    assert (states[ids["goal"]], states[ids["sol"]]) == ("staged", "staged")
    assert inbox["counts"]["staged"] == len(out["items"]) == 2
    assert inbox["counts"]["done"] == 0 and inbox["counts"]["declined"] == 1
    staged_item = next(i for i in inbox["items"] if i["id"] == ids["goal"])
    assert staged_item["staged_for_version"] == 3
    [row] = inbox["staged"]
    assert (row["count"], row["next_version"]) == (2, 3)
    # Still not open feedback.
    assert inbox["total"] == 1

    # Discarding one ends its staging: its item was closed, so it is done.
    resp = await client.post(
        f"/v1/suggestions/{ids['goal_s']}/dismiss",
        json={"reason": "Not any more.", "decline": False},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    assert {i["id"]: i["state"] for i in inbox["items"]}[ids["goal"]] == "done"
    assert (inbox["counts"]["staged"], inbox["counts"]["done"]) == (1, 1)
    assert len((await staged(client, ctx))["items"]) == 1
    assert (await feedback(client, ctx))[ids["goal"]]["state"] == "done"


async def test_an_item_closed_by_hand_keeps_its_staged_change(client, ctx, pool, fake):
    """The same rule when an approver closes the item itself (status addressed)."""
    ids = await staged_setup(client, ctx, fake)
    resp = await client.patch(
        f"/v1/feedback/{ids['sol']}", json={"status": "addressed"}, headers=ctx["headers"]
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["state"] == "staged"
    inbox = (await client.get("/v1/inbox", headers=ctx["headers"])).json()
    assert {i["id"]: i["state"] for i in inbox["items"]}[ids["sol"]] == "staged"
    assert inbox["counts"]["staged"] == 2 and inbox["counts"]["done"] == 0
