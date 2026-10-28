"""Walk fixes 3, M2 (2026-10-28): a review held early leaves "next". Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_held_review_leaves_upcoming: protects=once a review started from a ritual's
  occurrence ends (held before its due time), the ritual's occurrence is held and
  Meetings > Upcoming (Home's "Next review meeting" reads its first row) shows the
  ritual's following occurrence, with no meeting to open; fails_when=the held occurrence
  stays listed with its ended meeting ("Open meeting"), or stays scheduled/ready;
  no_claim=the minutes (test_simple_minutes*), the scheduler's tick (rituals' tests).
"""

import uuid

from oracle.rituals.models import Ritual, RitualOccurrence
from oracle.tenancy import tenant_session
from tests.test_simple_meetings_api import MEETINGS, start
from tests.test_simple_meetings_api import world as meeting_world
from tests.test_simple_meetings_walk import ritual


async def test_held_review_leaves_upcoming(client):
    w = await meeting_world()
    ritual_id, due = await ritual(w, owner="owner")
    m = await start(client, w, "owner", ritual_id=ritual_id, due_at=due.isoformat())

    async def row(who: str) -> dict:
        got = (await client.get(MEETINGS, headers=w.ctx.as_(who))).json()
        return next(x for x in got["upcoming"] if x["ritual_id"] == ritual_id)

    live = await row("owner")
    assert live["occurrence_id"] == m["occurrence_id"] and live["meeting_id"] == m["id"]
    r = await client.post(f"{MEETINGS}/{m['id']}/end", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        occ = await s.get(RitualOccurrence, uuid.UUID(m["occurrence_id"]))
        assert occ.status == "held" and occ.held_at is not None
        following = (await s.get(Ritual, uuid.UUID(ritual_id))).next_due_at
    assert following > due
    for who in ("owner", "decider", "approver", "commenter", "viewer"):
        nxt = await row(who)
        assert nxt["occurrence_id"] != m["occurrence_id"], who
        assert nxt["meeting_id"] is None, who
        assert nxt["due_at"].startswith(following.isoformat()[:19]), (who, nxt["due_at"])
