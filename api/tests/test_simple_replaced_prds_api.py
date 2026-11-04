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
    assert page["questions"] and {q["prd"]["title"] for q in page["questions"]} == AREAS
    waiting = await _get(client, ctx, "/v1/simple/decisions/waiting")
    assert waiting["questions"]
    assert {q["prd"]["title"] for q in waiting["questions"]} == AREAS
