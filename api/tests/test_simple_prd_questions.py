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

Review fixes (verdict NOT_YET):

- test_job_queued_once_per_version: protects=a PRD version with an open questions heading
  but no table queues one prd_questions job, read through ensure -> enqueue -> run_job, and
  never another for that version once it ran (even when it found nothing);
  fails_when=every GET queues another paid call; no_claim=the job runner's retries.
- test_concurrent_reads_import_once: protects=two reads at once right after approval import
  each question once; fails_when=an IntegrityError (a 500 on Home or the rail);
  no_claim=imports in other tenants.
- test_undo_name_decider_restores_needs_input: protects=undoing "Name a decider" puts the
  question back in Needs input with no decider; fails_when=the company owner shows as the
  named decider; no_claim=the web.
- test_hidden_prd_question_refused: protects=a commenter cannot propose on a question of a
  PRD they may not read; fails_when=a 201; no_claim=owners.
- test_removed_question_leaves: protects=a question a newer approved version drops leaves
  the list; fails_when=it stays open; no_claim=decided ones kept in the log.
- test_due_follows_the_plan_read_again: protects=a re-read plan that moves a milestone moves
  the due days; fails_when=the import-time day stays; no_claim=holidays.
- test_long_titles_cut_at_a_word: protects=a long question title is cut at a word;
  fails_when=a word is cut in half; no_claim=the web's wrapping.
- test_filters_narrow_questions: protects=the Decisions page's PRD and meeting filters
  narrow the questions too; fails_when=another PRD's questions show; no_claim=goals.

Fidelity (option A "Imported as decisions", 2026-10-28):

- test_page_source_outside_meetings_and_approvals: protects=each question says which
  approved version it was read from and when ("From Guided setup draft 1 · read Oct 28");
  Outside meetings lists a decided question with its code and answer and never an open one
  (those wait in "Waiting for you"); the foot names one run approval; fails_when=the source
  is missing, an open question shows outside meetings or the example is wrong;
  no_claim=the web's wording.
- test_meeting_agenda_keeps_what_it_decided: protects=a review meeting's agenda is the open
  questions blocking the milestone the soonest one blocks, and a question decided in the
  meeting stays on it with Undo for who decided it (others see no Undo); Undo opens it again;
  fails_when=another milestone's question is on the agenda, a decided one leaves it, or the
  Undo is offered to someone else; no_claim=the minutes' words.
- test_decided_label_company_zone (qa-simple-decide-7): protects=``decided_label`` reads a
  decision's day in the company's zone (America/Los_Angeles), so a decision decided at 7 PM
  PDT Oct 29 (02:00 UTC Oct 30) reads "Oct 29", not "Oct 30"; the mock's own decided_label
  (web/lib/api/mock/simple-questions.ts) must read the same day; fails_when=the label uses
  UTC; no_claim=the mock itself (web tests cover it).
