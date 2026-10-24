# ruff: noqa: F811 (the ctx, fake and no_wait fixtures, imported from tests.test_interviews)
"""H9 Pricing input: the pricing interview preset (C3) and its snapshot's pricing object.

A pricing interview's guide is the six fixed questions, with no guide job; its snapshot
carries ``pricing`` with each price as the customer said it or null. Each test's card is
one line: protects / fails_when / no_claim. Made-up names only.
"""

import uuid

from sqlalchemy import select

from oracle.interviews import jobs as interview_jobs
from oracle.interviews.service import PRICING_GUIDE
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.tenancy import tenant_session
from tests.test_interviews import (  # noqa: F401  (fixtures)
    ask,
    create,
    ctx,
    fake,
    get,
    invited,
    no_wait,
    open_link,
    say,
)

PRICING = {
    "preset": "pricing",
    "interviewee_name": "Rowan Example",
    "interviewee_company": "Account 14",
    "subject": {"topic": "Pricing of the reorder module"},
}
TOO_EXPENSIVE = "Above 90 euros a month per clinic we would not look at it."
SNAPSHOT = {"quick_facts": [], "quotes": [], "needs": [], "insights": []}


def _pricing(**said) -> dict:
    return {
        "too_cheap": None,
        "bargain": None,
        "expensive": None,
        "too_expensive": None,
        "currency": None,
        "budget_owner": None,
        "replaces": None,
    } | said


async def pricing_link(client, ctx) -> tuple[dict, str]:
    iv = await create(client, ctx, **PRICING)
    resp = await client.post(f"/v1/interviews/{iv['id']}/link", headers=ctx.as_("commenter"))
    assert resp.status_code == 201, resp.text
    return iv, resp.json()["url"].rsplit("/i/", 1)[1]


async def answer_and_finish(client, fake, token: str, answers: list[str]) -> None:
    _, cookie = await open_link(client, token)
    for body in answers:
        ask(fake)
        await say(client, token, cookie, body)
    done = await client.post(f"/v1/public/interviews/{token}/finish", headers=cookie)
    assert done.status_code == 200, done.text


def test_a_price_is_kept_only_when_its_numbers_were_said():
    """protects=the no-invention guard on prices; fails_when=a price with a number the
    customer never wrote, a price without a number or a non-string value is kept, or a
    thousands separator breaks a said price; no_claim=that the customer meant it."""
    said = ["Maybe 1,200 a year, and anything under 5 feels suspicious.", "Finance signs."]
    got = interview_jobs.pricing(
        {
            "too_cheap": "under 5",
            "bargain": "about 300",
            "expensive": "1200 a year",
            "too_expensive": "a lot",
            "currency": 12,
            "budget_owner": "  Finance  ",
            "replaces": "",
        },
        said,
    )
    assert got == _pricing(too_cheap="under 5", expensive="1200 a year", budget_owner="Finance")
    assert interview_jobs.pricing("not an object", said) == _pricing()


async def test_a_pricing_interview_gets_the_six_questions_and_no_guide_job(client, ctx):
    """protects=the preset fills the guide with the six fixed questions in order at no
    model cost, the list filter finds it and redraft refuses; fails_when=a question is
    missing or out of order, an interview_guide job is queued, preset is not shown or
    the filter returns another interview; no_claim=the questions' wording on screen."""
    iv = await create(client, ctx, **PRICING)
    assert iv["preset"] == "pricing" and iv["guide_job"] is None
    assert [(q["prompt"], q["purpose"]) for q in iv["guide"]] == list(PRICING_GUIDE)
    assert len({q["id"] for q in iv["guide"]}) == 6
    assert iv["guide"][3]["prompt"] == "At what price would it be too expensive to consider?"
    async with tenant_session(ctx.tenant_id) as s:
        found = await s.scalars(select(LlmJob).where(LlmJob.interview_id == uuid.UUID(iv["id"])))
        assert list(found) == []
    redraft = await client.post(f"/v1/interviews/{iv['id']}/guide", headers=ctx.as_("commenter"))
    assert redraft.status_code == 409 and "fixed" in redraft.json()["detail"]

    plain = await create(client, ctx, interviewee_name="Rowan Example")
    assert plain["preset"] is None and plain["guide_job"]["status"] == "queued"
    listed = await client.get("/v1/interviews?preset=pricing", headers=ctx.as_("viewer"))
    assert listed.status_code == 200
    assert [(i["id"], i["preset"]) for i in listed.json()] == [(iv["id"], "pricing")]
    every = await client.get("/v1/interviews", headers=ctx.as_("viewer"))
    assert {i["id"] for i in every.json()} == {iv["id"], plain["id"]}
    bad = await client.get("/v1/interviews?preset=other", headers=ctx.as_("viewer"))
    assert bad.status_code == 422


