"""A brief's answer "unknown, finding out is part of this work" becomes work, never a
blocker (owner, walk 2 problem 19).

Test cards (protects / fails_when / no_claim):

- ``test_recognises_unknown_that_is_part_of_the_work``: protects=an honest "we don't know
  yet, finding out is part of the work" is read as planned work, in plain words;
  fails_when=such an answer is missed, or a bare "unknown", a real answer or "not part of
  this work" is taken for one; no_claim=every phrasing a person might use.
- ``test_the_answer_clears_the_draft_gate_and_becomes_work``: protects=the draft is not
  stopped by such an answer, and the brief lists it as a requirement cited to the answer;
  fails_when=the gap stays a blocker or waits for review, or no requirement is listed;
  no_claim=the wording the writer picks.
- ``test_a_draft_that_blocks_on_it_is_refused``: protects=the blocker list never holds such
  an item; fails_when=a draft listing it as a blocker, or leaving it out, is imported;
  no_claim=other import checks.

Invented example data only.
"""

import uuid

import pytest
import yaml

from oracle.intake import discovery, drafting
from oracle.runs import flows
from oracle.runs import service as runs_service
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from tests.intake_helpers import all_questions, answer, company, intake_with_source
from tests.intake_helpers import summary as read_summary

STATEMENT = "Platform limits are not checked."
HONEST = "Unknown; finding the platform's limits is part of this work."


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.mark.parametrize(
    "text",
    [
        HONEST,
        "unknown, finding out is part of this work",
        "We don't know the rate limits yet. Figuring them out is part of the project.",
        "Nobody has checked. Working that out is part of the job.",
        "Not sure yet; we will find out as part of the work.",
        "TBD — we'll find out during the build, it's part of this work.",
        "No idea yet, so an early discovery step finds them.",
        "Finding out the platform's limits is part of this work.",
    ],
)
def test_recognises_unknown_that_is_part_of_the_work(text):
    assert discovery.is_discovery(text)


@pytest.mark.parametrize(
    "text",
    [
        None,
        "",
        "Unknown.",
        "We don't know.",
        "The platform allows 500 requests a minute per shop.",
        "Part of this work is the checkout page.",
        "Unknown, and finding out is not part of this work.",
        "Unknown; that is outside this work.",
        # A known fact: testing it is part of the work, but nothing is unknown.
        "The platform allows 500 requests a minute; testing that is part of this work.",
        "We checked: 500 a minute. Load testing is part of the project.",
    ],
)
def test_other_answers_are_not_work(text):
    assert not discovery.is_discovery(text)


def test_the_requirement_names_what_to_find_out():
    assert discovery.requirement_for("third_party_policy", STATEMENT) == (
        "Find out the platform's policy and API limits"
    )
    assert discovery.requirement_for("blockers", "x") == "Find out what could stop this shipping"


