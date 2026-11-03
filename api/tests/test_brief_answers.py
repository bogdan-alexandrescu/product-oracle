"""brief-answers: the PRD brief's first send saves, Research this really researches,
answered questions count, and accepting research never leaves orphan draft runs.

Each test's card is one line: protects / fails_when / no_claim. Synthetic placeholders
only.
"""

import re
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select

from oracle.baseline.models import Proposal
from oracle.intake import answers as intake_answers
from oracle.interviews import turns as interview_turns
from oracle.llm import gateway
from oracle.runs import service as runs_service
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import ChangeEvent
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import (
    answer,
    ask_of,
    batch,
    company,
    create_intake,
    intake_with_source,
    question_for,
    summary,
)
from tests.test_intake import _document
from tests.test_interviews_team import (
    answers_of,
    follow_up,
    intake_and_questions,
    team_interview,
    turn,
)
from tests.test_llm_jobs import FakeClaude

# About 1,500 characters, as a person writes a long answer.
LONG = ("Small clinics with one front desk and a shared phone line come first. " * 25)[:1500]


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


@pytest.fixture
def runtime():
    fake_runtime = FakeRuntime()
    set_runtime(fake_runtime)
    yield fake_runtime
    set_runtime(None)


# (1) The first send saves.


async def test_a_long_answer_resent_after_a_failed_first_send_is_saved_once(
    client, ctx, fake, monkeypatch
):
    """protects=a send that failed after its text was kept (the turn broke while
    recording) is saved by the second send, once; fails_when=the answer is saved as
    the text twice over, or the second send fails; no_claim=what broke the first."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    q = asked[0]
    real = intake_answers.answer
    calls = {"n": 0}

    async def flaky(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("the first send broke")
        return await real(*args, **kwargs)

    monkeypatch.setattr(intake_answers, "answer", flaky)
    follow_up(fake, None)
    with pytest.raises(RuntimeError):
        await turn(client, ctx, iv["id"], question_id=q["id"], body=LONG)
    follow_up(fake, None)
    out = await turn(client, ctx, iv["id"], question_id=q["id"], body=LONG)
    assert out["recorded"]["answer"]["body"] == LONG
    assert [a.body for a in await answers_of(ctx, q["id"])] == [LONG]


async def test_resending_an_answer_already_saved_says_saved(client, ctx, fake):
    """protects=a first send the browser lost (the API saved it) and sent again reads as
    saved; fails_when=the second send is refused as already answered or saves a second
    copy; no_claim=the proxy's own timeout."""
    intake_id, asked = await intake_and_questions(client, ctx)
    iv = await team_interview(client, ctx, intake_id)
    q = asked[0]
    follow_up(fake, None)
    await turn(client, ctx, iv["id"], question_id=q["id"], body=LONG)
    again = await turn(client, ctx, iv["id"], question_id=q["id"], body=LONG)
    assert again["recorded"]["answer"]["body"] == LONG
    assert again["recorded"]["question"]["status"] == "answered"
    assert len(await answers_of(ctx, q["id"])) == 1


# What recording an answer may take after the model's reply (its proposals, the change
# event, the audit rows), with room to spare.
RECORDING_SECONDS = 60


def test_the_web_proxy_waits_longer_than_a_turn_takes():
    """protects=the web's /v1 proxy (next.config.ts proxyTimeout) waits past a turn's
    model deadline plus recording the answer, so a long answer's first Send answer
    comes back; fails_when=proxyTimeout is missing (Next's 30 s default) or under that;
    no_claim=the network between the browser and the web."""
    config = (Path(__file__).parents[2] / "web" / "next.config.ts").read_text(encoding="utf-8")
    found = re.search(r"proxyTimeout:\s*([\d_]+)", config)
    assert found, "next.config.ts sets no proxyTimeout: Next's 30-second default applies"
    waits = int(found.group(1).replace("_", "")) / 1000
    assert waits > interview_turns.DEADLINE_SECONDS + RECORDING_SECONDS


# (3) An answer closes its question and counts.


