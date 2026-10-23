"""C3 Interviews, lane 2: team follow-ups on the intake's questions.

A member answering Oracle's questions on the Before drafting page with "Oracle follows
up" on sends each answer through a team turn (``POST /v1/interviews/{id}/turns``) of
their team interview (``POST /v1/intakes/{id}/interview``). Oracle reads the answer
against the gap's stop condition and asks at most one follow-up; the reply, or the
first answer when the member skips, is recorded through the existing answer path.

Each test's card is one line: protects / fails_when / no_claim. Synthetic placeholders
only.
"""

import asyncio
import time
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update

from oracle.interviews import turns
from oracle.interviews.models import Interview, InterviewMessage
from oracle.llm import gateway
from oracle.tenancy import tenant_session
from oracle.v2.models import StakeholderAnswer
from tests.baseline_helpers import make_ctx
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import company, create_intake
from tests.test_llm_jobs import FakeClaude

THIN = "Clinics."
REPLY = "Small clinics first."
FULL = "Small clinics with one front desk, confirmed by the head of operations last week."


@pytest.fixture
async def ctx():
    return await company()


@pytest.fixture
async def fake(ctx):
    claude = FakeClaude()
    previous = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    yield claude
    gateway.set_transports(previous)


async def intake_and_questions(client, ctx) -> tuple[str, list[dict]]:
    """An intake of the commenter's and the questions asked of them (with a gap each)."""
    out = await create_intake(client, ctx, "commenter")
    intake_id = out["intake"]["id"]
    resp = await client.get(
        "/v1/questions",
        params={"intake_id": intake_id, "status": "asked", "limit": 500},
        headers=ctx.as_("viewer"),
    )
    assert resp.status_code == 200, resp.text
    asked = [q for q in resp.json() if q["gap_id"]]
    assert len(asked) >= 2
    return intake_id, asked