async def _platform_gap(client, ctx, intake_id: str) -> dict:
    resp = await client.post(
        "/v1/gaps",
        json={"intake_id": intake_id, "category": "third_party_policy",
              "statement": STATEMENT, "importance": "critical"},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _question_of(client, ctx, intake_id: str, gap_id: str) -> dict:
    return next(q for q in await all_questions(client, ctx, intake_id) if q["gap_id"] == gap_id)


async def _create_run(client, ctx, intake_id: str):
    return await client.post(
        f"/v1/intakes/{intake_id}/runs", json={"document": "saved-addresses"},
        headers=ctx.as_("approver"),
    )  # fmt: skip


async def _brief_with_work(client, ctx, kind: str = "answer"):
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    gap = await _platform_gap(client, ctx, intake_id)
    question = await _question_of(client, ctx, intake_id, gap["id"])
    # Below the owner role: a real answer to a critical gap would wait for review (B4).
    given = await answer(client, ctx, question["id"], kind=kind, body=HONEST)
    return intake_id, gap, question, given


@pytest.mark.parametrize("kind", ["answer", "dont_know"])
async def test_the_answer_clears_the_draft_gate_and_becomes_work(client, kind):
    ctx = await company()
    intake_id, gap, question, given = await _brief_with_work(client, ctx, kind)
    assert given["gap"]["status"] == "answered"
    assert given["question"]["status"] == "answered"

    shown = await read_summary(client, ctx, intake_id)
    assert shown["readiness"]["blocking_gap_ids"] == []
    assert shown["readiness"]["gate"] == "clear"
    assert shown["work"] == [
        {
            "gap_id": gap["id"],
            "question_id": question["id"],
            "answer_id": given["answer"]["id"],
            "requirement": "Find out the platform's policy and API limits",
            "answer": HONEST,
            "cite_ref": f"urn:oracle:answer:{given['answer']['id']}",
        }
    ]
    resp = await _create_run(client, ctx, intake_id)
    assert resp.status_code == 201, resp.text


async def test_a_bare_unknown_still_holds_the_draft(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    gap = await _platform_gap(client, ctx, intake_id)
    question = await _question_of(client, ctx, intake_id, gap["id"])
    await answer(client, ctx, question["id"], kind="dont_know", body="Unknown.")
    shown = await read_summary(client, ctx, intake_id)
    assert shown["readiness"]["blocking_gap_ids"] == [gap["id"]]
    assert shown["work"] == []


async def test_a_known_fact_with_testing_planned_is_not_work(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    gap = await _platform_gap(client, ctx, intake_id)
    question = await _question_of(client, ctx, intake_id, gap["id"])
    body = "The platform allows 500 requests a minute; testing that is part of this work."
    given = await answer(client, ctx, question["id"], kind="answer", body=body)
    assert given["answer"]["knowledge_state"] != "unknown"
    shown = await read_summary(client, ctx, intake_id)
    assert shown["work"] == []
    assert shown["readiness"]["gate"] != "clear"


def _draft(answer_id: str, body: list[str], blockers: list[str] | None = None) -> str:
    front = [
        "---",
        "title: Saved addresses",
        "citations:",
        "  - id: a1",
        "    source: upload",
        f"    ref: urn:oracle:answer:{answer_id}",
        "    title: Answer on the brief",
        "    excerpt: Unknown; finding the platform's limits is part of this work.",
        "    retrieved_at: 2026-11-04T09:00:00Z",
    ]
    if blockers is not None:
        front += ["blockers:", *[f"  - {b}" for b in blockers]]
    return "\n".join([*front, "---", "", "# Saved addresses {#title}", "", *body, ""])


PLANNED = [
    "## Requirements {#requirements}",
    "",
    "- R1 Find out the platform's policy and API limits [c:a1]. An early discovery item, "
    "one week, before the sync work.",
    "",
    "## Risks and open questions {#risks}",
    "",
    "- Pre-fill may be slow on old phones.",
]
AS_BLOCKER = [
    "## Requirements {#requirements}",
    "",
    "- R1 Saved addresses at checkout.",
    "",
    "## Blockers {#blockers}",
    "",
    "- Platform limits are not checked [c:a1].",
]
BLOCKED_LINE = [
    "## Risks and open questions {#risks}",
    "",
    "- The draft is blocked until the platform limits are checked [c:a1].",
]


def _work(answer_id: str) -> list[discovery.Work]:
    return [
        discovery.Work(
            gap_id=uuid.uuid4(),
            question_id=uuid.uuid4(),
            answer_id=uuid.UUID(answer_id),
            requirement="Find out the platform's policy and API limits",
            answer=HONEST,
        )
    ]


def test_the_check_takes_a_requirement_cited_to_the_answer():
    a = str(uuid.uuid4())
    assert discovery.draft_problems(_draft(a, PLANNED), _work(a)) == []


@pytest.mark.parametrize("body", [AS_BLOCKER, BLOCKED_LINE])
def test_the_check_refuses_a_draft_that_blocks_on_it(body):
    a = str(uuid.uuid4())
    problems = discovery.draft_problems(_draft(a, body), _work(a))
    assert [p.code for p in problems] == ["discovery_as_blocker"]
    assert problems[0].message == (
        "“Find out the platform's policy and API limits” is listed as a blocker. The "
        "brief's answer says finding it out is part of this work: write it as a "
        "requirement, and as an early discovery item with its own estimate when it gates "
        "a date, never as a blocker."
    )
    assert problems[0].refs == {"answer_id": a}


def test_the_check_takes_a_requirement_that_mentions_blocking_something_else():
    a = str(uuid.uuid4())
    body = [
        "## Requirements {#requirements}",
        "",
        "- R1 Find out the platform's policy and API limits before blocking traffic [c:a1].",
        "- R2 Find out the limits first; the sync item waits on it [c:a1].",
    ]
    assert discovery.draft_problems(_draft(a, body), _work(a)) == []


def test_the_check_refuses_a_front_matter_blocker():
    a = str(uuid.uuid4())
    problems = discovery.draft_problems(_draft(a, PLANNED, blockers=["a1"]), _work(a))
    assert [p.code for p in problems] == ["discovery_as_blocker"]


def test_the_check_refuses_a_draft_that_leaves_it_out():
    a = str(uuid.uuid4())
    other = str(uuid.uuid4())
    problems = discovery.draft_problems(_draft(other, PLANNED), _work(a))
    assert [p.code for p in problems] == ["discovery_not_planned"]
    assert problems[0].message == (
        "The brief's answer “Unknown; finding the platform's limits is part of this work.” "
        "makes finding this out part of the work: add the requirement “Find out the "
        "platform's policy and API limits” cited to that answer (ref "
        f"urn:oracle:answer:{a})."
    )


async def test_a_draft_that_blocks_on_it_is_refused(client, runtime):
    ctx = await company()
    intake_id, _gap, _question, given = await _brief_with_work(client, ctx)
    run_id = (await _create_run(client, ctx, intake_id)).json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=approver)).status_code == 200
    answer_id = given["answer"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        out = await runs_service._import_draft(s, run, "prd", _draft(answer_id, AS_BLOCKER))
    assert out["error"].startswith("prd.md was rejected: [discovery_as_blocker]")
    assert [p["code"] for p in out["problems"]] == ["discovery_as_blocker"]


async def test_a_malformed_pinned_answer_id_is_skipped(client, runtime):
    ctx = await company()
    intake_id, _gap, _question, given = await _brief_with_work(client, ctx)
    run_id = (await _create_run(client, ctx, intake_id)).json()["id"]
    answer_id = given["answer"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        run.knobs = {**run.knobs, drafting.ANSWER_IDS: ["not-an-id", answer_id]}
        problems = await runs_service._work_problems(s, run, _draft(answer_id, AS_BLOCKER))
    assert [p.code for p in problems] == ["discovery_as_blocker"]


async def test_the_writer_is_told_unknowns_are_work(client, runtime):
    ctx = await company()
    intake_id, *_ = await _brief_with_work(client, ctx)
    run_id = (await _create_run(client, ctx, intake_id)).json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=approver)).status_code == 200
    prompt = runtime.submitted[0].steps[0].prompt
    assert flows.UNKNOWN_IS_WORK in prompt
    draft = next(s for s in flows.FLOWS["baseline_to_prd"].segments if s.name == "prd_draft")
    assert flows.UNKNOWN_IS_WORK_DRAFT in draft.task
    items = next(s for s in flows.FLOWS["prd_draft_items"].segments if s.name == "roadmap_items")
    assert "early discovery item" in items.task


ITEMS = [
    {"id": "find-limits", "title": "Find out the platform's policy and API limits",
     "outcome": "We know the limits before the sync work", "horizon": "now"},
    {"id": "sync", "title": "Address sync", "outcome": "Addresses stay current",
     "horizon": "now", "depends_on": ["find-limits"]},
]  # fmt: skip


@pytest.mark.parametrize(
    "blocker", ["find-limits", "find-out-the-platform-s-policy-and-api-limits", "answer"]
)
def test_the_items_check_refuses_a_discovery_item_as_a_blocker(blocker):
    a = str(uuid.uuid4())
    key = a if blocker == "answer" else blocker
    items = [ITEMS[0], {**ITEMS[1], "blockers": [key]}]
    problems = discovery.items_problems(items, _work(a))
    assert [(code, item) for code, _m, item in problems] == [("discovery_as_blocker", "sync")]


def test_the_items_check_takes_a_discovery_item_depended_on():
    a = str(uuid.uuid4())
    items = [ITEMS[0], {**ITEMS[1], "blockers": ["vendor-contract"]}]
    assert discovery.items_problems(items, _work(a)) == []


async def test_a_roadmap_item_blocked_on_the_discovery_is_refused(client, runtime):
    ctx = await company()
    intake_id, _gap, _question, given = await _brief_with_work(client, ctx)
    answer_id = given["answer"]["id"]
    resp = await client.post(
        "/v1/documents/saved-addresses/versions",
        content=_draft(answer_id, PLANNED).encode(),
        headers={**ctx.as_("approver"), "Content-Type": "text/markdown"},
    )
    assert resp.status_code in (200, 201), resp.text
    version_id = resp.json()["id"]
    items = [ITEMS[0], {**ITEMS[1], "blockers": ["find-limits"]}]
    text = yaml.safe_dump({"version": 1, "items": items})
    async with tenant_session(ctx.tenant_id) as s:
        run = Run(knobs={"source_version_id": version_id})
        check, *_ = await runs_service._checked(s, run, text)
    assert [p["code"] for p in check.problems if p["code"].startswith("discovery")] == [
        "discovery_as_blocker"
    ]
