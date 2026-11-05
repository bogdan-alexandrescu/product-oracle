"""simple-replaced-prds (the owner, Nov 4): a PRD marked replaced (POST
/v1/documents/{doc}/replaced-by) is history, read in Detailed only; Simple lists only the
PRDs that replaced it. A tenant with an older PRD (Trust plan, with open questions and an
open Simple draft) replaced by two area PRDs (User Safety, Scale): every Simple read that
lists PRDs (the one-pagers, the drafts, the review start sheet, the Decisions page's PRD
filter, the decisions waiting) names only the two area PRDs. Against Postgres. Invented data.

Test card: protects=no Simple list, picker, filter or count names a replaced PRD, and the
document page in Detailed still reads it with "Replaced by"; fails_when=Trust plan shows in
any of them; no_claim=the roadmap's items (test_one_roadmap_many_prds_api.py).
"""

import hashlib
from datetime import UTC, datetime
from pathlib import Path

import pytest

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)
QUESTIONS = (Path(__file__).parent / "fixtures" / "prd_questions_invented.md").read_text()
AREAS = {"User Safety", "Scale"}
OLD = "Trust plan"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def _prd(s, slug: str, title: str, body: str) -> Document:
    doc = Document(slug=slug, title=title, kind="prd", status="approved", visibility="company")
    s.add(doc)
    await s.flush()
    s.add(DocumentVersion(document_id=doc.id, number=1, markdown=body,
                          content_hash=hashlib.sha256(body.encode()).hexdigest(),
                          approved_at=datetime(2026, 10, 1, tzinfo=UTC)))  # fmt: skip
    await s.flush()
    return doc


async def world(client) -> Ctx:
    ctx = await make_ctx()
    async with tenant_session(ctx.tenant_id) as s:
        old = await _prd(s, "trust-plan", OLD, QUESTIONS)
        for slug, title in (("user-safety", "User Safety"), ("scale", "Scale")):
            d = await _prd(s, slug, title, QUESTIONS.replace("Guided setup", title))
            s.add(SimpleDraft(document_id=d.id, created_by=ctx.users["owner"].id))
        s.add(SimpleDraft(document_id=old.id, created_by=ctx.users["owner"].id))
        await s.commit()
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety", "scale"]})  # fmt: skip
    assert r.status_code == 200, r.text
    return ctx


