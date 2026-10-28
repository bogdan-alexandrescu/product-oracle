"""prd-questions: a PRD's open questions read in as decisions (oracle.simple.questions),
through Simple's Decisions, the waiting list and the change engine. Against Postgres; the
company's clock is Wed Oct 28, 2026; the PRD is INVENTED (16 questions, Q1 decided).

Test cards (protects / fails_when / no_claim):

- test_import_reads_sixteen_questions: protects=each question of the approved version
  becomes a decision with the PRD's code, its recommendation and alternatives, what it
  blocks and its due day; Q1 arrives decided with its date; fails_when=a question is
  missing, Q1 is open or a code is lost; no_claim=the web.
- test_reimport_never_duplicates: protects=a newly approved version that rewords a
  question updates its decision (16 rows still); fails_when=a 17th row or the old words;
  no_claim=drafts.
- test_due_dates_from_the_plan: protects=a PRD's date wins; else the running (or next)
  milestone's end; a question blocking a later milestone is due at its start; "Late"
  past it; fails_when=a calendar-quarter or Now-window date; no_claim=holidays.
- test_decide_per_role (owner, decider, approver, commenter, viewer): protects=owners and
  the decider apply (undoable), approvers and commenters propose, viewers are refused;
  fails_when=a role writes that may not; no_claim=the meeting's minutes.
- test_run_approvals_not_counted: protects=Oracle's run approvals (checkpoint records) are
  neither listed nor counted as waiting, only counted for Detailed; fails_when=a
  checkpoint shows up in the waiting count; no_claim=Detailed's Inbox.
- test_job_reads_a_prd_without_a_table: protects=a PRD with questions but no table is read
  by the prd_questions llm job (a fake model); fails_when=nothing is imported;
  no_claim=the live model.
"""

import hashlib
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, select

from oracle import company_time
from oracle.auth.models import User
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.simple import questions
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 10, 28, 19, 0, tzinfo=UTC)
FIXTURE = (Path(__file__).parent / "fixtures" / "prd_questions_invented.md").read_text()


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def version(s, doc: Document, n: int, body: str):
    v = DocumentVersion(document_id=doc.id, number=n, markdown=body,
                        content_hash=hashlib.sha256(body.encode()).hexdigest(),
                        approved_at=datetime(2026, 10, 20 + n, tzinfo=UTC))  # fmt: skip
    s.add(v)
    await s.flush()
    return v


async def seed(ctx: Ctx, body: str = FIXTURE) -> dict:
    async with tenant_session(ctx.tenant_id) as s:
        prd = Document(slug="guided-setup", title="Guided setup", kind="prd", status="approved",
                       visibility="company")  # fmt: skip
        s.add(prd)
        await s.flush()
        await version(s, prd, 1, body)
        decider = User(email="decider@example.com", password_hash="x", role="approver")
        s.add(decider)
        await s.flush()
        ctx.users["decider"] = decider
        s.add(DocumentReviewPolicy(document_id=prd.id, decider_id=decider.id))
        await s.commit()
        return {"prd": prd.id}


