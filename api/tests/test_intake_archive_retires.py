"""Archiving a brief retires its open questions; restoring it asks them again (#307).

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

from tests.intake_helpers import answer, company, create_intake, summary
from tests.test_questions_people import inbox, questions_of, uid


async def _status(client, ctx, intake_id: str, status: str, lock: int, who="commenter"):
    resp = await client.patch(
        f"/v1/intakes/{intake_id}",
        json={"status": status, "lock_version": lock},
        headers=ctx.as_(who),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _archived_with_a_delegate(client, ctx):
    """A brief whose questions are asked of its author, one delegated to the approver,
    one answered; then archived."""
    out = await create_intake(client, ctx, "commenter", batch_size=3)
    intake_id = out["intake"]["id"]
    asked = await questions_of(client, ctx, intake_id, "asked")
    assert len(asked) == 3
    delegated, answered = asked[0]["id"], asked[1]["id"]
    await answer(
        client, ctx, delegated, "commenter", kind="delegate", delegated_to=uid(ctx, "approver")
    )
    await answer(client, ctx, answered, "commenter", body="Repeat buyers on the web shop")
    assert len(await inbox(client, ctx, "commenter")) == 1
    assert len(await inbox(client, ctx, "approver")) == 1
    lock = (await summary(client, ctx, intake_id))["intake"]["lock_version"]
    intake = await _status(client, ctx, intake_id, "archived", lock)
    return intake_id, intake, {q["id"] for q in asked}, delegated, answered


async def test_archiving_retires_the_open_questions(client):
    """protects=an archived brief's open questions leave everyone's Inbox at once and stay
    on the brief as history; fails_when=one still reads in an Inbox, is still asked or
    delegated, or an answered one changes; no_claim=the web badge (the Playwright test)."""
    ctx = await company()
    intake_id, _, ids, delegated, answered = await _archived_with_a_delegate(client, ctx)
    assert await inbox(client, ctx, "commenter") == []
    assert await inbox(client, ctx, "approver") == []
    retired = await questions_of(client, ctx, intake_id, "retired")
    assert {q["id"] for q in retired} == ids - {answered}
    assert [q["id"] for q in await questions_of(client, ctx, intake_id, "answered")] == [answered]
    assert await questions_of(client, ctx, intake_id, "asked") == []
    # Kept on the brief's page, not counted as open there.
    resp = await client.get(
        f"/v1/intakes/{intake_id}/question-batch", params={"batch": 1}, headers=ctx.as_("viewer")
    )
    assert {c["question"]["id"] for c in resp.json()["questions"]} == ids
    resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=ctx.as_("viewer"))
    assert resp.json()["batch"]["asked"] == 0
    # A retired question is neither answered nor moved.
    for who in ("commenter", "approver"):
        await answer(client, ctx, delegated, who, expect=409, body="Too late")
    resp = await client.patch(
        f"/v1/questions/{delegated}",
        json={"asked_to": uid(ctx, "commenter")},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 409, resp.text


async def test_restoring_asks_the_unanswered_questions_again(client):
    """protects=restoring an archived brief brings its unanswered questions back to the
    people they were asked of; fails_when=one stays retired, a delegated one comes back as
    merely asked, or the answered one is asked again; no_claim=a UI to restore."""
    ctx = await company()
    intake_id, intake, ids, delegated, answered = await _archived_with_a_delegate(client, ctx)
    await _status(client, ctx, intake_id, "awaiting_answers", intake["lock_version"])
    assert await questions_of(client, ctx, intake_id, "retired") == []
    mine = await inbox(client, ctx, "commenter")
    assert {r["question"]["id"] for r in mine} == ids - {answered, delegated}
    assert all(r["question"]["status"] == "asked" for r in mine)
    theirs = await inbox(client, ctx, "approver")
    assert [(r["question"]["id"], r["question"]["status"]) for r in theirs] == [
        (delegated, "delegated")
    ]
    assert [q["id"] for q in await questions_of(client, ctx, intake_id, "answered")] == [answered]
