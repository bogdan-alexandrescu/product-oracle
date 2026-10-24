"""H10 Reasoned no, lane 1 (API): problems on themes (triage suggests, an approver
confirms, edits or dismisses) and Oracle's decline suggestion, which never decides.

Each test's card is one line: protects / fails_when / no_claim. Made-up names only.
"""

import uuid

import pytest

from oracle.requests.models import ProductRequest, RequestTheme
from oracle.runs import flows
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx
from tests.test_request_replies import add, feature, get, rows, set_level
from tests.test_requests_triage import apply, triage_file, triage_run

PROBLEM = {
    "problem": "Team leads copy boards one by one to report to their managers",
    "success": "A weekly report takes under five minutes",
    "constraints": "Legal: exports stay inside the company",
}


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


async def theme(client, ctx: Ctx, title: str = "Reporting") -> dict:
    resp = await client.post("/v1/request-themes", json={"title": title},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 201, resp.text
    return resp.json()


async def themes(client, ctx: Ctx) -> dict[str, dict]:
    resp = await client.get("/v1/request-themes", headers=ctx.as_("viewer"))
    return {t["title"]: t for t in resp.json()}


async def test_triage_problem_is_a_suggestion_until_confirmed(client, ctx):
    """protects=criterion 7 (an entry's problem becomes the theme's problem_suggestion;
    Confirm sets problem_state confirmed with the text); fails_when=the problem lands
    confirmed on its own or Confirm leaves it suggested; no_claim=the Themes tab."""
    t = await theme(client, ctx)
    r = await add(client, ctx)
    run = await triage_run(ctx)
    entry = {"id": r["id"], "theme": {"id": t["id"]}, "confidence": 0.8, "problem": PROBLEM}
    result = await apply(ctx, run, triage_file([entry]))
    assert result["suggestions"] == 1 and result["notes"] == []
    got = (await themes(client, ctx))["Reporting"]
    assert got["problem_state"] == "suggested" and got["problem"] is None
    assert got["problem_suggestion"] == PROBLEM

    resp = await client.post(f"/v1/request-themes/{t['id']}/problem/confirm",
                             json={"lock_version": got["lock_version"]},
                             headers=ctx.as_("commenter"))  # fmt: skip
    assert resp.status_code == 403
    resp = await client.post(f"/v1/request-themes/{t['id']}/problem/confirm",
                             json={"lock_version": got["lock_version"]},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["problem_state"] == "confirmed" and out["problem"] == PROBLEM["problem"]
    assert out["success"] == PROBLEM["success"] and out["problem_suggestion"] is None

    # A confirmed problem is not replaced by the next triage.
    await apply(ctx, await triage_run(ctx), triage_file([{**entry, "problem": {"problem": "x"}}]))
    assert (await themes(client, ctx))["Reporting"]["problem"] == PROBLEM["problem"]


async def test_dismiss_and_edit_a_problem(client, ctx):
    """protects=Dismiss drops a suggestion; a person's edit is a confirmed problem with the
    limits (1,000 and 500 characters); fails_when=a dismissed suggestion stays or an edit is
    left unconfirmed; no_claim=the inspector's theme block."""
    t = await theme(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(RequestTheme, uuid.UUID(t["id"]))
        row.problem_suggestion, row.problem_state = PROBLEM, "suggested"
        await s.commit()
    got = (await themes(client, ctx))["Reporting"]
    resp = await client.post(f"/v1/request-themes/{t['id']}/problem/dismiss",
                             json={"lock_version": got["lock_version"]},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["problem_state"] == "none" and resp.json()["problem_suggestion"] is None
    url = f"/v1/request-themes/{t['id']}"
    resp = await client.patch(url, json={"lock_version": resp.json()["lock_version"],
                              "problem": "x" * 1001}, headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 422
    lock = (await themes(client, ctx))["Reporting"]["lock_version"]
    resp = await client.patch(url, json={"lock_version": lock, "problem": "Leads retype numbers",
                              "success": "No retyping"}, headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["problem_state"] == "confirmed" and resp.json()["success"] == "No retyping"


async def test_problem_for_a_new_theme_waits_on_the_theme(client, ctx):
    """protects=criterion 7 (a problem for a suggested new theme is kept on the suggestion
    and stored on the theme when it is accepted); fails_when=it is lost; no_claim=theme
    naming."""
    r = await add(client, ctx)
    entry = {"id": r["id"], "theme": {"title": "Board reports"}, "problem": PROBLEM}
    await apply(ctx, await triage_run(ctx), triage_file([entry]))
    got = await get(client, ctx, r["id"])
    assert got["suggestion"]["problem"]["problem"] == PROBLEM["problem"]
    resp = await client.post(f"/v1/requests/{r['id']}/suggestion/accept",
                             json={"lock_version": got["lock_version"], "parts": ["theme"]},
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200, resp.text
    made = (await themes(client, ctx))["Board reports"]
    assert made["problem_state"] == "suggested"
    assert made["problem_suggestion"]["problem"] == PROBLEM["problem"]


async def test_decline_suggestion_shows_and_changes_nothing_even_at_act(client, ctx):
    """protects=criterion 7 (decline shows on the suggestion; nothing is disqualified, even
    with H11 requests at Act and confidence 1.0; hidden at Observe); fails_when=Oracle
    disqualifies or the suggestion is lost or shown at Observe; no_claim=Use this (lane 2)."""
    feat = await feature(client, ctx)
    r = await add(client, ctx)
    entry = {
        "id": r["id"],
        "confidence": 1.0,
        "decline": {"reason": "already_exists", "basis": {"kind": "feature", "id": "board-export"},
                    "why": "Board export already does this"},
    }  # fmt: skip
    await set_level(client, ctx, "requests", "act")
    await apply(ctx, await triage_run(ctx), triage_file([entry]))
    got = await get(client, ctx, r["id"])
    assert got["state"] == "new"
    assert got["suggestion"]["decline"] == {
        "reason": "already_exists",
        "basis": {"kind": "feature", "id": feat["id"]},
        "why": "Board export already does this",
    }
    assert [x.state for x in await rows(ctx, ProductRequest)] == ["new"]
    await set_level(client, ctx, "requests", "observe")
    assert (await get(client, ctx, r["id"]))["suggestion"]["decline"] is None


def test_prompts_say_a_no_is_not_scope():
    """protects=the agents' line on declined requests and the triage file's new fields;
    fails_when=either prompt drops it or the task still says nothing about problem and
    decline; no_claim=the agent obeying it."""
    line = "is not scope unless a person reopens it; cite its decision"
    triage = flows.FLOWS["request_triage"].segments[0].task
    assert line in triage and "never decide" in triage
    assert "problem" in triage and "decline" in triage
    prd = next(s for s in flows.FLOWS["baseline_to_prd"].segments if s.name == "feature_set")
    assert line in prd.task
    assert "list_request_replies" in flows.MCP_TOOLS
