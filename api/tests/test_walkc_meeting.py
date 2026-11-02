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
from tests.test_simple_chat_actions import CARDS, apply, say
from tests.test_simple_meetings_api import MEETINGS, start, uid, world


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


async def test_a_stalled_minutes_job_fails_with_draft_again(client):
    """walkc-meeting: protects=a minutes job still queued past MINUTES_STUCK reads
    "failed" with Draft again (never "drafting" on), and Draft again cancels it and
    queues a new one; fails_when=it stays "slow" with no way out; no_claim=the job's
    own answer."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from oracle.jobs.models import LlmJob
    from tests.test_simple_meetings_api import get
    from tests.test_simple_meetings_walk import ended, set_job

    w = await world()
    m = await ended(client, w)
    await set_job(w, updated_at=datetime.now(UTC) - timedelta(minutes=13))
    out = await get(client, w, m["id"])
    assert out["minutes_job"] == "failed" and out["can"]["redraft"]
    r = await client.post(f"/v1/simple/meetings/{m['id']}/minutes/redraft",
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["minutes_job"] == "drafting"
    async with tenant_session(w.ctx.tenant_id) as s:
        jobs = list(await s.scalars(select(LlmJob).where(LlmJob.kind == "meeting_minutes")
                                    .order_by(LlmJob.created_at)))  # fmt: skip
        assert [j.status for j in jobs] == ["cancelled", "queued"]


async def test_minutes_do_not_wait_for_the_prds_other_jobs(client):
    """walkc-meeting: protects=the worker claims a queued minutes job while another job on
    the same PRD runs and an older one waits; fails_when=the minutes wait behind the PRD's
    jobs (the walk's 13-15 minutes of "drafting"); no_claim=other kinds' order."""
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import select

    from oracle.jobs import worker
    from oracle.jobs.models import LlmJob
    from tests.test_simple_meetings_walk import ended

    w = await world()
    await ended(client, w)
    async with tenant_session(w.ctx.tenant_id) as s:
        minutes = await s.scalar(select(LlmJob).where(LlmJob.kind == "meeting_minutes"))
        old = datetime.now(UTC) - timedelta(minutes=5)
        for status in ("running", "queued"):
            s.add(LlmJob(kind="one_pager", document_id=minutes.document_id, status=status,
                         input={}, created_at=old, updated_at=old,
                         started_at=old if status == "running" else None))  # fmt: skip
        await s.commit()
        minutes_id = minutes.id
    assert await worker.claim_next(w.ctx.tenant_id) == minutes_id


async def test_a_task_on_an_item_whose_name_holds_for(client):
    """walkc-meeting: protects=a task line on an item named "Exports for teams" finds that
    item (the longest name the roadmap knows), with and without "for <person>";
    fails_when=the line splits at the name's own " for " (item "Exports", owner "teams
    for Theo"); no_claim=other phrases."""
    from sqlalchemy import update

    from oracle.roadmap.models import RoadmapItem
    from tests.test_simple_chat_api import World, make_people
    from tests.test_simple_chat_api import say as ask

    ctx = await make_people()
    w = await World(ctx).build()
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(update(RoadmapItem).where(RoadmapItem.id == w.ids["Partner API"])
                        .values(title="Exports for teams"))  # fmt: skip
        await s.commit()
    for line, owner in (
        ("add a task 'Draft the email' to Exports for teams for commenter by March 5",
         str(ctx.users["commenter"].id)),
        ("add a task 'Write the FAQ' to Exports for teams", None),
    ):  # fmt: skip
        m = await ask(client, ctx, "owner", line)
        assert m["kind"] == "cards", (line, m["body"])
        [card] = m["cards"]
        assert card["op"] == "add_item_task"
        assert card["target"]["item_id"] == w.ids["Partner API"], line
        assert card["after"]["owner_id"] == owner, line


async def test_a_card_reads_the_meetings_working_state(client):
    """walkc-meeting: protects=an open card in a meeting checks its links on the meeting's
    working state, so once a fix applied in the meeting clears a broken link, a card on
    that item offers no fixes for it; fails_when=the card still offers the fixes of the
    link the meeting already mended; no_claim=cards outside a meeting."""
    w = await world()
    mid = (await start(client, w, "owner", attendee_ids=[uid(w, "commenter")]))["id"]
    # Cut B starts before Cut A ends: a broken link both cards see.
    [later] = (await say(client, w, "commenter", "rename Cut B to Cut Y", mid))["cards"]
    assert later["fixes"], later
    [card] = (await say(client, w, "owner", "rename Cut A to Cut Q", mid))["cards"]
    assert card["fixes"], card
    r = await client.post(f"{CARDS}/{card['id']}/apply", json={"fix": 0},
                          headers=w.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 200, r.text
    r = await client.get(f"{MEETINGS}/{mid}/chat", headers=w.ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    cards = {c["id"]: c for m in r.json()["messages"] for c in m.get("cards") or []}
    assert cards[later["id"]]["status"] == "open"
    assert cards[later["id"]]["fixes"] == []
