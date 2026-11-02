"""walk-brief review, item 6: the brief's critical line, read right after each answer.

protects=the summary the brief's side panel reads says each answer at once: an owner's
answer to a critical question takes one off "Critical open" in the very next read, and a
commenter's answer leaves it counted, its gap "answered_pending_review" (B4: an answer
below the owner never clears a critical gap on its own; the panel says "Answered: waiting
for review"); fails_when=the summary keeps a recorded answer out of its next read (the
panel one answer behind); no_claim=Oracle's follow-up reply, which production records with
the answer.
"""

from tests.intake_helpers import (
    answer,
    batch,
    company,
    gaps_by_category,
    intake_with_source,
    question_for,
    summary,
)


async def _criticals(client, ctx, intake_id: str) -> list[dict]:
    """The critical questions of the brief's current batch, as the panel asks them."""
    gaps = gaps_by_category(await summary(client, ctx, intake_id))
    asked = await batch(client, ctx, intake_id)
    return [
        question_for(asked, cat)
        for cat, g in gaps.items()
        if g["importance"] == "critical"
        and any(c["question"]["category"] == cat for c in asked["questions"])
    ]


async def test_the_critical_line_moves_with_each_answer(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    first, second, *_ = await _criticals(client, ctx, intake_id)
    before = (await summary(client, ctx, intake_id))["readiness"]["open_critical"]

    # A commenter's answer: recorded at once, the gap waits for an owner's review.
    await answer(client, ctx, first["id"], body="Example: 95 s today, 45 s by Q3.")
    now = await summary(client, ctx, intake_id)
    assert gaps_by_category(now)[first["category"]]["status"] == "answered_pending_review"
    assert now["readiness"]["open_critical"] == before

    # An owner's answer clears its gap in the very next read, not one answer later.
    await answer(client, ctx, second["id"], who="owner", body="Example: an owner's answer.")
    now = await summary(client, ctx, intake_id)
    assert gaps_by_category(now)[second["category"]]["status"] == "answered"
    assert now["readiness"]["open_critical"] == before - 1
