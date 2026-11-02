"""A review meeting's Roadmap step shows the run's draft (build-runplan RP2, 'Meeting step
as draft'). Against Postgres.

After the engineering dates stop a run's draft roadmap holds the PRD's dated items, not on
the roadmap until approved. The meeting reads them as ``draft_roadmap`` and the people in
the room change an item's dates, leave one out, or approve the dates, which puts the items
on the roadmap and records the meeting's decision.

Test cards (protects / fails_when / no_claim):

- test_the_meeting_reads_the_runs_draft: protects=the draft's items with their dates, in
  roadmap order, and what the PRD's Simple roadmap still lacks; fails_when=the meeting
  lacks them or they show on the roadmap before approval; no_claim=the web.
- test_change_dates_and_leave_out_stay_draft: protects=Change dates and Leave out on a
  draft item; fails_when=a change reaches the roadmap or a viewer may change.
- test_approve_these_dates_puts_them_on_the_roadmap: protects=Approve these N dates: the
  items join the roadmap with their dates and the meeting records the decision;
  fails_when=the items stay draft, lose their dates or no decision is recorded.
"""

import datetime as dt

from sqlalchemy import select, update

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import MEETINGS, PRD, get, start, world

ITEMS = [
    ("Save a cart for later", "now", dt.date(2026, 11, 9), dt.date(2026, 12, 18)),
    ("Carts kept across devices", "next", dt.date(2026, 12, 7), dt.date(2027, 1, 22)),
    ("Turn a cart into a quote", "later", dt.date(2027, 4, 5), dt.date(2027, 5, 28)),
]


async def add_draft(w) -> None:
    """The run's draft roadmap of the PRD: three dated items, no others for the PRD."""
    async with tenant_session(w.ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        pv = await s.scalar(
            select(DocumentVersion.id).where(DocumentVersion.document_id == prd.id).limit(1)
        )
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.prd_document_id == prd.id)
            .values(prd_document_id=None)
        )
        draft = DraftRoadmap(prd_document_id=prd.id, prd_version_id=pv, status="ready")
        s.add(draft)
        await s.flush()
        for i, (title, horizon, start_, end_) in enumerate(ITEMS):
            s.add(RoadmapItem(draft_roadmap_id=draft.id, item_key=f"cart-{i}", position=i,
                              title=title, horizon=horizon, start_date=start_, end_date=end_,
                              date_source="engineering", prd_document_id=prd.id,
                              prd_version_id=pv))  # fmt: skip
        await s.commit()


async def on_roadmap(client, w) -> list[str]:
    r = await client.get("/v1/simple/roadmap", params={"prd": PRD}, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    return [i["title"] for i in r.json()["items"]]


def drafted(m: dict) -> list[tuple[str, str, str, str]]:
    return [(i["title"], i["horizon"], i["start"], i["end"]) for i in m["draft_roadmap"]["items"]]


async def test_the_meeting_reads_the_runs_draft(client):
    w = await world()
    await add_draft(w)
    m = await start(client, w)
    assert drafted(m) == [
        ("Save a cart for later", "now", "2026-11-09", "2026-12-18"),
        ("Carts kept across devices", "next", "2026-12-07", "2027-01-22"),
        ("Turn a cart into a quote", "later", "2027-04-05", "2027-05-28"),
    ]
    assert drafted(await get(client, w, m["id"], who="commenter")) == drafted(m)
    assert await on_roadmap(client, w) == []


async def test_a_meeting_with_no_draft_reads_none(client):
    w = await world()
    m = await start(client, w)
    assert m["draft_roadmap"] is None


async def test_change_dates_and_leave_out_stay_draft(client):
    w = await world()
    await add_draft(w)
    m = await start(client, w)
    quote = m["draft_roadmap"]["items"][2]
    url = f"{MEETINGS}/{m['id']}/draft-items/{quote['id']}"
    body = {"start": "2027-05-03", "end": "2027-06-25"}
    r = await client.post(f"{url}/dates", json=body, headers=w.ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{url}/dates", json=body, headers=w.ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    assert drafted(r.json())[2] == ("Turn a cart into a quote", "later", "2027-05-03", "2027-06-25")
    r = await client.post(
        f"{url}/dates",
        json={"start": "2027-06-25", "end": "2027-05-03"},
        headers=w.ctx.as_("decider"),
    )
    assert r.status_code == 422, r.text
    first = m["draft_roadmap"]["items"][0]
    r = await client.post(
        f"{MEETINGS}/{m['id']}/draft-items/{first['id']}/leave-out", headers=w.ctx.as_("decider")
    )
    assert r.status_code == 200, r.text
    assert [i["title"] for i in r.json()["draft_roadmap"]["items"]] == [
        "Carts kept across devices",
        "Turn a cart into a quote",
    ]
    assert await on_roadmap(client, w) == []


async def test_approve_these_dates_puts_them_on_the_roadmap(client):
    w = await world()
    await add_draft(w)
    m = await start(client, w)
    url = f"{MEETINGS}/{m['id']}/draft-items/approve"
    r = await client.post(url, headers=w.ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(url, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["draft_roadmap"] is None
    title = out["prd"]["title"]
    assert [d["title"] for d in out["meeting_decisions"]] == [
        f"{title} dates approved: 3 items on the roadmap"
    ]
    assert sorted(await on_roadmap(client, w)) == sorted(t for t, *_ in ITEMS)
    r = await client.get("/v1/simple/roadmap", params={"prd": PRD}, headers=w.ctx.as_("decider"))
    by_title = {i["title"]: i for i in r.json()["items"]}
    assert by_title["Turn a cart into a quote"]["start"] == "2027-04-05"
    assert by_title["Turn a cart into a quote"]["end"] == "2027-05-28"
    assert (await client.post(url, headers=w.ctx.as_("decider"))).status_code == 409
