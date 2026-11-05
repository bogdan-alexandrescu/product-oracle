"""one-roadmap-many-prds (the owner, Nov 4: the company has ONE roadmap, never one per PRD;
many PRDs, one per area of focus, feed it). (1) one active company roadmap, created empty
on demand, the one Simple reads; older per-PRD roadmaps stay readable as history; (2) a PRD's
roadmap run writes into the company roadmap and touches only its own PRD's items; (3) one
team's capacity queue plans every item across PRDs; (4) a replaced PRD's verified bases
carry over to the PRD its item moved to; (6) a replaced PRD is read-only, names the PRDs
that replace it and its items no longer feed the roadmap. Against Postgres. Invented data.
"""

import hashlib
import uuid
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
from oracle.runs.roadmap import check_items
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
        top = "# Product roadmap"
        v1 = await _add(s, DocumentVersion(document_id=rm.id, number=1, markdown=top,
                                           content_hash=_hash(top),
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
    assert r.json()["document_id"] == str(ids["company"])


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
        content="---\ntitle: Trust plan\n---\n# Trust plan {#trust-plan}\n\nMore.\n")  # fmt: skip
    assert r.status_code == 409, r.text
    # Its items no longer feed the roadmap.
    r = await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))
    assert "appeal-flow" not in {i["key"] for i in r.json()["items"]}
    # A run from it is refused.
    r = await client.post("/v1/runs", headers=ctx.as_("owner"),
                          json={"flow": "prd_to_roadmap", "source": "trust-plan"})  # fmt: skip
    assert r.status_code in (409, 422), r.text


def test_plan_tables_cover_every_item_on_the_company_roadmap():
    from oracle.runs import plan_tables

    others = [{"key": "read-replicas", "title": "Read replicas", "end": "2026-12-18"}]
    plan = plan_tables.engineering_plan(check_items(SAFETY_ITEMS).items, [], others=others)
    assert [r.key for r in plan.items] == ["report-button", "block-list", "read-replicas"]
    rr = plan.items[-1]
    assert (rr.end, rr.basis) == (date(2026, 12, 18), "team queue")
    assert "| read-replicas | Read replicas |  | Dec 18, 2026 | team queue | planned |" in (
        plan_tables.table_lines(plan)
    )
    # A draft that leaves the other PRD's item out of its Plan table is refused.
    only_ours = plan_tables.markdown(
        plan_tables.engineering_plan(check_items(SAFETY_ITEMS).items, [])
    )
    codes = {p.code for p in plan_tables.check(only_ours, plan, TODAY)}
    assert "missing_plan_item" in codes
    assert not plan_tables.check(plan_tables.markdown(plan), plan, TODAY)


async def test_a_prd_run_reads_the_shared_queue(client):
    from oracle.roadmap import company

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        rows = await company.run_queue(s, ids["safety"])
    assert {r["key"]: r["ours"] for r in rows} == {"report-button": True, "read-replicas": False}
    lines = company.queue_lines(rows)
    assert any(line.startswith("* Report button (User Safety): Nov") for line in lines)
    assert any(line.startswith("- Read replicas (Scale): Nov") for line in lines)


async def test_a_feature_added_in_simple_lands_on_the_company_roadmap(client):
    from oracle.simple import additions

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        # An older per-PRD roadmap made before the company one: history, never a target.
        older = await _add(s, Document(slug="scale-roadmap", title="Scale roadmap",
                                       kind="roadmap", status="approved", visibility="company",
                                       created_at=datetime(2026, 1, 1, tzinfo=UTC)))  # fmt: skip
        goal = await _add(s, Entity(type="goal", key="calm", title="Calm nights",
                                    status="confirmed", origin="user"))  # fmt: skip
        await s.commit()
        older_id, goal_id = older.id, goal.id
    r = await client.post("/v1/simple/changes", headers=ctx.as_("owner"), json={
        "op": "add_item", "target": {"where": {"kind": "horizon", "value": "now"}},
        "before": {}, "after": {"title": "Night alerts digest"}})  # fmt: skip
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.scalar(select(RoadmapItem).where(RoadmapItem.title == "Night alerts digest"))
        assert row is not None and row.roadmap_document_id == ids["company"]
        # A goal with no items yet files its suggestions under the company roadmap too.
        doc = await additions._job_document(s, await s.get(Entity, goal_id))
        assert doc is not None and doc.id == ids["company"]
    # Asking for a history roadmap by id is refused.
    r = await client.post("/v1/simple/changes", headers=ctx.as_("owner"), json={
        "op": "add_item", "target": {"roadmap_id": str(older_id),
                                     "where": {"kind": "horizon", "value": "now"}},
        "before": {}, "after": {"title": "Old place"}})  # fmt: skip
    assert r.status_code in (404, 409, 422), r.text


