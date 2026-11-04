"""one-roadmap-many-prds (the owner, Nov 4: the company has ONE roadmap, never one per PRD;
many PRDs, one per area of focus, feed it). (1) one active company roadmap, created empty
on demand, the one Simple reads; older per-PRD roadmaps stay readable as history; (2) a PRD's
roadmap run writes into the company roadmap and touches only its own PRD's items; (3) one
team's capacity queue plans every item across PRDs; (4) a replaced PRD's verified bases
carry over to the PRD its item moved to; (6) a replaced PRD is read-only, names the PRDs
that replace it and its items no longer feed the roadmap. Against Postgres. Invented data.
"""

import hashlib
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

import oracle.main  # noqa: F401 - registers the lanes' checks
from oracle import company_time
from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap import items as roadmap_items
from oracle.roadmap.models import RoadmapItem, ScheduleBasis
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 11, 4, 9, 0, tzinfo=UTC)
TODAY = date(2026, 11, 4)
COMPANY = "/v1/roadmaps/company"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


def _hash(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _prd(s, slug: str, title: str) -> tuple[Document, DocumentVersion]:
    doc = await _add(s, Document(slug=slug, title=title, kind="prd", status="approved",
                                 visibility="company"))  # fmt: skip
    body = f"# {title}"
    v = await _add(s, DocumentVersion(document_id=doc.id, number=1, markdown=body,
                                      content_hash=_hash(body),
                                      approved_at=datetime(2026, 10, 1, tzinfo=UTC)))  # fmt: skip
    return doc, v


def _item(roadmap, version, prd, pv, key, title, i, **kw) -> RoadmapItem:
    return RoadmapItem(roadmap_document_id=roadmap.id, roadmap_version_id=version.id,
                       item_key=key, title=title, horizon=kw.pop("horizon", "now"), position=i,
                       prd_document_id=prd.id, prd_version_id=pv.id, **kw)  # fmt: skip


async def _company(client, ctx: Ctx) -> dict:
    r = await client.post(COMPANY, headers=ctx.as_("owner"))
    assert r.status_code in (200, 201), r.text
    return r.json()


async def world(client) -> tuple[Ctx, dict]:
    """Two area PRDs (User Safety, Scale) and an older per-PRD roadmap of User Safety; the
    company roadmap's version 1 holds one item of each PRD."""
    ctx = await make_ctx()
    company = await _company(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        safety, sv = await _prd(s, "user-safety", "User Safety")
        scale, cv = await _prd(s, "scale", "Scale")
        old = await _add(s, Document(slug="user-safety-roadmap", title="User Safety roadmap",
                                     kind="roadmap", status="approved",
                                     visibility="company"))  # fmt: skip
        ov = await _add(s, DocumentVersion(document_id=old.id, number=1, markdown="# Old",
                                           content_hash=_hash("# Old"), source_version_id=sv.id,
                                           approved_at=datetime(2026, 10, 2,
                                                                tzinfo=UTC)))  # fmt: skip
        s.add(_item(old, ov, safety, sv, "old-report", "Old report button", 0))
        rm = await s.get(Document, company["id"])
        v1 = await _add(s, DocumentVersion(document_id=rm.id, number=1, markdown="# Product roadmap",
                                           content_hash=_hash("# Product roadmap"),
                                           source_version_id=sv.id,
                                           approved_at=datetime(2026, 10, 3,
                                                                tzinfo=UTC)))  # fmt: skip
        s.add(_item(rm, v1, safety, sv, "report-button", "Report button", 0,
                    start_date=date(2026, 11, 9), end_date=date(2026, 11, 27),
                    date_source="engineering"))  # fmt: skip
        s.add(_item(rm, v1, scale, cv, "read-replicas", "Read replicas", 1,
                    start_date=date(2026, 11, 16), end_date=date(2026, 12, 18),
                    date_source="engineering"))  # fmt: skip
        await s.commit()
        return ctx, {"company": rm.id, "slug": rm.slug, "v1": v1.id, "safety": safety.id,
                     "sv": sv.id, "scale": scale.id, "cv": cv.id}  # fmt: skip


async def test_one_active_company_roadmap(client):
    ctx = await make_ctx()
    r = await client.get(COMPANY, headers=ctx.as_("viewer"))
    assert r.status_code == 404
    first = await _company(client, ctx)
    again = await _company(client, ctx)
    assert first["id"] == again["id"]
    assert first["title"] == "Product roadmap"
    r = await client.get(COMPANY, headers=ctx.as_("viewer"))
    assert r.status_code == 200 and r.json()["id"] == first["id"]
    r = await client.post(COMPANY, headers=ctx.as_("viewer"))
    assert r.status_code == 403
    # A second active one is refused by the database itself.
    with pytest.raises(IntegrityError):
        async with tenant_session(ctx.tenant_id) as s:
            s.add(Document(slug="second", title="Second", kind="roadmap", company_roadmap=True))
            await s.commit()


async def test_simple_reads_the_company_roadmap_only(client):
    ctx, ids = await world(client)
    r = await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    body = r.json()
    keys = {i["key"] for i in body["items"]}
    assert keys == {"report-button", "read-replicas"}
    assert {i["prd"]["title"] for i in body["items"]} == {"User Safety", "Scale"}
    # The older per-PRD roadmap is history: still readable, never fed into Simple.
    r = await client.get("/v1/documents/user-safety-roadmap", headers=ctx.as_("viewer"))
    assert r.status_code == 200
    assert [d["roadmap"]["slug"] for d in body["roadmaps"]] in ([], [ids["slug"]])


SAFETY_ITEMS = """\
version: 1
prd: {document: user-safety, version: 1}
items:
  - id: report-button
    title: Report button for every post
    outcome: People report harm in one tap
    horizon: now
  - id: block-list
    title: Block list
    outcome: People block whoever they choose
    horizon: next
"""

SCALE_ITEMS = """\
version: 1
prd: {document: scale, version: 1}
items:
  - id: read-replicas
    title: Read replicas in two regions
    outcome: Reads stay fast at ten times the load
    horizon: now
"""


async def _version(s, ids: dict, number: int, source) -> DocumentVersion:
    body = f"# Product roadmap v{number}"
    return await _add(s, DocumentVersion(document_id=ids["company"], number=number, markdown=body,
                                         content_hash=_hash(body),
                                         source_version_id=source))  # fmt: skip


async def _items(s, version_id) -> dict[str, RoadmapItem]:
    rows = await s.scalars(select(RoadmapItem).where(RoadmapItem.roadmap_version_id == version_id))
    return {r.item_key: r for r in rows}


async def test_two_prds_runs_feed_one_roadmap_without_touching_each_other(client):
    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        v2 = await _version(s, ids, 2, ids["sv"])
        await roadmap_items.import_items(s, v2, SAFETY_ITEMS)
        got = await _items(s, v2.id)
        assert set(got) == {"report-button", "block-list", "read-replicas"}
        assert got["report-button"].title == "Report button for every post"
        # Scale's item is left as it was, dates and all.
        rr = got["read-replicas"]
        assert rr.prd_document_id == ids["scale"] and rr.title == "Read replicas"
        assert (rr.start_date, rr.end_date) == (date(2026, 11, 16), date(2026, 12, 18))
        # Scale's run while v2 is still a draft merges onto it, never overwriting it.
        v3 = await _version(s, ids, 3, ids["cv"])
        await roadmap_items.import_items(s, v3, SCALE_ITEMS)
        got = await _items(s, v3.id)
        assert set(got) == {"report-button", "block-list", "read-replicas"}
        assert got["read-replicas"].title == "Read replicas in two regions"
        assert got["report-button"].title == "Report button for every post"
        assert got["block-list"].prd_document_id == ids["safety"]
        await s.commit()


async def test_a_prd_run_writes_into_the_company_roadmap(client):
    ctx, ids = await world(client)
    r = await client.post("/v1/runs", headers=ctx.as_("owner"),
                          json={"flow": "prd_to_roadmap", "source": "user-safety"})  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["document"] in (ids["slug"], str(ids["company"]))


async def _goal(s, key: str, title: str, position: int, feature_key: str) -> Entity:
    goal = await _add(s, Entity(type="goal", key=key, title=title, status="confirmed",
                                origin="user", attrs={"position": position}))  # fmt: skip
    feature = await _add(s, Entity(type="feature", key=feature_key, title=feature_key,
                                   status="confirmed", origin="user"))  # fmt: skip
    s.add(Edge(src_id=feature.id, dst_id=goal.id, type="supports", status="confirmed",
               origin="user"))  # fmt: skip
    return feature


async def test_one_capacity_queue_plans_every_prd_as_one_team(client):
    ctx, ids = await world(client)
    r = await client.put("/v1/settings/team_capacity", headers=ctx.as_("owner"),
                         json={"value": {"team_size": 2, "focus": 0.5}})  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        safety_goal = await _goal(s, "g-safe", "Fewer harmful posts", 2, "f-safe")
        scale_goal = await _goal(s, "g-scale", "Fast at any load", 1, "f-scale")
        for row in (await _items(s, ids["v1"])).values():
            if row.item_key == "report-button":
                row.feature_id = safety_goal.id
                row.economics = {"declared": {"effort_weeks": 2}}
                row.milestone = {"name": "Beta"}
            else:
                row.feature_id = scale_goal.id
                row.economics = {"declared": {"effort_weeks": 1}}
                row.milestone = {"name": "Beta"}
        rm = await s.get(Document, ids["company"])
        pv = await s.get(DocumentVersion, ids["cv"])
        prd = await s.get(Document, ids["scale"])
        v1 = await s.get(DocumentVersion, ids["v1"])
        s.add(_item(rm, v1, prd, pv, "sharding", "Sharding", 2, horizon="later",
                    economics={"declared": {"effort_weeks": 1}},
                    milestone={"name": "Launch"}))  # fmt: skip
        await s.commit()
    r = await client.get(f"{COMPANY}/queue", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    q = r.json()
    assert q["team_size"] == 2 and q["focus"] == 0.5
    # Beta first, and within it the company goal order: Scale's goal is position 1.
    assert [i["key"] for i in q["items"]] == ["read-replicas", "report-button", "sharding"]
    ends = [i["end"] for i in q["items"]]
    assert ends == [str(TODAY + timedelta(days=7)), str(TODAY + timedelta(days=21)),
                    str(TODAY + timedelta(days=28))]  # fmt: skip
    assert {i["prd"]["title"] for i in q["items"]} == {"User Safety", "Scale"}
    # A PRD's run shows its own items' dates in that shared queue.
    r = await client.get(f"{COMPANY}/queue?prd=user-safety", headers=ctx.as_("viewer"))
    assert [i["key"] for i in r.json()["items"]] == ["report-button"]
    assert r.json()["items"][0]["end"] == str(TODAY + timedelta(days=21))


async def test_replaced_prd_carries_its_verified_bases(client):
    ctx, ids = await world(client)
    owner = ctx.users["owner"].id
    verified_at = datetime(2026, 10, 20, tzinfo=UTC)
    async with tenant_session(ctx.tenant_id) as s:
        old, ov = await _prd(s, "trust-plan", "Trust plan")
        s.add(ScheduleBasis(kind="estimate", reference="Lead estimate", status="verified",
                            supports_date=date(2026, 11, 27), prd_document_id=old.id,
                            item_key="report-button", verified_by=owner,
                            verified_at=verified_at))  # fmt: skip
        await s.commit()
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety", "scale"]})  # fmt: skip
    assert r.status_code == 200, r.text
    assert [p["title"] for p in r.json()["replaced_by"]] == ["User Safety", "Scale"]
    async with tenant_session(ctx.tenant_id) as s:
        carried = list(await s.scalars(select(ScheduleBasis).where(
            ScheduleBasis.prd_document_id == ids["safety"])))  # fmt: skip
        assert len(carried) == 1
        b = carried[0]
        assert b.status == "verified" and b.verified_by == owner
        assert b.item_key == "report-button" and b.supports_date == date(2026, 11, 27)
        assert "carried from Trust plan" in (b.detail or "")
        # The old PRD keeps its history.
        kept = list(await s.scalars(select(ScheduleBasis).where(
            ScheduleBasis.prd_document_id == old.id)))  # fmt: skip
        assert len(kept) == 1
        # Scale has no item of that key: nothing is carried there.
        assert not list(await s.scalars(select(ScheduleBasis).where(
            ScheduleBasis.prd_document_id == ids["scale"])))  # fmt: skip
    # Replacing again carries nothing twice.
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety", "scale"]})  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        n = len(list(await s.scalars(select(ScheduleBasis).where(
            ScheduleBasis.prd_document_id == ids["safety"]))))  # fmt: skip
        assert n == 1


