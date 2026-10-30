"""Simple Definition of Done, item 5 (docs/simple-dod-ops.md), review findings: the writes
that recorded no actor (minutes edit, date-suggestion refresh, PRD plan read-again,
meeting join) and the role refusals on chat cards and the minutes' send. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_unrecorded_writes_record_who_and_when: protects=editing a meeting's minutes,
  refreshing the date suggestions, reading a PRD's plan again and joining a meeting each
  leave an audit event naming the person and stamped during the request; fails_when=one of
  them writes without saying who did it; no_claim=what the write changes (its own tests).
- test_chat_card_writes_refuse_viewers_and_other_companies: protects=a viewer is refused
  discarding or undoing a chat card (403), another company's owner cannot discard, undo or
  choose on this company's chat (404), a viewer's pick of a choice builds a card the viewer
  may not apply, and nothing is written; fails_when=a viewer or an outsider changes a card
  or the roadmap; no_claim=who applies (test_simple_chat_api).
- test_only_the_presenter_decider_or_an_owner_sends_the_minutes: protects=an attendee who
  only proposes (approver, commenter) is refused sending the minutes (403), another
  company's owner gets 404, and the minutes stay unsent; fails_when=a proposer sends them;
  no_claim=the delivery itself (test_simple_meetings_api).
"""

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import select

from oracle.models import AuditEvent
from oracle.simple.models import SimpleChatCard, SimpleMeeting
from oracle.tenancy import tenant_session
from tests import test_simple_chat_api as ct
from tests import test_simple_meetings_api as mt
from tests import test_simple_plan_api as pt
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_changes_api import make_people
from tests.test_simple_roadmap_api import SUGGESTIONS


async def events(ctx, action: str) -> list[AuditEvent]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(await s.scalars(select(AuditEvent).where(AuditEvent.action == action)))


async def recorded(ctx, action: str, who: str, since: datetime, entity_id=None) -> None:
    [e] = await events(ctx, action)
    assert e.actor == f"user:{ctx.users[who].id}", action
    assert since <= e.created_at <= datetime.now(UTC), action
    if entity_id is not None:
        assert e.entity_id == uuid.UUID(str(entity_id)), action


async def test_unrecorded_writes_record_who_and_when(client):
    w = await mt.world()
    m = await mt.start(client, w, attendee_ids=[mt.uid(w, "approver")])
    since = datetime.now(UTC)
    r = await client.post(f"{mt.MEETINGS}/{m['id']}/join", headers=w.ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    await recorded(w.ctx, "simple_meeting.joined", "commenter", since, m["id"])
    await mt.end(client, w, m["id"])
    since = datetime.now(UTC)
    body = {"summary": "Short", "open_questions": [], "action_items": []}
    r = await client.put(f"{mt.MEETINGS}/{m['id']}/minutes", json=body,
                         headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    await recorded(w.ctx, "simple_meeting.minutes_edited", "decider", since, m["id"])

    since = datetime.now(UTC)
    r = await client.post(f"{SUGGESTIONS}/refresh", headers=w.ctx.as_("approver"))
    assert r.status_code == 200, r.text
    await recorded(w.ctx, "roadmap_date_suggestion.refresh", "approver", since)

    ctx = await pt.make_ctx()
    ids = await pt.seed(ctx)
    since = datetime.now(UTC)
    r = await client.post(f"{pt.url('guided-setup')}/read-again", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    await recorded(ctx, "simple_prd_plan.read_again", "owner", since, ids["prd"])


async def test_chat_card_writes_refuse_viewers_and_other_companies(client):
    ctx = await ct.make_people()
    w = await ct.World(ctx).build()
    other = await make_people()
    # The owner's applied card: neither a viewer nor an outsider undoes it.
    card = (await ct.say(client, ctx, "owner", "move Ledger v2 to Q2"))["cards"][0]
    r = await client.post(f"{ct.CARDS}/{card['id']}/apply", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    moved = (await w.item("Ledger v2")).start_date
    assert moved == date(2027, 4, 1)
    r = await client.post(f"{ct.CARDS}/{card['id']}/undo", headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    r = await client.post(f"{ct.CARDS}/{card['id']}/undo", headers=other.as_("owner"))
    assert r.status_code == 404, r.text
    assert (await w.item("Ledger v2")).start_date == moved
    # The viewer's own card: not discarded by the viewer, nor by an outsider.
    vcard = (await ct.say(client, ctx, "viewer", "cut Alert export"))["cards"][0]
    for who, code in ((ctx.as_("viewer"), 403), (other.as_("owner"), 404)):
        r = await client.post(f"{ct.CARDS}/{vcard['id']}/discard", headers=who)
        assert r.status_code == code, r.text
    # A choice: an outsider cannot pick it; the viewer's pick builds a card it cannot apply.
    q = await ct.say(client, ctx, "viewer", "move alert to Q2")
    assert q["kind"] == "question", q
    r = await client.post(f"{ct.ASK}/{q['id']}/choose", json={"index": 0},
                          headers=other.as_("owner"))  # fmt: skip
    assert r.status_code == 404, r.text
    r = await client.post(f"{ct.ASK}/{q['id']}/choose", json={"index": 0},
                          headers=ctx.as_("viewer"))  # fmt: skip
    assert r.status_code == 200, r.text
    built = r.json()["messages"][-1]["cards"]
    assert built and all(c["may"] is None and c["why_not"] for c in built), built
    r = await client.post(f"{ct.CARDS}/{built[0]['id']}/apply", headers=ctx.as_("viewer"))
    assert r.status_code == 403, r.text
    async with tenant_session(ctx.tenant_id) as s:
        status = {c.id: c.status for c in await s.scalars(select(SimpleChatCard))}
    assert status[uuid.UUID(card["id"])] == "applied"
    assert status[uuid.UUID(vcard["id"])] == "open"
    assert status[uuid.UUID(built[0]["id"])] == "open"
    assert await ct.n_changes(ctx) == 1
    assert not (await w.item("Alert export")).cut


async def test_only_the_presenter_decider_or_an_owner_sends_the_minutes(client):
    w = await mt.world()
    other = await make_people()
    m = await mt.start(client, w)
    await mt.end(client, w, m["id"])
    url = f"{mt.MEETINGS}/{m['id']}/send"
    for who in ("approver", "commenter"):
        r = await client.post(url, json={"email": True}, headers=w.ctx.as_(who))
        assert r.status_code == 403, (who, r.text)
    r = await client.post(url, json={"email": True}, headers=other.as_("owner"))
    assert r.status_code == 404, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(SimpleMeeting, uuid.UUID(m["id"]))
        assert row.minutes_state != "sent" and not row.delivery
    assert await events(w.ctx, "simple_meeting.sent") == []
