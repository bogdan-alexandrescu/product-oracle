"""edit-decisions (the owner's picks, BGD Nov 5: ec1 b "Decision sheet", eq2 b "Question
sheet"): an open decision and a PRD's open question are changed, added, withdrawn and
deleted from Simple's sheet. Against Postgres; the company's clock is Wed Oct 28, 2026; the
PRD is INVENTED (tests/fixtures/prd_questions_invented.md).

Test cards (protects / fails_when / no_claim):

- test_owner_edits_an_open_decision_and_undoes_it: protects=``edit_decision`` by an owner
  writes title, question, context, options and review day at once (applied, undoable); the
  Decisions page row carries every field, ``can`` and "edited" (who, when); Undo puts the
  fields back; fails_when=a field is not written, the row lacks it or Undo leaves it;
  no_claim=the sheet.
- test_approver_who_is_not_the_decider_proposes_the_edit: protects=an approver who neither
  decides nor made it proposes (routed to the decider); the decision is unchanged until
  the decider accepts; ``can`` offers propose, not edit, withdraw or delete; a viewer is
  refused; fails_when=the approver writes it or the viewer is let through.
- test_withdraw_is_the_not_now_with_undo: protects=``withdraw_decision`` by an editor makes
  it withdrawn, kept on the page; Undo opens it again; an approver who may not edit is
  refused (403); fails_when=it is deleted, stays open, or Undo fails.
- test_new_decision_takes_its_review_day: protects=``POST /v1/decisions`` keeps
  ``review_at``; fails_when=the day is dropped.
- test_delete_a_decision_to_trash_and_restore_it: protects=Delete sends it to Trash (kind
  "decision", its code and name); it leaves the page; whoever deleted it sees and restores
  it, with its meeting link and subjects as they were; another approver neither sees nor
  restores it; owners restore anything; fails_when=it stays listed, a link is lost, or the
  wrong person restores it.
- test_question_edit_add_withdraw_and_delete: protects=``edit_question`` (text,
  recommendation, other answers) by the decider applies and survives the PRD read again;
  an approver proposes; ``add_question`` adds Q17 to the PRD with no decider named and it
  survives the PRD read again; ``withdraw_decision`` takes it off Waiting with Undo; Delete
  sends a question to Trash (kind "question") and the PRD read again does not bring it
  back; Restore does; fails_when=any of these is lost or duplicated.
- test_accepting_an_outdated_edit_is_refused: protects=accepting a proposed edit whose
  fields were changed since it was made is refused (409 "outdated") and the newer edit
  stays; fails_when=the accept overwrites the newer edit.
- test_added_question_with_no_decider_is_not_accepted_by_its_proposer: protects=with no
  decider and no owner to route to, a proposed question is left open and its proposer may
  not accept it; an owner may; fails_when=the proposer accepts their own question.
- test_add_question_takes_the_prd_by_its_slug: protects=``add_question`` names its PRD by
  id or by the slug Decisions' PRD list gives (so + Ask a question offers every PRD the
  person reads); fails_when=the slug is refused.
"""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from oracle import company_time
from oracle.decisions.models import Decision
from oracle.docs.models import Document
from oracle.simple import questions
from oracle.simple.models import SimpleMeeting, SimpleMeetingDecision, SimpleSession
from oracle.tenancy import tenant_session
from oracle.trash.filter import INCLUDE_TRASHED
from tests.baseline_helpers import make_ctx
from tests.test_simple_prd_questions import seed, version

NOW = datetime(2026, 10, 28, 19, 0, tzinfo=UTC)
CHANGES = "/v1/simple/changes"
ALL = {INCLUDE_TRASHED: True}


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def _page(client, ctx, role="owner"):
    r = await client.get("/v1/simple/decisions", headers=ctx.as_(role))
    assert r.status_code == 200, r.text
    return r.json()


