"""Simple Definition of Done, item 5 (docs/simple-dod-ops.md): the document ops the change
engine hands to oracle.simple.questions (decide_question, name_decider) and
oracle.simple.one_pager (edit_line). Against Postgres; each test's world and clock are its
module's own (tests.test_simple_prd_questions, tests.test_simple_one_pager_api).

Test cards (protects / fails_when / no_claim):

- test_question_ops_record_who_and_when_and_stay_in_their_company: protects=answering a
  PRD's open question (applied by the decider, proposed by a commenter) and naming its
  decider are change rows with their author and the company's now; another company's
  owner can neither answer nor name a decider on this company's question; fails_when=an op
  is unrecorded or crosses companies; no_claim=the questions page (its own tests).
- test_edit_line_records_who_and_when_and_stays_in_its_company: protects=a one-pager line
  edit (applied by the decider, proposed by a commenter) is a change row with its author
  and now; another company's owner cannot edit it; fails_when=either way; no_claim=the
  section patching (test_simple_one_pager_api).
"""

from datetime import datetime

from sqlalchemy import select

from oracle.simple.models import SimpleChange
from oracle.tenancy import tenant_session
from tests import test_simple_one_pager_api as op_tests
from tests import test_simple_prd_questions as q_tests
from tests.baseline_helpers import make_ctx
from tests.test_simple_changes_api import make_people

CHANGES = "/v1/simple/changes"


async def recorded(ctx, change: dict, who: str, op: str, now: datetime) -> None:
    assert change["by"] == str(ctx.users[who].id), op
    assert datetime.fromisoformat(change["at"]) == now, op
    async with tenant_session(ctx.tenant_id) as s:
        row = await s.get(SimpleChange, change["id"])
        assert (row.op, row.by, row.at) == (op, ctx.users[who].id, now), op


async def changes(ctx) -> list[SimpleChange]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(await s.scalars(select(SimpleChange)))


async def test_question_ops_record_who_and_when_and_stay_in_their_company(client, monkeypatch):
    monkeypatch.setattr(q_tests.company_time, "now", lambda: q_tests.NOW)
    ctx = await make_ctx()
    await q_tests.seed(ctx, with_decider=False)
    other = await make_people()
    qs = {q["code"]: q for q in (await q_tests.page(client, ctx))["questions"]}
    decide = {"op": "decide_question", "target": {"decision_id": qs["Q3"]["id"]},
              "before": {"status": "proposed"}, "after": {"option": "recommended"}}  # fmt: skip
    name = {"op": "name_decider", "target": {"decision_id": qs["Q3"]["id"]}, "before": {},
            "after": {"decider_id": str(ctx.users["approver"].id)}}  # fmt: skip
    for body in (decide, name):
        r = await client.post(CHANGES, json=body, headers=other.as_("owner"))
        assert r.status_code in (404, 422), (body["op"], r.text)
    assert await changes(ctx) == []
    # Naming another company's person as the decider: refused.
    stranger = {**name, "after": {"decider_id": str(other.users["approver"].id)}}
    r = await client.post(CHANGES, json=stranger, headers=ctx.as_("owner"))
    assert r.status_code == 422, r.text
    assert await changes(ctx) == []
    r = await client.post(CHANGES, json=name, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    await recorded(ctx, r.json()["change"], "owner", "name_decider", q_tests.NOW)
    r = await client.post(CHANGES, json=decide, headers=ctx.as_("commenter"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    await recorded(ctx, r.json()["change"], "commenter", "decide_question", q_tests.NOW)
    r = await client.post(CHANGES, json=decide, headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    await recorded(ctx, r.json()["change"], "owner", "decide_question", q_tests.NOW)


async def test_edit_line_records_who_and_when_and_stays_in_its_company(client, monkeypatch):
    monkeypatch.setattr(op_tests.company_time, "now", lambda: op_tests.NOW)
    ctx = await op_tests.world(client)
    other = await make_people()
    view = await op_tests.get(client, ctx)
    r = await op_tests.edit(client, other, "owner", view, "problem-1", "Somebody else's line.")
    assert r.status_code in (404, 422), r.text
    assert await changes(ctx) == []
    r = await op_tests.edit(client, ctx, "commenter", await op_tests.get(client, ctx, "commenter"),
                            "risks-1", "A risk worth naming.")  # fmt: skip
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    await recorded(ctx, r.json()["change"], "commenter", "edit_line", op_tests.NOW)
    r = await op_tests.edit(client, ctx, "decider", view, "problem-1", "New admins stall.")
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    await recorded(ctx, r.json()["change"], "decider", "edit_line", op_tests.NOW)
