"""Security review, round 2 (S6 and B4): write responses go through the readers' view,
later model jobs never publish private model text, list pages never shift for hidden
rows, and an answer in another intake never clears a critical gap.

Synthetic placeholders only.
"""

import json
import uuid

import pytest
from sqlalchemy import func, select, update

from oracle import readiness
from oracle.auth.service import make_session_cookie
from oracle.config import get_settings
from oracle.intake import checks as intake_checks
from oracle.intake import sharing
from oracle.jobs import worker
from oracle.jobs.models import LlmJob
from oracle.llm import gateway
from oracle.sources.items import current_xid
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.v2.models import KnowledgeGap, ProductIntake, StakeholderQuestion
from tests.intake_helpers import (
    answer,
    batch,
    company,
    create_intake,
    gaps_by_category,
)
from tests.test_intake import _document
from tests.test_intake_jobs import FakeClaude
from tests.test_intake_rules import BLOCKER_BRIEF
from tests.test_intake_sharing import (
    CODENAME,
    LEVELS,
    MODEL_GAP,
    SECRETS,
    authored_intake,
    findings,
    read_summary,
    reader_texts,
    share_all,
)

INFERRED = "Oracle inferred it from sources"


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


def as_run(ctx) -> dict[str, str]:
    """How a run token of the author's run reaches REST: the author's session, marked
    as the run's (oracle.mcp.auth.user_caller)."""
    cookie = make_session_cookie(ctx.users["author"])
    return {"cookie": f"{get_settings().session_cookie_name}={cookie}",
            "x-oracle-run-id": str(uuid.uuid4())}  # fmt: skip


def headers(ctx, who: str) -> dict[str, str]:
    return as_run(ctx) if who == "run" else ctx.as_(who)


async def author_questions(ctx, intake_id: str) -> tuple[StakeholderQuestion, StakeholderQuestion]:
    """(the model-written gap's question, a rule-made gap's question whose evidence is
    the author's)."""
    async with tenant_session(ctx.tenant_id) as s:
        gaps = (
            await s.scalars(select(KnowledgeGap).where(KnowledgeGap.intake_id == intake_id))
        ).all()
        model = next(g for g in gaps if g.statement == MODEL_GAP)
        rule = next(
            g for g in gaps
            if g.statement != MODEL_GAP and g.knowledge_state == "ai_inference"
            and g.evidence_ids and g.status in ("unknown", "asked")
        )  # fmt: skip
        out = []
        for gap in (model, rule):
            out.append(
                await s.scalar(
                    select(StakeholderQuestion).where(
                        StakeholderQuestion.gap_id == gap.id,
                        StakeholderQuestion.status != "withdrawn",
                    )
                )
            )
    return out[0], out[1]


# --- M1: the answer route returns what the reads return ----------------------------------


@pytest.mark.parametrize("level", LEVELS)
@pytest.mark.parametrize("who", ["viewer", "commenter", "approver", "owner", "run"])
async def test_the_answer_route_shows_the_question_as_the_reads_do(client, fake, level, who):
    ctx, intake_id, _ = await authored_intake(client, fake)
    if level != "private":
        await share_all(client, ctx, intake_id, level)
    model_q, rule_q = await author_questions(ctx, intake_id)
    h = headers(ctx, who)
    for q, hidden in ((model_q, level in ("private", "counts")), (rule_q, False)):
        resp = await client.post(
            f"/v1/questions/{q.id}/answers", json={"kind": "answer", "body": "Synthetic answer"},
            headers=h,
        )  # fmt: skip
        if who == "viewer":
            assert resp.status_code == 403, resp.text
            continue
        if hidden:
            assert resp.status_code == 404, (level, who, resp.text)
            continue
        assert resp.status_code == 201, (level, who, resp.text)
        out = resp.json()
        read = await client.get(f"/v1/questions/{q.id}", headers=h)
        assert read.status_code == 200, read.text
        assert out["question"] == read.json(), (level, who)
        gap = await client.get(f"/v1/gaps/{q.gap_id}", headers=h)
        assert out["gap"] == gap.json(), (level, who)
        if level != "full":
            for secret in [*SECRETS, MODEL_GAP]:
                assert secret not in resp.text, (level, who, secret)
        if level in ("private", "counts") and q is rule_q:
            assert INFERRED not in out["question"]["rationale"], (level, who)


