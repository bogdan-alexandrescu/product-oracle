"""A proposed one-pager number fix (``set_section_number``) in the decider's Inbox (PR 1320
merge re-review): the row reads as what it is and opens on the one-pager section it changes,
not as "An item" on a roadmap. On test_simple_one_pager_numbers' invented PRDs "team-invites"
(a number in a section's words) and "later-list" (a count in a section's heading).

Test cards (protects / fails_when / no_claim):

- test_a_proposed_number_fix_reads_as_a_section_number: protects=an approver's fix is a row
  in the owner's ``simple_proposals`` named "Section number on Team invites: Use 6", with its
  PRD's ``document_id`` and the ``section`` it changes (where Open lands), reading as
  proposed; once accepted, the approver's decision reads as done under the same name;
  fails_when=the row has no subject or section (the web shows "An item" and opens a roadmap),
  or it reads as done while it waits; no_claim=the web's row and Open (e2e
  inbox-section-number-proposal).
- test_a_proposed_heading_count_reads_as_a_section_number: protects=a heading's count fix
  reads the same way ("the count in “Later”"); fails_when=it reads as an item.
"""

from tests.test_inbox_question_one_pager_proposals import _inbox, _row
from tests.test_simple_one_pager_api import CHANGES, get
from tests.test_simple_one_pager_api import clock as clock  # noqa: F401
from tests.test_simple_one_pager_clear import clear_world
from tests.test_simple_one_pager_numbers import COUNT, DOC, HEAD, HEAD_DOC, fix, head_world, look


async def test_a_proposed_number_fix_reads_as_a_section_number(client):
    ctx = await clear_world(client)
    view = await get(client, ctx, "owner", DOC)
    f = look(view, COUNT)["fix"]
    r = await fix(client, ctx, "approver", f)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "proposed"
    row = _row(await _inbox(client, ctx, "owner"), change["id"])
    assert row is not None
    assert row["subject"] == "Section number on Team invites: Use 6"
    assert row["document_id"] == view["document"]["id"]
    assert row["section"] == f["target"]["section"]
    assert row["item_id"] is None and row["item_title"] is None
    assert row["asked"] == "proposed setting the number in “Not this quarter” to 6"
    acc = await client.post(f"{CHANGES}/{change['id']}/accept", headers=ctx.as_("owner"))
    assert acc.status_code == 200, acc.text
    done = _row(
        {"simple_proposals": (await _inbox(client, ctx, "approver"))["simple_decisions"]},
        change["id"],
    )
    assert done is not None
    assert done["subject"] == "Section number on Team invites: Use 6"
    assert done["section"] == f["target"]["section"]
    assert done["asked"] == "set the number in “Not this quarter” to 6"


async def test_a_proposed_heading_count_reads_as_a_section_number(client):
    ctx = await head_world(client)
    f = look(await get(client, ctx, "owner", HEAD_DOC), HEAD)["fix"]
    r = await fix(client, ctx, "approver", f)
    assert r.status_code == 201, r.text
    row = _row(await _inbox(client, ctx, "owner"), r.json()["change"]["id"])
    assert row is not None
    assert row["subject"] == "Section number on Later list: Use 6"
    assert row["section"] == "later"
    assert row["asked"] == "proposed setting the count in “Later” to 6"
