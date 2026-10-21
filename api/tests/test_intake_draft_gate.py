"""C5 Pre-draft questions, lane 1: the next-batch preview, the draft gate and the answers
a run reads (decided 2026-10-21, C5 "Draft gate": drafting waits until decided).

Test cards (protects / fails_when / no_claim):

- ``test_preview_matches_ask``: protects=the preview shows exactly what will be asked;
  fails_when=preview and ask diverge, or the preview asks something itself;
  no_claim=ranking quality.
- ``test_draft_gate_blocks_on_shared_critical``: protects=no draft with an open shared
  critical gap; fails_when=a run is created or started while blocked, or a private gap
  blocks; no_claim=the UI copy.
- ``test_run_pins_answers``: protects=every segment sees the same answers;
  fails_when=a later answer leaks into a running run's reads; no_claim=what agents do
  with them.

Synthetic placeholders only.
"""

import uuid
from types import SimpleNamespace

import pytest

from oracle.auth.service import sign_run_binding
from oracle.intake import engine, sharing, summary
from oracle.jobs import worker
from oracle.llm import gateway
from oracle.runs.models import Run
from oracle.swarm import FakeRuntime, set_runtime
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, StakeholderQuestion
from tests.baseline_helpers import make_item
from tests.claude_account_helpers import add_account, window
from tests.intake_helpers import (
    answer,
    batch,
    company,
    create_intake,
    intake_with_source,
    summary as read_summary,
)
from tests.test_intake_jobs import FakeClaude
from tests.test_intake_sharing import CODENAME, EXCERPT_A, TITLE_A, _model, add_author


@pytest.fixture
def runtime():
    fake = FakeRuntime()
    set_runtime(fake)
    yield fake
    set_runtime(None)


@pytest.fixture
def fake():
    holder = {}

    def install(answer):
        claude = FakeClaude(answer)
        holder["previous"] = gateway.set_transports(gateway.Transports(plan=claude, api_key=claude))
        return claude

    yield install
    if "previous" in holder:
        gateway.set_transports(holder["previous"])


def _private_blocker(payload):
    """The model finds a critical blocker in the author's private sources."""
    out = _model(payload)
    out["gaps"] = [{"category": "blockers", "importance": "critical",
                    "statement": f"The {CODENAME} quota blocks pre-fill.",
                    "evidence_refs": []}]  # fmt: skip
    return out


def _ids(cards: list[dict]) -> list[str]:
    return [c["question"]["id"] for c in cards]


async def _next(client, ctx, intake_id: str, who: str, size: int = 5):
    return await client.get(
        f"/v1/intakes/{intake_id}/next-batch", params={"size": size}, headers=ctx.as_(who)
    )