async def team_interview(client, ctx, intake_id: str, who: str = "commenter", expect=200):
    resp = await client.post(f"/v1/intakes/{intake_id}/interview", headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def turn(client, ctx, iid: str, who: str = "commenter", expect: int = 200, **body):
    resp = await client.post(f"/v1/interviews/{iid}/turns", json=body, headers=ctx.as_(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


def follow_up(fake: FakeClaude, text: str | None = "Which segment comes first if you pick one?"):
    fake.script["interview_team_turn"].append({"ack": "Thanks.", "follow_up": text})


async def answers_of(ctx, question_id: str) -> list[StakeholderAnswer]:
    async with tenant_session(ctx.tenant_id) as db:
        return list(
            await db.scalars(
                select(StakeholderAnswer).where(StakeholderAnswer.question_id == question_id)
            )
        )


async def test_team_interview_is_one_per_person_and_intake(client, ctx):
    """protects=each member has one team interview per intake (its transcript);
    fails_when=a second call makes another, a viewer opens one, or an unknown intake
    answers; no_claim=the web page calls it."""
    intake_id, _ = await intake_and_questions(client, ctx)
    first = await team_interview(client, ctx, intake_id)
    assert first["kind"] == "team" and first["status"] == "in_progress"
    assert first["intake_id"] == intake_id and first["messages"] == []
    again = await team_interview(client, ctx, intake_id)
    assert again["id"] == first["id"]
    other = await team_interview(client, ctx, intake_id, "approver")
    assert other["id"] != first["id"]
    await team_interview(client, ctx, intake_id, "viewer", expect=403)
    await team_interview(client, ctx, "00000000-0000-0000-0000-000000000001", expect=404)


async def test_thin_answer_gets_one_follow_up_and_the_reply_records_both(client, ctx, fake):
    """protects=criterion 9: one follow-up when the answer misses the stop condition,
    then one answer joining both messages; fails_when=no follow-up, a second
    follow-up, two answers, or the reply alone is recorded; no_claim=what the real
    model judges thin."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    q = asked[0]
    follow_up(fake)
    first = await turn(client, ctx, iv["id"], question_id=q["id"], body=THIN)
    assert first["recorded"] is None and first["next_question_id"] is None
    oracle = [m for m in first["messages"] if m["role"] == "oracle"]
    assert [(m["kind"], m["body"]) for m in oracle] == [
        ("follow_up", "Which segment comes first if you pick one?")
    ]
    assert oracle[0]["question_id"] == q["id"]
    # The call reads the gap's statement and stop condition, and the answer.
    kind, payload = fake.calls[-1]
    assert kind == "interview_team_turn"
    assert payload["gap"]["stop_condition"] and payload["gap"]["statement"]
    assert payload["conversation"] == [{"role": "interviewee", "body": THIN}]
    assert await answers_of(ctx, q["id"]) == []

    # A second thin reply records anyway, without another call.
    calls = len(fake.calls)
    follow_up(fake)
    second = await turn(client, ctx, iv["id"], question_id=q["id"], body=REPLY)
    assert len(fake.calls) == calls
    assert not [m for m in second["messages"] if m["kind"] == "follow_up"]
    recorded = second["recorded"]
    assert recorded["answer"]["kind"] == "answer"
    assert recorded["answer"]["body"] == f"{THIN}\n\n{REPLY}"
    assert recorded["answer"]["knowledge_state"] == "user_decision"
    assert recorded["question"]["status"] == "answered"
    assert len(await answers_of(ctx, q["id"])) == 1
    # Then the next question asked of this person.
    assert second["next_question_id"] in {a["id"] for a in asked[1:]}

    # The transcript keeps the answer, the follow-up and the reply.
    shown = await team_interview(client, ctx, intake_id)
    assert [(m["role"], m["kind"]) for m in shown["messages"] if m["kind"] != "closing"] == [
        ("interviewee", "answer"),
        ("oracle", "follow_up"),
        ("interviewee", "answer"),
    ]
    assert all(m["question_id"] == q["id"] for m in shown["messages"])
    # The call's model and cost are on Oracle's message.
    async with tenant_session(ctx.tenant_id) as db:
        row = await db.scalar(
            select(InterviewMessage).where(
                InterviewMessage.interview_id == iv["id"], InterviewMessage.kind == "follow_up"
            )
        )
        assert row.model and row.usage and row.cost_usd is not None


async def test_skip_records_the_first_answer(client, ctx, fake):
    """protects=Skip, record my answer records what was written; fails_when=skip
    records nothing, asks again or calls the model; no_claim=the button's label."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    q = asked[0]
    follow_up(fake)
    await turn(client, ctx, iv["id"], question_id=q["id"], body=THIN)
    calls = len(fake.calls)
    out = await turn(client, ctx, iv["id"], question_id=q["id"], skip_follow_up=True)
    assert len(fake.calls) == calls
    assert out["recorded"]["answer"]["body"] == THIN
    assert len(await answers_of(ctx, q["id"])) == 1


async def test_answer_meeting_the_stop_condition_records_at_once(client, ctx, fake):
    """protects=a full answer is not followed up; fails_when=a follow-up is posted or
    nothing is recorded; no_claim=the model's judgement."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    q = asked[0]
    follow_up(fake, None)
    out = await turn(client, ctx, iv["id"], question_id=q["id"], body=FULL)
    assert not [m for m in out["messages"] if m["kind"] == "follow_up"]
    assert out["recorded"]["answer"]["body"] == FULL
    assert out["next_question_id"] in {a["id"] for a in asked[1:]}


async def test_turn_past_the_deadline_records_the_answer_as_written(client, ctx, fake, monkeypatch):
    """protects=criterion 10: a slow model never loses the answer; fails_when=the turn
    hangs, errors or records nothing, or the note is missing; no_claim=the real
    25-second figure (the deadline is shortened here)."""
    monkeypatch.setattr(turns, "DEADLINE_SECONDS", 0.05)

    async def slow(kind, payload):
        await asyncio.sleep(1)

    fake.on_call = slow
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    out = await turn(client, ctx, iv["id"], question_id=asked[0]["id"], body=THIN)
    assert out["recorded"]["answer"]["body"] == THIN
    notes = [m["body"] for m in out["messages"] if m["role"] == "oracle"]
    assert notes == ["Oracle could not follow up; your answer is saved."]


async def test_only_the_interviewee_takes_team_turns(client, ctx, fake):
    """protects=a team turn answers as its own interviewee only, on its intake's
    questions; fails_when=someone else answers through another's interview, a customer
    interview takes team turns, or an empty answer is sent; no_claim=the existing
    answer path's own rules (tested with it)."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    q = asked[0]["id"]
    await turn(client, ctx, iv["id"], "approver", expect=403, question_id=q, body=FULL)
    await turn(client, ctx, iv["id"], expect=422, question_id=q, body="   ")
    other_intake, other = await intake_and_questions(client, ctx)
    await turn(client, ctx, iv["id"], expect=404, question_id=other[0]["id"], body=FULL)
    resp = await client.post(
        "/v1/interviews",
        json={"interviewee_name": "Ana Lima", "subject": {"topic": "Reordering"}},
        headers=ctx.as_("commenter"),
    )
    assert resp.status_code == 201, resp.text
    await turn(client, ctx, resp.json()["id"], expect=409, question_id=q, body=FULL)
    assert not [k for k, _ in fake.calls if k == "interview_team_turn"]


async def test_a_burst_of_team_turns_never_holds_the_pool_for_other_companies(client, ctx, fake):
    """protects=the shared connection pool (fifth review of #380): a team turn claims
    the turn and commits, calls the model with no session or row lock held, then writes
    the result; one turn per interview runs at a time; fails_when=20 concurrent turns
    on one interview stall a member route of another company, or more than one turn
    reaches the model; no_claim=a real model's latency (the fake call waits until the
    member route has answered)."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    other = await make_ctx("Other Co")
    in_flight, release = asyncio.Event(), asyncio.Event()

    async def slow(kind, _payload):
        if kind == "interview_team_turn":
            in_flight.set()
            await release.wait()

    fake.on_call = slow
    follow_up(fake)
    burst = asyncio.gather(
        *(
            client.post(
                f"/v1/interviews/{iv['id']}/turns",
                json={"question_id": asked[0]["id"], "body": f"Answer {i}"},
                headers=ctx.as_("commenter"),
            )
            for i in range(20)
        )
    )
    try:
        await asyncio.wait_for(in_flight.wait(), 10)
        await asyncio.sleep(0.5)  # the rest of the burst arrives while the call runs
        started = time.monotonic()
        member = await asyncio.wait_for(
            client.get("/v1/interviews", headers=other.as_("viewer")), 5
        )
        assert member.status_code == 200, member.text
        assert time.monotonic() - started < 2
    finally:
        release.set()
        replies = await burst
    codes = sorted(r.status_code for r in replies)
    assert codes == [200] + [429] * 19, codes
    assert sum(1 for kind, _ in fake.calls if kind == "interview_team_turn") == 1
    # The one turn's answer and Oracle's follow-up, nothing of the refused ones.
    shown = await team_interview(client, ctx, intake_id)
    assert [(m["role"], m["kind"]) for m in shown["messages"]] == [
        ("interviewee", "answer"),
        ("oracle", "follow_up"),
    ]


async def test_a_team_turn_waits_for_another_instances_turn(client, ctx, fake):
    """protects=one team turn per interview across API instances (the claim is on the
    interview row); fails_when=a turn runs while another's claim is fresh, or the claim
    is left behind after a turn; no_claim=a second process (its claim is written to
    the row as that instance would)."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    async with tenant_session(ctx.tenant_id) as db:
        await db.execute(
            update(Interview)
            .where(Interview.id == uuid.UUID(iv["id"]))
            .values(turn_started_at=datetime.now(UTC))
        )
        await db.commit()
    await turn(client, ctx, iv["id"], expect=429, question_id=asked[0]["id"], body=FULL)
    assert not [k for k, _ in fake.calls if k == "interview_team_turn"]
    async with tenant_session(ctx.tenant_id) as db:
        await db.execute(
            update(Interview)
            .where(Interview.id == uuid.UUID(iv["id"]))
            .values(turn_started_at=None)
        )
        await db.commit()
    follow_up(fake, None)
    out = await turn(client, ctx, iv["id"], question_id=asked[0]["id"], body=FULL)
    assert out["recorded"]["answer"]["body"] == FULL
    async with tenant_session(ctx.tenant_id) as db:
        row = await db.get(Interview, uuid.UUID(iv["id"]))
        assert row.turn_started_at is None


async def test_a_turn_right_after_the_claim_is_released_never_races_its_writes(
    client, ctx, fake, monkeypatch
):
    """protects=the turn claim (re-review of #397): it is released only after the turn's
    writes are committed, so a second turn sent the moment it is released (a
    double-click, a second tab) reads them; fails_when=the second turn is a 500
    (StaleDataError), records a second answer, or reaches the model; no_claim=a real
    browser's timing (the second turn is sent from inside the release)."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    q = asked[0]["id"]
    release = turns.release_turn
    second: list[asyncio.Task] = []

    async def send_again():
        try:
            return await client.post(
                f"/v1/interviews/{iv['id']}/turns",
                json={"question_id": q, "body": FULL},
                headers=ctx.as_("commenter"),
            )
        except Exception as e:  # the app's exception, raised through the transport
            return e

    async def released_then_second_turn(tenant_id, interview_id, at):
        await release(tenant_id, interview_id, at)
        if not second:
            second.append(asyncio.create_task(send_again()))
            await asyncio.sleep(0.5)  # the second turn runs before the first returns

    monkeypatch.setattr(turns, "release_turn", released_then_second_turn)
    follow_up(fake, None)
    first = await turn(client, ctx, iv["id"], question_id=q, body=FULL)
    assert first["recorded"]["answer"]["body"] == FULL
    again = await second[0]
    assert not isinstance(again, Exception), repr(again)
    assert again.status_code in (409, 429), again.text
    assert len(await answers_of(ctx, q)) == 1
    assert sum(1 for kind, _ in fake.calls if kind == "interview_team_turn") == 1
