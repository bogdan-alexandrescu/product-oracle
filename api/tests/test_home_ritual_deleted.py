"""Home's "Next review meeting" for a ritual whose roadmaps were deleted for good. Against
Postgres.

Test cards (protects / fails_when / no_claim):

- test_roadmap_refresh_says_its_roadmaps_were_deleted_for_good: protects=once every
  roadmap is purged from Trash, Meetings > Upcoming (Home's "Next review meeting" reads
  its first row) marks a roadmap refresh ``reviews_deleted="roadmap"`` and no longer
  ``reviews_in_trash``; while a roadmap is live or still in Trash it is not marked, and a
  ritual that reviews no roadmap never is; fails_when=the refresh is listed as if its
  roadmap were live or in Trash after the purge, or another ritual is marked;
  no_claim=the web line (web/e2e/home-deleted-roadmap.spec.ts).
"""

from sqlalchemy import select

from oracle.docs.models import Document
from oracle.tenancy import tenant_session
from tests.test_home_ritual_trash import _rituals
from tests.test_simple_meetings_api import MEETINGS
from tests.test_simple_meetings_api import world as meeting_world


async def _marks(client, w) -> dict[str, tuple[str | None, str | None]]:
    r = await client.get(MEETINGS, headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return {
        row["ritual_id"]: (row.get("reviews_in_trash"), row.get("reviews_deleted"))
        for row in r.json()["upcoming"]
    }


async def test_roadmap_refresh_says_its_roadmaps_were_deleted_for_good(client):
    w = await meeting_world()
    refresh, custom = await _rituals(w)
    async with tenant_session(w.ctx.tenant_id) as s:
        roadmaps = list(await s.scalars(select(Document.slug).where(Document.kind == "roadmap")))
    assert roadmaps
    marks = await _marks(client, w)
    assert marks[refresh] == (None, None) and marks[custom] == (None, None)

    entries = []
    for slug in roadmaps:
        resp = await client.request("DELETE", f"/v1/documents/{slug}", headers=w.ctx.as_("owner"))
        assert resp.status_code == 200, resp.text
        entries.append(resp.json()["id"])
    marks = await _marks(client, w)
    assert marks[refresh] == ("roadmap", None)

    owner = {**w.ctx.as_("owner"), "Origin": "http://test"}
    for entry in entries[:-1]:
        gone = await client.request("DELETE", f"/v1/trash/{entry}", headers=owner)
        assert gone.status_code == 204, gone.text
    # One roadmap is still in Trash: it can come back, so it is not deleted for good.
    marks = await _marks(client, w)
    assert marks[refresh] == ("roadmap", None)

    gone = await client.request("DELETE", f"/v1/trash/{entries[-1]}", headers=owner)
    assert gone.status_code == 204, gone.text
    marks = await _marks(client, w)
    assert marks[refresh] == (None, "roadmap")
    assert marks[custom] == (None, None)