async def test_an_answer_oracle_follows_up_on_closes_its_question_and_counts(client, ctx, fake):
    """protects=an answer Oracle follows up on is saved at once: the question is
    answered and counted, its critical gap waiting for review; the reply adds to the same
    answer; fails_when=the question stays asked until the reply, the count stays 0, or
    the reply makes a second answer; no_claim=what the model judges thin."""
    intake_id, asked = await intake_and_questions(client, ctx)
    s = await summary(client, ctx, intake_id)
    gaps = {g["id"]: g for g in s["gaps"]}
    critical = [q for q in asked if gaps[q["gap_id"]]["importance"] == "critical"]
    assert critical
    q = critical[0]
    iv = await team_interview(client, ctx, intake_id)
    follow_up(fake)
    first = await turn(client, ctx, iv["id"], question_id=q["id"], body=LONG)
    assert [m["kind"] for m in first["messages"] if m["role"] == "oracle"] == ["follow_up"]
    assert first["recorded"]["question"]["status"] == "answered"
    after = await summary(client, ctx, intake_id)
    assert after["batch"]["answered"] == 1
    gap = {g["id"]: g for g in after["gaps"]}[q["gap_id"]]
    # Answered: a commenter's answer to a critical question waits for an owner's review
    # (B4), no longer asked.
    assert gap["status"] == "answered_pending_review"
    reply = await turn(client, ctx, iv["id"], question_id=q["id"], body="Front desks first.")
    assert reply["recorded"]["answer"]["body"] == f"{LONG}\n\nFront desks first."
    assert [a.body for a in await answers_of(ctx, q["id"])] == [f"{LONG}\n\nFront desks first."]


# (2) Research this really researches; (4) no orphan draft runs.


async def _research(client, ctx, intake_id: str, category: str) -> dict:
    q = question_for(await batch(client, ctx, intake_id), category)
    result = await answer(client, ctx, q["id"], kind="research")
    [proposal] = [p for p in result["proposals"] if p["kind"] == "research_run"]
    return proposal


async def _runs(ctx, intake_id: str) -> list[Run]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(await s.scalars(select(Run).where(Run.knobs["intake_id"].astext == intake_id)))


