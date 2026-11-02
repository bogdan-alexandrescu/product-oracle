"""approved-prd-roadmap (the owner's pick: 'Add them as a roadmap draft'): approving a PRD
version puts its dated items (the dates the engineering lead accepted; end-only items stay
end-only) and its milestones (as key dates) into its roadmap's working draft, each marked
as coming from that PRD; no run. Approving again replaces that PRD's items in the draft;
an item already on the published roadmap only adds what changed. Against Postgres.
"""

import hashlib
import uuid
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401 - registers the lanes' checks
from oracle import company_time
from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import DraftRoadmap, RoadmapItem, ScheduleBasis
from oracle.simple.models import SimpleDraft
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx, make_ctx

NOW = datetime(2026, 11, 2, 20, 0, tzinfo=UTC)
ROADMAP = "/v1/simple/roadmap"
DRAFTS = "/v1/simple/drafts"
PRD = "trail-maps"

MILESTONES = """
## Plan {{#plan}}

| Milestone | Name | Start | End |
|---|---|---|---|
| M1 | Private beta | 2026-11-09 | 2026-12-04 |
| M2 | Launch | 2026-12-07 | {end} |
"""


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    moment = {"now": NOW}
    monkeypatch.setattr(company_time, "now", lambda: moment["now"])
    return moment


def _body(n: int, launch_end: str) -> str:
    return (
        f"# Trail maps v{n}\n\n## Summary {{#summary}}\n\nHikers see offline trail maps.\n"
        + MILESTONES.format(end=launch_end)
    )


async def _add(s, row):
    s.add(row)
    await s.flush()
    return row


async def _version(s, doc: Document, n: int, body: str) -> DocumentVersion:
    return await _add(
        s,
        DocumentVersion(
            document_id=doc.id,
            number=n,
            markdown=body,
            content_hash=hashlib.sha256(body.encode()).hexdigest(),
        ),
    )


async def _items(s, doc: Document, pv: DocumentVersion, rm: Document, items: list[dict]) -> None:
    """The version's derived items (E1), ready."""
    dr = await _add(s, DraftRoadmap(prd_document_id=doc.id, prd_version_id=pv.id, status="ready"))
    for i, it in enumerate(items):
        s.add(RoadmapItem(roadmap_document_id=rm.id, draft_roadmap_id=dr.id, item_key=it["key"],
                          title=it["title"], horizon="now", position=i,
                          start_date=it.get("start"), end_date=it.get("end"),
                          prd_document_id=doc.id, prd_version_id=pv.id))  # fmt: skip
    await s.flush()


async def world() -> tuple[Ctx, dict[str, uuid.UUID]]:
    """A published roadmap with one item from the PRD (Offline sync, ends Dec 15); the
    PRD's version 1, not approved yet, with four derived items: Offline sync unchanged,
    Route search end-only (the lead accepted Jan 8), Trip reports dated, Ideas undated."""
    ctx = await make_ctx()
    owner = ctx.users["owner"].id
    async with tenant_session(ctx.tenant_id) as s:
        prd = await _add(s, Document(slug=PRD, title="Trail maps", kind="prd", status="draft",
                                     visibility="company"))  # fmt: skip
        rm = await _add(s, Document(slug="outdoors", title="Outdoors", kind="roadmap",
                                    status="approved", visibility="company"))  # fmt: skip
        body = "# Outdoors v1\n"
        rv = await _add(s, DocumentVersion(document_id=rm.id, number=1, markdown=body,
                                           content_hash=hashlib.sha256(body.encode()).hexdigest(),
                                           approved_at=datetime(2026, 10, 1, tzinfo=UTC)))  # fmt: skip
        pv = await _version(s, prd, 1, _body(1, "2027-01-29"))
        s.add(RoadmapItem(roadmap_document_id=rm.id, roadmap_version_id=rv.id,
                          item_key="offline-sync", title="Offline sync", horizon="now",
                          position=0, start_date=date(2026, 11, 9), end_date=date(2026, 12, 15),
                          date_source="typed", prd_document_id=prd.id,
                          prd_version_id=pv.id))  # fmt: skip
        await _items(s, prd, pv, rm, [
            {"key": "offline-sync", "title": "Offline sync",
             "start": date(2026, 11, 9), "end": date(2026, 12, 15)},
            {"key": "route-search", "title": "Route search"},
            {"key": "trip-reports", "title": "Trip reports",
             "start": date(2026, 12, 1), "end": date(2027, 1, 15)},
            {"key": "ideas", "title": "Ideas board"},
        ])  # fmt: skip
        s.add(ScheduleBasis(kind="estimate", reference="Lead estimate", status="verified",
                            supports_date=date(2027, 1, 8), prd_document_id=prd.id,
                            item_key="route-search", verified_by=owner,
                            verified_at=NOW))  # fmt: skip
        await s.commit()
        return ctx, {"prd": prd.id, "roadmap": rm.id}


