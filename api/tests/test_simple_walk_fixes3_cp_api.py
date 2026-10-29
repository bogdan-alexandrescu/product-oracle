"""The owner's production walk of Simple mode, round 3 (2026-10-28), findings H2 and M1.
Against Postgres.

Test cards (protects / fails_when / no_claim):

- test_every_op_has_a_plain_sentence: protects=every op of the change engine
  (schemas.ChangeOp) reads as a sentence with who, what and the item's code and name, "·
  undone" once undone, never the op's internal name; fails_when=an op has no sentence of
  its own (it falls back to "changed <item>") or shows its op name; no_claim=the web's
  layout (web/e2e/simple-walk-fixes3-cp.spec.ts).
- test_change_list_says_an_undone_estimate_in_words: protects=GET /v1/simple/changes
  gives each change its plain words, as Home's "Since your last visit" shows them: "<who>
  changed the estimate of <code> <name> · undone" for an undone estimate_feature;
  fails_when=the words are missing, name the op, or miss the item or "· undone";
  no_claim=the estimate's write and undo (test_simple_priorities_api).
- test_simple_reads_product_decisions_never_run_approvals: protects=Simple's Decisions
  page and a meeting's open decisions (the pre-read Home's "Open pre-read" opens lists
  them as the Decisions page reads them) list the PRD's open product decision and never
  a run's approval (a checkpoint decision) on the same PRD; fails_when=the run's approval
  is listed in either; no_claim=Detailed's decision log and the rituals' own pre-read.
"""

import typing
import uuid

from sqlalchemy import select

from oracle.decisions import capture
from oracle.docs.models import Document
from oracle.simple import change_words
from oracle.simple.schemas import ChangeOp
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, clock, make_people  # noqa: F401
from tests.test_simple_meetings_api import PRD, start
from tests.test_simple_meetings_api import world as meeting_world
from tests.test_simple_priorities_api import World as PriorityWorld
from tests.test_simple_targets_api import no_llm  # noqa: F401

ITEM = "F-08 Billing page"


def test_every_op_has_a_plain_sentence():
    ops = typing.get_args(ChangeOp)
    assert len(ops) >= 30
    for op in ops:
        target = {"item_id": str(uuid.uuid4()), "code": "F-09", "title": "Invoices"}
        after = {"title": "Ask", "status": "done", "horizon": "next", "line": "A line",
                 "key_date": {"name": "Launch"}, "milestone": {"name": "Beta"}}  # fmt: skip
        what = change_words.phrase(op, target, {}, after, ITEM)
        assert what != f"changed {ITEM}", op
        # No internal name: a one-word op ("cut") may be its plain verb, no "_" name shows.
        assert "_" not in what, (op, what)
        words = change_words.sentence(op, target, {}, after, who="Ana", item=ITEM,
                                      status="applied", undone=True)  # fmt: skip
        assert words.startswith("Ana ") and words.endswith(" · undone"), (op, words)
        assert "_" not in words, (op, words)
    item_ops = [op for op in ops if op not in ("edit_line", "add_feature_ask")
                and "key_date" not in op]  # fmt: skip
    for op in item_ops:
        assert ITEM in change_words.phrase(op, {}, {}, {}, ITEM), op
    assert (
        change_words.sentence(
            "estimate_feature",
            {},
            {},
            {"effort": 2},
            who="Ana",
            item=ITEM,
            status="applied",
            undone=True,
        )  # fmt: skip
        == "Ana changed the estimate of F-08 Billing page · undone"
    )


async def test_change_list_says_an_undone_estimate_in_words(client):
    ctx = await make_people()
    w = await PriorityWorld(ctx).build()
    r = await w.change(client, "owner", "estimate_feature", "pay-1",
                       {"goal_value": None, "effort": 1}, {"effort": 2})  # fmt: skip
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    who = change["by_name"]
    rm = (await client.get("/v1/simple/roadmap", headers=ctx.as_("owner"))).json()
    item = next(i for i in rm["items"] if i["id"] == w.ids["pay-1"])
    label = f"{item['code']} {item['title']}" if item["code"] else item["title"]
    assert change["words"] == f"{who} changed the estimate of {label}"
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=ctx.as_("owner"))
    assert r.status_code == 201, r.text
    rows = (await client.get(CHANGES, headers=ctx.as_("owner"))).json()
    by_id = {c["id"]: c for c in rows}
    assert by_id[change["id"]]["words"] == f"{who} changed the estimate of {label} · undone"
    for c in rows:
        assert c["words"] and "estimate_feature" not in c["words"], c


async def _decision(s, title: str, origin: str, subject: str, approver) -> None:
    d = await capture.capture(s, None, origin=origin, source_kind="test", source_id=uuid.uuid4(),
                              title=title, options=[{"key": "yes"}, {"key": "no"}],
                              chosen_option="yes", rationale="Seeded",
                              approver_id=approver,
                              subjects=[{"kind": "document", "id": subject}])  # fmt: skip
    # Still open: proposed, nothing chosen yet.
    d.status, d.chosen_option, d.decided_at = "proposed", None, None
    await s.flush()


async def test_simple_reads_product_decisions_never_run_approvals(client):
    w = await meeting_world()
    async with tenant_session(w.ctx.tenant_id) as s:
        prd = await s.scalar(select(Document).where(Document.slug == PRD))
        owner = w.ctx.users["owner"].id
        for title, origin in (("Should refunds wait for the ledger?", "oracle"),
                              ("Approve the plan · Build the baseline", "checkpoint")):  # fmt: skip
            await _decision(s, title, origin, str(prd.id), owner)
        await s.commit()
    r = await client.get("/v1/simple/decisions", headers=w.ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    titles = [d["title"] for d in r.json()["other"]]
    assert "Should refunds wait for the ledger?" in titles
    assert "Approve the plan · Build the baseline" not in titles
    m = await start(client, w)
    r = await client.get(f"/v1/simple/meetings/{m['id']}", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert [d["title"] for d in r.json()["open_decisions"]] == [
        "Should refunds wait for the ledger?"
    ]