async def test_the_author_still_sees_their_own_words_in_the_answer(client, fake):
    ctx, intake_id, _ = await authored_intake(client, fake)
    model_q, _ = await author_questions(ctx, intake_id)
    resp = await client.post(
        f"/v1/questions/{model_q.id}/answers", json={"kind": "defer"}, headers=ctx.as_("author")
    )
    assert resp.status_code == 201, resp.text
    assert MODEL_GAP in resp.json()["question"]["prompt"]


async def test_a_proposal_of_a_private_gap_is_404_to_everyone_else(client, fake):
    ctx, intake_id, _ = await authored_intake(client, fake)
    model_q, _ = await author_questions(ctx, intake_id)
    resp = await client.post(f"/v1/gaps/{model_q.gap_id}/research", headers=ctx.as_("author"))
    assert resp.status_code == 201, resp.text
    proposal = resp.json()["id"]
    for action in ("accept", "dismiss"):
        resp = await client.post(
            f"/v1/intake-proposals/{proposal}/{action}", headers=ctx.as_("owner")
        )
        assert resp.status_code == 404, (action, resp.text)


# --- M3: a later job never makes private model text public -------------------------------


async def test_a_job_after_a_repin_never_restates_private_model_text(client, fake):
    ctx, intake_id, _ = await authored_intake(client, fake)
    # The author's items are deleted: the next pin reads none of their sources.
    async with tenant_session(ctx.tenant_id) as s:
        owned = select(Source.id).where(Source.owner_user_id == ctx.users["author"].id)
        await s.execute(
            update(SourceItem)
            .where(SourceItem.source_id.in_(owned))
            .values(deleted_at=func.clock_timestamp(), deleted_xid=current_xid())
        )
        await s.commit()
    payloads = []

    def restate(payload):
        payloads.append(payload)
        said = [g["statement"] for g in payload["untrusted_data"]["gap_statements"]]
        return {
            "items": [{"field": "outcomes", "text": f"Restated: {s}", "evidence_refs": []}
                      for s in said],
            "gaps": [{"category": "non_goals", "importance": "high",
                      "statement": f"Echo of an earlier question: {s}"} for s in said[:2]],
            "category": "feature",
        }  # fmt: skip

    fake(restate)
    resp = await client.post(f"/v1/intakes/{intake_id}/repin", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    tick = await worker.run_pending(ctx.tenant_id)
    assert tick.succeeded == 1, tick.errors
    [payload] = payloads
    assert payload["untrusted_data"]["sources"] == []
    assert MODEL_GAP not in json.dumps(payload)
    for who in ("viewer", "owner", "run"):
        texts = await reader_texts(client, ctx, intake_id, who)
        for name, text in texts.items():
            for secret in [*SECRETS, MODEL_GAP]:
                assert secret not in text, (who, name, secret)
    # The author still sees their private gap, and it stays private.
    mine = await read_summary(client, ctx, intake_id, "author")
    [gap] = [g for g in mine["gaps"] if g["statement"] == MODEL_GAP]
    assert gap["sharing"] == "private"


# --- M4: pages never shift for hidden rows -----------------------------------------------


@pytest.mark.parametrize(
    "path", ["/v1/gaps", "/v1/questions", "/v1/answers", "/v1/change-events",
             "/v1/assumption-decisions"],
)  # fmt: skip
async def test_a_viewers_pages_never_shift_because_of_private_rows(client, fake, path):
    ctx, intake_id, _ = await authored_intake(client, fake, role="approver")
    model_q, _ = await author_questions(ctx, intake_id)
    # Public rows first, the author's private ones last (newest: the first page).
    shown = await batch(client, ctx, intake_id)
    for card in shown["questions"][:2]:
        await answer(client, ctx, card["question"]["id"], kind="dont_know")
    resp = await client.post(
        f"/v1/gaps/{shown['questions'][2]['gap']['id']}/decisions",
        json={"decision": "reject", "rationale": "Not yet."}, headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    await answer(client, ctx, str(model_q.id), who="author", kind="defer")
    resp = await client.post(
        f"/v1/gaps/{model_q.gap_id}/decisions",
        json={"decision": "reject", "rationale": "Not yet."}, headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text

    async def page(who: str, limit: int, offset: int) -> list[dict]:
        resp = await client.get(
            path, params={"limit": limit, "offset": offset}, headers=ctx.as_(who)
        )
        assert resp.status_code == 200, resp.text
        return resp.json()

    mine = await page("author", 500, 0)
    everyone = await page("viewer", 500, 0)
    assert len(everyone) < len(mine)  # something is hidden from the viewer
    for offset in range(len(everyone) + 1):
        assert await page("viewer", 1, offset) == everyone[offset : offset + 1], offset
    for offset in range(0, len(everyone), 2):
        assert await page("viewer", 2, offset) == everyone[offset : offset + 2], offset


# --- M6: an answer elsewhere never clears a critical gap ---------------------------------


async def _blocking(ctx, document_id: str, gap_id: str) -> bool:
    async with tenant_session(ctx.tenant_id) as s:
        report = await readiness.evaluate(
            readiness.ReadinessContext(s, uuid.UUID(document_id)),
            keys=[intake_checks.CRITICAL_BLOCKERS],
        )
    return any(gap_id in r.rationale for r in report.blocking)


async def _question_of(ctx, gap_id: str) -> str:
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(
            select(StakeholderQuestion).where(StakeholderQuestion.gap_id == uuid.UUID(gap_id))
        )
    return str(row.id)


@pytest.mark.parametrize("who", ["commenter", "owner"])
async def test_an_answer_in_another_intake_never_clears_a_critical_gap(client, who):
    ctx = await company()
    doc = await _document(client, ctx)
    # Intake A, on the PRD: blockers matter less here, and a commenter answers them.
    first = await create_intake(client, ctx, who="approver", document=doc)
    a_gap = gaps_by_category(first)["blockers"]
    q = await _question_of(ctx, a_gap["id"])
    done = await answer(client, ctx, q, who=who, body="The partner limit is fine.",
                        knowledge_state="hypothesis")  # fmt: skip
    assert done["gap"]["status"] in ("answered", "answered_pending_review")
    if who == "commenter":
        assert a_gap["importance"] != "critical" and done["gap"]["status"] == "answered"

    # Intake B, same PRD: a critical blocker. The answer in A does not clear it.
    second = await create_intake(client, ctx, who="approver", document=doc, brief=BLOCKER_BRIEF)
    b_gap = gaps_by_category(second)["blockers"]
    assert b_gap["importance"] == "critical"
    assert b_gap["status"] == "answered_pending_review", b_gap
    assert await _blocking(ctx, second["intake"]["document_id"], b_gap["id"])
    assert second["readiness"]["gate"] == "blocked"
    assert b_gap["id"] in second["readiness"]["blocking_gap_ids"]
    [row] = [c for c in second["coverage"] if c["category"] == "blockers"]
    assert row["state"] != "covered" and row["knowledge_state"] != "hypothesis"
    assert "owner" in row["reason"]
    # An owner reviews it, here.
    resp = await client.post(
        f"/v1/gaps/{b_gap['id']}/decisions",
        json={"decision": "validate", "rationale": "Same partner limit."},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 403
    resp = await client.post(
        f"/v1/gaps/{b_gap['id']}/decisions",
        json={"decision": "validate", "rationale": "Same partner limit."},
        headers=ctx.as_("owner"),
    )  # fmt: skip
    assert resp.status_code == 201, resp.text
    assert not await _blocking(ctx, second["intake"]["document_id"], b_gap["id"])


async def test_a_later_answer_elsewhere_never_closes_an_open_critical_gap(client):
    ctx = await company()
    doc = await _document(client, ctx)
    second = await create_intake(client, ctx, who="approver", document=doc, brief=BLOCKER_BRIEF)
    b_gap = gaps_by_category(second)["blockers"]
    assert b_gap["importance"] == "critical"
    # Not asked yet: the next analysis may close an unknown gap the baseline answers.
    async with tenant_session(ctx.tenant_id) as s:
        gap = await s.get(KnowledgeGap, uuid.UUID(b_gap["id"]))
        gap.status = "unknown"
        await s.execute(
            update(StakeholderQuestion)
            .where(StakeholderQuestion.gap_id == gap.id)
            .values(status="draft", batch=None)
        )
        await s.commit()
    first = await create_intake(client, ctx, who="approver", document=doc)
    q = await _question_of(ctx, gaps_by_category(first)["blockers"]["id"])
    await answer(client, ctx, q, body="The partner limit is fine.")
    resp = await client.post(
        f"/v1/intakes/{second['intake']['id']}/analyze", headers=ctx.as_("approver")
    )
    assert resp.status_code == 200, resp.text
    after = gaps_by_category(resp.json())["blockers"]
    assert after["status"] == "answered_pending_review", after
    assert after["knowledge_state"] == "user_decision"
    assert resp.json()["readiness"]["gate"] == "blocked"
    assert await _blocking(ctx, second["intake"]["document_id"], b_gap["id"])


# --- minors ------------------------------------------------------------------------------


async def test_conflict_and_stale_finding_ids_cannot_be_guessed(client, fake):
    ctx, intake_id, items = await authored_intake(client, fake)
    mine = await read_summary(client, ctx, intake_id, "author")
    [conflict] = [c for c in mine["conflicts"] if c["kind"] == "source"]
    ids = sorted(str(i) for i in (items["a"], items["b"]))
    iid = uuid.UUID(intake_id)
    guesses = {
        str(uuid.uuid5(iid, ":".join(["conflict", conflict["topic"], *ids]))),
        str(uuid.uuid5(iid, ":".join(["stale", str(items["old"])]))),
    }
    rows = await findings(client, ctx, intake_id)
    assert not guesses & {r["id"] for r in rows}
    # Ids survive a re-analysis, and so do the levels the author set.
    [row] = [r for r in rows if r["kind"] == "conflict"]
    resp = await client.patch(
        f"/v1/intakes/{intake_id}/findings/{row['id']}", json={"sharing": "counts"},
        headers=ctx.as_("author"),
    )  # fmt: skip
    assert resp.status_code == 200
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200
    again = {r["id"]: r for r in await findings(client, ctx, intake_id)}
    assert again[row["id"]]["sharing"] == "counts"
    assert {r["id"] for r in rows} == set(again)


async def test_a_legacy_stable_conflict_id_keeps_its_level_under_a_new_id(client, fake):
    ctx, intake_id, items = await authored_intake(client, fake)
    iid = uuid.UUID(intake_id)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, iid)
        analysis = dict(intake.analysis)
        reg = dict(analysis["findings"])
        [(fid, entry)] = [(k, v) for k, v in reg.items() if v["kind"] == "conflict"]
        [conflict] = analysis["conflicts"]
        ids = sorted({cl["item_id"] for cl in conflict["claims"]})
        legacy = sharing.stable_id(iid, "conflict", conflict["topic"], *ids)
        reg.pop(fid)
        reg[legacy] = {k: v for k, v in entry.items() if k != "match"} | {"sharing": "counts"}
        analysis["findings"] = reg
        intake.analysis = analysis
        await s.commit()
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200
    [row] = [r for r in await findings(client, ctx, intake_id) if r["kind"] == "conflict"]
    assert row["id"] != legacy and row["sharing"] == "counts"


async def test_question_order_and_batches_reveal_nothing_of_private_sources(client, fake):
    ctx, private_id, _ = await authored_intake(client, fake)
    plain = await create_intake(client, ctx, who="commenter")

    async def visible(intake_id: str) -> list[tuple]:
        resp = await client.get(
            "/v1/questions", params={"intake_id": intake_id, "limit": 500},
            headers=ctx.as_("viewer"),
        )  # fmt: skip
        rows = sorted(resp.json(), key=lambda q: q["priority"])
        return [(q["category"], q["priority"], q["batch"], q["status"]) for q in rows]

    assert await visible(private_id) == await visible(plain["intake"]["id"])


async def test_an_approver_asking_the_next_batch_leaves_private_gaps_alone(client, fake):
    ctx, intake_id, _ = await authored_intake(client, fake)
    model_q, _ = await author_questions(ctx, intake_id)
    sizes = []
    while True:
        resp = await client.post(
            f"/v1/intakes/{intake_id}/question-batches", params={"size": 5},
            headers=ctx.as_("approver"),
        )  # fmt: skip
        if resp.status_code == 409:
            break
        assert resp.status_code == 200, resp.text
        assert MODEL_GAP not in resp.text
        sizes.append(len(resp.json()["questions"]))
    assert sizes and all(n == 5 for n in sizes[:-1]), sizes
    async with tenant_session(ctx.tenant_id) as s:
        q = await s.get(StakeholderQuestion, model_q.id)
        gap = await s.get(KnowledgeGap, model_q.gap_id)
        assert q.status == "draft" and q.batch is None
        assert gap.status == "unknown"
    # The author asks it.
    resp = await client.post(f"/v1/intakes/{intake_id}/question-batches", headers=ctx.as_("author"))
    assert resp.status_code == 200, resp.text
    assert MODEL_GAP in resp.text


async def test_an_intake_jobs_output_is_the_authors_only(client, fake):
    ctx, intake_id, _ = await authored_intake(client, fake)
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.intake_id == uuid.UUID(intake_id)))
    url = f"/v1/llm-jobs/{job.id}"
    mine = await client.get(url, headers=ctx.as_("author"))
    assert mine.status_code == 200 and mine.json()["output"]["gaps_added"] == 1
    for who in ("viewer", "approver", "owner"):
        theirs = await client.get(url, headers=ctx.as_(who))
        assert theirs.status_code == 200, theirs.text
        assert theirs.json()["output"] is None, who
    theirs = await client.get(url, headers=as_run(ctx))
    assert theirs.json()["output"] is None


async def test_an_unregistered_model_gap_is_private_even_in_a_registered_intake(client, fake):
    """A model gap with no finding (written before S6) is private, whatever else the
    intake registered, and a re-analysis registers it as a private model finding."""
    ctx, intake_id, _ = await authored_intake(client, fake)
    model_q, _ = await author_questions(ctx, intake_id)
    async with tenant_session(ctx.tenant_id) as s:
        intake = await s.get(ProductIntake, uuid.UUID(intake_id))
        analysis = dict(intake.analysis)
        analysis["findings"] = {
            k: v for k, v in analysis["findings"].items() if k != str(model_q.gap_id)
        }
        intake.analysis = analysis
        await s.commit()
    for who in ("viewer", "owner"):
        texts = await reader_texts(client, ctx, intake_id, who)
        for name, text in texts.items():
            assert MODEL_GAP not in text and CODENAME not in text, (who, name)
    resp = await client.post(f"/v1/intakes/{intake_id}/analyze", headers=ctx.as_("author"))
    assert resp.status_code == 200
    for who in ("viewer", "owner"):
        texts = await reader_texts(client, ctx, intake_id, who)
        for name, text in texts.items():
            assert MODEL_GAP not in text and CODENAME not in text, (who, name)
    rows = {r["id"]: r for r in await findings(client, ctx, intake_id)}
    entry = rows[str(model_q.gap_id)]
    assert entry["origin"] == "model" and entry["sharing"] == "private"


def test_oracle_summary_refuses_three_words_of_a_source():
    source = "Shoppers abandon carts when the address form keeps resetting on mobile."
    fallback = "Oracle's fixed wording."
    said = "We should know why shoppers abandon carts so often."
    assert sharing.oracle_summary(said, [source], fallback) == fallback
    fine = "We should know why people leave checkout early."
    assert sharing.oracle_summary(fine, [source], fallback) != fallback