async def test_a_prd_runs_own_items_take_their_place_in_the_shared_queue(client):
    from oracle.roadmap import company
    from oracle.runs import plan_tables

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        rows = await company.run_queue(s, ids["safety"])
    queued = company.with_run_items(rows, check_items(SAFETY_ITEMS).items)
    plan = plan_tables.engineering_plan(check_items(SAFETY_ITEMS).items, [], others=queued)
    by = {r.key: r for r in plan.items}
    assert [r.key for r in plan.items] == ["report-button", "block-list", "read-replicas"]
    # One team, one week each: report button, then read replicas, then the new block list.
    week = timedelta(days=7)
    assert by["report-button"].end == TODAY + week
    assert by["read-replicas"].end == TODAY + 2 * week
    assert by["block-list"].end == TODAY + 3 * week
    assert {r.basis for r in plan.items} == {"team queue"}
    # The run's prompt lists the new item in the queue too.
    assert any(line.startswith("* Block list for") or "Block list" in line
               for line in company.queue_lines(queued))  # fmt: skip


async def test_the_queue_starts_on_the_companys_day(client, monkeypatch):
    # 3 AM UTC on Nov 4 is still Nov 3 in the company's time zone (Los Angeles).
    monkeypatch.setattr(company_time, "now", lambda: datetime(2026, 11, 4, 3, 0, tzinfo=UTC))
    ctx, _ = await world(client)
    r = await client.get(f"{COMPANY}/queue", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["start"] == "2026-11-03"


async def test_a_features_shown_name_comes_from_the_company_roadmap(client):
    from oracle.simple import priorities

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        feature = await _add(s, Entity(type="feature", key="f-report", title="Reporting",
                                       status="confirmed", origin="user"))  # fmt: skip
        for row in await s.scalars(select(RoadmapItem).where(
                RoadmapItem.item_key.in_(["old-report", "report-button"]))):  # fmt: skip
            row.feature_id = feature.id
        await s.commit()
        shown = await priorities._shown_names(s, {feature.id: feature.key})
    # The older per-PRD roadmap is history: its title never names the feature.
    assert shown == {"f-report": "Report button"}


async def test_a_runs_queue_is_the_roadmap_as_it_was_when_the_run_started(client):
    from oracle.roadmap import company

    ctx, ids = await world(client)
    started = datetime.now(UTC)
    async with tenant_session(ctx.tenant_id) as s:
        # Another PRD's draft lands while the run is going.
        rm = await s.get(Document, ids["company"])
        later = "# Product roadmap v2"
        v2 = await _add(s, DocumentVersion(document_id=rm.id, number=2, markdown=later,
                                           content_hash=_hash(later), source_version_id=ids["cv"],
                                           created_at=started + timedelta(minutes=5)))  # fmt: skip
        safety, scale = await s.get(Document, ids["safety"]), await s.get(Document, ids["scale"])
        sv, cv = await s.get(DocumentVersion, ids["sv"]), await s.get(DocumentVersion, ids["cv"])
        s.add(_item(rm, v2, safety, sv, "report-button", "Report button", 0))
        s.add(_item(rm, v2, scale, cv, "read-replicas", "Read replicas", 1))
        s.add(_item(rm, v2, scale, cv, "sharding", "Sharding", 2))
        await s.commit()
        now_rows = await company.run_queue(s, ids["safety"])
        then_rows = await company.run_queue(s, ids["safety"], as_of=started)
    assert "sharding" in {r["key"] for r in now_rows}
    assert {r["key"] for r in then_rows} == {"report-button", "read-replicas"}


MILESTONE_ITEMS = """\
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
    horizon: later
    milestone: {name: Beta}
"""


async def test_a_run_item_that_names_a_milestone_takes_that_milestones_place(client):
    from oracle.roadmap import company

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        replicas = await s.scalar(select(RoadmapItem).where(
            RoadmapItem.item_key == "read-replicas"))  # fmt: skip
        replicas.milestone = {"name": "Beta"}
        rm = await s.get(Document, ids["company"])
        v1 = await s.get(DocumentVersion, ids["v1"])
        scale, cv = await s.get(Document, ids["scale"]), await s.get(DocumentVersion, ids["cv"])
        s.add(_item(rm, v1, scale, cv, "sharding", "Sharding", 2, horizon="later"))
        await s.commit()
        rows = await company.run_queue(s, ids["safety"])
    queued = company.with_run_items(rows, check_items(MILESTONE_ITEMS).items)
    # Block list is in Later, but it names Beta: it goes where Beta is in the queue (before
    # every item without a milestone), not after Later's items. Landing puts the run's items
    # first (block list at 1, read replicas after it at 2), so Beta's place is block list's.
    assert [r["key"] for r in queued] == ["block-list", "read-replicas", "report-button",
                                          "sharding"]  # fmt: skip
    by = {r["key"]: r for r in queued}
    week = timedelta(days=7)
    assert by["block-list"]["start"] == TODAY.isoformat()
    assert by["block-list"]["end"] == (TODAY + week).isoformat()
    assert by["sharding"]["end"] == (TODAY + 4 * week).isoformat()
    # The plan tables a person approves are the queue once the file lands.
    assert await _landed(ctx, ids, MILESTONE_ITEMS) == _planned(queued)


NUMBER_MILESTONE_ITEMS = MILESTONE_ITEMS.replace("{name: Beta}", "{name: 2026}")


async def test_a_run_item_whose_milestone_name_reads_as_a_number_keeps_it_as_text(client):
    """A milestone named 2026 in a run's YAML reads as a number: the run's items are read with
    the items file's own text helper, so it is the "2026" milestone, as once it lands."""
    from oracle.roadmap import company

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        replicas = await s.scalar(select(RoadmapItem).where(
            RoadmapItem.item_key == "read-replicas"))  # fmt: skip
        replicas.milestone = {"name": "2026"}
        await s.commit()
        rows = await company.run_queue(s, ids["safety"])
    queued = company.with_run_items(rows, check_items(NUMBER_MILESTONE_ITEMS).items)
    # Block list names 2026, as read replicas does: it takes 2026's place, before report button.
    assert [r["key"] for r in queued] == ["block-list", "read-replicas", "report-button"]
    assert company._milestone_name({"name": 3}) == "3"
    assert company._milestone_name({"name": 2026}) == "2026"


async def _landed(ctx: Ctx, ids: dict, text: str) -> list[tuple[str, str, str]]:
    """The company queue once the run's items file lands as the roadmap's next version."""
    from oracle.roadmap import company

    async with tenant_session(ctx.tenant_id) as s:
        v2 = await _version(s, ids, 2, ids["sv"])
        await roadmap_items.import_items(s, v2, text)
        await s.commit()
        _, rows = await company.queue(s)
    return [(q.item.item_key, q.start.isoformat(), q.end.isoformat()) for q in rows]


def _planned(queued: list[dict]) -> list[tuple[str, str, str]]:
    return [(r["key"], r["start"], r["end"]) for r in queued]


FIRST_ITEMS = """\
version: 1
prd: {document: user-safety, version: 1}
items:
  - id: block-list
    title: Block list
    outcome: People block whoever they choose
    horizon: now
  - id: no-title
    outcome: Left out when the file lands
    horizon: now
  - id: report-button
    title: Report button for every post
    outcome: People report harm in one tap
    horizon: now
"""


async def test_a_run_items_place_in_its_horizon_is_the_one_landing_gives_it(client):
    from oracle.roadmap import company

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        rows = await company.run_queue(s, ids["safety"])
    queued = company.with_run_items(rows, check_items(FIRST_ITEMS).items)
    # The run's file lands first, in file order (the item without a title left out), then
    # the other PRDs' items: the new block list comes before read replicas in Now.
    assert [r["key"] for r in queued] == ["block-list", "report-button", "read-replicas"]
    assert await _landed(ctx, ids, FIRST_ITEMS) == _planned(queued)


REPORT_ITEMS = """\
version: 1
prd: {document: user-safety, version: 1}
items:
  - id: report-button
    title: Report button
    outcome: People report harm in one tap
    horizon: now
"""


QUICK_REPORT_ITEMS = REPORT_ITEMS + "    economics: {effort_weeks: 0.01}\n"


async def test_a_runs_prompt_and_check_date_the_queue_from_the_runs_own_day(client, monkeypatch):
    from oracle.roadmap import company
    from oracle.runs import plan_tables, service
    from oracle.runs.models import Run, RunSegment

    ctx, ids = await world(client)
    # The run's file makes the report button a few hours' work: it ends on the run's own day.
    started = datetime.now(UTC)
    run_day = company_time.day(started, company_time.DEFAULT_ZONE)
    monkeypatch.setattr(company_time, "now", lambda: started)
    async with tenant_session(ctx.tenant_id) as s:
        run = await _add(s, Run(flow="prd_to_roadmap", status="running", created_at=started))
        s.add(RunSegment(run_id=run.id, seq=1, name="roadmap_items", status="succeeded",
                         artifacts={"files": {
                             plan_tables.ITEMS_FILE: QUICK_REPORT_ITEMS}}))  # fmt: skip
        await s.commit()
        prompt_rows = await company.run_queue(s, ids["safety"], as_of=started)
    assert prompt_rows[0]["start"] == run_day.isoformat()
    queued = company.with_run_items(prompt_rows, check_items(QUICK_REPORT_ITEMS).items)
    plan = plan_tables.engineering_plan(check_items(QUICK_REPORT_ITEMS).items, [], others=queued)
    written = plan_tables.markdown(plan)
    # The writer words the run's day without its year, as people do.
    day = company_time.calendar_day(run_day)
    assert f"| {company_time.calendar_day_with_year(run_day)} | team queue |" in written
    written = written.replace(f"| {company_time.calendar_day_with_year(run_day)} |", f"| {day} |")
    assert f"| report-button | Report button |  | {day} | team queue |" in written
    # The check runs after the company's midnight: it still dates the queue from the run's day.
    monkeypatch.setattr(company_time, "now", lambda: started + timedelta(days=1))
    async with tenant_session(ctx.tenant_id) as s:
        check_rows = await company.run_queue(s, ids["safety"], as_of=started)
        problems = await service._plan_table_problems(s, run, written, ids["sv"])
    assert [(r["start"], r["end"]) for r in check_rows] == [
        (r["start"], r["end"]) for r in prompt_rows
    ]
    assert not problems, [p.message for p in problems]


GAMMA_ITEMS = """\
version: 1
prd: {document: user-safety, version: 1}
items:
  - id: report-button
    title: Report button
    outcome: People report harm in one tap
    horizon: later
    milestone: {name: Gamma}
"""


async def test_an_item_moved_to_a_new_milestone_takes_the_place_it_will_have(client):
    from oracle.roadmap import company

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        report = await s.scalar(select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == ids["v1"],
            RoadmapItem.item_key == "report-button"))  # fmt: skip
        report.milestone = {"name": "Alpha"}
        rm = await s.get(Document, ids["company"])
        v1 = await s.get(DocumentVersion, ids["v1"])
        scale, cv = await s.get(Document, ids["scale"]), await s.get(DocumentVersion, ids["cv"])
        s.add(_item(rm, v1, scale, cv, "sharding", "Sharding", 2, horizon="next",
                    milestone={"name": "Beta"}))  # fmt: skip
        await s.commit()
        rows = await company.run_queue(s, ids["safety"])
    queued = company.with_run_items(rows, check_items(GAMMA_ITEMS).items)
    # The report button leaves Alpha (Now) for Gamma, which only it names, in Later: Gamma's
    # place is the report button's own in Later, after Beta (Next), not Alpha's.
    assert [r["key"] for r in queued] == ["sharding", "report-button", "read-replicas"]