"""

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from sqlalchemy import func, select

from oracle import company_time
from oracle.auth.models import User
from oracle.decisions.models import Decision
from oracle.docs.models import Document, DocumentVersion
from oracle.jobs.models import LlmJob
from oracle.review.models import DocumentReviewPolicy
from oracle.simple import plan, questions
from oracle.simple.models import SimplePrdPlan
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


async def seed(ctx: Ctx, body: str = FIXTURE, with_decider: bool = True) -> dict:
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
        if with_decider:
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
    assert qs["Q3"]["due_label"] == "Due Fri Nov 27"
    assert qs["Q8"]["due_on"] == "2026-11-30"  # M2, a later milestone: its start
    assert qs["Q13"]["due_on"] == "2026-12-28"
    later = datetime(2026, 11, 10, 15, 0, tzinfo=UTC)
    monkeypatch.setattr(company_time, "now", lambda: later)
    qs = {q["code"]: q for q in (await page(client, ctx))["questions"]}
    assert qs["Q2"]["late"] is True and qs["Q2"]["due_label"] == "Late · due Fri Nov 6"
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
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    after = {x["code"]: x for x in (await page(client, ctx, role))["questions"]}["Q3"]
    if role in ("owner", "decider"):
        assert change["status"] == "applied" and change["can_undo"] is True
        assert after["status"] == "decided" and after["chosen"] == "Option A for question 3"
        u = await client.post(f"/v1/simple/changes/{change['id']}/undo", headers=ctx.as_(role))
        assert u.status_code in (200, 201), u.text
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
                       origin="checkpoint",
                       options=[{"key": "approve", "label": "Approve"}]))  # fmt: skip
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


NO_TABLE = FIXTURE.split("## Open questions")[0] + "## Open questions\n\nQ1: Who signs off?\n"


async def test_job_queued_once_per_version(client):
    ctx = await make_ctx()
    ids = await seed(ctx, NO_TABLE)
    for _ in range(2):
        await page(client, ctx)
        await client.get("/v1/simple/decisions/waiting", headers=ctx.as_("owner"))

    async def jobs(s):
        return list(await s.scalars(select(LlmJob).where(LlmJob.kind == "prd_questions")))

    async with tenant_session(ctx.tenant_id) as s:
        (job,) = await jobs(s)
        job.status = "running"
        await s.commit()
    await page(client, ctx)  # running: not queued again
    async with tenant_session(ctx.tenant_id) as s:
        (job,) = await jobs(s)

        async def nothing(kind, payload):
            return {"questions": []}

        assert (await questions.run_job(s, job, nothing))["read"] is True
        job.status = "succeeded"
        await s.commit()
    await page(client, ctx)  # read, found nothing: never asked again for this version
    async with tenant_session(ctx.tenant_id) as s:
        assert len(await jobs(s)) == 1
        prd = await s.get(Document, ids["prd"])
        await version(s, prd, 2, NO_TABLE.replace("Who signs off", "Who signs it off"))
        await s.commit()
    await page(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        job = next(j for j in await jobs(s) if j.status == "queued")

        async def fake(kind, payload):
            assert kind == "prd_questions" and "Who signs it off" in payload["text"]
            return {"questions": [{"code": "Q1", "title": "Who signs it off",
                                   "recommendation": "The PM", "alternatives": ["The lead"],
                                   "milestone": "M1", "features": ["F-01"]}]}  # fmt: skip

        assert (await questions.run_job(s, job, fake))["questions"] == 1
        job.status = "succeeded"
        await s.commit()
    qs = (await page(client, ctx))["questions"]
    assert [q["code"] for q in qs] == ["Q1"] and qs[0]["recommendation"] == "The PM"


async def test_concurrent_reads_import_once(client):
    ctx = await make_ctx()
    ids = await seed(ctx)

    async def read():
        async with tenant_session(ctx.tenant_id) as s:
            await questions.ensure(s, await s.get(Document, ids["prd"]))
            await s.commit()

    await asyncio.gather(read(), read())
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Decision)) == 16


async def test_undo_name_decider_restores_needs_input(client):
    ctx = await make_ctx()
    await seed(ctx, with_decider=False)
    q = next(q for q in (await page(client, ctx))["questions"] if q["code"] == "Q3")
    assert q["missing"] == "decider" and q["decider"] is None, (
        q["status"],
        q["column"],
        q["missing"],
        q["decider"],
        q["can"],
    )
    r = await client.post("/v1/simple/changes", headers=ctx.as_("owner"), json={
        "op": "name_decider", "target": {"decision_id": q["id"]}, "before": {},
        "after": {"decider_id": str(ctx.users["approver"].id)}})  # fmt: skip
    assert r.status_code == 201, r.text
    named = {x["code"]: x for x in (await page(client, ctx))["questions"]}["Q3"]
    assert named["decider"]["id"] == str(ctx.users["approver"].id)
    u = await client.post(f"/v1/simple/changes/{r.json()['change']['id']}/undo",
                          headers=ctx.as_("owner"))  # fmt: skip
    assert u.status_code in (200, 201), u.text
    again = {x["code"]: x for x in (await page(client, ctx))["questions"]}["Q3"]
    assert again["missing"] == "decider" and again["decider"] is None
    assert again["column"] == "needs_input"


async def test_hidden_prd_question_refused(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    q = next(q for q in (await page(client, ctx))["questions"] if q["code"] == "Q3")
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(Document, ids["prd"])).visibility = "approvers"
        await s.commit()
    r = await client.post("/v1/simple/changes", headers=ctx.as_("commenter"), json={
        "op": "decide_question", "target": {"decision_id": q["id"]},
        "before": {"status": "proposed"}, "after": {"option": "recommended"}})  # fmt: skip
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "No such question", r.text


async def test_removed_question_leaves(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    await page(client, ctx)
    body = "\n".join(line for line in FIXTURE.splitlines() if not line.startswith("| Q16 "))
    assert body != FIXTURE
    async with tenant_session(ctx.tenant_id) as s:
        await version(s, await s.get(Document, ids["prd"]), 2, body)
        await s.commit()
    qs = (await page(client, ctx))["questions"]
    assert len(qs) == 15 and "Q16" not in {q["code"] for q in qs}
    w = (await client.get("/v1/simple/decisions/waiting", headers=ctx.as_("decider"))).json()
    assert "Q16" not in {q["code"] for q in w["questions"]}


async def test_due_follows_the_plan_read_again(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    qs = {q["code"]: q for q in (await page(client, ctx))["questions"]}
    assert qs["Q3"]["due_on"] == "2026-11-27"
    async with tenant_session(ctx.tenant_id) as s:
        v = await questions.approved(s, ids["prd"])
        data = plan.parse(FIXTURE, v.approved_at.date())
        data["milestones"][0]["end"] = "2026-12-04"
        s.add(SimplePrdPlan(document_id=ids["prd"], version_id=v.id, status="ready",
                            source="prd", data=data, read_at=NOW))  # fmt: skip
        await s.commit()
    qs = {q["code"]: q for q in (await page(client, ctx))["questions"]}
    assert qs["Q3"]["due_on"] == "2026-12-04" and qs["Q3"]["due_label"] == "Due Fri Dec 4"


async def test_long_titles_cut_at_a_word(client):
    long = "Should we " + "really " * 40 + "go out on Mondays"
    (q,) = questions.clean({"questions": [{"code": "Q1", "title": long}]})
    assert len(q["title"]) <= 200 and long.startswith(q["title"].rstrip("…"))
    assert q["title"].rstrip("…").endswith("really")
    ctx = await make_ctx()
    ids = await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        v = await questions.approved(s, prd.id)
        await questions.import_answer(s, prd, v, [{**q, "title": long}])
        await s.commit()
        d = await s.scalar(select(Decision).where(Decision.title.like("Should%")))
        assert len(d.title) <= 200 and d.title.rstrip("…").endswith("really")


async def test_filters_narrow_questions(client):
    ctx = await make_ctx()
    await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        s.add(Document(slug="usage-alerts", title="Usage alerts", kind="prd",
                       status="approved", visibility="company"))  # fmt: skip
        await s.commit()
    assert len((await page(client, ctx))["questions"]) == 16
    r = await client.get("/v1/simple/decisions?prd=usage-alerts", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["questions"] == [] and r.json()["waiting_count"] == 0
    r = await client.get("/v1/simple/decisions?prd=guided-setup", headers=ctx.as_("owner"))
    assert len(r.json()["questions"]) == 16
    r = await client.get(f"/v1/simple/decisions?meeting={uuid.uuid4()}", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert r.json()["questions"] == []


async def test_page_source_outside_meetings_and_approvals(client):
    ctx = await make_ctx()
    await seed(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.decisions.service import next_number

        s.add(Decision(number=await next_number(s), title="Approve Baseline confirm",
                       status="proposed", approver_id=ctx.users["decider"].id, driver="oracle",
                       origin="checkpoint",
                       options=[{"key": "approve", "label": "Approve"}]))  # fmt: skip
        await s.commit()
    body = await page(client, ctx, "decider")
    q3 = {q["code"]: q for q in body["questions"]}["Q3"]
    assert q3["source"]["version"] == 1 and q3["source"]["read_at"].startswith("2026-10-28")
    prd_rows = [d for d in body["other"] if d["origin"] == "prd"]
    assert [d["code"] for d in prd_rows] == ["Q1"]
    assert prd_rows[0]["chosen"] == "Option A for question 1"
    assert body["approvals_waiting"] == 1
    assert body["approvals_example"] is not None
    assert body["approvals_example"].startswith("D-")
    assert body["approvals_example"].endswith(" Approve Baseline confirm")


async def test_meeting_agenda_keeps_what_it_decided(client):
    ctx = await make_ctx()
    await seed(ctx)
    await page(client, ctx)
    r = await client.post("/v1/simple/meetings", headers=ctx.as_("decider"),
                          json={"prd": "guided-setup", "title": "Decisions due"})  # fmt: skip
    assert r.status_code == 201, r.text
    m = r.json()
    # Q2 (due Nov 6) and Q3..Q6 block M1; Q7.. block later milestones.
    assert [q["code"] for q in m["decisions_due"]] == ["Q2", "Q3", "Q4", "Q5", "Q6"]
    # The agenda holds the PRD's questions; "Open decisions" never lists them again.
    assert not [d for d in m["open_decisions"] if d["title"].startswith("Question number")]
    q3 = next(q for q in m["decisions_due"] if q["code"] == "Q3")
    c = await client.post("/v1/simple/changes", headers=ctx.as_("decider"), json={
        "op": "decide_question", "target": {"decision_id": q3["id"]},
        "session_id": m["session_id"], "before": {"status": "proposed"},
        "after": {"option": "recommended"}})  # fmt: skip
    assert c.status_code == 201, c.text
    change = c.json()["change"]
    url = f"/v1/simple/meetings/{m['id']}"
    mine = {q["code"]: q for q in (await client.get(url, headers=ctx.as_("decider"))).json()[
        "decisions_due"]}  # fmt: skip
    assert list(mine) == ["Q2", "Q3", "Q4", "Q5", "Q6"]
    assert mine["Q3"]["status"] == "decided" and mine["Q3"]["undo_id"] == change["id"]
    assert mine["Q3"]["chosen"] == "Option A for question 3"
    theirs = (await client.get(url, headers=ctx.as_("owner"))).json()["decisions_due"]
    assert next(q for q in theirs if q["code"] == "Q3")["undo_id"] is None
    u = await client.post(f"/v1/simple/changes/{change['id']}/undo", headers=ctx.as_("decider"))
    assert u.status_code in (200, 201), u.text
    again = {q["code"]: q for q in (await client.get(url, headers=ctx.as_("decider"))).json()[
        "decisions_due"]}  # fmt: skip
    assert again["Q3"]["status"] == "proposed" and again["Q3"]["undo_id"] is None


async def test_decided_label_company_zone(client):
    """qa-simple-decide-7: decided_label reads the company's zone (America/Los_Angeles),
    not UTC. The mock's decided_label (web/lib/api/mock/simple-questions.ts) must match."""
    ctx = await make_ctx()
    await seed(ctx)
    q = next(q for q in (await page(client, ctx))["questions"] if q["code"] == "Q3")
    r = await client.post("/v1/simple/changes", headers=ctx.as_("decider"), json={
        "op": "decide_question", "target": {"decision_id": q["id"]},
        "before": {"status": "proposed"}, "after": {"option": "recommended"}})  # fmt: skip
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.get(Decision, uuid.UUID(q["id"]))
        # 7 PM PDT Oct 29, 2026 is 02:00 UTC Oct 30: the company's day is still Oct 29.
        d.decided_at = datetime(2026, 10, 30, 2, 0, tzinfo=UTC)
        await s.commit()
    assert company_time.date_in_words(company_time.day(d.decided_at)) == "Thu Oct 29"
    after = {x["code"]: x for x in (await page(client, ctx))["questions"]}["Q3"]
    assert after["decided_label"].startswith("Decided on Thu Oct 29 by")
