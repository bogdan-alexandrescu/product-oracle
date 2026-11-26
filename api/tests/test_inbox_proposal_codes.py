"""inbox-codes (#1786, reopened): a proposal's Inbox row carries its feature's code
(``item_code``), read at the source, so the row names the feature with its code even when
the item is on no roadmap the Inbox page reads. Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_a_proposal_row_carries_its_features_code: protects=reviewer2's Inbox row for a
  meeting's cut of ``ship-a`` (imported from PRD section f-01) carries ``item_code`` "F-01"
  beside its unchanged ``item_title``; fails_when=the row has no code;
  no_claim=the web (e2e/inbox-proposal-codes.spec.ts).
- test_an_item_with_no_code_has_none: protects=an item with no code reads ``item_code``
  None (its name alone, flagged on the page); fails_when=a code is made up.
"""

from sqlalchemy import update

from oracle.roadmap.models import RoadmapItem
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meeting_agenda import INBOX, cut, meeting, with_roadmap_b
from tests.test_simple_meetings_api import world


async def _row(client, w, change_id: str) -> dict:
    r = await client.get(INBOX, headers=w.ctx.as_("reviewer2"))
    assert r.status_code == 200, r.text
    rows = [x for x in r.json()["simple_proposals"] if x["id"] == change_id]
    assert len(rows) == 1, r.json()["simple_proposals"]
    return rows[0]


async def test_a_proposal_row_carries_its_features_code(client):
    """A meeting's proposed cut of a coded item carries the item's code."""
    w = await world()
    await with_roadmap_b(w)
    async with tenant_session(w.ctx.tenant_id) as s:
        await s.execute(
            update(RoadmapItem)
            .where(RoadmapItem.id == w.ids["ship-a"])
            .values(prd_section_key="f-01")
        )
        await s.commit()
    m = await meeting(client, w)
    c = (await cut(client, w, "owner", "ship-a", m["session_id"])).json()["change"]
    row = await _row(client, w, c["id"])
    assert row["item_title"] == "Delivery integrity"
    assert row["item_code"] == "F-01"


async def test_an_item_with_no_code_has_none(client):
    """An item with no code of its own, feature or PRD section reads no code."""
    w = await world()
    await with_roadmap_b(w)
    m = await meeting(client, w)
    c = (await cut(client, w, "owner", "ship-a", m["session_id"])).json()["change"]
    row = await _row(client, w, c["id"])
    assert row["item_code"] is None
