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


async def test_approve_says_each_problem_in_plain_words(client, monkeypatch):
    """walkc-meeting: protects=a meeting's Approve the importer refuses answers 422 with
    each problem once, in plain words with what to do (a count when repeated), never the
    raw "draft rejected: N problem(s)"; fails_when=the body is that raw line;
    no_claim=the importer's own checks."""
    from oracle.docs.parser import DraftError
    from oracle.docs.schemas import ImportProblem
    from oracle.simple import drafts

    said = "the date Nov 20 (in What we will build) is not backed by a confirmed schedule"
    problems = [ImportProblem(code="unverified_date", message=said)] * 2 + [
        ImportProblem(code="invalid_citation", message="a source is cited twice; drop one")
    ]

    async def refuse(*_a, **_k):
        raise DraftError(problems)

    monkeypatch.setattr(drafts, "approve_in_meeting", refuse)
    w = await world()
    mid = (await start(client, w))["id"]
    r = await client.post(f"/v1/simple/meetings/{mid}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 422, r.text
    assert "draft rejected" not in r.text
    detail = r.json()["detail"]
    assert detail["code"] == "draft_problems"
    assert detail["message"] == "Not approved: the draft has 3 problems to fix first."
    assert detail["problems"] == [
        {"what": said[0].upper() + said[1:] + ".", "where": None, "times": 2},
        {"what": "A source is cited twice; drop one.", "where": None, "times": 1},
    ]
