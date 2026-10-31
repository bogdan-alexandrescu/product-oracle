"""A review meeting for a PRD whose roadmap items are only on a run's draft roadmap
(meet-draft-items). Against Postgres.

A Baseline to PRD run writes the PRD's items onto a draft roadmap (``draft_roadmap_id``,
no ``roadmap_document_id``) until the PRD is approved. Before the fix the meeting's
``roadmap_ids`` held NULL and every read of the meeting answered 500.

Test cards (protects / fails_when / no_claim):

- test_meeting_for_prd_with_only_draft_items: protects=starting the meeting answers 201
  with ``roadmap_ids`` [], reading it 200, the meetings list 200, ending it 200;
  fails_when=a NULL roadmap id reaches the reply; no_claim=what the web shows for them.
- test_meeting_lists_only_real_roadmaps: protects=a PRD with items on a roadmap and on a
  draft roadmap lists only the roadmap; fails_when=the draft items add a NULL or the
  roadmap is dropped; no_claim=the draft items' own view.
"""

from sqlalchemy import select, update

from oracle.docs.models import Document, DocumentVersion
from oracle.roadmap.models import DraftRoadmap, RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import MEETINGS, PRD, end, get, start, world


async def add_draft_items(w, *, only: bool) -> None:
    """Nine items on a run's draft roadmap of the PRD; ``only``: the PRD has no others."""
    async with tenant_session(w.ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        pv = await s.scalar(
            select(DocumentVersion.id).where(DocumentVersion.document_id == prd.id).limit(1)
        )
        if only:
            await s.execute(
                update(RoadmapItem)
                .where(RoadmapItem.prd_document_id == prd.id)
                .values(prd_document_id=None)
            )
        draft = DraftRoadmap(prd_document_id=prd.id, prd_version_id=pv, status="ready")
        s.add(draft)
        await s.flush()
        for i in range(9):
            s.add(RoadmapItem(draft_roadmap_id=draft.id, item_key=f"draft-{i}", position=i,
                              title=f"Draft item {i}", horizon="now",
                              prd_document_id=prd.id, prd_version_id=pv))  # fmt: skip
        await s.commit()


async def test_meeting_for_prd_with_only_draft_items(client):
    w = await world()
    await add_draft_items(w, only=True)
    m = await start(client, w)
    assert m["roadmap_ids"] == []
    assert (await get(client, w, m["id"]))["roadmap_ids"] == []
    assert (await get(client, w, m["id"], who="commenter"))["roadmap_ids"] == []
    r = await client.get(MEETINGS, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert [x["id"] for x in r.json()["live"]] == [m["id"]]
    assert (await end(client, w, m["id"]))["status"] != "live"
    r = await client.get(MEETINGS, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text


async def test_meeting_lists_only_real_roadmaps(client):
    w = await world()
    await add_draft_items(w, only=False)
    m = await start(client, w)
    assert m["roadmap_ids"] == [w.roadmap_id]
    assert (await get(client, w, m["id"]))["roadmap_ids"] == [w.roadmap_id]