async def _get(client, ctx: Ctx, path: str) -> dict | list:
    r = await client.get(path, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return r.json()


async def test_simple_one_pagers_list_only_the_area_prds(client):
    ctx = await world(client)
    rows = await _get(client, ctx, "/v1/simple/one-pagers")
    assert {d["title"] for d in rows} == AREAS
    # Detailed is unchanged: its list and the document page still read the old PRD.
    every = await _get(client, ctx, "/v1/documents?kind=prd")
    assert OLD in {d["title"] for d in every}
    page = await _get(client, ctx, "/v1/documents/trust-plan")
    assert [p["title"] for p in page["replaced_by"]] == ["User Safety", "Scale"]


async def test_simple_drafts_leave_out_the_replaced_prd(client):
    ctx = await world(client)
    drafts = await _get(client, ctx, "/v1/simple/drafts")
    assert {d["document"]["title"] for d in drafts} == AREAS


async def test_review_start_sheet_offers_only_the_area_prds(client):
    ctx = await world(client)
    options = await _get(client, ctx, "/v1/simple/meetings/options")
    assert {p["document"]["title"] for p in options["prds"]} == AREAS


async def test_decisions_filter_and_questions_only_the_area_prds(client):
    ctx = await world(client)
    page = await _get(client, ctx, "/v1/simple/decisions")
    assert {o["title"] for o in page["prds"]} == AREAS
    # Its open questions leave Simple; a decided one stays as history (re-review round 3).
    open_ = [q for q in page["questions"] if q["status"] == "proposed"]
    assert open_ and {q["prd"]["title"] for q in open_} == AREAS
    assert {q["status"] for q in page["questions"] if q["prd"]["title"] == OLD} <= {"decided"}
    waiting = await _get(client, ctx, "/v1/simple/decisions/waiting")
    assert waiting["questions"]
    assert {q["prd"]["title"] for q in waiting["questions"]} == AREAS


async def test_one_pager_of_the_replaced_prd_names_only_the_prds_that_replaced_it(client):
    """Fix round: GET /v1/simple/one-pagers/<replaced> (and its PDF and Remind) is a 404 whose
    detail names the PRDs that replaced it, never the one-pager; theirs still read."""
    ctx = await world(client)
    r = await client.get("/v1/simple/one-pagers/trust-plan", headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text
    detail = r.json()["detail"]
    assert [p["slug"] for p in detail["replaced_by"]] == ["user-safety", "scale"]
    assert [p["title"] for p in detail["replaced_by"]] == ["User Safety", "Scale"]
    assert "blocks" not in r.text
    r = await client.get("/v1/simple/one-pagers/trust-plan/pdf", headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text
    r = await client.post("/v1/simple/one-pagers/trust-plan/remind", headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text
    r = await client.get("/v1/simple/one-pagers/scale", headers=ctx.as_("owner"))
    assert r.status_code != 404, r.text


async def test_start_sheet_refuses_the_replaced_prd(client):
    ctx = await world(client)
    r = await client.get("/v1/simple/meetings/options?prd=trust-plan", headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text
    assert [p["slug"] for p in r.json()["detail"]["replaced_by"]] == ["user-safety", "scale"]
    r = await client.post("/v1/simple/meetings", headers=ctx.as_("owner"),
                          json={"prd": "trust-plan", "attendee_ids": []})  # fmt: skip
    assert r.status_code == 404, r.text
    options = await _get(client, ctx, "/v1/simple/meetings/options?prd=scale")
    assert [p["document"]["title"] for p in options["prds"]] == ["Scale"]


async def test_replaced_prds_past_meeting_and_its_decisions_stay_on_decisions(client):
    """Re-review round 3: marking a PRD replaced leaves it out of the Decisions page's PRD
    filter and its open questions only. Its past review meeting, the decisions taken in it
    and its decided questions stay on GET /v1/simple/decisions and ?meeting=<id>, as the
    Meetings page and the minutes inbox still link there."""
    from sqlalchemy import select

    from oracle.decisions.models import Decision
    from oracle.simple.models import SimpleMeeting, SimpleMeetingDecision, SimpleSession

    ctx = await make_ctx()
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        old = await _prd(s, "trust-plan", OLD, QUESTIONS)
        for slug, title in (("user-safety", "User Safety"), ("scale", "Scale")):
            await _prd(s, slug, title, QUESTIONS.replace("Guided setup", title))
        await s.commit()
    # The questions are read in, then one of Trust plan's is decided in its review meeting.
    await _get(client, ctx, "/v1/simple/decisions")
    async with tenant_session(ctx.tenant_id) as s:
        qs = [d for d in await s.scalars(select(Decision).where(Decision.origin == "prd"))
              if d.prd_question["document_id"] == str(old.id)]  # fmt: skip
        assert len(qs) > 1
        decided = min(qs, key=lambda d: d.number)
        decided.status, decided.chosen_option, decided.rationale = "decided", "a", "Decided"
        decided.decided_at, decided.decided_by, decided.decided_actor = NOW, owner, "user"
        session = SimpleSession(kind="meeting", started_by=owner, started_at=NOW)
        s.add(session)
        await s.flush()
        m = SimpleMeeting(title="Trust plan review", prd_document_id=old.id, origin="one_pager",
                          session_id=session.id, presenter_id=owner, started_at=NOW,
                          status="ended", ended_at=NOW)  # fmt: skip
        s.add(m)
        await s.flush()
        s.add(SimpleMeetingDecision(meeting_id=m.id, decision_id=decided.id, at=NOW))
        await s.commit()
        meeting_id, number = str(m.id), decided.number
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety", "scale"]})  # fmt: skip
    assert r.status_code == 200, r.text

    page = await _get(client, ctx, "/v1/simple/decisions")
    assert {o["title"] for o in page["prds"]} == AREAS
    assert meeting_id in {o["id"] for o in page["meeting_options"]}
    group = next(g for g in page["meetings"] if g["meeting"]["id"] == meeting_id)
    assert [d["number"] for d in group["decisions"]] == [number]
    old_qs = [q for q in page["questions"] if q["prd"]["title"] == OLD]
    assert [(q["number"], q["status"]) for q in old_qs] == [(number, "decided")]

    one = await _get(client, ctx, f"/v1/simple/decisions?meeting={meeting_id}")
    assert [g["meeting"]["id"] for g in one["meetings"]] == [meeting_id]
    assert [d["number"] for d in one["meetings"][0]["decisions"]] == [number]
    assert [q["number"] for q in one["questions"]] == [number]

    r = await client.get("/v1/simple/decisions?prd=trust-plan", headers=ctx.as_("owner"))
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "No such PRD"


async def test_proposal_on_a_replaced_prds_item_leaves_simple_with_the_item(client):
    """Re-review round 5: a proposal waiting on an item of a replaced PRD read as a nameless
    "An item: change the horizon" row in Roadmap's "Pulled in, pending a decision", as the
    item itself has left Simple. The proposal leaves GET /v1/simple/changes with it; one on
    a live item stays, and a decided one stays as history."""
    from sqlalchemy import select

    from oracle.roadmap.models import RoadmapItem
    from oracle.simple.models import SimpleChange
    from tests.test_one_roadmap_many_prds_api import world as company_world

    ctx, ids = await company_world(client)
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        items = {r.item_key: r for r in await s.scalars(select(RoadmapItem))}
        made = {}
        for key, status in (("read-replicas", "proposed"), ("report-button", "proposed"),
                            ("read-replicas", "accepted")):  # fmt: skip
            c = SimpleChange(op="change_horizon", target={"item_id": str(items[key].id)},
                             before={"horizon": "now"}, after={"horizon": "next"},
                             status=status, by=owner, at=NOW)  # fmt: skip
            s.add(c)
            await s.flush()
            made[(key, status)] = str(c.id)
        await s.commit()
    shown = {c["id"] for c in await _get(client, ctx, "/v1/simple/changes")}
    assert set(made.values()) <= shown
    # Scale is replaced by User Safety: Read replicas leaves Simple, and its proposal with it.
    r = await client.post("/v1/documents/scale/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety"]})  # fmt: skip
    assert r.status_code == 200, r.text
    keys = {i["key"] for i in (await _get(client, ctx, "/v1/simple/roadmap"))["items"]}
    assert keys == {"report-button"}
    shown = {c["id"] for c in await _get(client, ctx, "/v1/simple/changes")}
    assert made[("read-replicas", "proposed")] not in shown
    assert made[("report-button", "proposed")] in shown
    assert made[("read-replicas", "accepted")] in shown
    waiting = await _get(client, ctx, "/v1/simple/changes?status=proposed")
    assert [c["id"] for c in waiting] == [made[("report-button", "proposed")]]