DROP_ITEMS = """\
version: 1
prd: {document: user-safety, version: 1}
items:
  - id: block-list
    title: Block list
    outcome: People block whoever they choose
    horizon: later
"""


async def test_a_milestone_keeps_no_place_only_a_dropped_item_gave_it(client):
    from oracle.roadmap import company

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        report = await s.scalar(select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == ids["v1"],
            RoadmapItem.item_key == "report-button"))  # fmt: skip
        report.milestone = {"name": "Beta"}
        replicas = await s.scalar(select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == ids["v1"],
            RoadmapItem.item_key == "read-replicas"))  # fmt: skip
        replicas.horizon, replicas.milestone = "next", {"name": "Alpha"}
        rm = await s.get(Document, ids["company"])
        v1 = await s.get(DocumentVersion, ids["v1"])
        scale, cv = await s.get(Document, ids["scale"]), await s.get(DocumentVersion, ids["cv"])
        s.add(_item(rm, v1, scale, cv, "sharding", "Sharding", 2, horizon="later",
                    milestone={"name": "Beta"}))  # fmt: skip
        await s.commit()
        rows = await company.run_queue(s, ids["safety"])
    assert [r["key"] for r in rows] == ["report-button", "sharding", "read-replicas"]
    queued = company.with_run_items(rows, check_items(DROP_ITEMS).items)
    # The run drops the report button, which put Beta in Now: Beta is where sharding puts it
    # (Later), after Alpha (Next).
    assert [r["key"] for r in queued] == ["read-replicas", "sharding", "block-list"]