async def test_accepting_research_starts_it(client, runtime, ctx):
    """protects=Accept on a research proposal starts the research (estimated and
    started, or waiting for an owner's approval); fails_when=the run is left a draft
    nobody starts; no_claim=what the research finds."""
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    proposal = await _research(client, ctx, intake_id, "goal_alignment")
    resp = await client.post(
        f"/v1/intake-proposals/{proposal['id']}/accept", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["result"]["run_id"]
    run = (await client.get(f"/v1/runs/{run_id}", headers=ctx.as_("viewer"))).json()
    assert run["status"] != "draft"
    assert run["estimate_usd"] is not None
    if run["status"] != "awaiting_approval":
        assert runtime.submitted
    # Starting the research converts nothing: the brief stays open.
    assert (await summary(client, ctx, intake_id))["intake"]["status"] != "converted"


async def test_accepted_research_reuses_the_one_unstarted_draft(client, runtime, ctx, monkeypatch):
    """protects=a PRD keeps at most one unstarted research draft run: a second accepted
    research joins it; fails_when=each accept leaves its own draft run; no_claim=why a
    run could not start."""

    async def refuse(*args, **kwargs):
        raise runs_service.RunError("the estimate is over the budget")

    monkeypatch.setattr(runs_service, "start", refuse)
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    current = await batch(client, ctx, intake_id)
    categories = [c["question"]["category"] for c in current["questions"] if c["gap"]][:2]
    assert len(categories) == 2
    run_ids = set()
    gap_ids = []
    for category in categories:
        proposal = await _research(client, ctx, intake_id, category)
        gap_ids.append(proposal["gap_id"])
        resp = await client.post(
            f"/v1/intake-proposals/{proposal['id']}/accept", headers=ctx.as_("approver")
        )
        assert resp.status_code == 200, resp.text
        run_ids.add(resp.json()["result"]["run_id"])
    assert len(run_ids) == 1
    drafts = [r for r in await _runs(ctx, intake_id) if r.status == "draft"]
    assert len(drafts) == 1
    assert sorted(drafts[0].knobs["intake_gap_ids"]) == sorted(gap_ids)
    assert drafts[0].id == uuid.UUID(run_ids.pop())


# Review findings: the reply reaches the proposals; a refused start says why.


async def test_the_reply_to_a_follow_up_reaches_the_answers_proposals(client, ctx, fake):
    """protects=the reply to Oracle's follow-up reaches the PRD patch and the baseline
    proposal made of the answer, and the change is recorded; fails_when=they keep the
    thin first answer; no_claim=what the model judges thin."""
    doc = await _document(client, ctx)
    out = await create_intake(client, ctx, who="approver", document=doc)
    intake_id = out["intake"]["id"]
    q = question_for(await batch(client, ctx, intake_id), "success_metric")
    await ask_of(client, ctx, q["id"], "commenter")
    iv = await team_interview(client, ctx, intake_id)
    follow_up(fake)
    first = await turn(client, ctx, iv["id"], question_id=q["id"], body="Checkout time.")
    [patch] = [p for p in first["recorded"]["proposals"] if p["kind"] == "prd_patch"]
    [baseline_id] = first["recorded"]["baseline_proposal_ids"]
    reply = await turn(client, ctx, iv["id"], question_id=q["id"], body="95 s to 45 s by Q3.")
    assert reply["recorded"]["answer"]["body"] == "Checkout time.\n\n95 s to 45 s by Q3."
    s = await summary(client, ctx, intake_id)
    patches = [p for p in s["proposals"] if p["kind"] == "prd_patch" and p["status"] == "proposed"]
    assert [p["id"] for p in patches] == [patch["id"]]
    assert "95 s to 45 s by Q3." in patches[0]["detail"]["text"]
    async with tenant_session(ctx.tenant_id) as db:
        proposal = await db.get(Proposal, uuid.UUID(baseline_id))
        assert "95 s to 45 s by Q3." in proposal.payload["fields"]["body"]
        changes = (
            await db.scalars(
                select(ChangeEvent).where(ChangeEvent.subject_id == uuid.UUID(q["gap_id"]))
            )
        ).all()
        assert any(c.cause == "intake_answer:amended" for c in changes)


async def test_a_reply_after_an_owners_review_waits_for_review_again(client, ctx, fake):
    """protects=a commenter's reply that changes a critical answer an owner already
    reviewed puts its gap back to waiting for an owner's review (B4); fails_when=the
    changed answer stays reviewed; no_claim=how the owner reviews it in the web."""
    intake_id, asked = await intake_and_questions(client, ctx)
    gaps = {g["id"]: g for g in (await summary(client, ctx, intake_id))["gaps"]}
    q = next(x for x in asked if gaps[x["gap_id"]]["importance"] == "critical")
    iv = await team_interview(client, ctx, intake_id)
    follow_up(fake)
    await turn(client, ctx, iv["id"], question_id=q["id"], body=LONG)
    # The owner reviews the answer and validates the gap.
    resp = await client.post(
        f"/v1/gaps/{q['gap_id']}/decisions",
        json={"decision": "validate", "rationale": "Reviewed with the team."},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    await turn(client, ctx, iv["id"], question_id=q["id"], body="Front desks first.")
    gap = {g["id"]: g for g in (await summary(client, ctx, intake_id))["gaps"]}[q["gap_id"]]
    assert gap["status"] == "answered_pending_review"


async def test_a_research_run_that_cannot_start_says_why(client, runtime, ctx, monkeypatch):
    """protects=when Accept cannot start the research, the proposal keeps the reason
    (result.start_error) for the brief and the question to show; fails_when=Accept
    answers 200 with nothing saying the run is a draft nobody started; no_claim=the
    run page's own Estimate and Start."""

    async def refuse(*args, **kwargs):
        raise runs_service.RunError("no Claude account is registered")

    monkeypatch.setattr(runs_service, "start", refuse)
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    proposal = await _research(client, ctx, intake_id, "goal_alignment")
    resp = await client.post(
        f"/v1/intake-proposals/{proposal['id']}/accept", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["result"]["start_error"] == "no Claude account is registered"
    [listed] = [
        p for p in (await summary(client, ctx, intake_id))["proposals"] if p["id"] == proposal["id"]
    ]
    assert listed["result"]["start_error"] == "no Claude account is registered"