async def test_a_team_interview_cannot_take_the_pricing_preset(client, ctx):
    """protects=the preset is for customer interviews only; fails_when=a team interview
    or an unknown preset is created; no_claim=the team interview route."""
    await create(client, ctx, expect=422, kind="team", preset="pricing")
    await create(client, ctx, expect=422, preset="discovery")


async def test_the_snapshot_keeps_a_said_price_and_nulls_the_unsaid(client, ctx, fake, no_wait):
    """protects=the snapshot's pricing object holds what the customer said and null for
    what they did not; fails_when=a stated too-expensive price is lost or an unstated one
    is filled; no_claim=what the real model extracts."""
    iv, token = await pricing_link(client, ctx)
    await answer_and_finish(client, fake, token, ["I have no idea, honestly.", TOO_EXPENSIVE])
    fake.script["interview_snapshot"].append(
        SNAPSHOT | {"pricing": _pricing(too_expensive="Above 90 euros a month per clinic")}
    )
    await worker.run_pending(ctx.tenant_id)
    kind, payload = fake.calls[-1]
    assert kind == "interview_snapshot" and payload["preset"] == "pricing"
    got = await get(client, ctx, iv["id"])
    assert got["snapshot"]["pricing"] == _pricing(too_expensive="Above 90 euros a month per clinic")


async def test_an_invented_price_ends_as_null(client, ctx, fake, no_wait):
    """protects=a price the customer never stated never reaches the snapshot;
    fails_when=the model's invented bargain or too-cheap price is kept, or a non-string
    value survives; no_claim=a misattributed price whose numbers were said."""
    iv, token = await pricing_link(client, ctx)
    await answer_and_finish(client, fake, token, ["I have no idea, honestly.", TOO_EXPENSIVE])
    fake.script["interview_snapshot"].append(
        SNAPSHOT
        | {
            "pricing": _pricing(
                too_cheap="10 euros",
                bargain="45 euros a month",
                too_expensive="90 euros a month",
                currency="euros",
                budget_owner=["the CFO"],
            )
        }
    )
    await worker.run_pending(ctx.tenant_id)
    got = await get(client, ctx, iv["id"])
    assert got["snapshot"]["pricing"] == _pricing(
        too_expensive="90 euros a month", currency="euros"
    )


async def test_a_plain_interview_snapshot_has_no_pricing(client, ctx, fake, no_wait):
    """protects=pricing is written only for a pricing interview; fails_when=a non-pricing
    interview's snapshot carries pricing or its payload names a preset; no_claim=the
    rest of the snapshot (tests/test_interviews.py)."""
    iv, token = await invited(client, ctx, fake, interviewee_name="Rowan Example")
    await answer_and_finish(client, fake, token, [TOO_EXPENSIVE])
    fake.script["interview_snapshot"].append(
        SNAPSHOT | {"pricing": _pricing(too_expensive="Above 90 euros")}
    )
    await worker.run_pending(ctx.tenant_id)
    kind, payload = fake.calls[-1]
    assert kind == "interview_snapshot" and "preset" not in payload
    got = await get(client, ctx, iv["id"])
    assert got["snapshot_job"]["status"] == "succeeded" and "pricing" not in got["snapshot"]