async def test_a_runs_queue_is_frozen_when_its_prompt_is_first_built(client):
    """Runs onto the one roadmap go in parallel: another PRD's items land and the team's
    capacity changes before a run's check; the prompt, every rewrite and the check read the
    queue the run froze when its prompt was first built."""
    from oracle.roadmap import company
    from oracle.runs import plan_tables, service
    from oracle.runs.models import Run, RunSegment

    ctx = await make_ctx()
    rm = await _company(client, ctx)
    ids = {"company": uuid.UUID(rm["id"])}
    started = datetime.now(UTC)
    day = company_time.day(started, company_time.DEFAULT_ZONE)
    async with tenant_session(ctx.tenant_id) as s:
        _, sv = await _prd(s, "user-safety", "User Safety")
        _, cv = await _prd(s, "scale", "Scale")
        run = await _add(s, Run(flow="prd_to_roadmap", status="running", created_at=started,
                                knobs={"source_version_id": str(sv.id)}))  # fmt: skip
        s.add(RunSegment(run_id=run.id, seq=1, name="roadmap_items", status="succeeded",
                         artifacts={"files": {plan_tables.ITEMS_FILE: REPORT_ITEMS}}))  # fmt: skip
        await s.commit()
        run_id, sv_id = run.id, sv.id
        source = await service._source_context(s, run)
        await s.commit()
    # The roadmap is still empty: the run's own item is dated from the team's capacity.
    queued = company.with_run_items(
        source.company_queue, check_items(REPORT_ITEMS).items, **source.company_plan
    )
    plan = plan_tables.engineering_plan(check_items(REPORT_ITEMS).items, [], others=queued)
    assert [(r.key, r.end, r.basis) for r in plan.items] == [
        ("report-button", day + timedelta(days=7), "team queue")
    ]
    written = plan_tables.markdown(plan)
    # Another PRD's run lands first and the team's capacity changes.
    async with tenant_session(ctx.tenant_id) as s:
        await roadmap_items.import_items(s, await _version(s, ids, 1, cv.id), SCALE_ITEMS)
        await s.commit()
    r = await client.put("/v1/settings/team_capacity", headers=ctx.as_("owner"),
                         json={"value": {"team_size": 2, "focus": 1.0}})  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(ctx.tenant_id) as s:
        run = await s.get(Run, run_id)
        # A rewrite after a refusal reads the same queue.
        again = await service._source_context(s, run)
        assert (again.company_queue, again.company_plan) == (
            source.company_queue, source.company_plan)  # fmt: skip
        problems = await service._plan_table_problems(s, run, written, sv_id)
    assert not problems, [p.message for p in problems]


