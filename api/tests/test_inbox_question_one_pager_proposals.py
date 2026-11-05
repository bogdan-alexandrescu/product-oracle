"""inbox-meeting-proposals fix 3: a teammate's proposed answer to a PRD question
(decide_question, name_decider) and a teammate's proposed one-pager wording (edit_line)
wait in the decider's Inbox with what they are on, so the row is named and opens where it
is decided. Against Postgres. Made-up names only.

Test cards (protects / fails_when / no_claim):

- test_a_proposed_question_answer_waits_named_by_its_question (decide_question,
  name_decider): protects=a commenter's proposal on Q3 is in the question decider's
  ``simple_proposals`` with its PRD's ``document_id``, the question's id and a ``subject``
  of its code and title, counted in ``total``; Accept removes it; fails_when=no row, no
  subject or question id, ``asked`` reads as decided rather than proposed, not counted, or
  it stays once accepted; no_claim=the web
  (e2e/inbox-question-one-pager.spec.ts).
- test_a_proposed_one_pager_wording_waits_named_by_its_line: protects=an approver's new
  wording for a one-pager line is in the PRD decider's ``simple_proposals`` with the
  one-pager's ``document_id``, the line's id and the line as it reads as ``subject``;
  Decline removes it; fails_when=no row, no subject or line id, or it stays once declined.
- test_deciding_the_question_on_decisions_removes_its_proposal: protects=the decider
  deciding Q3 on Decisions while a proposal on it waits removes that proposal from their
  Inbox; fails_when=it still waits (Accept would only say it is outdated).
"""

import pytest

from tests import test_simple_one_pager_api as op_tests
from tests import test_simple_prd_questions as q_tests
from tests.baseline_helpers import make_ctx
from tests.test_simple_changes_api import CHANGES
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_meeting_agenda import INBOX


async def _inbox(client, ctx, who: str) -> dict:
    r = await client.get(INBOX, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def _row(inbox: dict, change_id: str) -> dict | None:
    rows = [x for x in inbox["simple_proposals"] if x["id"] == change_id]
    return rows[0] if rows else None


@pytest.mark.parametrize("op", ["decide_question", "name_decider"])
async def test_a_proposed_question_answer_waits_named_by_its_question(client, op):
    ctx = await make_ctx()
    await q_tests.seed(ctx)
    qs = (await q_tests.page(client, ctx, "owner"))["questions"]
    q3 = next(q for q in qs if q["code"] == "Q3")
    before = (await _inbox(client, ctx, "decider"))["total"]
    after = (
        {"option": "recommended"}
        if op == "decide_question"
        else {"decider_id": str(ctx.users["approver"].id)}
    )
    r = await client.post(CHANGES, headers=ctx.as_("commenter"), json={
        "op": op, "target": {"decision_id": q3["id"]}, "before": {"status": "proposed"},
        "after": after})  # fmt: skip
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "proposed"
    inbox = await _inbox(client, ctx, "decider")
    row = _row(inbox, change["id"])
    assert row is not None, inbox["simple_proposals"]
    assert row["document_id"] == q3["prd"]["id"]
    assert row["question_id"] == q3["id"]
    assert row["subject"] == f"Q3 {q3['title']}"
    # Still to decide: it reads as proposed, never as done ("Decided Q3 ...").
    assert row["asked"] == (
        f"proposed deciding Q3 {q3['title']}"
        if op == "decide_question"
        else f"proposed who decides Q3 {q3['title']}"
    )
    assert row["item_id"] is None
    assert row["can_decide"] is True
    assert inbox["total"] == before + 1
    r = await client.post(f"{CHANGES}/{change['id']}/accept", json={},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, ctx, "decider")
    assert _row(inbox, change["id"]) is None
    # A new decider named: Q3 itself no longer waits on the old one either.
    assert inbox["total"] == before - (op == "name_decider")


async def test_a_proposed_one_pager_wording_waits_named_by_its_line(client):
    ctx = await op_tests.world(client)
    view = await op_tests.get(client, ctx, "approver")
    old = op_tests.line(view, "bets-1")["text"]
    before = (await _inbox(client, ctx, "decider"))["total"]
    r = await op_tests.edit(client, ctx, "approver", view, "bets-1", "A checklist for admins")
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "proposed"
    inbox = await _inbox(client, ctx, "decider")
    row = _row(inbox, change["id"])
    assert row is not None, inbox["simple_proposals"]
    assert row["document_id"] == view["document"]["id"]
    assert row["line_id"] == "bets-1"
    assert row["subject"] == old
    assert row["item_id"] is None
    assert inbox["total"] == before + 1
    r = await client.post(f"{CHANGES}/{change['id']}/decline", json={},
                          headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    inbox = await _inbox(client, ctx, "decider")
    assert _row(inbox, change["id"]) is None
    assert inbox["total"] == before


async def test_deciding_the_question_on_decisions_removes_its_proposal(client):
    ctx = await make_ctx()
    await q_tests.seed(ctx)
    qs = (await q_tests.page(client, ctx, "owner"))["questions"]
    q3 = next(q for q in qs if q["code"] == "Q3")
    body = {"op": "decide_question", "target": {"decision_id": q3["id"]},
            "before": {"status": "proposed"}, "after": {"option": "recommended"}}  # fmt: skip
    r = await client.post(CHANGES, headers=ctx.as_("commenter"), json=body)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert _row(await _inbox(client, ctx, "decider"), change["id"]) is not None
    # The decider decides Q3 on Decisions instead: nothing is left to accept.
    r = await client.post(CHANGES, headers=ctx.as_("decider"), json=body)
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    assert _row(await _inbox(client, ctx, "decider"), change["id"]) is None
