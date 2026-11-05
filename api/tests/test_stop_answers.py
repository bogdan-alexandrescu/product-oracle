"""Answers given at a run's stops reach the PRD writer as decided, and the run's Decisions.

At the Engineering review stop the lead answers the architect's questions and approves;
the PRD writer reads each answer as decided, with the person and the stop, on the first
draft and on a draft the PRD review sent back. A draft that still lists an answered
question under Decisions needed or Open questions is refused at import, naming the
question. The run's Decisions list each answer under its stop.

Every test states its card: protects / fails_when / no_claim. Against Postgres; the
FakeRuntime stands in for SwarmCloud and its agents (no model is called). Synthetic
placeholders only.
"""

import uuid

from oracle.runs import service
from oracle.runs.models import Run
from oracle.tenancy import tenant_session
from tests.test_eng_check_answers import _answer_all
from tests.test_eng_review_stop import _approve, _at_check, owner, runtime  # noqa: F401
from tests.test_runs import decide, get, pending, tick

Q1 = "Can the tax service answer within 200 ms?"
A1 = "Not today: 900 ms at p95."
Q2 = "Show shipping too?"
A2 = "No, shipping comes later."

OPEN_PRD = (
    "---\ntitle: Example checkout PRD\ncitations: []\n---\n\n"
    "# Example checkout PRD {#title}\n\n"
    "## Approach {#approach}\n\nShow the total on the cart page.\n\n"
    "## Decisions needed {#decisions}\n\n"
    f"- {Q1} Owner: engineering.\n\n"
    "## Open questions {#open-questions}\n\n"
    "- Which regions launch first?\n"
)


async def _approved_check(client, auth) -> dict:
    run = await _at_check(client, auth)
    await _answer_all(client, auth, run)
    assert (await _approve(client, auth, run)).status_code == 200
    return await get(client, auth, run["id"])


def _writer_prompt(runtime) -> str:  # noqa: F811
    job = runtime.submitted[-1]
    assert job.labels["segment"] == "prd_draft", job.labels
    return job.steps[0].prompt


def _assert_decided(prompt: str) -> None:
    for words in (Q1, A1, Q2, A2):
        assert words in prompt, prompt
    assert "Engineering review" in prompt
    assert "never list it under Decisions needed or Open questions" in prompt


async def _to_prd_review(client, auth, run) -> dict:
    for _ in range(4):
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        if run["waiting_on"] == "prd_review":
            return run
        if run["status"] == "awaiting_checkpoint":
            run = await decide(client, auth, run)
    raise AssertionError(run["waiting_on"])


async def test_the_prd_writer_reads_the_engineering_answers_as_decided_with_who_and_where(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=answers at the Engineering review reach the PRD draft as decided;
    # fails_when=the PRD writer's prompt lacks an answered question, its answer, the stop
    # or the person who answered it; no_claim=what the writer writes with them.
    tenant_id, auth = owner
    run = await _approved_check(client, auth)
    [d] = [x for x in (await client.get(f"/v1/runs/{run['id']}/decisions", headers=auth)).json()
           if x["kind"] == "eng_review"]  # fmt: skip
    who = d["decided_by_name"]
    assert who
    run = await _to_prd_review(client, auth, run)
    prompt = _writer_prompt(runtime)
    _assert_decided(prompt)
    assert f"answered by {who}" in prompt
    assert "(D-" in prompt  # the stop's decision record, to cite


async def test_a_sent_back_prd_review_carries_the_answers_into_the_next_draft(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=Send back to agents at the PRD review keeps the decided answers;
    # fails_when=the next draft's writer prompt drops them; no_claim=the change request.
    tenant_id, auth = owner
    run = await _approved_check(client, auth)
    run = await _to_prd_review(client, auth, run)
    cp = pending(run)
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "changes_requested", "note": "Tighten the scope section."},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    assert runtime.submitted[-1].labels["attempt"] == "2", runtime.submitted[-1].labels
    prompt = _writer_prompt(runtime)
    assert "Tighten the scope section." in prompt
    _assert_decided(prompt)


async def test_a_draft_listing_an_answered_question_as_open_is_refused_naming_it(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=the import check refuses a PRD that lists an answered question as open;
    # fails_when=the draft imports, or the refusal does not name the question; no_claim=a
    # paraphrased question.
    tenant_id, auth = owner
    run = await _approved_check(client, auth)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        refused = await service._import_draft(s, row, "prd", OPEN_PRD)
        assert refused.get("problems"), refused
        assert f'"{Q1}" was answered at Engineering review' in refused["summary"], refused
        assert "Decisions needed" in refused["summary"]
        # A question nobody answered may stay open.
        assert "Which regions launch first" not in refused["summary"]
        from oracle.runs import stop_answers

        ok = OPEN_PRD.replace(f"- {Q1} Owner: engineering.\n", "- None.\n")
        assert await stop_answers.open_problems(s, row, ok) == []


async def test_the_decisions_list_each_answer_under_its_stop(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=the run page's Decisions show what was decided at the Engineering review;
    # fails_when=the stop's decision lists no answers, or one without its question, answer,
    # person or time; no_claim=the run page's layout.
    tenant_id, auth = owner
    run = await _approved_check(client, auth)
    decisions = (await client.get(f"/v1/runs/{run['id']}/decisions", headers=auth)).json()
    [d] = [x for x in decisions if x["kind"] == "eng_review"]
    got = {(a["question"], a["answer"]) for a in d["answers"]}
    assert got == {(Q1, A1), (Q2, A2)}, d["answers"]
    for a in d["answers"]:
        assert a["answered_by_name"] == d["decided_by_name"]
        assert a["answered_at"]
        assert a["feature"] == "price-early Show the price early"
    others = [x for x in decisions if x["kind"] != "eng_review"]
    assert all(x["answers"] == [] for x in others)
