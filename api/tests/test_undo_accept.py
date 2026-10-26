"""D14 follow-up: Undo of an accepted suggestion (``POST /v1/suggestions/{id}/undo-accept``).

Undo reverts what Accept did, for the roles that may accept (approver and up): section
text leaves Staged and its suggestion is open again; a "nothing to change" or duplicate
suggestion re-opens its item. It refuses, with the reason, what it cannot revert: an
answer already posted on the thread, a change a draft applied or a build is using, an
item someone changed since.

Test cards (protects / fails_when / no_claim):

- ``test_undo_puts_staged_text_back_to_open``: protects=Undo after Accept moves the row
  back; fails_when=the suggestion stays accepted or the item stays Staged; no_claim=the
  10 s window (the web's).
- ``test_undo_refuses_what_it_cannot_revert``: protects=no silent half-undo;
  fails_when=an answer, an applied or in-build change is re-opened; no_claim=wording.

Synthetic placeholders only.
"""

import pytest

from oracle.llm import gateway
from oracle.seed import seed
from tests.claude_account_helpers import add_account, window
from tests.test_llm_jobs import (
    DRAFT_V1,
    FakeClaude,
    actions,
    comment,
    feedback,
    import_draft,
    review_answer,
    tick,
)
from tests.test_members import token_with_role
from tests.test_next_draft import DOC, build, staged, staged_setup


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


async def undo(client, ctx, sid: str, headers=None):
    return await client.post(
        f"/v1/suggestions/{sid}/undo-accept", headers=headers or ctx["headers"]
    )


async def accept(client, ctx, sid: str):
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=ctx["headers"])
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_undo_puts_staged_text_back_to_open(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    resp = await undo(client, ctx, ids["goal_s"])
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["status"] == "open" and out["decided_by"] is None and out["decided_at"] is None
    fb = await feedback(client, ctx)
    assert fb[ids["goal"]]["state"] == "open"
    assert fb[ids["goal"]]["suggestion"]["status"] == "open"
    assert {r["suggestion_id"] for r in (await staged(client, ctx))["items"]} == {ids["sol_s"]}
    assert ("suggestion.undo_accept", {"kind": "section_text"}) in await actions(ctx["tenant_id"])
    # It can be accepted again.
    await accept(client, ctx, ids["goal_s"])
    assert (await feedback(client, ctx))[ids["goal"]]["state"] == "staged"


async def test_undo_reopens_a_closed_or_merged_item(client, ctx, pool, fake):
    await import_draft(client, ctx)
    a = await comment(client, ctx, "solution", "Make the checklist skippable.")
    b = await comment(client, ctx, "solution", "Let teams skip the checklist.")
    ok = await comment(client, ctx, "problem", "Looks right to me.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {"feedback_id": a, "classification": "change_request"},
                {"feedback_id": b, "classification": "change_request", "duplicate_of": a},
                {"feedback_id": ok, "classification": "approval", "suggestion": {"kind": "none"}},
            ]
        )
    )
    await tick(client, ctx)
    fb = await feedback(client, ctx)
    for fid, closed in ((ok, "addressed"), (b, "superseded")):
        sid = fb[fid]["suggestion"]["id"]
        await accept(client, ctx, sid)
        assert (await feedback(client, ctx))[fid]["status"] == closed
        resp = await undo(client, ctx, sid)
        assert resp.status_code == 200, resp.text
        item = (await feedback(client, ctx))[fid]
        assert (item["status"], item["resolution_note"], item["addressed_in_version"]) == (
            "open",
            None,
            None,
        )
        assert item["suggestion"]["status"] == "open"


