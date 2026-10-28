"""The walk-fixes review, round 2 (2026-10-28). Against Postgres; jobs run with fakes.

Test cards (protects / fails_when / no_claim):

- test_next_review_keeps_past_attendees_after_the_scheduler_runs: protects=the next
  review lists who was present at the last review held after the scheduler makes the
  ritual's next occurrence (which moves ``next_due_at`` and with it ``updated_at``), and
  lists the edited list once the ritual's attendees are edited after the review;
  fails_when=the scheduler's tick drops the past attendees (the "fresh" check read
  ``updated_at``), or an attendee edit after the review keeps them; no_claim=the
  occurrence's pre-read (the rituals' tests).
"""

import uuid
from datetime import timedelta

from oracle.rituals import clock
from oracle.rituals.models import Ritual
from oracle.tenancy import tenant_session
from tests.ritual_helpers import tick
from tests.test_simple_meetings_api import start, uid
from tests.test_simple_meetings_api import world as meeting_world
from tests.test_simple_meetings_walk import ritual


async def test_next_review_keeps_past_attendees_after_the_scheduler_runs(client, monkeypatch):
    w = await meeting_world()
    ritual_id, due = await ritual(w, owner="owner")
    await start(client, w, "owner", ritual_id=ritual_id, due_at=due.isoformat())

    async def listed() -> set[str]:
        got = (await client.get("/v1/simple/meetings", headers=w.ctx.as_("viewer"))).json()
        row = next(x for x in got["upcoming"] if x["ritual_id"] == ritual_id)
        return {a["id"] for a in row["attendees"]}

    held = {uid(w, "owner"), uid(w, "approver"), uid(w, "commenter")}
    assert await listed() == held
    # The scheduler makes the next occurrence (its prep window has come): the ritual's
    # next_due_at moves on, and the past attendees stay listed.
    async with tenant_session(w.ctx.tenant_id) as s:
        nxt = (await s.get(Ritual, uuid.UUID(ritual_id))).next_due_at
    monkeypatch.setattr(clock, "now", lambda: nxt - timedelta(hours=1))
    await tick(w.ctx.tenant_id)
    async with tenant_session(w.ctx.tenant_id) as s:
        assert (await s.get(Ritual, uuid.UUID(ritual_id))).next_due_at > nxt
    assert await listed() == held
    # The ritual's attendees edited after the review (as an owner does): its list is the list.
    r = await client.get(f"/v1/rituals/{ritual_id}", headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    body = {"attendee_ids": [uid(w, "commenter")], "lock_version": r.json()["lock_version"]}
    r = await client.patch(f"/v1/rituals/{ritual_id}", json=body, headers=w.ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert await listed() == {uid(w, "owner"), uid(w, "commenter")}