async def _decision(client, ctx, approver="owner", by="owner", **extra) -> dict:
    body = {"title": "Keep the free plan's five-seat limit",
            "question": "Keep the free plan's five-seat limit?",
            "context": "Raised in the weekly product review.",
            "options": [{"key": "a", "label": "Yes, this quarter"},
                        {"key": "b", "label": "Not now"}],
            "approver_id": str(ctx.users[approver].id), **extra}  # fmt: skip
    r = await client.post("/v1/decisions", headers=ctx.as_(by), json=body)
    assert r.status_code == 201, r.text
    return r.json()


def _row(page: dict, did: str) -> dict | None:
    return next((r for r in page["other"] if r["id"] == did), None)


async def _change(client, ctx, role, op, target, after=None):
    body = {"op": op, "target": target, "before": {}, "after": after or {}}
    return await client.post(CHANGES, headers=ctx.as_(role), json=body)


EDIT = {
    "title": "Keep the free plan's seat limit",
    "question": "Keep the limit at five seats?",
    "context": "Raised again by sales.",
    "options": ["Yes, this quarter", "Not now", "Ship to pilot customers first"],
    "review_at": "2026-12-07",
}


async def test_owner_edits_an_open_decision_and_undoes_it(client):
    ctx = await make_ctx()
    d = await _decision(client, ctx, approver="approver")
    row = _row(await _page(client, ctx), d["id"])
    assert row is not None
    assert row["question"] == "Keep the free plan's five-seat limit?"
    assert row["context"] == "Raised in the weekly product review."
    assert [o["label"] for o in row["options"]] == ["Yes, this quarter", "Not now"]
    assert row["can"] == {"edit": True, "propose": False, "withdraw": True, "delete": True,
                          "reassign": True}  # fmt: skip
    r = await _change(client, ctx, "owner", "edit_decision", {"decision_id": d["id"]}, EDIT)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied" and change["can_undo"] is True
    row = _row(await _page(client, ctx), d["id"])
    assert row["title"] == EDIT["title"] and row["question"] == EDIT["question"]
    assert row["context"] == EDIT["context"] and row["review_at"] == "2026-12-07"
    assert [o["label"] for o in row["options"]] == EDIT["options"]
    assert row["edited_by"]["id"] == str(ctx.users["owner"].id)
    assert row["edited_at"].startswith("2026-10-28")
    u = await client.post(f"{CHANGES}/{change['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code in (200, 201), u.text
    row = _row(await _page(client, ctx), d["id"])
    assert row["title"] == "Keep the free plan's five-seat limit" and row["review_at"] is None
    assert [o["label"] for o in row["options"]] == ["Yes, this quarter", "Not now"]


async def test_approver_who_is_not_the_decider_proposes_the_edit(client):
    ctx = await make_ctx()
    d = await _decision(client, ctx, approver="owner")
    row = _row(await _page(client, ctx, "approver"), d["id"])
    assert row["can"] == {"edit": False, "propose": True, "withdraw": False, "delete": False,
                          "reassign": False}  # fmt: skip
    assert _row(await _page(client, ctx, "viewer"), d["id"])["can"]["propose"] is False
    r = await _change(client, ctx, "viewer", "edit_decision", {"decision_id": d["id"]}, EDIT)
    assert r.status_code == 403, r.text
    r = await _change(client, ctx, "approver", "edit_decision", {"decision_id": d["id"]}, EDIT)
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "proposed"
    assert change["routed_to"] == [str(ctx.users["owner"].id)]
    assert "proposed" in change["words"] and "edit_decision" not in change["words"]
    assert _row(await _page(client, ctx), d["id"])["title"] == d["title"]
    ok = await client.post(f"{CHANGES}/{change['id']}/accept", headers=ctx.as_("owner"),
                           json={})  # fmt: skip
    assert ok.status_code in (200, 201), ok.text
    assert _row(await _page(client, ctx), d["id"])["title"] == EDIT["title"]


async def test_withdraw_is_the_not_now_with_undo(client):
    ctx = await make_ctx()
    d = await _decision(client, ctx, approver="owner")
    r = await _change(client, ctx, "approver", "withdraw_decision", {"decision_id": d["id"]})
    assert r.status_code == 403, r.text
    r = await _change(client, ctx, "owner", "withdraw_decision", {"decision_id": d["id"]})
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    row = _row(await _page(client, ctx), d["id"])
    assert row["status"] == "withdrawn"
    assert row["can"]["edit"] is False and row["can"]["withdraw"] is False
    u = await client.post(f"{CHANGES}/{change['id']}/undo", headers=ctx.as_("owner"))
    assert u.status_code in (200, 201), u.text
    assert _row(await _page(client, ctx), d["id"])["status"] == "proposed"


async def test_new_decision_takes_its_review_day(client):
    ctx = await make_ctx()
    d = await _decision(client, ctx, approver="approver", review_at="2026-12-15")
    assert d["review_at"] == "2026-12-15"
    assert _row(await _page(client, ctx), d["id"])["review_at"] == "2026-12-15"


async def _meeting_link(ctx, decision_id: str) -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        prd = Document(slug="billing", title="Billing", kind="prd", status="approved",
                       visibility="company")  # fmt: skip
        s.add(prd)
        await s.flush()
        owner = ctx.users["owner"].id
        session = SimpleSession(kind="meeting", started_by=owner, started_at=NOW)
        s.add(session)
        await s.flush()
        m = SimpleMeeting(title="Weekly review", prd_document_id=prd.id, origin="roadmap",
                          session_id=session.id, presenter_id=owner, started_at=NOW,
                          status="ended", ended_at=NOW)  # fmt: skip
        s.add(m)
        await s.flush()
        s.add(SimpleMeetingDecision(meeting_id=m.id, decision_id=uuid.UUID(decision_id),
                                    change_ids=[], at=NOW))  # fmt: skip
        await s.commit()
        return m.id


async def test_delete_a_decision_to_trash_and_restore_it(client):
    ctx = await make_ctx()
    d = await _decision(
        client,
        ctx,
        approver="approver",
        by="approver",
        subjects=[{"kind": "document", "id": str(uuid.uuid4()), "ref": "x"}],
    )
    meeting = await _meeting_link(ctx, d["id"])
    other = await _decision(client, ctx, approver="owner", by="owner")
    # who may not edit it is refused
    r = await client.request("DELETE", f"/v1/simple/decisions/{other['id']}",
                             headers=ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 403, r.text
    r = await client.request("DELETE", f"/v1/simple/decisions/{d['id']}",
                             headers=ctx.as_("approver"))  # fmt: skip
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["can_restore"] is True
    entry = out["entry"]
    assert entry["root"]["type"] == "decision" and entry["root"]["kind"] == "decision"
    assert entry["root"]["code"] == f"D-{d['number']}"
    assert entry["root"]["title"] == d["title"]
    page = await _page(client, ctx)
    assert _row(page, d["id"]) is None
    assert all(r["id"] != d["id"] for g in page["meetings"] for r in g["decisions"])
    assert (await client.get(f"/v1/decisions/{d['id']}", headers=ctx.as_("owner"))
            ).status_code == 404  # fmt: skip
    # Trash: the deleter and owners see it; another approver does not
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.auth.models import User

        u = User(email="other-approver@example.com", password_hash="x", role="approver")
        s.add(u)
        await s.commit()
        ctx.users["other"] = u
    mine = (await client.get("/v1/trash", headers=ctx.as_("approver"))).json()
    assert [e["id"] for e in mine] == [entry["id"]] and mine[0]["can_restore"] is True
    assert (await client.get("/v1/trash", headers=ctx.as_("other"))).json() == []
    r = await client.post(f"/v1/simple/decisions/{d['id']}/restore", headers=ctx.as_("other"))
    assert r.status_code == 403, r.text
    r = await client.post(f"/v1/simple/decisions/{d['id']}/restore", headers=ctx.as_("approver"))
    assert r.status_code == 200, r.text
    got = (await client.get(f"/v1/decisions/{d['id']}", headers=ctx.as_("owner"))).json()
    assert got["status"] == "proposed" and got["subjects"][0]["ref"] == "x"
    async with tenant_session(ctx.tenant_id) as s:
        link = await s.scalar(select(SimpleMeetingDecision).where(
            SimpleMeetingDecision.decision_id == uuid.UUID(d["id"])))  # fmt: skip
        assert link is not None and link.meeting_id == meeting
    # an owner restores what an approver deleted, through Trash
    r = await client.request("DELETE", f"/v1/simple/decisions/{d['id']}",
                             headers=ctx.as_("approver"))  # fmt: skip
    eid = r.json()["entry"]["id"]
    r = await client.post(f"/v1/trash/{eid}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert _row(await _page(client, ctx), d["id"]) is None  # in its meeting, not outside
    assert any(r["id"] == d["id"] for g in (await _page(client, ctx))["meetings"]
               for r in g["decisions"])  # fmt: skip


def _q(page: dict, code: str) -> dict | None:
    return next((q for q in page["questions"] if q["code"] == code), None)


async def _read_again(ctx, ids: dict) -> None:
    from tests.test_simple_prd_questions import FIXTURE

    async with tenant_session(ctx.tenant_id) as s:
        prd = await s.get(Document, ids["prd"])
        await version(s, prd, 2, FIXTURE.replace("Question number 9 ", "Question nine "))
        await s.commit()


async def test_question_edit_add_withdraw_and_delete(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    page = await _page(client, ctx, "decider")
    q3 = _q(page, "Q3")
    assert q3["can"]["edit"] is True and q3["can"]["withdraw"] is True
    assert q3["can"]["delete"] is True
    aq3 = _q(await _page(client, ctx, "approver"), "Q3")
    assert aq3["can"]["edit"] is False and aq3["can"]["propose"] is True
    assert aq3["can"]["withdraw"] is False and aq3["can"]["delete"] is False
    after = {"title": "Do weekly digests include muted alerts?",
             "recommendation": "Leave muted alerts out, with a count at the foot",
             "alternatives": ["Noon", "Let each person pick",
                              "Only when a muted alert fired three times"]}  # fmt: skip
    # an approver who does not decide proposes
    r = await _change(client, ctx, "approver", "edit_question", {"decision_id": q3["id"]}, after)
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "proposed"
    assert r.json()["change"]["routed_to"] == [str(ctx.users["decider"].id)]
    r = await _change(client, ctx, "decider", "edit_question", {"decision_id": q3["id"]}, after)
    assert r.status_code == 201, r.text
    assert r.json()["change"]["status"] == "applied"
    q = _q(await _page(client, ctx), "Q3")
    assert q["title"] == after["title"] and q["recommendation"] == after["recommendation"]
    assert [a["label"] for a in q["alternatives"]] == after["alternatives"]
    assert q["edited_by"]["id"] == str(ctx.users["decider"].id)
    # added to the PRD: Q17, no decider named yet
    r = await _change(client, ctx, "owner", "add_question", {"document_id": str(ids["prd"])},
                      {"title": "Who can export a team's alert history?",
                       "recommendation": "Owners only, from Settings",
                       "alternatives": ["Every member", "Owners and approvers"]})  # fmt: skip
    assert r.status_code == 201, r.text
    q17 = _q(await _page(client, ctx), "Q17")
    assert q17 is not None and q17["status"] == "proposed" and q17["decider"] is None
    assert q17["recommendation"] == "Owners only, from Settings"
    assert [a["label"] for a in q17["alternatives"]] == ["Every member", "Owners and approvers"]
    # a viewer adds nothing
    r = await _change(client, ctx, "viewer", "add_question", {"document_id": str(ids["prd"])},
                      {"title": "Anything?"})  # fmt: skip
    assert r.status_code == 403, r.text
    # withdraw (with Undo) and delete
    q5 = _q(await _page(client, ctx), "Q5")
    r = await _change(client, ctx, "decider", "withdraw_decision", {"decision_id": q5["id"]})
    assert r.status_code == 201, r.text
    assert _q(await _page(client, ctx), "Q5")["status"] == "withdrawn"
    u = await client.post(f"{CHANGES}/{r.json()['change']['id']}/undo",
                          headers=ctx.as_("decider"))  # fmt: skip
    assert u.status_code in (200, 201), u.text
    assert _q(await _page(client, ctx), "Q5")["status"] == "proposed"
    q4 = _q(await _page(client, ctx), "Q4")
    r = await client.request("DELETE", f"/v1/simple/decisions/{q4['id']}",
                             headers=ctx.as_("decider"))  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["entry"]["root"]["type"] == "question"
    assert r.json()["entry"]["root"]["code"] == "Q4"
    assert _q(await _page(client, ctx), "Q4") is None
    # the PRD read again keeps the edit and the added question, and leaves Q4 in Trash
    await _read_again(ctx, ids)
    page = await _page(client, ctx)
    assert _q(page, "Q3")["title"] == after["title"]
    assert _q(page, "Q9")["title"] == "Question nine"
    assert _q(page, "Q17") is not None and _q(page, "Q4") is None
    async with tenant_session(ctx.tenant_id) as s:
        n = await s.scalar(select(func.count()).select_from(Decision).execution_options(**ALL))
        assert n == 17
    r = await client.post(f"/v1/simple/decisions/{q4['id']}/restore", headers=ctx.as_("owner"))
    assert r.status_code == 200, r.text
    assert _q(await _page(client, ctx), "Q4") is not None
    _ = questions


async def test_accepting_an_outdated_edit_is_refused(client):
    ctx = await make_ctx()
    d = await _decision(client, ctx, approver="owner")
    target = {"decision_id": d["id"]}
    r = await _change(client, ctx, "approver", "edit_decision", target, {"title": "Old idea"})
    assert r.status_code == 201, r.text
    proposal = r.json()["change"]
    assert proposal["status"] == "proposed"
    r = await _change(client, ctx, "owner", "edit_decision", target, {"title": "Newer idea"})
    assert r.status_code == 201, r.text
    ok = await client.post(f"{CHANGES}/{proposal['id']}/accept", headers=ctx.as_("owner"),
                           json={})  # fmt: skip
    assert ok.status_code == 409, ok.text
    assert "outdated" in ok.text
    assert _row(await _page(client, ctx), d["id"])["title"] == "Newer idea"


async def test_added_question_with_no_decider_is_not_accepted_by_its_proposer(client, monkeypatch):
    ctx = await make_ctx()
    ids = await seed(ctx)

    async def no_decider(db, doc):
        return None, False

    monkeypatch.setattr(questions, "_decider", no_decider)
    r = await _change(client, ctx, "approver", "add_question", {"document_id": str(ids["prd"])},
                      {"title": "Who can export a team's alert history?"})  # fmt: skip
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "proposed"
    assert str(ctx.users["approver"].id) not in change["routed_to"]
    mine = await client.post(f"{CHANGES}/{change['id']}/accept", headers=ctx.as_("approver"),
                             json={})  # fmt: skip
    assert mine.status_code == 403, mine.text
    ok = await client.post(f"{CHANGES}/{change['id']}/accept", headers=ctx.as_("owner"),
                           json={})  # fmt: skip
    assert ok.status_code in (200, 201), ok.text


async def test_add_question_takes_the_prd_by_its_slug(client):
    ctx = await make_ctx()
    ids = await seed(ctx)
    page = await _page(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        slug = (await s.get(Document, ids["prd"])).slug
    assert slug in [p["id"] for p in page["prds"]]
    r = await _change(client, ctx, "owner", "add_question", {"document_id": slug},
                      {"title": "Who can export a team's alert history?"})  # fmt: skip
    assert r.status_code == 201, r.text
    assert _q(await _page(client, ctx), "Q17") is not None
