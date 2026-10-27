"""Simple S8 (#723): the review's findings on meetings (oracle.simple.meetings). Against
Postgres, over REST as a person would, on test_simple_meetings_api's world.

Test cards (protects / fails_when / no_claim):

- test_decided_flow_is_linked: protects=a meeting decision on a new flow or feature (a
  draft item) carries its flow (``oracle.simple.visuals.flow_for``, the s10 contract) on
  the meeting and on the Decisions page, and still names the item when there is no flow
  or no visuals module ("No flow yet"); a decision on a planned item carries none;
  fails_when=the decided flow is not linked; no_claim=how S10 draws the flow.
- test_filtered_decisions_reach_older_ones: protects=the Decisions page's PRD filter finds
  a matching decision outside meetings behind 200 newer ones; fails_when=the newest 200
  are taken before the filter.
- test_idle_meeting_ends: protects=a meeting whose session closed for idleness reads as
  ended (with Oracle's quick minutes), in Past, and its presenter may still send them;
  fails_when=it stays live while changes through it are refused.
- test_one_meeting_per_occurrence: protects=a second start from the same scheduled review
  is 409 naming the first meeting; fails_when=two meetings share the occurrence.
- test_change_and_its_meeting_decision_commit_together: protects=a change made through a
  meeting is written with its meeting decision or not at all; fails_when=a failure
  recording the decision leaves the change without it.
"""

import sys
import types
import uuid
from datetime import timedelta

from sqlalchemy import select, update

from oracle import company_time
from oracle.decisions import capture
from oracle.docs.models import Document
from oracle.roadmap.models import RoadmapItem
from oracle.simple import meetings
from oracle.simple.models import SimpleChange, SimpleMeeting, SimpleSession
from oracle.simple.schemas import SimpleFlow, SimpleFlowScreen
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meetings_api import MEETINGS, PRD, edit_title, get, start, world

DECISIONS = "/v1/simple/decisions"
FLOW = SimpleFlow(
    title="Pay by link",
    steps=["Open the link", "Pay"],
    screen=SimpleFlowScreen(title="Checkout", regions=["Amount", "Pay button"]),
)


def visuals_module(monkeypatch, flows: dict) -> list:
    """A stand-in for s10's oracle.simple.visuals; returns the calls it saw."""
    import oracle.simple

    calls: list = []

    async def flow_for(db, subject_kind, subject_id):
        calls.append((subject_kind, subject_id))
        return flows.get((subject_kind, subject_id))

    mod = types.ModuleType("oracle.simple.visuals")
    mod.flow_for = flow_for  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "oracle.simple.visuals", mod)
    monkeypatch.setattr(oracle.simple, "visuals", mod, raising=False)
    return calls


def no_visuals(monkeypatch) -> None:
    import oracle.simple

    monkeypatch.setitem(sys.modules, "oracle.simple.visuals", None)  # ImportError
    monkeypatch.delattr(oracle.simple, "visuals", raising=False)


async def test_decided_flow_is_linked(client, monkeypatch):
    w = await world()
    item = uuid.UUID(w.ids["edit_title-a"])
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(update(RoadmapItem).where(RoadmapItem.id == item).values(draft=True))
        await s.commit()
    calls = visuals_module(monkeypatch, {("draft_item", item): FLOW})
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    r = await w.post(
        client, "decider", "reorder", session_id=m["session_id"], before={"position": 12}
    )
    assert r.status_code == 201, r.text
    out = await get(client, w, m["id"])
    by_title = {d["title"]: d for d in out["meeting_decisions"]}
    linked = by_title["Renamed Edit_Title A"]["flow"]
    assert linked == {"kind": "draft_item", "id": str(item), "title": "Ledger v2",
                      "flow": FLOW.model_dump()}  # fmt: skip
    assert ("draft_item", item) in calls
    # A planned item's change is no new flow: no link.
    assert [d["flow"] for t, d in by_title.items() if t.startswith("Reordered")] == [None]
    r = await client.get(DECISIONS, headers=w.ctx.as_("viewer"))
    [g] = r.json()["meetings"]
    rows = {d["title"]: d for d in g["decisions"]}
    assert rows["Renamed Edit_Title A"]["flow"]["flow"]["title"] == "Pay by link"
    # No flow drawn yet, and no visuals module at all: the item is still linked.
    visuals_module(monkeypatch, {})
    got = (await get(client, w, m["id"]))["meeting_decisions"]
    flow = next(d["flow"] for d in got if d["title"] == "Renamed Edit_Title A")
    assert flow["id"] == str(item) and flow["flow"] is None
    no_visuals(monkeypatch)
    got = (await get(client, w, m["id"]))["meeting_decisions"]
    flow = next(d["flow"] for d in got if d["title"] == "Renamed Edit_Title A")
    assert flow["id"] == str(item) and flow["flow"] is None