async def test_undo_refuses_what_it_cannot_revert(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    # Not accepted: nothing to undo.
    resp = await undo(client, ctx, ids["still_s"])
    assert resp.status_code == 409 and "open" in resp.json()["detail"]
    # A build is using it: discard the build first.
    job = await build(client, ctx, fake, {"suggestion_ids": [ids["goal_s"]]})
    resp = await undo(client, ctx, ids["goal_s"])
    assert resp.status_code == 409, resp.text
    assert "next draft" in resp.json()["detail"] and "discard" in resp.json()["detail"]
    # The other staged change is not in that build: it may be undone.
    assert (await undo(client, ctx, ids["sol_s"])).status_code == 200
    # Applied in a draft: the draft keeps it.
    resp = await client.post(f"{DOC}/next-draft/{job['id']}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 201, resp.text
    resp = await undo(client, ctx, ids["goal_s"])
    assert resp.status_code == 409 and "draft 2" in resp.json()["detail"]


async def test_undo_refuses_a_posted_answer_and_a_changed_item(client, ctx, pool, fake):
    await import_draft(client, ctx)
    q = await comment(client, ctx, "problem", "Where does the half figure come from?")
    ok = await comment(client, ctx, "goal-trace", "Looks right to me.")
    fake.script["review_comments"].append(
        review_answer(
            [
                {
                    "feedback_id": q,
                    "classification": "question",
                    "suggestion": {"kind": "answer", "text": "From the funnel analysis."},
                },
                {"feedback_id": ok, "classification": "approval", "suggestion": {"kind": "none"}},
            ]
        )
    )
    await tick(client, ctx)
    fb = await feedback(client, ctx)
    await accept(client, ctx, fb[q]["suggestion"]["id"])
    resp = await undo(client, ctx, fb[q]["suggestion"]["id"])
    assert resp.status_code == 409 and "posted" in resp.json()["detail"]
    assert (await feedback(client, ctx))[q]["status"] == "addressed"

    sid = fb[ok]["suggestion"]["id"]
    await accept(client, ctx, sid)
    resp = await client.patch(
        f"/v1/feedback/{ok}", json={"status": "declined"}, headers=ctx["headers"]
    )
    assert resp.status_code == 200, resp.text
    resp = await undo(client, ctx, sid)
    assert resp.status_code == 409 and "declined" in resp.json()["detail"]


async def test_undo_takes_an_approver(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    for role in ("viewer", "commenter"):
        headers = await token_with_role(ctx["tenant_id"], role)
        assert (await undo(client, ctx, ids["goal_s"], headers)).status_code == 403
    headers = await token_with_role(ctx["tenant_id"], "approver")
    assert (await undo(client, ctx, ids["goal_s"], headers)).status_code == 200


async def refine(client, ctx, fake, key: str, body: dict) -> str:
    resp = await client.post(f"{DOC}/versions/1/sections/{key}/refine", json=body,
                             headers=ctx["headers"])  # fmt: skip
    assert resp.status_code == 201, resp.text
    fake.script["refinement"].append({"heading": "Goal trace", "body_md": "Serves activation."})
    await tick(client, ctx)
    return resp.json()["id"]


async def test_an_unapplied_refinement_holds_undo_only_while_it_can_be_applied(
    client, ctx, pool, fake
):
    """#587 review MAJOR 1: a single-section refinement has no discard; its preview holds
    Undo only while it is the section's latest and on the latest version."""
    ids = await staged_setup(client, ctx, fake)
    await refine(client, ctx, fake, "goal-trace", {})
    resp = await undo(client, ctx, ids["goal_s"])
    assert resp.status_code == 409, resp.text
    assert "refine" in resp.json()["detail"] and "discard" not in resp.json()["detail"]
    # A newer refinement of the section, without it, replaces that preview.
    await refine(client, ctx, fake, "goal-trace", {"suggestion_ids": [], "instruction": "Short."})
    resp = await undo(client, ctx, ids["goal_s"])
    assert resp.status_code == 200, resp.text


async def test_a_replaced_refinement_cannot_be_applied(client, ctx, pool, fake):
    """#595 re-review: once a newer refinement of the section replaced a preview, Undo
    no longer waits on it, so applying it is refused (else it would mark a re-opened
    suggestion applied)."""
    ids = await staged_setup(client, ctx, fake)
    older = await refine(client, ctx, fake, "goal-trace", {})
    await refine(client, ctx, fake, "goal-trace", {"suggestion_ids": [], "instruction": "Short."})
    assert (await undo(client, ctx, ids["goal_s"])).status_code == 200
    resp = await client.post(f"/v1/llm-jobs/{older}/apply", json={}, headers=ctx["headers"])
    assert resp.status_code == 409, resp.text
    assert "newer refinement" in resp.json()["detail"]
    assert (await feedback(client, ctx))[ids["goal"]]["suggestion"]["status"] == "open"


async def test_a_refinement_of_an_older_version_never_holds_undo(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    await refine(client, ctx, fake, "goal-trace", {})
    assert (await undo(client, ctx, ids["goal_s"])).status_code == 409
    # A newer version landed: that preview can no longer be applied.
    await import_draft(client, ctx, DRAFT_V1.replace("A guided checklist", "A short checklist"))
    resp = await undo(client, ctx, ids["goal_s"])
    assert resp.status_code == 200, resp.text


async def test_undo_drops_the_text_accept_edited(client, ctx, pool, fake):
    ids = await staged_setup(client, ctx, fake)
    sid = ids["still_s"]
    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={"text": "Half (2026)."},
                             headers=ctx["headers"])  # fmt: skip
    assert resp.status_code == 200 and resp.json()["edited_text"] == "Half (2026)."
    resp = await undo(client, ctx, sid)
    assert resp.status_code == 200, resp.text
    assert resp.json()["edited_text"] is None


async def test_undo_leaves_an_item_closed_before_accept(client, ctx, pool, fake):
    await import_draft(client, ctx)
    ok = await comment(client, ctx, "problem", "Looks right to me.")
    fake.script["review_comments"].append(
        review_answer(
            [{"feedback_id": ok, "classification": "approval", "suggestion": {"kind": "none"}}]
        )
    )
    await tick(client, ctx)
    resp = await client.patch(
        f"/v1/feedback/{ok}",
        json={"status": "addressed", "resolution_note": "Checked by hand."},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200, resp.text
    sid = (await feedback(client, ctx))[ok]["suggestion"]["id"]
    await accept(client, ctx, sid)
    resp = await undo(client, ctx, sid)
    assert resp.status_code == 200, resp.text
    item = (await feedback(client, ctx))[ok]
    assert (item["status"], item["resolution_note"]) == ("addressed", "Checked by hand.")
    assert item["suggestion"]["status"] == "open"