REESTIMATE_ITEMS = """\
version: 1
prd: {document: user-safety, version: 1}
items:
  - id: report-button
    title: Report button
    outcome: People report harm in one tap
    horizon: now
    milestone: {name: Beta}
    economics: {effort_weeks: 3}
  - id: mute-words
    title: Mute words
    outcome: People hide the words they choose
    horizon: now
    milestone: {name: Beta}
    priority: {score: 5}
  - id: block-list
    title: Block list
    outcome: People block whoever they choose
    horizon: now
    milestone: {name: Beta}
    feature: blocking
"""


async def test_a_run_items_effort_priority_and_goal_are_the_ones_landing_stores(client):
    """The file re-estimates the report button (3 weeks), drops the mute words' effort and
    the report button's priority, and names a feature that serves a company goal for the
    new block list: the plan tables use what landing stores, not the old item's values."""
    from oracle.roadmap import company

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        await _goal(s, "fewer-harmful-posts", "Fewer harmful posts", 1, "blocking")
        report = await s.scalar(select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == ids["v1"],
            RoadmapItem.item_key == "report-button"))  # fmt: skip
        report.milestone = {"name": "Beta"}
        report.priority = {"score": 9}
        report.economics = {"declared": {"effort_weeks": 1}, "priority_score": 9}
        replicas = await s.scalar(select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == ids["v1"],
            RoadmapItem.item_key == "read-replicas"))  # fmt: skip
        replicas.milestone, replicas.position = {"name": "Beta"}, 3
        rm = await s.get(Document, ids["company"])
        v1 = await s.get(DocumentVersion, ids["v1"])
        safety, sv = await s.get(Document, ids["safety"]), await s.get(DocumentVersion, ids["sv"])
        s.add(_item(rm, v1, safety, sv, "mute-words", "Mute words", 2,
                    milestone={"name": "Beta"},
                    economics={"declared": {"effort_weeks": 2}}))  # fmt: skip
        await s.commit()
        frozen = await company.frozen_queue(s, ids["safety"])
    plan = {k: v for k, v in frozen.items() if k != "rows"}
    queued = company.with_run_items(frozen["rows"], check_items(REESTIMATE_ITEMS).items, **plan)
    # In Beta: the block list serves a goal, so it goes first; then priority (the mute words'
    # 5, the report button has none now), then the report button's 3 weeks.
    assert [r["key"] for r in queued] == ["block-list", "mute-words", "report-button",
                                          "read-replicas"]  # fmt: skip
    by = {r["key"]: r for r in queued}
    week = timedelta(days=7)
    assert (by["report-button"]["start"], by["report-button"]["end"]) == (
        (TODAY + 2 * week).isoformat(), (TODAY + 5 * week).isoformat())  # fmt: skip
    assert await _landed(ctx, ids, REESTIMATE_ITEMS) == _planned(queued)


