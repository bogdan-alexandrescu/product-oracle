"""Build prompt §10 (03b §5): learnings kept from outcomes tune later module and question
recommendations. A module a learning recommends is suggested with a visible
"Recommended because ..." reason; a question category it recommends is asked earlier,
its rationale saying why; the effect is capped so one signal never outweighs a gap's
importance; retired learnings stop counting. Against Postgres. Made-up names only.

Every test states its card: protects (the observable), fails_when (the wrong result
it rejects), no_claim (what green does not prove)."""

import uuid

from sqlalchemy import select

from oracle.intake import categories as cats
from oracle.quality.learned import LEARNING_CAP
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from tests.intake_helpers import create_intake
from tests.modules.helpers import seeded_ctx

BRAND = "platform.brand-governance"
TOOLS = "agents.tool-policies"


async def _learn(client, ctx, applies_to, target, direction="recommend_more", weight=1, text=None):
    resp = await client.post(
        "/v1/learnings",
        json={
            "applies_to": applies_to,
            "target": target,
            "direction": direction,
            "weight": weight,
            "statement": text or f"Past outcomes say: {direction} {target}.",
        },
        headers=ctx.as_("approver"),
    )
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


async def _retire(client, ctx, learning_id):
    resp = await client.post(
        f"/v1/learnings/{learning_id}/retire", json={"reason": "No longer true"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text


async def _agent_intake(ctx) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        intake = ProductIntake(
            title="Agent tool permissions",
            brief="Let each customer configure which tools their agents may call, with "
            "multi-tenant isolation of tool credentials.",
            source_snapshot_ids=[uuid.uuid4()],
            analysis={"category": "ai_agent_platform", "scope": ["tool calling permissions"]},
        )
        s.add(intake)
        await s.commit()
        return intake.id


async def _recommend(client, ctx, intake_id) -> dict:
    resp = await client.post(
        "/v1/compositions/recommend",
        json={"intake_id": str(intake_id), "template": "prd-rfc"},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 200, resp.text
    return {m["key"]: m for m in resp.json()["modules"]}


async def test_a_learning_suggests_a_module_and_says_why(client):
    """protects=a kept recommend_more learning on an optional module makes the
    recommendation suggest it, decided by the learning, with "Recommended because" and
    the learning's words; fails_when=the module stays optional, or the reason does not
    say why; no_claim=a person's decision (it always wins, test_prior_decisions)."""
    ctx = await seeded_ctx()
    intake_id = await _agent_intake(ctx)
    before = (await _recommend(client, ctx, intake_id))[BRAND]
    assert before["selection"] == "optional" and not before["included"]

    lid = await _learn(client, ctx, "module", BRAND, text="Brand rules caught launch rework twice.")
    after = (await _recommend(client, ctx, intake_id))[BRAND]
    assert after["selection"] == "suggested" and after["included"]
    assert after["decided_by"] == "learning"
    assert after["reason"].startswith("Recommended because")
    assert "Brand rules caught launch rework twice." in after["reason"]
    assert any("Recommended because" in line for line in after["explanation"])

    # Retired learnings stop counting.
    await _retire(client, ctx, lid)
    again = (await _recommend(client, ctx, intake_id))[BRAND]
    assert again["selection"] == "optional" and not again["included"]
    assert not any("Recommended" in line for line in again["explanation"])


async def test_a_learning_never_overrides_policy_or_a_condition(client):
    """protects=the cap: a recommend_less learning, however heavy, never drops a mandatory
    module or one its condition suggests; it only explains and lowers the advisory score,
    by at most the cap; fails_when=a learning removes a module, or its score moves more
    than the cap; no_claim=how the score is shown."""
    ctx = await seeded_ctx()
    intake_id = await _agent_intake(ctx)
    before = await _recommend(client, ctx, intake_id)
    mandatory = next(k for k, m in before.items() if m["selection"] == "mandatory")
    for target in (TOOLS, mandatory):
        for _ in range(3):
            await _learn(client, ctx, "module", target, "recommend_less", 3)
    after = await _recommend(client, ctx, intake_id)
    tools = after[TOOLS]
    assert tools["selection"] == "suggested" and tools["included"]
    assert any(line.startswith("Recommended less because") for line in tools["explanation"])
    assert before[TOOLS]["score"] - tools["score"] <= LEARNING_CAP + 1e-9
    assert after[mandatory]["selection"] == "mandatory" and after[mandatory]["included"]


async def _drafts(ctx, intake_id: str) -> list[StakeholderQuestion]:
    async with tenant_session(ctx.tenant_id) as s:
        rows = await s.scalars(
            select(StakeholderQuestion)
            .where(StakeholderQuestion.intake_id == uuid.UUID(intake_id))
            .order_by(StakeholderQuestion.priority)
        )
        return list(rows)


async def _scores(ctx, intake_id: str) -> dict[str, float]:
    async with tenant_session(ctx.tenant_id) as s:
        gaps = await s.scalars(
            select(KnowledgeGap).where(KnowledgeGap.intake_id == uuid.UUID(intake_id))
        )
        return {
            g.category: cats.rank_score(g.importance, list(g.impact), g.knowledge_state, None)
            for g in gaps
        }


async def test_a_learning_moves_a_question_up_and_says_why(client):
    """protects=a recommend_more learning on a question category asks its question before
    a tied one in a later intake, and its rationale says "Recommended because" with the
    learning's words; a retired learning stops counting; fails_when=the order or the
    rationale ignores the learning; no_claim=questions already asked (never re-ranked)."""
    ctx = await seeded_ctx()
    first = await create_intake(client, ctx, ai_extraction=False)
    order = [q.category for q in await _drafts(ctx, first["intake"]["id"])]
    scores = await _scores(ctx, first["intake"]["id"])
    # The first category tied on score with the one ranked just above it.
    i = next(i for i in range(1, len(order)) if scores[order[i]] == scores[order[i - 1]])
    late, early = order[i], order[i - 1]

    lid = await _learn(
        client, ctx, "question_category", late, text="Asking this early saved a rewrite."
    )
    second = await create_intake(client, ctx, ai_extraction=False)
    drafts = await _drafts(ctx, second["intake"]["id"])
    tuned = [q.category for q in drafts]
    assert tuned.index(late) < tuned.index(early)
    asked = next(q for q in drafts if q.category == late)
    assert "Recommended because" in asked.rationale
    assert "Asking this early saved a rewrite." in asked.rationale
    other = next(q for q in drafts if q.category == early)
    assert "Recommended" not in other.rationale

    await _retire(client, ctx, lid)
    third = await create_intake(client, ctx, ai_extraction=False)
    plain = [q.category for q in await _drafts(ctx, third["intake"]["id"])]
    assert plain.index(early) < plain.index(late)


async def test_one_signal_never_outweighs_importance(client):
    """protects=the cap: however many learnings recommend a category, its question never
    jumps a gap whose expected effect is more than the cap above its own, and a
    recommend_less learning never drops it below one more than the cap below;
    fails_when=one heavy signal dominates the ranking; no_claim=the cap's exact size."""
    ctx = await seeded_ctx()
    probe = await create_intake(client, ctx, ai_extraction=False)
    scores = await _scores(ctx, probe["intake"]["id"])
    order = [q.category for q in await _drafts(ctx, probe["intake"]["id"])]
    up, down = order[-1], order[0]
    for _ in range(3):
        await _learn(client, ctx, "question_category", up, "recommend_more", 3)
        await _learn(client, ctx, "question_category", down, "recommend_less", 3)
    later = await create_intake(client, ctx, ai_extraction=False)
    tuned = [q.category for q in await _drafts(ctx, later["intake"]["id"])]
    # The furthest any two gaps' scores can move apart: one up by the cap, one down.
    spread = (1 + LEARNING_CAP) / (1 - LEARNING_CAP)
    for other, score in scores.items():
        if score > scores[up] * spread:
            assert tuned.index(other) < tuned.index(up), other
        if score * spread < scores[down]:
            assert tuned.index(down) < tuned.index(other), other


READERS = ("author", "viewer", "commenter", "run")


async def _read_order(client, ctx, intake_id: str, who: str) -> tuple[list, list]:
    """(asked questions' categories, drafts' categories) in the order ``who`` reads them,
    from the question list and the latest batch alike."""
    from tests.test_intake_sharing_writes import headers

    resp = await client.get(
        "/v1/questions", params={"intake_id": intake_id, "limit": 500}, headers=headers(ctx, who)
    )
    assert resp.status_code == 200, resp.text
    listed = sorted(resp.json(), key=lambda q: (q["priority"], q["created_at"]))
    out = (
        [q["category"] for q in listed if q["status"] not in ("draft", "withdrawn")],
        [q["category"] for q in listed if q["status"] == "draft"],
    )
    resp = await client.get(f"/v1/intakes/{intake_id}/question-batch", headers=headers(ctx, who))
    assert resp.status_code == 200, resp.text
    asked = [c["question"]["category"] for c in resp.json()["questions"]]
    assert asked == [c for c in out[0] if c in asked], (who, asked, out[0])
    return out


async def _stored_asked(ctx, intake_id: str) -> list[str]:
    return [
        q.category for q in await _drafts(ctx, intake_id) if q.status not in ("draft", "withdrawn")
    ]


async def test_asked_questions_keep_one_order_for_every_reader(client):
    """protects=03b §5 "asked questions are never re-ranked": after an approver adds and
    then retires learnings, the asked questions read in the same order by the author, a
    viewer, a commenter and a run token, the stored order; a draft moves only at the
    next sync; fails_when=reads by anyone but the author re-rank asked questions from
    the learnings in force now; no_claim=which drafts are asked next."""
    from tests.test_intake_sharing import add_author

    ctx = await seeded_ctx()
    await add_author(ctx)
    intake = await create_intake(client, ctx, "author", ai_extraction=False)
    iid = intake["intake"]["id"]
    resp = await client.post(
        f"/v1/intakes/{iid}/question-batches", json={"size": 5}, headers=ctx.as_("author")
    )
    assert resp.status_code == 200, resp.text
    stored = await _stored_asked(ctx, iid)
    assert len(stored) >= 3
    drafts_before = (await _read_order(client, ctx, iid, "author"))[1]
    assert len(drafts_before) >= 2
    for who in READERS:
        assert (await _read_order(client, ctx, iid, who))[0] == stored, who

    # Learnings that, applied to asked questions, would turn their order around; and one
    # that lifts the last draft.
    ids = [
        await _learn(client, ctx, "question_category", stored[-1], "recommend_more", 3),
        await _learn(client, ctx, "question_category", stored[0], "recommend_less", 3),
        await _learn(client, ctx, "question_category", drafts_before[-1], "recommend_more", 3),
    ]
    for who in READERS:
        asked, drafts = await _read_order(client, ctx, iid, who)
        assert asked == stored, (who, asked)
        assert drafts == drafts_before, (who, drafts)
    waiting = next(q for q in await _drafts(ctx, iid) if q.category == drafts_before[-1])
    assert "Recommended" not in waiting.rationale

    for lid in ids[:2]:
        await _retire(client, ctx, lid)
    for who in READERS:
        assert (await _read_order(client, ctx, iid, who))[0] == stored, who

    # The next sync moves the draft; the asked questions keep their order for everyone.
    resp = await client.post(f"/v1/intakes/{iid}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    assert await _stored_asked(ctx, iid) == stored
    orders = {who: await _read_order(client, ctx, iid, who) for who in READERS}
    for who, (asked, drafts) in orders.items():
        assert asked == stored, (who, asked)
        assert drafts == orders["author"][1], (who, drafts)
    lifted = next(q for q in await _drafts(ctx, iid) if q.category == drafts_before[-1])
    assert "Recommended because" in lifted.rationale