async def _critical_gap(client, ctx, intake_id: str) -> dict:
    """A person adds a critical hard blocker: shared with everyone from the start."""
    resp = await client.post(
        "/v1/gaps",
        json={"intake_id": intake_id, "category": "blockers",
              "statement": "The partner quota may block pre-fill.", "importance": "critical"},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _create_run(client, ctx, intake_id: str, who: str = "approver"):
    return await client.post(
        f"/v1/intakes/{intake_id}/runs", json={"document": "saved-addresses"},
        headers=ctx.as_(who),
    )  # fmt: skip


def _as_run(ctx, run_id: str, who: str = "approver") -> dict[str, str]:
    """A run's in-process REST read: its creator's session marked as the run's."""
    return {**ctx.as_(who), "x-oracle-run-id": sign_run_binding(ctx.users[who].id,
                                                                uuid.UUID(run_id))}  # fmt: skip


# --- choose_batch: the one selection preview and ask share ----------------------------------


def _gap(**kw) -> KnowledgeGap:
    kw.setdefault("id", uuid.uuid4())
    kw.setdefault("intake_id", uuid.uuid4())
    kw.setdefault("rule_key", kw.get("category", "alternatives"))
    kw.setdefault("category", "alternatives")
    kw.setdefault("created_by", None)
    kw.setdefault("importance", "high")
    kw.setdefault("status", "unknown")
    return KnowledgeGap(**kw)


def _draft(gap: KnowledgeGap | None, priority: int, **kw) -> StakeholderQuestion:
    kw.setdefault("status", "draft")
    return StakeholderQuestion(
        id=uuid.uuid4(), gap_id=gap.id if gap else None, priority=priority, **kw
    )


def _hidden_gap() -> tuple[KnowledgeGap, sharing.Registry]:
    """A model-written gap its author keeps private: hidden from everyone else."""
    gap = _gap(rule_key=None, category="release_rollout")
    reg = sharing.Registry({str(gap.id): {"kind": "gap", "origin": "model",
                                          "sharing": "private", "category": "release_rollout"}})  # fmt: skip
    reg.analysed = True
    return gap, reg


def test_choose_batch_takes_the_first_drafts_in_order():
    gaps = [_gap() for _ in range(4)]
    asked = _draft(gaps[0], 10, status="asked", batch=1)
    drafts = [_draft(g, 20 + i * 10) for i, g in enumerate(gaps[1:])]
    skipped = _draft(_gap(), 15)
    by_id = {g.id: g for g in gaps}
    chosen = engine.choose_batch(
        [asked, skipped, *drafts], by_id, sharing.Registry(), 2, skip={skipped.gap_id}
    )
    assert chosen.questions == drafts[:2]
    assert chosen.number == 2


def test_choose_batch_lets_hidden_drafts_ranked_before_the_cut_ride_along():
    hidden, reg = _hidden_gap()
    public = [_gap() for _ in range(3)]
    qs = [_draft(public[0], 10), _draft(hidden, 15), _draft(public[1], 20), _draft(public[2], 30)]
    by_id = {g.id: g for g in [hidden, *public]}
    chosen = engine.choose_batch(qs, by_id, reg, 1)
    # The cut falls before the second public draft: the hidden one ranked before it rides.
    assert chosen.questions == qs[:2]
    assert chosen.number == 1


def test_choose_batch_joins_hidden_only_drafts_to_the_latest_batch():
    hidden, reg = _hidden_gap()
    public = _gap()
    qs = [_draft(public, 10, status="asked", batch=3), _draft(hidden, 15)]
    chosen = engine.choose_batch(qs, {g.id: g for g in (hidden, public)}, reg, 5)
    assert chosen.questions == [qs[1]]
    assert chosen.number == 3  # no new number tells anyone a hidden question exists


def test_draft_gate_counts_shared_critical_blockers_only():
    hidden, reg = _hidden_gap()
    hidden.category = "blockers"
    hidden.importance = "critical"
    shared = _gap(category="blockers", importance="critical", rule_key=None,
                  created_by=uuid.uuid4())  # fmt: skip
    view = SimpleNamespace(raw={hidden.id: hidden}, reg=reg, v=sharing.EVERYONE)
    assert summary.gate(view).gate == "clear"  # private: gates nothing until shared
    view.raw[shared.id] = shared
    out = summary.gate(view)
    assert out.gate == "blocked" and out.blocking_gap_ids == [shared.id]
    reg[str(hidden.id)] = {**reg[str(hidden.id)], "sharing": "counts"}
    assert set(summary.gate(view).blocking_gap_ids) == {shared.id, hidden.id}


# --- next-batch ---------------------------------------------------------------------------


async def test_preview_matches_ask(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    before = out["batch"]

    resp = await _next(client, ctx, intake_id, "commenter")
    assert resp.status_code == 200, resp.text
    preview = resp.json()
    assert len(preview["questions"]) == 5
    assert preview["remaining"] == before["remaining"]
    # Each is shown with the person it would be asked of: the gap's owner, else the author.
    author = str(ctx.users["commenter"].id)
    assert {c["question"]["asked_to"] for c in preview["questions"]} == {author}
    assert all(c["question"]["status"] == "draft" for c in preview["questions"])
    # Previewing asks nothing.
    again = (await _next(client, ctx, intake_id, "approver")).json()
    assert _ids(again["questions"]) == _ids(preview["questions"])
    assert (await read_summary(client, ctx, intake_id))["batch"] == before

    resp = await client.post(
        f"/v1/intakes/{intake_id}/question-batches", params={"size": 5},
        headers=ctx.as_("commenter"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert _ids(resp.json()["questions"]) == _ids(preview["questions"])


async def test_preview_matches_ask_with_the_authors_hidden_questions(client, fake):
    """The author's private questions ride along in the preview exactly as asked (S6)."""
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx)
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    fake(_model)
    out = await create_intake(client, ctx, who="author", ai_extraction=True, batch_size=1)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    intake_id = out["intake"]["id"]
    for size in (1, 3):
        preview = (await _next(client, ctx, intake_id, "author", size)).json()
        others = (await _next(client, ctx, intake_id, "approver", size)).json()
        assert CODENAME not in str(others)
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches", params={"size": size},
            headers=ctx.as_("author"),
        )  # fmt: skip
        assert resp.status_code == 200, resp.text
        assert _ids(resp.json()["questions"]) == _ids(preview["questions"])
        assert len(others["questions"]) <= size


async def test_next_batch_is_for_the_author_or_an_approver(client):
    ctx = await company()
    out = await create_intake(client, ctx, who="approver")
    intake_id = out["intake"]["id"]
    for who in ("commenter", "viewer"):
        resp = await _next(client, ctx, intake_id, who)
        assert resp.status_code == 403, (who, resp.text)
    for who in ("approver", "owner"):
        assert (await _next(client, ctx, intake_id, who)).status_code == 200
    assert (await _next(client, ctx, intake_id, "approver", 11)).status_code == 422


async def test_next_batch_is_empty_when_nothing_is_left(client):
    ctx = await company()
    out = await create_intake(client, ctx, batch_size=10)
    intake_id = out["intake"]["id"]
    while True:
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches", params={"size": 10},
            headers=ctx.as_("commenter"),
        )  # fmt: skip
        if resp.status_code == 409:
            break
    preview = (await _next(client, ctx, intake_id, "commenter")).json()
    assert preview == {"questions": [], "remaining": 0}


# --- the draft gate ---------------------------------------------------------------------------


async def test_draft_gate_blocks_on_shared_critical(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    gap = await _critical_gap(client, ctx, intake_id)

    resp = await _create_run(client, ctx, intake_id)
    assert resp.status_code == 409, resp.text
    body = resp.json()
    assert body["detail"] == "1 critical question is open on this brief"
    assert body["blocking_gap_ids"] == [gap["id"]]
    shown = await read_summary(client, ctx, intake_id)
    assert shown["readiness"]["gate"] == "blocked"
    assert shown["intake"]["status"] != "converted"

    # Validating a hard blocker unanswered is an owner's call (B4).
    resp = await client.post(
        f"/v1/gaps/{gap['id']}/decisions",
        json={"decision": "validate", "rationale": "The partner confirmed the quota."},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    resp = await _create_run(client, ctx, intake_id)
    assert resp.status_code == 201, resp.text
    assert resp.json()["status"] == "draft"


async def test_two_open_critical_questions_are_counted(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    first = await _critical_gap(client, ctx, intake_id)
    second = await _critical_gap(client, ctx, intake_id)
    resp = await _create_run(client, ctx, intake_id)
    assert resp.status_code == 409
    assert resp.json()["detail"] == "2 critical questions are open on this brief"
    assert set(resp.json()["blocking_gap_ids"]) == {first["id"], second["id"]}


async def test_a_private_critical_gap_does_not_block_the_run(client, fake):
    ctx = await company()
    await add_account(ctx.tenant_id, "personal", windows={"five_hour": window(0.2)})
    await add_author(ctx, "approver")
    await make_item(ctx, "author", content=EXCERPT_A, title=TITLE_A)
    fake(_private_blocker)
    out = await create_intake(client, ctx, who="author", ai_extraction=True)
    assert (await worker.run_pending(ctx.tenant_id)).succeeded == 1
    intake_id = out["intake"]["id"]
    mine = await read_summary(client, ctx, intake_id, "author")
    assert mine["readiness"]["private_blocking_gap_ids"]
    assert mine["readiness"]["gate"] == "clear"
    resp = await _create_run(client, ctx, intake_id, who="author")
    assert resp.status_code == 201, resp.text


async def test_starting_an_intake_run_waits_for_a_critical_gap_added_later(client, runtime):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    resp = await _create_run(client, ctx, intake_id)
    assert resp.status_code == 201, resp.text
    run_id = resp.json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    gap = await _critical_gap(client, ctx, intake_id)

    resp = await client.post(f"/v1/runs/{run_id}/start", headers=approver)
    assert resp.status_code == 409, resp.text
    assert resp.json()["blocking_gap_ids"] == [gap["id"]]
    assert runtime.submitted == []

    resp = await client.post(
        f"/v1/gaps/{gap['id']}/decisions",
        json={"decision": "accept_risk", "rationale": "We ship behind the quota."},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=approver)
    assert resp.status_code == 200, resp.text


# --- answers pinned to the run ----------------------------------------------------------------


async def test_run_pins_answers(client, runtime):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    intake_id = out["intake"]["id"]
    first, second = (await batch(client, ctx, intake_id))["questions"][:2]
    before = await answer(client, ctx, first["question"]["id"], body="Returning buyers.")

    resp = await _create_run(client, ctx, intake_id)
    run_id = resp.json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    resp = await client.post(f"/v1/runs/{run_id}/start", headers=approver)
    assert resp.status_code == 200, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, uuid.UUID(run_id))
        assert run.knobs["intake_answer_ids"] == [before["answer"]["id"]]

    later = await answer(client, ctx, second["question"]["id"], body="Checkout time.")
    as_run = _as_run(ctx, run_id)
    for question, kept in ((first, [before]), (second, [])):
        params = {"question_id": question["question"]["id"]}
        resp = await client.get("/v1/answers", params=params, headers=as_run)
        assert resp.status_code == 200, resp.text
        assert [a["id"] for a in resp.json()] == [a["answer"]["id"] for a in kept]
        # A person reads every answer.
        resp = await client.get("/v1/answers", params=params, headers=ctx.as_("viewer"))
        assert len(resp.json()) == 1
    resp = await client.get(f"/v1/answers/{later['answer']['id']}", headers=as_run)
    assert resp.status_code == 404
    cards = {
        c["question"]["id"]: c
        for c in (
            await client.get(f"/v1/intakes/{intake_id}/question-batch", headers=as_run)
        ).json()["questions"]
    }
    assert cards[first["question"]["id"]]["answers"][0]["id"] == before["answer"]["id"]
    assert cards[second["question"]["id"]]["answers"] == []
    mine = (await batch(client, ctx, intake_id, who="viewer"))["questions"]
    assert any(a["id"] == later["answer"]["id"] for c in mine for a in c["answers"])

    # The page tells people how many answers came after drafting started.
    assert (await read_summary(client, ctx, intake_id))["answers_since_run"] == 1


async def test_the_step_prompt_says_answers_are_pinned(client, runtime):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    run_id = (await _create_run(client, ctx, out["intake"]["id"])).json()["id"]
    approver = ctx.as_("approver")
    assert (await client.post(f"/v1/runs/{run_id}/estimate", headers=approver)).status_code == 200
    assert (await client.post(f"/v1/runs/{run_id}/start", headers=approver)).status_code == 200
    prompt = runtime.submitted[0].steps[0].prompt
    assert "This run uses the answers given before it started." in prompt
    assert "Later answers reach the next draft." in prompt


async def test_answers_since_run_is_zero_before_drafting(client):
    ctx = await company()
    out = await intake_with_source(client, ctx)
    assert out["answers_since_run"] == 0
