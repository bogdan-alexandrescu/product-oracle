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

from tests.test_llm_jobs import (
    actions,
    comment,
    feedback,
    import_draft,
    review_answer,
    tick,
)
from tests.test_members import token_with_role
from tests.test_next_draft import (  # noqa: F401 (fixtures)
    DOC,
    build,
    ctx,
    fake,
    pool,
    staged,
    staged_setup,
)


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
