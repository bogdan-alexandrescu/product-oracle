"""#348 Requests queue: an approver declines Oracle's suggestion for a New request.

Each test's card is one line: protects / fails_when / no_claim. Synthetic placeholders
only.
"""

import pytest

from tests.baseline_helpers import Ctx, make_ctx
from tests.test_requests import act, add, audits, get, goal, suggest


@pytest.fixture
async def ctx() -> Ctx:
    return await make_ctx()


async def test_decline_marks_the_suggestion_declined_and_changes_nothing_else(client, ctx):
    """protects=#348 (decline Oracle's suggestion); fails_when=declining changes the
    request's goals, theme or state, keeps the suggestion acceptable, or leaves no audit;
    no_claim=which buttons the UI shows."""
    g = await goal(client, ctx)
    r = await add(client, ctx, title="Keep my address")
    await suggest(ctx, r["id"], theme_title="Faster check-out", goal_ids=[g["id"]])

    resp = await act(client, ctx, r["id"], "suggestion/decline")
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["state"] == "new"
    assert out["goal_ids"] == [] and out["theme"] is None
    assert out["suggestion"]["declined_at"] is not None
    assert out["lock_version"] == r["lock_version"] + 1
    assert len(await audits(ctx, "request.suggestion_declined")) == 1

    # A declined suggestion is no longer there to accept or decline again.
    resp = await act(client, ctx, r["id"], "suggestion/accept", parts=["goals"])
    assert resp.status_code == 422
    resp = await act(client, ctx, r["id"], "suggestion/decline")
    assert resp.status_code == 422
    assert (await get(client, ctx, r["id"]))["goal_ids"] == []


async def test_decline_needs_an_approver_a_suggestion_and_a_new_request(client, ctx):
    """protects=rule 2 (approvers decide) and the state rule; fails_when=a commenter
    declines, a request with no suggestion is changed, a decided request is changed, or a
    stale version lands; no_claim=the triage that writes suggestions."""
    g = await goal(client, ctx)
    r = await add(client, ctx, goal_ids=[g["id"]])
    await suggest(ctx, r["id"], goal_ids=[g["id"]])

    resp = await act(client, ctx, r["id"], "suggestion/decline", who="commenter")
    assert resp.status_code == 403
    stale = (await get(client, ctx, r["id"]))["lock_version"] - 1
    resp = await act(client, ctx, r["id"], "suggestion/decline", lock_version=stale)
    assert resp.status_code == 409

    bare = await add(client, ctx, title="Dark mode")
    resp = await act(client, ctx, bare["id"], "suggestion/decline")
    assert resp.status_code == 422

    assert (await act(client, ctx, r["id"], "qualify")).status_code == 200
    resp = await act(client, ctx, r["id"], "suggestion/decline")
    assert resp.status_code == 409
    assert (await get(client, ctx, r["id"]))["suggestion"]["declined_at"] is None
