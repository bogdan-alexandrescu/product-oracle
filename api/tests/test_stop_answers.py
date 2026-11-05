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

import yaml
from sqlalchemy import select

from oracle.runs import service
from oracle.runs.models import Checkpoint, Run, RunSegment
from oracle.tenancy import tenant_session
from tests.test_eng_check_answers import _answer_all
from tests.test_eng_review_stop import _approve, _at_check, owner, runtime  # noqa: F401
from tests.test_runs import decide, get, pending, started, tick

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
        # The feature's name and its key apart: a person reads the name, never a slug.
        assert (a["feature_key"], a["feature_title"]) == ("price-early", "Show the price early")
        assert "feature" not in a
    others = [x for x in decisions if x["kind"] != "eng_review"]
    assert all(x["answers"] == [] for x in others)


AQ = "Reuse the old notice sender, or build a new one?"
AGENT_QUESTIONS = {
    "questions": [
        {
            "id": "aq1",
            "role": "architect",
            "feature": "price-early",
            "question": AQ,
            "why": "A half-built sender exists with no tests.",
            "options": [
                {"key": "reuse", "label": "Reuse the old sender"},
                {"key": "build", "label": "Build a new sender"},
            ],
            "recommended": "build",
        }
    ]
}


async def test_answers_to_the_agents_questions_at_the_feature_set_reach_the_prd_writer(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=answers on the Questions from the agents cards of the feature-set stop are
    # decided for the PRD writer and listed under that stop; fails_when=the writer's prompt
    # or the stop's Decisions lack the question or its answer; no_claim=an unanswered card.
    tenant_id, auth = owner
    run = await started(client, auth)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    run = await decide(client, auth, run)
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "feature_set", run["waiting_on"]
    cp = pending(run)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Checkpoint, uuid.UUID(cp["id"]))
        segment = await s.scalar(
            select(RunSegment).where(
                RunSegment.run_id == row.run_id, RunSegment.seq == row.payload["segment_seq"]
            )
        )
        arts = dict(segment.artifacts or {})
        files = {**(arts.get("files") or {}), "agent_questions.yaml": yaml.dump(AGENT_QUESTIONS)}
        segment.artifacts = {**arts, "files": files}
        await s.commit()
    resp = await client.put(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/agent-questions/aq1/answer",
        json={"option": "reuse", "note": "It ships this month."},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    run = await decide(client, auth, run)
    decisions = (await client.get(f"/v1/runs/{run['id']}/decisions", headers=auth)).json()
    [d] = [x for x in decisions if x["kind"] == "feature_set"]
    assert [(a["question"], a["answer"]) for a in d["answers"]] == [
        (AQ, "Reuse the old sender. Note: It ships this month.")
    ]
    # A card names its feature by key only: its title is the run's feature set's.
    scope = (await client.get(f"/v1/runs/{run['id']}/scope", headers=auth)).json()
    title = next(f["title"] for f in scope["features"] if f["key"] == "price-early")
    assert (d["answers"][0]["feature_key"], d["answers"][0]["feature_title"]) == (
        "price-early",
        title,
    ), d["answers"]
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "eng_review", run["waiting_on"]
    await _answer_all(client, auth, run)
    assert (await _approve(client, auth, run)).status_code == 200
    run = await _to_prd_review(client, auth, await get(client, auth, run["id"]))
    prompt = _writer_prompt(runtime)
    assert f'"{AQ}" Decided: "Reuse the old sender. Note: It ships this month."' in prompt
    assert "Feature set" in prompt
    # The writer reads the feature's name, and its key apart, for citing only.
    line = next(ln for ln in prompt.splitlines() if AQ in ln)
    assert f'{title} (feature key price-early, for citing only): "{AQ}"' in line, line


# ------------------------------------------------------------------ review round 1

from oracle.runs import stop_answers  # noqa: E402
from oracle.runs.stop_answers import Answered, listed_open  # noqa: E402

DB_Q = "Which database?"
CSV_Q = "Should exports use CSV?"


def _answered(question: str, answer: str = "Yes.") -> Answered:
    return Answered(
        checkpoint_id=uuid.uuid4(), kind="eng_review", question=question, answer=answer,
        by_name="Rae Example",
    )  # fmt: skip


def _prd(open_lines: str, heading: str = "## Open questions {#open-questions}") -> str:
    return (
        "---\ntitle: Example archive PRD\ncitations: []\n---\n\n"
        "# Example archive PRD {#title}\n\n"
        "## Approach {#approach}\n\nKeep a year of records.\n\n"
        f"{heading}\n\n{open_lines}\n"
    )


def test_a_longer_new_question_that_contains_an_answered_one_imports():
    # protects=a new, longer question is not taken for an answered one; fails_when=a draft
    # listing "Which database should hold the audit trail for the archive?" or "...CSVs or
    # XLSX..." is refused because "Which database?" / "Should exports use CSV?" were
    # answered; no_claim=a reworded copy of an answered question (it passes: fail safe).
    answers = [_answered(DB_Q), _answered(CSV_Q)]
    markdown = _prd(
        "- Which database should hold the audit trail for the archive? Owner: Rae Example, "
        "needed by Nov 30.\n"
        "- Should exports use CSVs or XLSX for the finance team?\n"
    )
    assert listed_open(answers, markdown) == []
    table = _prd(
        "| Question | Owner | Needed by |\n|---|---|---|\n"
        "| Which database should hold the audit trail for the archive? | Rae Example | Nov 30 |\n"
    )
    assert listed_open(answers, table) == []


def test_an_exact_relisting_of_an_answered_question_is_refused_plainly():
    # protects=the same question listed again as open is refused; fails_when=a bullet with
    # its owner and due tail, or a table row, that is the answered question goes through,
    # or the refusal does not name it plainly; no_claim=paraphrases.
    answers = [_answered(DB_Q, "Postgres.")]
    for markdown in (
        _prd("- Which database? Owner: Rae Example, needed by Nov 30."),
        _prd("- **Which database?** (owner: Rae Example)"),
        _prd("| Question | Owner |\n|---|---|\n| Which database? | Rae Example |",
             "## Decisions needed {#decisions}"),
    ):  # fmt: skip
        [problem] = listed_open(answers, markdown)
        assert problem.message.startswith(
            '"Which database?" was answered at Engineering review by Rae Example ("Postgres.")'
        ), problem.message


def test_a_risk_line_quoting_an_answered_question_is_not_an_open_question():
    # protects=in "Risks and open questions" only the open-questions list is checked;
    # fails_when=a risk that quotes an answered question refuses the draft, or the same
    # question listed under its Open questions label goes through; no_claim=other
    # templates' layouts.
    answers = [_answered(DB_Q, "Postgres.")]
    heading = "## Risks and open questions {#risks}"
    risky = _prd(
        "- Which database? If the choice slips, the archive ships late. Mitigation: "
        "decided at the review.\n\n**Open questions**\n\n- Which regions launch first?",
        heading,
    )
    assert listed_open(answers, risky) == []
    only_risk = _prd("- Which database?\n", heading)
    assert listed_open(answers, only_risk) == []
    relisted = _prd(
        "- Slow exports: batch them.\n\nOpen questions:\n\n- Which database? Owner: Rae Example.",
        heading,
    )
    assert len(listed_open(answers, relisted)) == 1


PRD_AQ = "Ship the archive search in v1, or after launch?"
PRD_QUESTIONS = {
    "questions": [
        {
            "id": "pq1",
            "role": "writer",
            "feature": "price-early",
            "question": PRD_AQ,
            "why": "Search doubles the scope.",
            "options": [
                {"key": "v1", "label": "In v1"},
                {"key": "later", "label": "After launch"},
            ],
            "recommended": "later",
        }
    ]
}


async def _ask_at(tenant_id, cp_id: str, questions: dict) -> None:
    async with tenant_session(tenant_id) as s:
        row = await s.get(Checkpoint, uuid.UUID(cp_id))
        segment = await s.scalar(
            select(RunSegment).where(
                RunSegment.run_id == row.run_id, RunSegment.seq == row.payload["segment_seq"]
            )
        )
        arts = dict(segment.artifacts or {})
        files = {**(arts.get("files") or {}), "agent_questions.yaml": yaml.dump(questions)}
        segment.artifacts = {**arts, "files": files}
        await s.commit()


async def test_a_card_answered_at_a_sent_back_prd_review_reaches_the_next_attempt(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=answers on the PRD review's Questions from the agents cards survive Send
    # back; fails_when=the attempt-2 writer prompt lacks the question, its answer, the
    # person or the stop, or a draft re-listing it as open imports once the attempt's
    # files are replaced; no_claim=what the writer writes.
    from tests.review_v2_helpers import person

    tenant_id, auth = owner
    run = await _approved_check(client, auth)
    run = await _to_prd_review(client, auth, run)
    cp = pending(run)
    await _ask_at(tenant_id, cp["id"], PRD_QUESTIONS)
    rae = await person(tenant_id, "approver", "rae")
    async with tenant_session(tenant_id) as s:
        from oracle.models import User

        (await s.get(User, rae.user_id)).name = "Rae Example"
        await s.commit()
    resp = await client.put(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/agent-questions/pq1/answer",
        json={"option": "later", "note": None},
        headers=rae.headers,
    )
    assert resp.status_code == 200, resp.text
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "changes_requested", "note": "Tighten the scope section."},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    assert runtime.submitted[-1].labels["attempt"] == "2", runtime.submitted[-1].labels
    prompt = _writer_prompt(runtime)
    line = next((ln for ln in prompt.splitlines() if PRD_AQ in ln and "Decided:" in ln), "")
    assert "PRD review" in line and "answered by Rae Example" in line, prompt
    assert 'Decided: "After launch"' in line, line
    _assert_decided(prompt)
    # The next attempt's files replace the asking attempt's: the answer still holds.
    await _ask_at(tenant_id, cp["id"], {"questions": []})
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        draft = OPEN_PRD.replace("- Which regions launch first?", f"- {PRD_AQ} Owner: product.")
        problems = await stop_answers.open_problems(s, row, draft)
        assert any(f'"{PRD_AQ}" was answered at PRD review' in p.message for p in problems)


async def test_stop_notes_reach_the_writer_with_the_stop_name_person_and_record(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=an approved or sent-back stop's note is stated in the writer's decided block
    # with the stop's name, its D-number, the person and the day; fails_when=it reaches the
    # writer as "eng_review: <note>" with no person; no_claim=other segments' notes.
    import re

    tenant_id, auth = owner
    run = await _at_check(client, auth)
    await _answer_all(client, auth, run)
    assert (await _approve(client, auth, run, "Keep the tax call async.")).status_code == 200
    run = await get(client, auth, run["id"])
    decisions = (await client.get(f"/v1/runs/{run['id']}/decisions", headers=auth)).json()
    who = next(x for x in decisions if x["kind"] == "eng_review")["decided_by_name"]
    run = await _to_prd_review(client, auth, run)
    prompt = _writer_prompt(runtime)
    assert "eng_review: Keep the tax call async." not in prompt, prompt
    pattern = (
        rf"Engineering review \(D-\d+\), approved by {re.escape(who)} on [A-Z][a-z]{{2}} "
        r'\d{1,2}: note "Keep the tax call async\."'
    )
    assert re.search(pattern, prompt), prompt
    cp = pending(run)
    resp = await client.post(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/decide",
        json={"decision": "changes_requested", "note": "Tighten the scope section."},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    prompt = _writer_prompt(runtime)
    assert re.search(
        rf"PRD review \(D-\d+\), sent back by {re.escape(who)} on [A-Z][a-z]{{2}} \d{{1,2}}: "
        r'note "Tighten the scope section\."',
        prompt,
    ), prompt


async def test_the_feedback_loop_writer_reads_the_answers_too(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=the feedback loop's next draft (a PRD import, checked like the first) is
    # told the answers; fails_when=prompt_lines for next_draft is empty; no_claim=the loop.
    tenant_id, auth = owner
    run = await _approved_check(client, auth)
    async with tenant_session(tenant_id) as s:
        row = await s.get(Run, uuid.UUID(run["id"]))
        _assert_decided("\n".join(await stop_answers.prompt_lines(s, row, "next_draft")))


async def test_the_answerer_is_who_staged_the_answer_not_who_approved(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=an answer is attributed to the person who gave it (the staged action's
    # created_by/updated_by); fails_when=the approver is named for a lead's answer;
    # no_claim=the console path.
    from oracle.models import User
    from tests.review_v2_helpers import person

    tenant_id, auth = owner
    run = await _at_check(client, auth)
    lead = await person(tenant_id, "approver", "lead")
    async with tenant_session(tenant_id) as s:
        (await s.get(User, lead.user_id)).name = "Lee Example"
        await s.commit()
    await _answer_all(client, lead.headers, run)
    assert (await _approve(client, auth, run)).status_code == 200
    decisions = (await client.get(f"/v1/runs/{run['id']}/decisions", headers=auth)).json()
    [d] = [x for x in decisions if x["kind"] == "eng_review"]
    assert d["decided_by_name"] != "Lee Example"
    assert {a["answered_by_name"] for a in d["answers"]} == {"Lee Example"}, d["answers"]


async def test_reading_the_answers_of_many_stops_is_batched(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=pages that load the Decisions of many runs read the stops' answers in a
    # fixed number of reads; fails_when=of_checkpoints reads once per stop (N+1);
    # no_claim=the reads of the rest of the Decisions.
    from sqlalchemy import event

    from oracle.db import get_engine
    from oracle.runs.models import AgentAnswer

    tenant_id, auth = owner
    run = await started(client, auth)
    await tick(client, auth)
    run = await decide(client, auth, await get(client, auth, run["id"]))
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    cp = pending(run)
    await _ask_at(tenant_id, cp["id"], AGENT_QUESTIONS)
    resp = await client.put(
        f"/v1/runs/{run['id']}/checkpoints/{cp['id']}/agent-questions/aq1/answer",
        json={"option": "reuse", "note": None},
        headers=auth,
    )
    assert resp.status_code == 200, resp.text
    run = await decide(client, auth, run)

    async def reads(copies: int) -> int:
        async with tenant_session(tenant_id) as s:
            row = await s.get(Run, uuid.UUID(run["id"]))
            first = await s.get(Checkpoint, uuid.UUID(cp["id"]))
            answer = await s.scalar(
                select(AgentAnswer).where(AgentAnswer.checkpoint_id == first.id)
            )
            cps = []
            for _ in range(copies):
                # A stop decided before its answers were recorded: read live.
                payload = {k: v for k, v in (first.payload or {}).items() if k != "stop_answers"}
                c = Checkpoint(
                    run_id=first.run_id, kind=first.kind, status="approved", payload=payload,
                    decided_by=first.decided_by, decided_at=first.decided_at,
                )  # fmt: skip
                s.add(c)
                await s.flush()
                s.add(AgentAnswer(checkpoint_id=c.id, question_key="aq1", option="reuse",
                                  answered_by=answer.answered_by,
                                  answered_at=answer.answered_at))  # fmt: skip
                cps.append(c)
            await s.flush()
            statements: list[str] = []

            def count(conn, cursor, statement, *args):
                statements.append(statement)

            engine = get_engine().sync_engine
            event.listen(engine, "before_cursor_execute", count)
            try:
                got = await stop_answers.of_checkpoints(s, {row.id: row}, cps)
            finally:
                event.remove(engine, "before_cursor_execute", count)
            assert all(len(got[c.id]) == 1 for c in cps), got
            assert all(got[c.id][0].by_name for c in cps), got
            await s.rollback()
            return len([st for st in statements if "SAVEPOINT" not in st])

    one, six = await reads(1), await reads(6)
    assert six == one, (one, six)
    assert six <= 5, six


# ------------------------------------------------------------------ review round 2


def test_a_negated_or_longer_question_is_not_an_answered_one():
    # protects=only the answered question itself, or one of the same length differing in a
    # word, is taken for it; fails_when=a negated copy ("should not") or a question one
    # word longer is refused at import as already answered; no_claim=paraphrases.
    long_q = (
        "Should the archive keep every export of the finance team for seven years "
        "in the cold storage bucket that the records team already runs today?"
    )
    answers = [_answered(long_q)]
    negated = long_q.replace("Should the archive", "Should the archive not")
    longer = long_q.replace("today?", "today, too?")
    for listed in (negated, longer):
        assert listed_open(answers, _prd(f"- {listed}")) == [], listed
    # The same length, one word apart: still the answered question.
    swapped = long_q.replace("seven years", "seven yrs")
    assert len(listed_open(answers, _prd(f"- {swapped}"))) == 1
    shorter = "Should the archive keep exports?"
    assert listed_open([_answered("Should the archive not keep exports?")],
                       _prd(f"- {shorter}")) == []  # fmt: skip


def test_only_an_owner_or_due_tail_is_stripped_not_a_due_in_the_question():
    # protects=the owner and due day are stripped only in their listed forms ("Owner: …",
    # "needed by …", "(due …)"); fails_when="Is the invoice due on delivery?" is read as
    # "Is the invoice" and refused because "Is the invoice?" was answered; no_claim=other
    # tail wordings.
    answers = [_answered("Is the invoice?"), _answered("Should the owner see it?")]
    for listed in ("Is the invoice due on delivery?", "Is the invoice, due to tax, final?"):
        assert listed_open(answers, _prd(f"- {listed}")) == [], listed
    for listed in (
        "Is the invoice? (due Nov 30)",
        "Is the invoice? Owner: Rae Example",
        "Is the invoice? Needed by Nov 30.",
        "Should the owner see it? Owner: Rae Example",
    ):
        assert len(listed_open(answers, _prd(f"- {listed}"))) == 1, listed


# ------------------------------------------------------------------ review round 3


def test_a_short_question_one_word_apart_is_the_answered_one_but_not_reordered():
    # protects=a short answered question listed again with one word swapped is refused, a
    # question with its words in another order or one word longer imports; fails_when=
    # "Which datastore should hold the audit trail?" or "... seven months?" imports after
    # "Which database ..." / "... seven years?" were answered, or "Should B replace A in
    # checkout flow?" is refused after "Should A replace B in checkout flow?"; no_claim=
    # paraphrases.
    answers = [
        _answered("Which database should hold the audit trail?"),
        _answered("Should we keep exports for seven years?"),
        _answered("Should Alpha replace Beta in checkout flow?"),
    ]
    for listed in (
        "Which datastore should hold the audit trail?",
        "Should we keep exports for seven yrs?",
    ):
        assert len(listed_open(answers, _prd(f"- {listed}"))) == 1, listed
    # Review round 5: "months" for "years" is another span, so another question (it imports).
    for listed in (
        "Should we keep exports for seven months?",
        "Should Beta replace Alpha in checkout flow?",
        "Which database should hold the old audit trail?",
        "Should we keep exports for seven years or more?",
    ):
        assert listed_open(answers, _prd(f"- {listed}")) == [], listed


def test_a_needed_by_or_owned_by_mid_sentence_is_part_of_the_question():
    # protects="owned by", "needed by" and "decide by" are stripped only as a tail after a
    # comma, dash, parenthesis or the question's end; fails_when="Is the report needed by
    # finance each week?" is read as "Is the report" and refused because "Is the report?"
    # was answered; no_claim=other tail wordings.
    answers = [_answered("Is the report?")]
    for listed in (
        "Is the report needed by finance each week?",
        "Is the report owned by finance today?",
    ):
        assert listed_open(answers, _prd(f"- {listed}")) == [], listed
    for listed in (
        "Is the report, needed by Nov 30",
        "Is the report - owned by Rae Example",
        "Is the report (decide by Nov 30)",
        "Is the report? Needed by Nov 30.",
    ):
        assert len(listed_open(answers, _prd(f"- {listed}"))) == 1, listed


def test_the_decision_record_names_a_feature_by_its_title_never_its_key():
    # protects=a stop's decision record names an answer's feature by its title, or "a
    # feature in this run" when it has none; fails_when=the record shows the raw key
    # "price-early"; no_claim=the writer's prompt (it cites the key, apart).
    def one(title: str | None) -> str:
        a = _answered("Which database?", "Postgres.")
        a.feature_key, a.feature_title = "price-early", title
        return stop_answers.decision_lines([a])[1]

    assert one("Show the price early").startswith('- Show the price early: "Which database?"')
    untitled = one(None)
    assert "price-early" not in untitled, untitled
    assert untitled.startswith('- A feature in this run: "Which database?"'), untitled


# ------------------------------------------------------------------ review round 4


def test_a_different_short_question_one_word_apart_imports():
    # protects=a short question (under 5 words) is the answered one only with the same
    # words, so a different short question one word apart imports; fails_when="Which
    # region?" is refused because "Which database?" was answered at the Engineering
    # review; no_claim=paraphrases.
    pairs = (
        ("Which database?", "Which region?"),
        ("Who owns billing?", "Who owns support?"),
        ("Should we support Safari?", "Should we support Firefox?"),
        ("Which region launches first?", "Which region launches last?"),
    )
    for asked, listed in pairs:
        assert listed_open([_answered(asked)], _prd(f"- {listed}")) == [], listed
        assert len(listed_open([_answered(asked)], _prd(f"- {asked}"))) == 1, asked
    # Five words or more, one word apart: the answered question only when the two words are
    # one word spelt two ways (review round 5: "backups" is another thing kept than
    # "exports", so another question, and it imports).
    five = [_answered("Should we keep audit exports?")]
    assert listed_open(five, _prd("- Should we keep audit backups?")) == []
    assert len(listed_open(five, _prd("- Should we keep audit export?"))) == 1


def test_the_refusal_quotes_the_draft_line_that_matched():
    # protects=the refusal names the answered question and the draft's own line;
    # fails_when=the message quotes only the answered question; no_claim=table layout.
    answers = [_answered("Should we keep exports for seven years?", "Yes.")]
    [problem] = listed_open(
        answers, _prd("- Should we keep exports for seven yrs? Owner: Rae Example")
    )
    assert (
        'the draft lists it under Open questions as "Should we keep exports for seven yrs? '
        'Owner: Rae Example"'
    ) in problem.message, problem.message


def test_an_owner_word_inside_the_question_is_not_a_tail():
    # protects=only a trailing owner tail ("… Owner: Rae") is stripped; fails_when="Who is
    # the owner: finance or ops?" is also read as "Who is the" and refused because "Who is
    # the?" was answered; no_claim=other tail wordings.
    answers = [_answered("Who is the?")]
    assert listed_open(answers, _prd("- Who is the owner: finance or ops?")) == []
    assert len(listed_open(answers, _prd("- Who is the? Owner: Rae Example"))) == 1


# ------------------------------------------------------------------ review round 5


def test_a_question_one_content_word_apart_is_a_new_question():
    # protects=at five words or more, one word apart is the answered question only when the
    # two words are one word spelt two ways (an abbreviation, a plural, a known synonym such
    # as datastore/database); fails_when="Should we support Firefox on launch?" is refused
    # because "Should we support Safari on launch?" was answered, or "slow" for "fast";
    # no_claim=paraphrases.
    pairs = (
        ("Should we support Safari on launch?", "Should we support Firefox on launch?"),
        ("Is it fast enough today?", "Is it slow enough today?"),
        ("Should we keep audit exports?", "Should we keep audit backups?"),
        ("Who signs off the Nova pricing page?", "Who signs off the Orbit pricing page?"),
        ("Should we keep exports for seven years?", "Should we keep exports for seven weeks?"),
        ("Should the export run every night?", "Should the expert run every night?"),
    )
    for asked, listed in pairs:
        assert listed_open([_answered(asked)], _prd(f"- {listed}")) == [], listed
        assert len(listed_open([_answered(asked)], _prd(f"- {asked}"))) == 1, asked
    long_q = (
        "Which datastore should hold the audit trail that the records team reads every "
        "quarter when the finance team closes its books?"
    )
    refused = (
        ("Should we keep exports for seven years?", "Should we keep exports for seven yrs?"),
        (long_q, long_q.replace("datastore", "database")),
        (long_q, long_q.replace("datastore", "db")),
        ("Should we keep the audit exports?", "Should we keep the audit export?"),
        ("Which colour should the banner use?", "Which color should the banner use?"),
        ("Should we organise the audit exports?", "Should we organize the audit exports?"),
        ("Who reads the management report weekly?", "Who reads the mgmt report weekly?"),
    )
    for asked, listed in refused:
        assert len(listed_open([_answered(asked)], _prd(f"- {listed}"))) == 1, listed


def test_same_question_reads_variants_both_ways():
    # protects=a variant pair is the same either way round; fails_when="yrs" answered lets
    # "years" import; no_claim=variants of two words or more.
    assert stop_answers.same_question("keep exports for seven yrs", "keep exports for seven years")
    assert stop_answers.same_question("keep exports for seven years", "keep exports for seven yrs")
    assert not stop_answers.same_question("keep exports for seven years", "keep exports for seven yards")
