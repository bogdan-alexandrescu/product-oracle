"""Simple DoD: the date suggestions' review-policy cells of docs/simple-dod-ops.md
(section 6, accept and edit). Against Postgres, over REST (oracle.simple.router).

Test cards (protects / fails_when / no_claim):

- test_a_viewer_cannot_accept_or_edit_a_date_suggestion: protects=a viewer's Accept and
  Edit on an Oracle date suggestion are refused (403) and write nothing: no change row,
  the suggestion stays open, the item keeps no dates in the published roadmap or the
  working draft; a commenter's Accept on the same suggestion is a proposal (the route's
  role is commenter, the change engine decides); fails_when=a viewer's accept or edit
  lands, proposes, or closes the suggestion; no_claim=who applies directly
  (test_simple_review_fixes::test_suggestions_go_through_the_change_engine).
- test_another_company_cannot_accept_or_edit_a_date_suggestion: protects=another
  company's owner cannot accept or edit this company's date suggestion (404, never 2xx)
  and nothing is written in either company; fails_when=the suggestion is found or
  changed across tenants; no_claim=listing (tenant-scoped by the session).
"""

import uuid

from sqlalchemy import func, select

from oracle.simple.models import RoadmapDateSuggestion, SimpleChange
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import World, make_people
from tests.test_simple_drafts_api import published, roadmap
from tests.test_simple_roadmap_api import SUGGESTIONS, by_key

EDIT = {"start_date": "2026-11-02", "end_date": "2026-11-30"}


async def state(ctx, sid: str) -> tuple[int, str]:
    async with tenant_session(ctx.tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(SimpleChange))
        return n or 0, (await s.get(RoadmapDateSuggestion, uuid.UUID(sid))).status


async def test_a_viewer_cannot_accept_or_edit_a_date_suggestion(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    sid = w.suggestion["move_dates-u"]
    assert await state(ctx, sid) == (0, "open")
    for action, body in (("accept", None), ("edit", EDIT)):
        r = await client.post(f"{SUGGESTIONS}/{sid}/{action}", json=body,
                              headers=ctx.as_("viewer"))  # fmt: skip
        assert r.status_code == 403, (action, r.text)
        assert await state(ctx, sid) == (0, "open"), action
    row = await published(w, "move_dates-u")
    assert (row.start_date, row.end_date) == (None, None)
    item = by_key(await roadmap(client, w, "owner"))["move_dates-u"]
    assert item["start"]["source"] != "accepted"
    # The same suggestion, a commenter: a proposal for the decider, still nothing applied.
    r = await client.post(f"{SUGGESTIONS}/{sid}/accept", headers=ctx.as_("commenter"))
    assert r.status_code == 200, r.text
    assert r.json()["change"]["status"] == "proposed"
    assert await state(ctx, sid) == (1, "open")


async def test_another_company_cannot_accept_or_edit_a_date_suggestion(client):
    ctx = await make_people()
    w = await World(ctx).build(decider=True, ops=["move_dates"])
    other = await make_people()
    sid = w.suggestion["move_dates-u"]
    for action, body in (("accept", None), ("edit", EDIT)):
        r = await client.post(f"{SUGGESTIONS}/{sid}/{action}", json=body,
                              headers=other.as_("owner"))  # fmt: skip
        assert r.status_code == 404, (action, r.text)
    assert await state(ctx, sid) == (0, "open")
    async with tenant_session(other.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(SimpleChange)) == 0
    assert (await published(w, "move_dates-u")).start_date is None
