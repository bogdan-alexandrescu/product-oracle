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
"""

import uuid
from datetime import date

from oracle.simple.models import RoadmapDateSuggestion, SimpleGoalSuggestion
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
    assert row["submitted_by_name"] == _name(w, "decider")
