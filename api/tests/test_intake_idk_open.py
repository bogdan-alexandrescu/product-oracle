"""An "I don't know" answer on a brief leaves its question open (owner 2026-10-29, qa-work-2).

Test cards (protects / fails_when / no_claim) head each test. Synthetic placeholders only.
"""

from tests.intake_helpers import answer, batch, company, create_intake, summary
from tests.test_questions_people import inbox, questions_of


async def _brief(client, ctx):
    out = await create_intake(client, ctx, "commenter", batch_size=3)
    intake_id = out["intake"]["id"]
    asked = await questions_of(client, ctx, intake_id, "asked")
    assert len(asked) == 3
    counts = (await summary(client, ctx, intake_id))["batch"]
    assert (counts["asked"], counts["answered"]) == (3, 0)
    return intake_id, [q["id"] for q in asked]


async def test_a_real_answer_closes_the_question(client):
    """protects=a real answer counts the question answered on the brief, in the Inbox and in
    the brief's own list; fails_when=it still counts open; no_claim=the web tally."""
    ctx = await company()
    intake_id, ids = await _brief(client, ctx)
    out = await answer(client, ctx, ids[0], "commenter", body="Repeat buyers on the web shop")
    assert out["question"]["status"] == "answered"
    counts = (await summary(client, ctx, intake_id))["batch"]
    assert (counts["asked"], counts["answered"]) == (2, 1)
    assert ids[0] not in {r["question"]["id"] for r in await inbox(client, ctx, "commenter")}
    # Asked again only by an approver's new answer, never by another "I don't know".
    await answer(client, ctx, ids[0], "commenter", expect=409, kind="dont_know")


async def test_dont_know_leaves_the_question_open_until_a_real_answer(client):
    """protects=an "I don't know" answer keeps its question open in every count (the brief,
    the Inbox, the batch) with the answer and its text kept, its gap open, until someone
    gives a real answer; fails_when=it counts answered, leaves the Inbox, drops its text,
    or a later real answer is refused; no_claim=the web tally (the Playwright spec)."""
    ctx = await company()
    intake_id, ids = await _brief(client, ctx)
    out = await answer(client, ctx, ids[0], "commenter", kind="dont_know", body="Not measured yet")
    assert out["question"]["status"] == "asked"
    assert out["answer"]["kind"] == "dont_know" and out["answer"]["body"] == "Not measured yet"
    assert out["gap"]["status"] == "unknown"
    counts = (await summary(client, ctx, intake_id))["batch"]
    assert (counts["asked"], counts["answered"]) == (3, 0)
    assert ids[0] in {r["question"]["id"] for r in await inbox(client, ctx, "commenter")}
    [card] = [
        c
        for c in (await batch(client, ctx, intake_id))["questions"]
        if c["question"]["id"] == ids[0]
    ]
    assert [(a["kind"], a["body"]) for a in card["answers"]] == [("dont_know", "Not measured yet")]

    # Someone gives a real answer: now it is answered, the "I don't know" kept before it.
    out = await answer(client, ctx, ids[0], "commenter", body="Median checkout time")
    assert out["question"]["status"] == "answered"
    assert out["gap"]["status"] in ("answered", "answered_pending_review")
    counts = (await summary(client, ctx, intake_id))["batch"]
    assert (counts["asked"], counts["answered"]) == (2, 1)
    [card] = [
        c
        for c in (await batch(client, ctx, intake_id))["questions"]
        if c["question"]["id"] == ids[0]
    ]
    assert [a["kind"] for a in card["answers"]] == ["dont_know", "answer"]


async def test_dont_know_on_a_delegated_question_stays_with_the_delegate(client):
    """protects=an "I don't know" from the person a question was delegated to keeps it
    delegated to them (still open); fails_when=it counts answered or moves back to merely
    asked; no_claim=who is asked next."""
    ctx = await company()
    intake_id, ids = await _brief(client, ctx)
    approver = str(ctx.users["approver"].id)
    await answer(client, ctx, ids[0], "commenter", kind="delegate", delegated_to=approver)
    out = await answer(client, ctx, ids[0], "approver", kind="dont_know")
    assert out["question"]["status"] == "delegated"
    counts = (await summary(client, ctx, intake_id))["batch"]
    assert (counts["asked"], counts["answered"]) == (3, 0)


async def test_dont_know_on_a_deferred_or_researched_question_asks_it_again(client):
    """protects=an "I don't know" on a deferred or researching question puts it back to asked
    (open, in the Inbox), never answered; fails_when=it counts answered or stays deferred or
    researching; no_claim=what the research run finds."""
    ctx = await company()
    intake_id, ids = await _brief(client, ctx)
    await answer(client, ctx, ids[0], "commenter", kind="defer")
    await answer(client, ctx, ids[1], "commenter", kind="research")
    for qid in ids[:2]:
        out = await answer(client, ctx, qid, "commenter", kind="dont_know")
        assert out["question"]["status"] == "asked"
        assert out["gap"]["status"] == "unknown"
    counts = (await summary(client, ctx, intake_id))["batch"]
    assert (counts["asked"], counts["answered"]) == (3, 0)
    assert set(ids[:2]) <= {r["question"]["id"] for r in await inbox(client, ctx, "commenter")}


async def test_the_same_person_says_i_dont_know_once(client):
    """protects=once a person's latest answer to a still-open question is their own "I don't
    know", they are not offered it again and another one is refused, so the ledger keeps one
    row; anyone else may still say it, and after another answer they may again;
    fails_when=a repeat adds a ledger row or the Inbox still offers it;
    no_claim=the web (the Playwright spec)."""
    ctx = await company()
    intake_id, ids = await _brief(client, ctx)
    await answer(client, ctx, ids[0], "commenter", kind="dont_know")
    [row] = [r for r in await inbox(client, ctx, "commenter") if r["question"]["id"] == ids[0]]
    assert "dont_know" not in row["answer_paths"] and "answer" in row["answer_paths"]
    await answer(client, ctx, ids[0], "commenter", expect=409, kind="dont_know")
    await answer(client, ctx, ids[0], "approver", kind="dont_know")
    [card] = [
        c
        for c in (await batch(client, ctx, intake_id))["questions"]
        if c["question"]["id"] == ids[0]
    ]
    assert [a["kind"] for a in card["answers"]] == ["dont_know", "dont_know"]
    # The latest is now someone else's: the first person may say it again.
    await answer(client, ctx, ids[0], "commenter", kind="dont_know")
    # Other questions still offer it.
    [other] = [r for r in await inbox(client, ctx, "commenter") if r["question"]["id"] == ids[1]]
    assert "dont_know" in other["answer_paths"]