async def page(client, ctx, role="owner"):
    r = await client.get("/v1/simple/decisions", headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


async def test_import_reads_sixteen_questions(client):
    ctx = await make_ctx()
    await seed(ctx)
    body = await page(client, ctx)
    qs = {q["code"]: q for q in body["questions"]}
    assert len(qs) == 16
    assert qs["Q1"]["status"] == "decided" and qs["Q1"]["column"] == "decided"
    assert qs["Q1"]["decided_at"].startswith("2026-10-20")
    q3 = qs["Q3"]
    assert q3["title"] == "Question number 3"
    assert q3["recommendation"] == "Option A for question 3"
    assert [a["label"] for a in q3["alternatives"]] == [
        "Option B for question 3", "Option C for question 3"]  # fmt: skip
    assert q3["blocks"]["label"] == "Blocks M1: F-01 Setup checklist"
    assert q3["column"] == "recommended" and q3["decider"]["id"] == str(ctx.users["decider"].id)
    assert qs["Q16"]["column"] == "needs_input" and qs["Q16"]["missing"] == "recommendation"


async def test_reimport_never_duplicates(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    await page(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        await version(s, prd, 2, FIXTURE.replace("Question number 7 ", "Question seven, reworded "))
        await s.commit()
    body = await page(client, ctx)
    assert len(body["questions"]) == 16
    assert {q["code"]: q["title"] for q in body["questions"]}["Q7"] == "Question seven, reworded"
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Decision)) == 16


async def test_due_dates_from_the_plan(client, monkeypatch):
    ctx = await make_ctx()
    await seed(ctx)
    qs = {q["code"]: q for q in (await page(client, ctx))["questions"]}
    assert qs["Q2"]["due_on"] == "2026-11-06"  # the PRD's own date
    assert qs["Q3"]["due_on"] == "2026-11-27"  # M1 (the next to run): its end
    assert qs["Q3"]["due_label"] == "Due Fri 27 Nov"
    assert qs["Q8"]["due_on"] == "2026-11-30"  # M2, a later milestone: its start
    assert qs["Q13"]["due_on"] == "2026-12-28"
    later = datetime(2026, 11, 10, 15, 0, tzinfo=UTC)
    monkeypatch.setattr(company_time, "now", lambda: later)
    qs = {q["code"]: q for q in (await page(client, ctx))["questions"]}
    assert qs["Q2"]["late"] is True and qs["Q2"]["due_label"] == "Late · due Fri 6 Nov"
    assert qs["Q3"]["late"] is False


@pytest.mark.parametrize("role", ["owner", "decider", "approver", "commenter", "viewer"])
async def test_decide_per_role(client, role):
    ctx = await make_ctx()
    await seed(ctx)
    q = next(q for q in (await page(client, ctx, role))["questions"] if q["code"] == "Q3")
    r = await client.post("/v1/simple/changes", headers=ctx.as_(role), json={
        "op": "decide_question", "target": {"decision_id": q["id"]},
        "before": {"status": "proposed"}, "after": {"option": "recommended"}})  # fmt: skip
    if role == "viewer":
        assert r.status_code == 403, r.text
        return
    assert r.status_code == 200, r.text
    change = r.json()["change"]
    after = {x["code"]: x for x in (await page(client, ctx, role))["questions"]}["Q3"]
    if role in ("owner", "decider"):
        assert change["status"] == "applied" and change["can_undo"] is True
        assert after["status"] == "decided" and after["chosen"] == "Option A for question 3"
        u = await client.post(f"/v1/simple/changes/{change['id']}/undo", headers=ctx.as_(role))
        assert u.status_code == 200, u.text
        again = {x["code"]: x for x in (await page(client, ctx, role))["questions"]}["Q3"]
        assert again["status"] == "proposed"
    else:
        assert change["status"] == "proposed"
        assert after["status"] == "proposed" and after["pending"]["answer"]
    waiting = (await client.get("/v1/simple/decisions/waiting", headers=ctx.as_("decider"))).json()
    assert waiting["count"] == len([x for x in waiting["questions"]]) + waiting["others"]


async def test_run_approvals_not_counted(client):
    ctx = await make_ctx()
    await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.decisions.service import next_number

        s.add(Decision(number=await next_number(s), title="Approve Baseline confirm",
                       status="proposed", approver_id=ctx.users["decider"].id, driver="oracle",
                       origin="checkpoint", options=[{"key": "approve", "label": "Approve"}]))  # fmt: skip
        await s.commit()
    await page(client, ctx)
    w = (await client.get("/v1/simple/decisions/waiting", headers=ctx.as_("decider"))).json()
    assert w["approvals_waiting"] == 1
    assert w["count"] == 15  # Q2..Q16, none of them a run approval
    assert all(q["title"] != "Approve Baseline confirm" for q in w["questions"])


async def test_job_reads_a_prd_without_a_table(client, monkeypatch):
    ctx = await make_ctx()
    body = FIXTURE.split("## Open questions")[0] + "## Open questions\n\nQ1: Who signs off?\n"
    ids = await seed(ctx, body)

    async def fake(kind, payload):
        assert kind == "prd_questions" and "Who signs off" in payload["text"]
        return {"questions": [{"code": "Q1", "title": "Who signs off", "recommendation":
                               "The PM", "alternatives": ["The lead"], "milestone": "M1",
                               "features": ["F-01"]}]}  # fmt: skip

    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        v = await questions.approved(s, prd.id)
        await questions.import_answer(s, prd, v, await fake("prd_questions",
                                                           questions.payload(prd, v)))  # fmt: skip
        await s.commit()
    qs = (await page(client, ctx))["questions"]
    assert [q["code"] for q in qs] == ["Q1"] and qs[0]["recommendation"] == "The PM"
