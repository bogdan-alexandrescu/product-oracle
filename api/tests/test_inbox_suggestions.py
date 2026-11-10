"""inbox-meeting-proposals fix: Oracle's open date and goal suggestions the person may
decide wait in their Inbox as rows of their own, counted in ``total``; a Simple draft
waiting on a required reviewer names who submitted it. Against Postgres. Made-up names
only.

Test cards (protects / fails_when / no_claim):

- test_open_date_suggestion_waits_on_who_may_decide_it: protects=an open date suggestion
  is a ``simple_date_suggestions`` row for the roadmap's decider, naming the item, its
  roadmap and dates, counted in ``total``; a commenter who may not decide it gets none;
  dismissed, the row leaves; fails_when=no row, not counted, a row for the commenter, or
  it stays once dismissed; no_claim=the web (e2e/inbox-suggestions.spec.ts).
- test_open_goal_suggestion_waits_on_who_may_decide_it: protects=an open goal suggestion
  is a ``simple_goal_suggestions`` row for the decider, naming the goal and the feature,
  counted in ``total``; the approver and commenter, who may not decide it, get none;
  rejected, the row leaves; fails_when=no row, not counted, a row for someone who may not
  decide, or it stays once rejected.
- test_draft_approval_names_who_submitted_it: protects=a submitted draft waiting on the
  required reviewer is a ``simple_approvals`` row naming the roadmap and who submitted it
  (``submitted_by_name``); fails_when=no name.
- test_draft_waiting_on_the_decider_is_in_their_inbox: protects=a submitted draft with no
  decider approval is a ``simple_approvals`` row for its decider (who is never in
  ``waiting_on``), counted in ``total``, gone once they approve; fails_when=no row, not
  counted, or it stays once approved.
- test_feature_ask_waits_as_asked_and_files_who_asked: protects=a teammate's feature ask
  waiting on the owners reads as proposed in their Inbox row (never "filed" before it is),
  and accepted, the request in Requests names the teammate as who asked when the ask named
  no one; fails_when=the row says "filed", or the request has no requester_name.
"""

import uuid
from datetime import date

from sqlalchemy import select

from oracle.requests.models import ProductRequest
from oracle.simple.models import RoadmapDateSuggestion, SimpleChange, SimpleGoalSuggestion
from oracle.tenancy import tenant_session
from tests.test_simple_additions_api import SUGGESTIONS, World
from tests.test_simple_additions_api import clock as clock  # noqa: F401

INBOX = "/v1/inbox"
DATES = "/v1/simple/roadmap/date-suggestions"


async def _inbox(client, w: World, who: str) -> dict:
    r = await client.get(INBOX, headers=w.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def _name(w: World, who: str) -> str:
    u = w.ctx.users[who]
    return u.name or u.email


async def test_open_date_suggestion_waits_on_who_may_decide_it(client):
    w = await World().build()
    before = (await _inbox(client, w, "decider"))["total"]
    async with tenant_session(w.ctx.tenant_id) as s:
        sug = RoadmapDateSuggestion(item_id=uuid.UUID(w.ids["import-b"]),
                                    start_date=date(2026, 12, 1), end_date=date(2026, 12, 18),
                                    basis="Two sprints after Bulk import")  # fmt: skip
        s.add(sug)
        await s.commit()
        sid = str(sug.id)
    inbox = await _inbox(client, w, "decider")
    rows = [x for x in inbox.get("simple_date_suggestions", []) if x["id"] == sid]
    assert len(rows) == 1, inbox.get("simple_date_suggestions")
    row = rows[0]
    assert row["item_id"] == w.ids["import-b"]
    assert row["item_title"] == "Import history"
    assert row["document_id"] == w.roadmap_id
    assert row["start_date"] == "2026-12-01" and row["end_date"] == "2026-12-18"
    assert inbox["total"] == before + 1
    commenter = await _inbox(client, w, "commenter")
    assert [x for x in commenter.get("simple_date_suggestions", []) if x["id"] == sid] == []
    r = await client.post(f"{DATES}/{sid}/dismiss", headers=w.as_("decider"))
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, w, "decider")
    assert [x for x in inbox["simple_date_suggestions"] if x["id"] == sid] == []
    assert inbox["total"] == before