async def test_filtered_decisions_reach_older_ones(client):
    w = await world()
    async with tenant_session(w.ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))

        async def add(title: str, subject: uuid.UUID) -> None:
            await capture.capture(s, None, origin="version_approval", source_kind="test",
                                  source_id=uuid.uuid4(), title=title,
                                  options=[{"key": "approve"}], chosen_option="approve",
                                  rationale="Fine", approver_id=w.ctx.users["owner"].id,
                                  subjects=[{"kind": "document", "id": str(subject)}])  # fmt: skip

        await add("Approved the PRD", prd.id)
        for i in range(201):
            await add(f"Elsewhere {i}", uuid.uuid4())
        await s.commit()
    r = await client.get(DECISIONS, params={"prd": PRD}, headers=w.ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    assert [d["title"] for d in r.json()["other"]] == ["Approved the PRD"]


async def test_idle_meeting_ends(client):
    w = await world()
    m = await start(client, w)
    assert (await edit_title(client, w, "decider", m["session_id"])).status_code == 201
    async with tenant_session(w.ctx.tenant_id) as s:
        old = company_time.now() - timedelta(hours=5)
        await s.execute(update(SimpleSession).where(SimpleSession.id == uuid.UUID(m["session_id"]))
                        .values(started_at=old, last_change_at=old))  # fmt: skip
        await s.commit()
    out = await get(client, w, m["id"])
    assert out["status"] == "ended" and not out["can"]["change"] and not out["can"]["approve"]
    assert out["minutes"] and "Renamed Edit_Title A" in out["minutes"]["summary"]
    assert out["can"]["end"]
    listed = (await client.get(MEETINGS, headers=w.ctx.as_("commenter"))).json()
    assert listed["live"] == [] and [x["id"] for x in listed["past"]] == [m["id"]]
    r = await client.post(f"{MEETINGS}/{m['id']}/send", json={}, headers=w.ctx.as_("decider"))
    assert r.status_code == 200 and r.json()["minutes_state"] == "sent", r.text


async def test_one_meeting_per_occurrence(client):
    from oracle.rituals.models import Ritual, RitualOccurrence

    w = await world()
    async with tenant_session(w.ctx.tenant_id) as s:
        now = company_time.now()
        r = Ritual(kind="custom", title="Weekly review", schedule={}, duration_min=45,
                   prep_hours=0, owner_id=w.ctx.users["decider"].id, attendee_ids=[])  # fmt: skip
        s.add(r)
        await s.flush()
        o = RitualOccurrence(ritual_id=r.id, due_at=now, ends_at=now + timedelta(hours=1))
        s.add(o)
        await s.commit()
        occ = str(o.id)
    first = await start(client, w, occurrence_id=occ)
    assert first["occurrence_id"] == occ
    r = await client.post(MEETINGS, json={"prd": PRD, "occurrence_id": occ},
                          headers=w.ctx.as_("owner"))  # fmt: skip
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["meeting_id"] == first["id"]
    async with tenant_session(w.ctx.tenant_id) as s:
        rows = list(await s.scalars(select(SimpleMeeting).where(
            SimpleMeeting.occurrence_id == uuid.UUID(occ))))  # fmt: skip
        assert len(rows) == 1


async def test_change_and_its_meeting_decision_commit_together(client, monkeypatch):
    w = await world()
    m = await start(client, w)

    real = meetings.record_meeting_decision

    async def fails(*a, **k):
        raise meetings.MeetingError(409, "boom")

    monkeypatch.setattr(meetings, "record_meeting_decision", fails)
    r = await edit_title(client, w, "decider", m["session_id"])
    assert r.status_code == 409, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        assert list(await s.scalars(select(SimpleChange))) == []
    monkeypatch.setattr(meetings, "record_meeting_decision", real)
    r = await edit_title(client, w, "decider", m["session_id"])
    assert r.status_code == 201, r.text
    assert [d["title"] for d in (await get(client, w, m["id"]))["meeting_decisions"]] == [
        "Renamed Edit_Title A"
    ]