async def test_replaced_prd_is_read_only_and_stops_feeding(client):
    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        old, ov = await _prd(s, "trust-plan", "Trust plan")
        rm = await s.get(Document, ids["company"])
        v1 = await s.get(DocumentVersion, ids["v1"])
        s.add(_item(rm, v1, old, ov, "appeal-flow", "Appeal flow", 3))
        await s.commit()
    r = await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))
    assert "appeal-flow" in {i["key"] for i in r.json()["items"]}
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("viewer"),
                          json={"prds": ["user-safety"]})  # fmt: skip
    assert r.status_code == 403
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["trust-plan"]})  # fmt: skip
    assert r.status_code == 422
    r = await client.post("/v1/documents/trust-plan/replaced-by", headers=ctx.as_("owner"),
                          json={"prds": ["user-safety"]})  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.get("/v1/documents/trust-plan", headers=ctx.as_("viewer"))
    assert [p["slug"] for p in r.json()["replaced_by"]] == ["user-safety"]
    # Read-only: a new version is refused.
    r = await client.post("/v1/documents/trust-plan/versions", headers={
        **ctx.as_("owner"), "content-type": "text/markdown"},
        content="---\ntitle: Trust plan\n---\n# Trust plan\n\nMore.\n")  # fmt: skip
    assert r.status_code == 409, r.text
    # Its items no longer feed the roadmap.
    r = await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))
    assert "appeal-flow" not in {i["key"] for i in r.json()["items"]}
    # A run from it is refused.
    r = await client.post("/v1/runs", headers=ctx.as_("owner"),
                          json={"flow": "prd_to_roadmap", "source": "trust-plan"})  # fmt: skip
    assert r.status_code in (409, 422), r.text
