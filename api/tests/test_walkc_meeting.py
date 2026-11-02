"""walkc-meeting: a live Simple review meeting, as an end-to-end walk ran it. Against
Postgres, with S8's real meetings module. People of tests.test_simple_meetings_api.world,
plus ``owner2`` (a second company owner who is not in the meeting); the roadmap names no
decider, so outside a meeting a proposal goes to every company owner.

Test cards (protects / fails_when / no_claim):

- test_a_meeting_proposal_goes_to_the_meetings_deciders: protects=an attendee's Propose
  in a meeting goes to the meeting's deciders (the owner in it), never to an owner who is
  not in it, and the card names who it asks before and after Propose; fails_when=the
  proposal is routed to every company owner; no_claim=proposals outside a meeting.
- test_nobody_in_the_meeting_decides: protects=when nobody in the meeting may decide, the
  open card says so (asks_outside) and names who Propose would ask; fails_when=the card
  is silent; no_claim=the web's words (web spec).
"""

from sqlalchemy import delete

from oracle.auth.models import User
from oracle.review.models import DocumentReviewPolicy
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_actions import apply, say
from tests.test_simple_meetings_api import start, uid, world


async def _no_roadmap_decider(w) -> None:
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(
            delete(DocumentReviewPolicy).where(DocumentReviewPolicy.document_id == w.roadmap_id)
        )
        user = User(email="owner2@example.com", name="Olive Second", password_hash="x",
                    role="owner")  # fmt: skip
        s.add(user)
        await s.commit()
        w.ctx.users["owner2"] = user


async def test_a_meeting_proposal_goes_to_the_meetings_deciders(client):
    w = await world()
    await _no_roadmap_decider(w)
    mid = (await start(client, w, "owner", attendee_ids=[uid(w, "commenter")]))["id"]
    [card] = (await say(client, w, "commenter", "rename Cut A to Cut Z", mid))["cards"]
    assert card["may"] == "propose"
    owner = w.ctx.users["owner"]
    assert card["asks_outside"] is False
    assert card["asks"] == ["Owner"]
    r = await apply(client, w, "commenter", card["id"])
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["card"]["status"] == "proposed"
    assert out["result"]["change"]["routed_to"] == [str(owner.id)]
    assert out["card"]["asks"] == ["Owner"]


async def test_nobody_in_the_meeting_decides(client):
    w = await world()
    await _no_roadmap_decider(w)
    mid = (await start(client, w, attendee_ids=[uid(w, "commenter")]))["id"]
    [card] = (await say(client, w, "commenter", "rename Cut A to Cut Z", mid))["cards"]
    assert card["may"] == "propose"
    assert card["asks_outside"] is True
    names = {"Owner", "Olive Second"}
    assert set(card["asks"]) == names
