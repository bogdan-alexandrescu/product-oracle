"""Home's "Next review meeting" for a ritual whose roadmaps are all in Trash. Against
Postgres.

Test cards (protects / fails_when / no_claim):

- test_roadmap_refresh_says_its_roadmaps_are_in_trash: protects=while every roadmap is in
  Trash, Meetings > Upcoming (Home's "Next review meeting" reads its first row) marks a
  roadmap refresh ``reviews_in_trash="roadmap"``; a ritual that reviews no roadmap, and a
  refresh with a live roadmap (before the delete, after the restore), is not marked;
  fails_when=the refresh is listed as if its roadmap were live, or another ritual is
  marked; no_claim=the web line (web/e2e/home-honest-loading.spec.ts).
"""

from datetime import timedelta

from sqlalchemy import select

from oracle import company_time
from oracle.docs.models import Document
from oracle.rituals.models import Ritual
from oracle.tenancy import tenant_session
from tests.test_simple_meetings_api import MEETINGS
from tests.test_simple_meetings_api import world as meeting_world

SCHEDULE = {"freq": "monthly", "interval": 1, "weekday": 1, "week_of_month": 1, "month": 1,
            "time": "10:00", "timezone": "UTC"}  # fmt: skip


async def _rituals(w) -> tuple[str, str]:
    due = (company_time.now() + timedelta(days=2)).replace(microsecond=0)
    async with tenant_session(w.ctx.tenant_id) as s:
        refresh = Ritual(kind="roadmap_refresh", title="Monthly roadmap refresh",
                         duration_min=60, prep_hours=2, schedule=SCHEDULE, next_due_at=due,
                         owner_id=w.ctx.users["owner"].id)  # fmt: skip
        custom = Ritual(kind="custom", title="Team sync", duration_min=30, prep_hours=2,
                        schedule=SCHEDULE, next_due_at=due + timedelta(days=1),
                        owner_id=w.ctx.users["owner"].id)  # fmt: skip
        s.add_all([refresh, custom])
        await s.commit()
        return str(refresh.id), str(custom.id)


async def _marks(client, w) -> dict[str, str | None]:
    r = await client.get(MEETINGS, headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    return {row["ritual_id"]: row.get("reviews_in_trash") for row in r.json()["upcoming"]}


async def test_roadmap_refresh_says_its_roadmaps_are_in_trash(client):
    w = await meeting_world()
    refresh, custom = await _rituals(w)
    async with tenant_session(w.ctx.tenant_id) as s:
        roadmaps = list(await s.scalars(select(Document.slug).where(Document.kind == "roadmap")))
    assert roadmaps
    marks = await _marks(client, w)
    assert marks[refresh] is None and marks[custom] is None

    for slug in roadmaps:
        resp = await client.request("DELETE", f"/v1/documents/{slug}", headers=w.ctx.as_("owner"))
        assert resp.status_code == 200, resp.text
    marks = await _marks(client, w)
    assert marks[refresh] == "roadmap"
    assert marks[custom] is None

    back = await client.post(f"/v1/documents/{roadmaps[0]}/restore", headers=w.ctx.as_("owner"))
    assert back.status_code == 200, back.text
    marks = await _marks(client, w)
    assert marks[refresh] is None