SECTION_ITEMS = """\
version: 1
prd: {document: user-safety, version: 1}
items:
  - id: report-button
    title: Report button
    outcome: People report harm in one tap
    horizon: now
    milestone: {name: Beta}
  - id: safety-reports
    title: Safety reports
    outcome: People see what happened to their report
    horizon: now
    milestone: {name: Beta}
    prd_section: reporting
"""


async def test_a_run_items_goal_comes_from_the_feature_its_prd_section_links(client):
    from oracle.docs.models import Section
    from oracle.roadmap import company
    from oracle.v2.models import DocumentSectionLink

    ctx, ids = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        feature = await _goal(s, "fewer-harmful-posts", "Fewer harmful posts", 1, "reporting")
        s.add(Section(version_id=ids["sv"], section_key="reporting", ordinal=1, level=2,
                      heading="Reporting", content_hash=_hash("Reporting")))  # fmt: skip
        s.add(DocumentSectionLink(document_id=ids["safety"], version_id=ids["sv"],
                                  section_key="reporting", kind="implements",
                                  entity_id=feature.id))  # fmt: skip
        replicas = await s.scalar(select(RoadmapItem).where(
            RoadmapItem.roadmap_version_id == ids["v1"],
            RoadmapItem.item_key == "read-replicas"))  # fmt: skip
        replicas.milestone = {"name": "Beta"}
        await s.commit()
        frozen = await company.frozen_queue(s, ids["safety"], prd_version=await s.get(
            DocumentVersion, ids["sv"]))  # fmt: skip
    plan = {k: v for k, v in frozen.items() if k != "rows"}
    queued = company.with_run_items(frozen["rows"], check_items(SECTION_ITEMS).items, **plan)
    # Its section links a feature that serves a company goal: it goes first in Beta.
    assert [r["key"] for r in queued] == ["safety-reports", "report-button", "read-replicas"]
    assert await _landed(ctx, ids, SECTION_ITEMS) == _planned(queued)
