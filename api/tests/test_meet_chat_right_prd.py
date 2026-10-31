"""meet-chat-right-prd: a review meeting's chat reads the meeting's own PRD. Against
Postgres; the reader's model is a fake. Made-up names only.

The company has two PRDs: the meeting's ("Alerts PRD", v2 under review, not approved, its
items only on v2's draft roadmap) and another, approved one ("Payments PRD") whose items
are on a roadmap with a milestone. Before the fix the reader was given every roadmap item
of the company but no draft-roadmap item, so it answered from the other PRD and a move of
the meeting PRD's first feature had no card.

Test cards (protects / fails_when / no_claim):

- test_the_reader_reads_only_the_meetings_prd: protects=the reader's items are the meeting
  PRD's draft-roadmap items (none of the other PRD's), its milestones none of the other
  PRD's, its context names the PRD and the draft under review; fails_when=the other PRD's
  items or milestones reach the reader, or the draft items are missing; no_claim=the
  prompt's wording.
- test_a_move_gets_a_card_for_the_meeting_prds_item: protects=a move asked in the chat
  ("Move Usage alerts to start on Dec 1, 2026.") gets one card for the meeting PRD's
  draft item, named, and applying it moves that item and records a meeting decision;
  fails_when=no card, a card for another item, or Apply fails; no_claim=the card's flags.
- test_a_cut_gets_a_card_and_an_unclear_item_a_question: protects=a cut of a draft item
  gets a card; a name matching two draft items asks which one; fails_when=no card or a
  guess; no_claim=the question's wording.
- test_an_answer_names_its_sources_and_reads_dates_month_first: protects=an answer's raw
  citation tokens ([c:5]) are dropped, its ISO dates read "Dec 1, 2026", and it names its
  source (the PRD, its draft and the draft roadmap); fails_when=a token, an ISO date or
  no source reaches the chat; no_claim=the model's words.
- test_an_oracle_line_is_dated_when_oracle_wrote_it: protects=a read line's time is when
  the reader wrote it, not the request's; fails_when=it keeps the request's time;
  no_claim=the order of the lines.
- test_an_oracle_line_is_never_marked_edited: protects=Oracle's write time is kept on its
  read (simple_chat_reads.answered_at), not in the line's edited_at, so a discussion view
  never labels its lines "edited"; fails_when=edited_at is set on Oracle's line;
  no_claim=the line's body.
- test_the_reader_reads_the_prd_text: protects=the reader is given the text of the
  meeting PRD's version under review; fails_when=only its title, version and approved
  flag reach it; no_claim=how much of a long PRD is kept.
- test_the_version_is_the_one_under_review: protects=the reader's prd_version and the
  answer's source name the PRD's version under review even when its items come from an
  older version's ready draft roadmap (the newer one still running); fails_when=the
  older draft's version is named; no_claim=which draft's items are read.
- test_an_ended_meeting_says_who_ended_it: protects=the chat's rules name who ended the
  meeting and when, or that it ended by itself after its time ran out; fails_when=only
  "ended" is said; no_claim=the web's words.
"""

import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import select

from oracle.discussions.models import DiscussionMessage
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import DraftRoadmap, ProductTrack, RoadmapItem, TrackMilestone
from oracle.simple.models import SimpleMeeting, SimpleSession
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_chat_reader import act, actions, read
from tests.test_simple_meetings_api import MEETINGS, PRD, end, start, world

CHAT = "/v1/simple/meetings/{}/chat"
FIRST = "Usage alerts"


async def two_prds(w) -> dict[str, str]:
    """The meeting's PRD (v1 approved, v2 under review, its items on v2's draft roadmap)
    beside the world's approved Payments PRD, which gets a milestone "M1 Ledger"."""
    ids: dict[str, str] = {}
    async with tenant_session(w.ctx.tenant_id) as s:
        track = await s.scalar(select(ProductTrack))
        s.add(TrackMilestone(track_id=track.id, name="M1 Ledger", target_date=None,
                             item_keys=["move_dates-a"]))  # fmt: skip
        doc = Document(slug="alerts-prd", title="Alerts PRD", kind="prd", status="draft",
                       visibility="company")  # fmt: skip
        s.add(doc)
        await s.flush()
        vs = []
        for n in (1, 2):
            approved = datetime(2026, 9, 1, tzinfo=UTC) if n == 1 else None
            v = DocumentVersion(document_id=doc.id, number=n, markdown=f"# Alerts v{n}\n",
                                content_hash=f"alerts-{n}", approved_at=approved)  # fmt: skip
            s.add(v)
            await s.flush()
            vs.append(v)
        s.add(DocumentReviewPolicy(document_id=doc.id, decider_id=w.ctx.users["decider"].id))
        for v in vs:
            draft = DraftRoadmap(prd_document_id=doc.id, prd_version_id=v.id, status="ready")
            s.add(draft)
            await s.flush()
            for i, title in enumerate((FIRST, "Alert digests", "Alert digests weekly")):
                row = RoadmapItem(draft_roadmap_id=draft.id, item_key=f"alerts-{i}",
                                  position=i, title=title, horizon="now",
                                  start_date=date(2026, 11, 2) + timedelta(days=30 * i),
                                  end_date=date(2026, 11, 30) + timedelta(days=30 * i),
                                  date_source="typed", prd_document_id=doc.id,
                                  prd_version_id=v.id)  # fmt: skip
                s.add(row)
                await s.flush()
                if v.number == 2:
                    ids[title] = str(row.id)
                else:
                    ids[f"old {title}"] = str(row.id)
        await s.commit()
    return ids


