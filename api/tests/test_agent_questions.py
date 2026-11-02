"""AQ1 Cards atop the review: the questions a run's agents asked at a stop
(``agent_questions.yaml`` of the segment the stop reviews), read by every member and
answered by the stop's approver role or above until it is decided. Each answer is kept with
who and when; the decision record carries every answer to the next step, and a question
nobody answered goes with the agent's pick.

Integration tests wait a ``prd_to_roadmap`` run at its Roadmap items checkpoint on the
FakeRuntime against Postgres. Synthetic placeholders only.
"""

import uuid

import yaml
from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.runs.models import Checkpoint, RunSegment
from oracle.tenancy import tenant_session
from tests.test_checkpoint_review import Review, review  # noqa: F401 - fixtures
from tests.test_roadmap import approved_prd, owner, runtime, seed_baseline  # noqa: F401

QUESTIONS = {
    "questions": [
        {
            "id": "q1",
            "role": "architect",
            "feature": "mobile-push",
            "question": "Reuse the old notice sender, or build a new one?",
            "why": "A half-built sender exists with no tests.",
            "options": [
                {"key": "reuse", "label": "Reuse the old sender", "detail": "About 3 days."},
                {"key": "build", "label": "Build a new sender", "detail": "About 8 days."},
            ],
            "recommended": "reuse",
        },
        {
            "id": "q2",
            "role": "analyst",
            "feature": None,
            "question": "Home orders only, or every country?",
            "why": "Two goals disagree.",
            "options": [
                {"key": "home", "label": "Home orders only", "detail": "Smaller set."},
                {"key": "all", "label": "Every country", "detail": "More rules."},
            ],
            "recommended": "home",
        },
    ]
}


async def asked(r: Review, questions: dict = QUESTIONS) -> None:
    """The stop's segment wrote its agents' questions."""
    async with tenant_session(r.tenant_id) as s:
        cp = await s.get(Checkpoint, uuid.UUID(r.cp["id"]))
        seq = cp.payload["segment_seq"]
        segment = await s.scalar(
            select(RunSegment).where(RunSegment.run_id == cp.run_id, RunSegment.seq == seq)
        )
        arts = dict(segment.artifacts or {})
        arts["files"] = {**(arts.get("files") or {}), "agent_questions.yaml": yaml.dump(questions)}
        segment.artifacts = arts
        await s.commit()


async def qs(r: Review, who: str = "viewer", expect: int = 200) -> dict:
    resp = await r.client.get(f"{r.base}/agent-questions", headers=r.h(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def answer(r: Review, who: str, qid: str, expect: int = 200, **body) -> dict:
    resp = await r.client.put(f"{r.base}/agent-questions/{qid}/answer", json=body, headers=r.h(who))
    assert resp.status_code == expect, resp.text
    return resp.json()


async def test_every_member_reads_the_stops_agent_questions(review):  # noqa: F811
    """protects=the cards atop the review read the agents' file; fails_when=the route is
    missing, a field is lost, or a viewer may answer; no_claim=the web's layout."""
    out = await qs(review)
    assert out["questions"] == []
    await asked(review)
    out = await qs(review)
    assert out["can_answer"] is False
    assert out["next_step"]
    q1, q2 = out["questions"]
    assert q1["id"] == "q1" and q1["role"] == "architect" and q1["feature"] == "mobile-push"
    assert q1["recommended"] == "reuse" and q1["answer"] is None
    assert [o["label"] for o in q1["options"]] == ["Reuse the old sender", "Build a new sender"]
    assert q1["why"] == "A half-built sender exists with no tests."
    assert q2["feature"] is None
    assert (await qs(review, "owner"))["can_answer"] is True


async def test_the_approver_answers_and_may_change_it_until_the_stop_is_decided(review):  # noqa: F811
    """protects=an answer is kept with who and when, and replaced by the next;
    fails_when=a commenter answers, an unknown option is kept, or the answer is lost;
    no_claim=the next agent's reading of it."""
    await asked(review)
    await answer(review, "commenter", "q1", 403, option="build")
    await answer(review, "owner", "q1", 422, option="nope")
    await answer(review, "owner", "q9", 404, option="build")
    out = await answer(review, "approver", "q1", option="build", note="Owned from Nov 16")
    a = out["questions"][0]["answer"]
    assert a["option"] == "build" and a["note"] == "Owned from Nov 16"
    assert a["by"]["name"] and a["at"] and a["mine"] is True
    other = (await qs(review, "owner"))["questions"][0]["answer"]
    assert other["mine"] is False and other["by"]["name"] == a["by"]["name"]
    out = await answer(review, "owner", "q1", option="reuse", note="")
    a = out["questions"][0]["answer"]
    assert a["option"] == "reuse" and a["note"] is None and a["mine"] is True
    assert out["questions"][1]["answer"] is None


async def test_answers_go_with_the_decision_and_unanswered_ones_with_the_agents_pick(review):  # noqa: F811
    """protects=the next step reads every answer with the stop's decision; fails_when=an
    answer or the agent's pick for an open question is missing from the decision record,
    or a decided stop still takes answers; no_claim=the next segment's prompt."""
    await asked(review)
    await answer(review, "owner", "q1", option="build", note="Owned from Nov 16")
    await review.decide("owner", decision="changes_requested", note="Look again")
    async with tenant_session(review.tenant_id) as s:
        d = await s.scalar(select(Decision).where(Decision.source_id == uuid.UUID(review.cp["id"])))
    assert d is not None and d.context
    assert "Reuse the old notice sender, or build a new one?: Build a new sender" in d.context
    assert "Owned from Nov 16" in d.context
    assert "Home orders only, or every country?: Home orders only (the agent's pick" in d.context
    await answer(review, "owner", "q2", 409, option="all")
