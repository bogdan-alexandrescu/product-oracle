"""Shared setup for the intake tests (CR-03): a company, one source item, an intake.

Synthetic placeholders only.
"""

from typing import Any

from tests.baseline_helpers import Ctx, make_ctx, make_item
from tests.conftest import seed_company

BRIEF = (
    "Returning buyers retype their shipping address at every checkout. "
    "Add saved addresses so returning buyers check out faster."
)
PAIN = (
    "Support thread: returning buyers complain that retyping the shipping address at "
    "checkout is slow, and several abandon the cart."
)

# The seventeen question categories of build prompt §5.
CATEGORIES = {
    "customer_user",
    "pain_evidence",
    "goal_alignment",
    "success_metric",
    "differentiation",
    "alternatives",
    "constraints",
    "blockers",
    "economic_benefit",
    "effort_cost",
    "security_privacy",
    "ownership",
    "non_goals",
    "release_rollout",
    "evaluation_criteria",
    "third_party_policy",
    "configurability_scaling",
}


async def company(name: str = "Example Co") -> Ctx:
    return await make_ctx(name)


async def create_intake(
    client, ctx: Ctx, who: str = "commenter", expect: int = 201, **body: Any
) -> dict:
    body.setdefault("title", "Saved addresses")
    body.setdefault("brief", BRIEF)
    body.setdefault("ai_extraction", False)
    # The template hint reads the built-in templates, seeded at startup and when a
    # company is created (reads never seed).
    await seed_company(ctx.tenant_id)
    resp = await client.post("/v1/intakes", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def intake_with_source(client, ctx: Ctx, who: str = "commenter", **body: Any) -> dict:
    """An intake from the short brief plus one source item of ``who``."""
    await make_item(ctx, who, content=PAIN, title="#support thread")
    return await create_intake(client, ctx, who, **body)


def gaps_by_category(summary: dict) -> dict[str, dict]:
    return {g["category"]: g for g in summary["gaps"]}


async def summary(client, ctx: Ctx, intake_id: str, who: str = "viewer") -> dict:
    resp = await client.get(f"/v1/intakes/{intake_id}/summary", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def batch(client, ctx: Ctx, intake_id: str, who: str = "viewer") -> dict:
    resp = await client.get(f"/v1/intakes/{intake_id}/question-batch", headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


def question_for(batch_or_list: dict | list, category: str) -> dict:
    cards = batch_or_list["questions"] if isinstance(batch_or_list, dict) else batch_or_list
    for card in cards:
        if card["question"]["category"] == category:
            return card["question"]
    raise AssertionError(f"no {category} question in {[c['question']['category'] for c in cards]}")


async def answer(
    client, ctx: Ctx, question_id: str, who: str = "commenter", expect: int = 201, **body: Any
) -> dict:
    body.setdefault("kind", "answer")
    resp = await client.post(
        f"/v1/questions/{question_id}/answers", json=body, headers=ctx.as_(who)
    )
    assert resp.status_code == expect, resp.text
    return resp.json()


async def all_questions(client, ctx: Ctx, intake_id: str) -> list[dict]:
    resp = await client.get(
        "/v1/questions", params={"intake_id": intake_id, "limit": 500}, headers=ctx.as_("viewer")
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def ask_of(client, ctx: Ctx, question_id: str, who: str, by: str = "approver") -> dict:
    """Ask ``who`` the question instead (C2: a batch asks the intake's author by
    default, and only the person asked or an approver answers)."""
    resp = await client.patch(
        f"/v1/questions/{question_id}",
        json={"asked_to": str(ctx.users[who].id)},
        headers=ctx.as_(by),
    )
    assert resp.status_code == 200, resp.text
    return resp.json()
