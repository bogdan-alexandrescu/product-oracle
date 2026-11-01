"""The answers the engineering lead gives at the Engineering check reach the later agents.

The lead answers each question of the tech briefs at the check (``answer:<question id>``
edits); the prioritizer (``priority``), the PRD writer (``prd_draft``) and the dates
architect (``eng_dates``) read them as answered, each quoted with its question, whether
the check was approved in Oracle or by the lead in SwarmCloud's console.

Every test states its card: protects / fails_when / no_claim. Against Postgres; the fakes
stand in for SwarmCloud and its agents (no model is called). Synthetic placeholders only.
"""

import uuid
from datetime import timedelta

from oracle.engineering import check as eng_check
from oracle.runs import flows, service
from oracle.swarm import set_runtime
from oracle.tenancy import tenant_session
from tests import swarmcloud_fake
from tests.swarmcloud_fake import FakeSwarmCloud
from tests.test_adapter_v2 import owner, settings  # noqa: F401 - fixtures
from tests.test_eng_review_stop import BRIEFS, _act, _approve, _at_check, runtime  # noqa: F401
from tests.test_eng_review_stop_console import _lead
from tests.test_runs import decide, get, pending, started, tick

Q1 = '"Can the tax service answer within 200 ms?"'
A1 = '"Not today: 900 ms at p95."'
Q2 = '"Show shipping too?"'
A2 = '"No, shipping comes later."'
LATER = ("priority", "prd_draft", "eng_dates")


async def _answer_all(client, headers, run) -> None:
    for body in (
        {"item_key": "price-early", "kind": "edit", "field": "verdict",
         "value": {"verdict": "feasible", "note": None}},
        {"item_key": "price-early", "kind": "edit", "field": "answer:q1",
         "value": "Not today: 900 ms at p95."},
        {"item_key": "price-early", "kind": "edit", "field": "answer:q2",
         "value": "No, shipping comes later."},
    ):  # fmt: skip
        resp = await _act(client, headers, run, body)
        assert resp.status_code in (200, 201), resp.text


async def _lines(tenant_id, run_id, segment: str) -> str:
    async with tenant_session(tenant_id) as s:
        return "\n".join(await eng_check.prompt_lines(s, uuid.UUID(run_id), segment))


def _assert_answered(text: str) -> None:
    for words in (Q1, A1, Q2, A2):
        assert words in text, text
    assert "answered" in text
    assert "not answered" not in text.lower()


async def test_the_answers_reach_the_prioritizer_the_prd_writer_and_the_dates_architect(
    client,
    owner,  # noqa: F811
    runtime,  # noqa: F811
):
    # protects=walk-eng-check: each later stage reads the check's answers quoted with their
    # questions; fails_when=a later stage's lines lack a question or its answer (the dates
    # architect read none), or name a question by its id only; no_claim=what the agents
    # write with them.
    tenant_id, auth = owner
    run = await _at_check(client, auth)
    await _answer_all(client, auth, run)
    assert (await _approve(client, auth, run)).status_code == 200
    for segment in LATER:
        _assert_answered(await _lines(tenant_id, run["id"], segment))
    await tick(client, auth)
    run = await get(client, auth, run["id"])
    assert run["waiting_on"] == "priority_order"
    assert runtime.submitted[-1].labels["segment"] == "priority"
    _assert_answered(runtime.submitted[-1].steps[-1].prompt)


async def test_a_console_approval_by_the_lead_still_carries_the_answers(
    client,
    owner,  # noqa: F811
    monkeypatch,
):
    # protects=walk-eng-check: the lead answers in Oracle and approves the check in
    # SwarmCloud's console; fails_when=the counted console approval records no answers, so
    # the later stages read the questions as unanswered; no_claim=a held console answer.
    real = swarmcloud_fake._default_content

    def content(name, segment, attempt, document):
        if name == flows.BRIEFS_FILE:
            return BRIEFS
        return real(name, segment, attempt, document)

    monkeypatch.setattr(swarmcloud_fake, "_default_content", content)
    tenant_id, auth = owner
    swarm = FakeSwarmCloud(mcp=True, await_input=True, service_answer=True)
    set_runtime(swarm.runtime())
    try:
        run = await started(client, auth)
        for _ in range(6):
            await tick(client, auth)
            run = await get(client, auth, run["id"])
            if run["waiting_on"] == "eng_review":
                break
            if run["status"] == "awaiting_checkpoint":
                run = await decide(client, auth, run)
        assert run["waiting_on"] == "eng_review", run["status"]
        cp = pending(run)
        lead, lead_email = await _lead(client, auth, tenant_id)
        await _answer_all(client, lead.headers, run)
        swarm.console_answer(cp["payload"]["wait"]["workflow_id"], "eng_review-review1",
                             "MERGE", by=lead_email)  # fmt: skip
        real_now = service._now
        monkeypatch.setattr(service, "_now", lambda: real_now() + timedelta(seconds=61))
        await tick(client, auth)
        run = await get(client, auth, run["id"])
        cp = next(c for c in run["checkpoints"] if c["id"] == cp["id"])
        assert cp["status"] == "approved", cp.get("console")
        for segment in LATER:
            _assert_answered(await _lines(tenant_id, run["id"], segment))
    finally:
        set_runtime(None)