async def test_open_goal_suggestion_waits_on_who_may_decide_it(client):
    w = await World().build()
    before = (await _inbox(client, w, "decider"))["total"]
    async with tenant_session(w.ctx.tenant_id) as s:
        sug = SimpleGoalSuggestion(goal_id=uuid.UUID(w.goals["quiet"]), title="Quiet hours",
                                   outcome="Fewer alerts at night", why="Alerts wake people",
                                   evidence=[], origin="auto")  # fmt: skip
        s.add(sug)
        await s.commit()
        sid = str(sug.id)
    inbox = await _inbox(client, w, "decider")
    rows = [x for x in inbox.get("simple_goal_suggestions", []) if x["id"] == sid]
    assert len(rows) == 1, inbox.get("simple_goal_suggestions")
    row = rows[0]
    assert row["title"] == "Quiet hours"
    assert row["goal"]["id"] == w.goals["quiet"]
    assert row["goal"]["title"]
    assert row["from_oracle"] is True
    assert inbox["total"] == before + 1
    for who in ("approver", "commenter"):
        other = await _inbox(client, w, who)
        assert [x for x in other.get("simple_goal_suggestions", []) if x["id"] == sid] == []
    r = await client.post(f"{SUGGESTIONS}/{sid}/reject", headers=w.as_("decider"), json={})
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, w, "decider")
    assert [x for x in inbox["simple_goal_suggestions"] if x["id"] == sid] == []
    assert inbox["total"] == before


async def test_draft_approval_names_who_submitted_it(client):
    w = await World().build()
    await w.add(client, "decider", "Guided setup")
    ds = (await client.get("/v1/simple/drafts", headers=w.as_("decider"))).json()
    d = next(x for x in ds if x["document"]["id"] == w.roadmap_id)
    r = await client.post(f"/v1/simple/drafts/{d['id']}/submit", headers=w.as_("decider"))
    assert r.status_code == 200, r.text
    [row] = (await _inbox(client, w, "approver"))["simple_approvals"]
    assert row["draft_id"] == d["id"]
    assert row["document"]["id"] == w.roadmap_id
    assert row["document_kind"] == "roadmap"
    assert row["submitted_by_name"] == _name(w, "decider")


async def test_draft_waiting_on_the_decider_is_in_their_inbox(client):
    w = await World().build()
    await w.add(client, "decider", "Guided setup")
    ds = (await client.get("/v1/simple/drafts", headers=w.as_("decider"))).json()
    d = next(x for x in ds if x["document"]["id"] == w.roadmap_id)
    before = (await _inbox(client, w, "decider"))["total"]
    r = await client.post(f"/v1/simple/drafts/{d['id']}/submit", headers=w.as_("decider"))
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, w, "decider")
    rows = [x for x in inbox["simple_approvals"] if x["draft_id"] == d["id"]]
    assert len(rows) == 1, inbox["simple_approvals"]
    assert rows[0]["decider_approved"] is False
    assert inbox["total"] == before + 1
    # The commenter, neither reviewer nor decider, gets none.
    assert (await _inbox(client, w, "commenter"))["simple_approvals"] == []
    r = await client.post(f"/v1/simple/drafts/{d['id']}/approve", headers=w.as_("decider"))
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, w, "decider")
    assert [x for x in inbox["simple_approvals"] if x["draft_id"] == d["id"]] == []
    assert inbox["total"] == before


async def test_feature_ask_waits_as_asked_and_files_who_asked(client):
    from oracle import company_time

    w = await World().build()
    u = w.ctx.users
    rid = uuid.uuid4()
    async with tenant_session(w.ctx.tenant_id) as s:
        c = SimpleChange(op="add_feature_ask", target={"request_id": str(rid)}, before={},
                         after={"title": "Bulk export", "requester_name": None,
                                "requester_kind": "unknown", "channel": "other"},
                         status="proposed", by=u["commenter"].id, at=company_time.now(),
                         routed_to=[u["owner"].id])  # fmt: skip
        s.add(c)
        await s.commit()
        cid = str(c.id)
    inbox = await _inbox(client, w, "owner")
    [row] = [x for x in inbox["simple_proposals"] if x["id"] == cid]
    assert row["asked"] == "proposed the feature ask “Bulk export”"
    r = await client.post(f"/v1/simple/changes/{cid}/accept", headers=w.as_("owner"), json={})
    assert r.status_code == 200, r.text
    async with tenant_session(w.ctx.tenant_id) as s:
        request = await s.scalar(select(ProductRequest).where(ProductRequest.id == rid))
    assert request is not None and request.filed_by == u["commenter"].id
    assert request.requester_name == _name(w, "commenter")
    assert request.requester_kind == "team"