async def meeting(client, w) -> str:
    m = await start(client, w, prd="alerts-prd", title="Alerts review")
    return m["id"]


async def say(client, w, mid: str, text: str, who: str = "decider") -> dict:
    r = await client.post(f"{CHAT.format(mid)}/messages", json={"text": text},
                          headers=w.ctx.as_(who))  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()


async def last(client, w, mid: str, who: str = "decider") -> dict:
    r = await client.get(CHAT.format(mid), headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()["messages"][-1]


async def test_the_reader_reads_only_the_meetings_prd(client):
    w = await world()
    ids = await two_prds(w)
    mid = await meeting(client, w)
    await say(client, w, mid, "What does the plan say about alerts?")
    seen: list = []
    await read(w.ctx, {"actions": [], "clarify": None, "answer": None}, seen)
    [payload] = seen
    titles = [i["title"] for i in payload["items"]]
    assert sorted(titles) == sorted([FIRST, "Alert digests", "Alert digests weekly"])
    assert {i["id"] for i in payload["items"]} == {
        ids[FIRST],
        ids["Alert digests"],
        ids["Alert digests weekly"],
    }
    assert "M1 Ledger" not in payload["milestones"]
    meeting_ = payload["context"]["meeting"]
    assert meeting_["prd"] == "Alerts PRD"
    assert meeting_["prd_version"] == 2
    assert meeting_["approved"] is False


async def test_a_move_gets_a_card_for_the_meeting_prds_item(client):
    w = await world()
    ids = await two_prds(w)
    mid = await meeting(client, w)
    await say(client, w, mid, f"Move {FIRST} to start on Dec 1, 2026.")
    await read(w.ctx, actions(act("move_dates", item=ids[FIRST], when="2026-12-01")))
    m = await last(client, w, mid)
    assert m["kind"] == "cards", (m["kind"], m["body"])
    [card] = m["cards"]
    assert card["item_id"] == ids[FIRST]
    assert card["item_title"] == FIRST
    assert card["summary"].startswith(f"Move {FIRST} to Dec 1")
    assert card["may"] == "apply"
    r = await client.post(f"/v1/simple/chat/cards/{card['id']}/apply", json={},
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["card"]["status"] == "applied"
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(ids[FIRST]))
        assert row.start_date == date(2026, 12, 1)
    m = await last(client, w, mid)
    assert m["cards"][0]["status"] == "applied"
    assert m["cards"][0]["decision_id"]
    # Undo puts the item's dates back.
    r = await client.post(f"/v1/simple/chat/cards/{card['id']}/undo",
                          headers=w.ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        row = await s.get(RoadmapItem, uuid.UUID(ids[FIRST]))
        assert row.start_date == date(2026, 11, 2)


async def test_a_cut_gets_a_card_and_an_unclear_item_a_question(client):
    w = await world()
    ids = await two_prds(w)
    mid = await meeting(client, w)
    await say(client, w, mid, "drop the weekly digests please")
    await read(w.ctx, actions(act("cut", item=ids["Alert digests weekly"])))
    m = await last(client, w, mid)
    assert m["kind"] == "cards", (m["kind"], m["body"])
    assert m["cards"][0]["item_id"] == ids["Alert digests weekly"]
    await say(client, w, mid, "let's push the digests out a month")
    await read(w.ctx, actions(act("move_dates", item="Alert digests", shift="1 month")))
    m = await last(client, w, mid)
    assert m["kind"] == "cards"
    assert m["cards"][0]["item_id"] == ids["Alert digests"]
    await say(client, w, mid, "and push digest out two months")
    await read(w.ctx, actions(act("move_dates", item="digest", shift="2 months")))
    m = await last(client, w, mid)
    assert m["kind"] == "question", (m["kind"], m["body"])
    assert {c["label"] for c in m["choices"]} >= {"Alert digests", "Alert digests weekly"}


async def test_an_answer_names_its_sources_and_reads_dates_month_first(client):
    w = await world()
    await two_prds(w)
    mid = await meeting(client, w)
    await say(client, w, mid, f"When does {FIRST} start?")
    await read(w.ctx, {"actions": [], "clarify": None,
                       "answer": f"{FIRST} starts on 2026-11-02 [c:5] and ends 2026-11-30.",
                       "source": "prd"})  # fmt: skip
    m = await last(client, w, mid)
    assert m["kind"] == "answer", (m["kind"], m["body"])
    assert m["body"] == f"{FIRST} starts on Nov 2, 2026 and ends Nov 30, 2026."
    assert m["source"] == "From Alerts PRD (draft 2) and its draft roadmap"


async def test_an_oracle_line_is_dated_when_oracle_wrote_it(client):
    w = await world()
    ids = await two_prds(w)
    mid = await meeting(client, w)
    await say(client, w, mid, f"Move {FIRST} to start on Dec 1, 2026.")
    async with tenant_session(w.ctx.tenant_id) as s:
        # The request was made a while ago (the reader was slow).
        for msg in await s.scalars(select(DiscussionMessage)):
            msg.created_at = msg.created_at - timedelta(minutes=5)
        await s.commit()
    before = datetime.now(UTC)
    await read(w.ctx, actions(act("move_dates", item=ids[FIRST], when="2026-12-01")))
    r = await client.get(CHAT.format(mid), headers=w.ctx.as_("decider"))
    asked, answer = r.json()["messages"][-2:]
    assert datetime.fromisoformat(answer["at"]) >= before
    assert datetime.fromisoformat(asked["at"]) < before - timedelta(minutes=4)


async def test_an_ended_meeting_says_who_ended_it(client):
    w = await world()
    await two_prds(w)
    mid = await meeting(client, w)
    await end(client, w, mid)
    r = await client.get(CHAT.format(mid), headers=w.ctx.as_("approver"))
    rules = r.json()["rules"]
    assert rules["ended"] is True
    assert rules["ended_by"] == {"id": str(w.ctx.users["decider"].id), "name": "Dee Cider"}
    assert rules["ended_by_itself"] is False
    assert rules["ended_at"]
    # A second meeting nobody ends: its session goes idle and it ends by itself.
    mid2 = (await start(client, w, prd=PRD, title="Payments review"))["id"]
    async with tenant_session(w.ctx.tenant_id) as s:
        m = await s.get(SimpleMeeting, uuid.UUID(mid2))
        session = await s.get(SimpleSession, m.session_id)
        session.last_change_at = session.started_at = datetime(2026, 1, 1, tzinfo=UTC)
        await s.commit()
    r = await client.get(CHAT.format(mid2), headers=w.ctx.as_("approver"))
    assert r.status_code == 200, r.text
    rules = r.json()["rules"]
    assert rules["ended"] is True, rules
    assert rules["ended_by_itself"] is True
    assert rules["ended_at"]
    r = await client.get(MEETINGS, headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text


async def test_an_oracle_line_is_never_marked_edited(client):
    w = await world()
    await two_prds(w)
    mid = await meeting(client, w)
    await say(client, w, mid, f"When does {FIRST} start?")
    before = datetime.now(UTC)
    await read(w.ctx, {"actions": [], "clarify": None, "answer": f"{FIRST} starts Nov 2.",
                       "source": "prd"})  # fmt: skip
    async with tenant_session(w.ctx.tenant_id) as s:
        oracle_ = [m for m in await s.scalars(select(DiscussionMessage))
                   if m.author_kind != "person"]  # fmt: skip
        assert oracle_ and all(m.edited_at is None for m in oracle_)
    m = await last(client, w, mid)
    assert m["kind"] == "answer"
    assert datetime.fromisoformat(m["at"]) >= before


async def test_the_reader_reads_the_prd_text(client):
    w = await world()
    await two_prds(w)
    mid = await meeting(client, w)
    await say(client, w, mid, "What does the PRD say?")
    seen: list = []
    await read(w.ctx, {"actions": [], "clarify": None, "answer": None}, seen)
    [payload] = seen
    assert "# Alerts v2" in payload["context"]["meeting"]["prd_text"]


async def test_the_version_is_the_one_under_review(client):
    w = await world()
    await two_prds(w)
    async with tenant_session(w.ctx.tenant_id) as s:
        v2 = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.content_hash == "alerts-2")
        )
        draft = await s.scalar(select(DraftRoadmap).where(DraftRoadmap.prd_version_id == v2.id))
        draft.status = "running"
        await s.commit()
    mid = await meeting(client, w)
    await say(client, w, mid, f"When does {FIRST} start?")
    seen: list = []
    await read(w.ctx, {"actions": [], "clarify": None, "answer": f"{FIRST} starts Nov 2.",
                       "source": "prd"}, seen)  # fmt: skip
    [payload] = seen
    assert payload["context"]["meeting"]["prd_version"] == 2
    assert {i["title"] for i in payload["items"]} >= {FIRST}
    m = await last(client, w, mid)
    assert m["source"] == "From Alerts PRD (draft 2) and its draft roadmap"
