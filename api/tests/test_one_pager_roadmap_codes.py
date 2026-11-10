"""PRD one-pager Timeline strip, roadmap-milestone-codes (the owner, Nov 9): each milestone row
of ``GET /v1/simple/one-pagers/{doc}`` (``plan.rows``) reads the milestone's roadmap-wide code,
the one the Roadmap read gives it (``roadmap_code``), not the PRD's own written code. Against
Postgres; invented data.

Test cards (protects / fails_when / no_claim):

- test_strip_rows_read_the_roadmap_codes: protects=a PRD whose "M1 Setup basics" and "M2
  Rollout" are the roadmap's M2 and M3 (the company roadmap's own "Kickoff" is dated first)
  shows the rows "M2 · Setup basics" and "M3 · Rollout" with ``code`` "M2" / "M3", the codes
  the Roadmap read gives them; fails_when=a row keeps the PRD's written code;
  no_claim=the strip's layout (tests/test_simple_plan_strip*).
- test_a_milestone_with_no_roadmap_milestone_shows_no_code: protects=a PRD milestone that
  is no roadmap milestone (the PRD names no item on any roadmap) shows its name alone, code
  null; fails_when=it shows "M1 · Setup basics".
"""

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.simple.models import SimplePrdPlan
from oracle.tenancy import tenant_session
from tests.test_simple_goal_milestones_api import MILESTONES, get_roadmap
from tests.test_simple_one_pager_api import get, world
from tests.test_simple_one_pager_qa import company_roadmap
from tests.test_simple_roadmap_api import NOW


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


PLAN = {
    "milestones": [
        {"code": "M1", "name": "Setup basics", "start": "2026-11-02", "end": "2026-12-18"},
        {"code": "M2", "name": "Rollout", "start": "2026-12-21", "end": "2027-01-29"},
    ],
    "features": [
        {"code": "F-07", "name": "Setup checklist", "milestones": ["M1"]},
        {"code": "F-08", "name": "Team invites", "milestones": ["M2"]},
    ],
}


async def _seed(client, own_items: bool):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        pv = await s.scalar(select(DocumentVersion).where(DocumentVersion.document_id == prd.id))
        s.add(SimplePrdPlan(document_id=prd.id, version_id=pv.id, status="ready", source="prd",
                            data=PLAN))  # fmt: skip
        named = {"prd_document_id": prd.id} if own_items else {}
        await company_roadmap(s, prd.id, [
            {"item_key": "f-07", "title": "Setup checklist", "prd_section_key": "f-07", **named},
            {"item_key": "f-08", "title": "Team invites", "prd_section_key": "f-08", **named},
        ])  # fmt: skip
        await s.commit()
        roadmap_id = await s.scalar(select(Document.id).where(Document.slug == "product-roadmap"))
    return ctx, str(roadmap_id)


async def test_strip_rows_read_the_roadmap_codes(client):
    ctx, roadmap_id = await _seed(client, own_items=True)
    body = {"roadmap_id": roadmap_id, "name": "Kickoff", "date": "2026-11-06"}
    r = await client.post(MILESTONES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    read = await get_roadmap(client, ctx, "owner")
    coded = {m["name"]: m["roadmap_code"] for m in read["goal_milestones"] if m["prd"]}
    assert coded["Setup basics"] != "M1", read["goal_milestones"]
    view = await get(client, ctx, "viewer")
    rows = [(r["name"], r["code"]) for r in view["plan"]["rows"]]
    assert rows == [
        (f"{coded['Setup basics']} · Setup basics", coded["Setup basics"]),
        (f"{coded['Rollout']} · Rollout", coded["Rollout"]),
    ], (rows, coded)


async def test_a_milestone_with_no_roadmap_milestone_shows_no_code(client):
    ctx, _ = await _seed(client, own_items=False)
    read = await get_roadmap(client, ctx, "owner")
    assert not [m for m in read["goal_milestones"] if m["prd"]], read["goal_milestones"]
    view = await get(client, ctx, "viewer")
    rows = [(r["name"], r.get("code")) for r in view["plan"]["rows"]]
    assert rows == [("Setup basics", None), ("Rollout", None)], rows
