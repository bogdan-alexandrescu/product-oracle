"""Walk fixes 3, M2 (2026-10-28): a review held early leaves "next". Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_held_review_leaves_upcoming: protects=once a review started from a ritual's
  occurrence ends (held before its due time), the ritual's occurrence is held and
  Meetings > Upcoming (Home's "Next review meeting" reads its first row) shows the
  ritual's following occurrence, with no meeting to open; fails_when=the held occurrence
  stays listed with its ended meeting ("Open meeting"), or stays scheduled/ready;
  no_claim=the minutes (test_simple_minutes*), the scheduler's tick (rituals' tests).
- test_held_by_a_meeting_is_audited_and_recordable: protects=the end that holds the ritual's
  occurrence records "ritual.held" in the audit log, as Detailed's Mark held does, and the
  ritual's owner can still record the notes and decisions on it in Detailed (others are
  refused as before); fails_when=no "ritual.held" event, or the owner's Mark held answers
  409 "This occurrence is held"; no_claim=skipping (a held occurrence is not skipped).
"""

import uuid

from sqlalchemy import select

from oracle.models import AuditEvent
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


async def test_held_by_a_meeting_is_audited_and_recordable(client):
    w = await meeting_world()
    ritual_id, due = await ritual(w, owner="owner")
    m = await start(client, w, "owner", ritual_id=ritual_id, due_at=due.isoformat())
    r = await client.post(f"{MEETINGS}/{m['id']}/end", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    occ_id = uuid.UUID(m["occurrence_id"])
    async with tenant_session(w.ctx.tenant_id) as s:
        events = select(AuditEvent).where(
            AuditEvent.action == "ritual.held", AuditEvent.entity_id == occ_id
        )
        held = (await s.scalars(events)).all()
        held_at = (await s.get(RitualOccurrence, occ_id)).held_at
    assert len(held) == 1 and held[0].entity == "ritual_occurrence"

    url = f"/v1/ritual-occurrences/{occ_id}/held"
    for who in ("approver", "commenter", "viewer"):
        got = await client.post(url, json={"notes": "Agreed the plan."}, headers=w.ctx.as_(who))
        assert got.status_code == 403, (who, got.text)
    got = await client.post(url, json={"notes": "Agreed the plan."}, headers=w.ctx.as_("owner"))
    assert got.status_code == 200, got.text
    async with tenant_session(w.ctx.tenant_id) as s:
        occ = await s.get(RitualOccurrence, occ_id)
        assert occ.status == "held" and occ.notes == "Agreed the plan."
        assert occ.held_at == held_at
    skip = await client.post(
        f"/v1/ritual-occurrences/{occ_id}/skip", json={"reason": "x"}, headers=w.ctx.as_("owner")
    )
    assert skip.status_code == 409, skip.text