async def approve(client, ctx: Ctx, n: int) -> None:
    r = await client.post(f"/v1/documents/{PRD}/versions/{n}/approve", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text


async def read(client, ctx: Ctx) -> dict:
    r = await client.get(ROADMAP, headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return r.json()


def by_key(out: dict) -> dict[str, dict]:
    return {i["key"]: i for i in out["items"]}


async def test_approval_writes_the_prds_dated_items_and_key_dates_into_the_draft(client):
    """protects=approving a PRD version adds its dated items (the lead's accepted date,
    end-only kept end-only) and its milestones as key dates to its roadmap's working draft,
    marked as from the PRD, and the draft says how many; fails_when=approval writes nothing
    (only a Build roadmap run reaches the roadmap), an undated item is added, an end-only item
    gets a typed start, or an unchanged published item is added again."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    out = await read(client, ctx)
    items = by_key(out)
    assert set(items) == {"offline-sync", "route-search", "trip-reports"}
    search = items["route-search"]
    assert search["end"]["date"] == "2027-01-08" and not search["end"]["estimated"]
    assert search["start"]["estimated"] is True
    assert items["trip-reports"]["start"]["date"] == "2026-12-01"
    assert items["trip-reports"]["end"]["date"] == "2027-01-15"
    for k in ("route-search", "trip-reports"):
        assert items[k]["prd"]["slug"] == PRD, k
    kds = {k["name"]: k for k in out["key_dates"]}
    assert kds["Private beta"]["date"] == "2026-12-04" and kds["Private beta"]["in_draft"]
    assert kds["Launch"]["date"] == "2027-01-29" and kds["Launch"]["in_draft"]
    drafts = (await client.get(DRAFTS, headers=ctx.as_("owner"))).json()
    [d] = [d for d in drafts if d["document"]["id"] == str(ids["roadmap"])]
    [src] = d["from_prds"]
    assert src["prd"]["slug"] == PRD and src["items"] == 2 and src["key_dates"] == 2
    assert d["can_submit"] is True
    # A viewer reads the published roadmap: none of the draft's additions.
    r = await client.get(ROADMAP, headers=ctx.as_("viewer"))
    assert set(by_key(r.json())) == {"offline-sync"}


async def test_reapproval_replaces_the_prds_items_rather_than_adding_them_again(client):
    """protects=approving a later version of the PRD replaces its items and key dates in the
    draft (no duplicates); an item already published only adds what changed;
    fails_when=a second approval doubles the items or key dates, keeps a removed one, or
    leaves a changed published item as it was."""
    ctx, ids = await world()
    await approve(client, ctx, 1)
    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        rm = await s.get(Document, ids["roadmap"])
        pv2 = await _version(s, prd, 2, _body(2, "2027-02-05"))
        await _items(s, prd, pv2, rm, [
            {"key": "offline-sync", "title": "Offline sync",
             "start": date(2026, 11, 9), "end": date(2026, 12, 22)},
            {"key": "route-search", "title": "Route search"},
        ])  # fmt: skip
        await s.commit()
    await approve(client, ctx, 2)
    out = await read(client, ctx)
    items = by_key(out)
    assert sorted(i["key"] for i in out["items"]) == ["offline-sync", "route-search"]
    assert items["offline-sync"]["end"]["date"] == "2026-12-22"
    assert items["route-search"]["end"]["date"] == "2027-01-08"
    assert sorted((k["name"], k["date"]) for k in out["key_dates"]) == [
        ("Launch", "2027-02-05"),
        ("Private beta", "2026-12-04"),
    ]
    drafts = (await client.get(DRAFTS, headers=ctx.as_("owner"))).json()
    [d] = [d for d in drafts if d["document"]["id"] == str(ids["roadmap"])]
    [src] = d["from_prds"]
    assert src["items"] == 2 and src["key_dates"] == 2 and src["version"] == 2
    async with tenant_session(ctx.tenant_id) as s:
        added = list(
            await s.scalars(
                select(RoadmapItem.item_key).where(
                    RoadmapItem.simple_draft_id.is_not(None),
                    RoadmapItem.roadmap_version_id.is_(None),
                )
            )
        )
        assert added == ["route-search"]
        n = await s.scalar(select(SimpleDraft.id).where(SimpleDraft.status == "working"))
        assert n is not None
    # Approving the same version again changes nothing.
    await approve(client, ctx, 2)
    again = await read(client, ctx)
    assert sorted(i["key"] for i in again["items"]) == ["offline-sync", "route-search"]
    assert len(again["key_dates"]) == 2
