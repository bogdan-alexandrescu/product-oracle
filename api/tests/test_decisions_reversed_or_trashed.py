"""decisions-reversed-or-trashed: drafts never cite a reversed decision or one about
something in Trash.

- test_drafting_readers_leave_out_decisions_about_trash: protects=Ask Oracle's plan, the
  PRD and roadmap drafts' decided lines (decided_in) and the briefs' decision blocks keep
  standing decisions and leave out one about a roadmap now in Trash, saying so in the
  sources; fails_when=a trashed roadmap's decision is fed to drafting, or nothing says it
  was left out; no_claim=what the model writes from them.
- test_roadmap_read_says_which_decisions_were_left_out and
  test_one_pager_read_says_which_decisions_were_left_out: protects=the roadmap's items'
  and a PRD's lines' decided decisions leave out one also about a roadmap now in Trash,
  and the read's ``left_out`` entry (its sources) says so; fails_when=it is listed, or
  dropped with nothing to say so; no_claim=the web, which does not show it yet.
- test_review_due_keeps_a_decision_about_trash: protects=a brief's "review due" block
  still reminds the owner of a decided decision about a roadmap now in Trash, marked so;
  fails_when=the reminder is dropped; no_claim=other blocks.
- test_split_leaves_out_lapsed_decisions: protects=reversed, withdrawn and superseded
  decisions never stand, each with why; fails_when=one is kept; no_claim=none.
- test_company_decisions_marks_a_decision_about_a_trashed_roadmap: protects=Company >
  Decisions (list and inspector) says "Made about a roadmap now in Trash" for a decision
  naming it, or made in a meeting reviewing it; fails_when=no mark, or a mark before it
  is trashed; no_claim=the page (web/e2e).
- test_reversing_a_decision_notes_the_open_drafts_that_cited_it: protects=the owner's
  Reverse puts a note on the open roadmap draft whose item the decision named;
  fails_when=no note, or a note before it is reversed; no_claim=other draft kinds.

Invented example data only.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from oracle.decisions.models import Decision
from oracle.discussions import plan
from oracle.discussions.context import Context
from oracle.docs.models import Document
from oracle.rituals import blocks
from oracle.simple import meetings
from oracle.simple.models import SimpleMeeting, SimpleMeetingDecision, SimpleSession
from oracle.tenancy import tenant_session
from tests.baseline_helpers import make_ctx
from tests.decision_helpers import decide, propose
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_drafts_api import edit_title, the_draft, world

ROADMAP_GONE = "Made about a roadmap now in Trash"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _roadmap(ctx, slug: str = "example-test-roadmap") -> uuid.UUID:
    async with tenant_session(ctx.tenant_id) as s:
        doc = Document(slug=slug, title="Example test roadmap", kind="roadmap")
        s.add(doc)
        await s.commit()
        return doc.id


async def _trash(client, ctx, slug: str = "example-test-roadmap") -> None:
    r = await client.request(
        "DELETE",
        f"/v1/documents/{slug}",
        headers=ctx.as_("owner"),
        params={"reason": "A test roadmap", "confirm_published": True},
    )
    assert r.status_code in (200, 204), r.text


def _about(doc_id: uuid.UUID) -> list[dict]:
    return [{"kind": "document", "id": str(doc_id), "ref": "example-test-roadmap"}]


async def test_drafting_readers_leave_out_decisions_about_trash(client, ctx):
    doc_id = await _roadmap(ctx)
    gone_open = await propose(client, ctx, title="Cut bulk export", subjects=_about(doc_id))
    kept_open = await propose(client, ctx, title="Keep the weekly digest")
    gone = await propose(client, ctx, title="Cut saved filters", subjects=_about(doc_id))
    await decide(client, ctx, gone["number"])
    await _trash(client, ctx)

    async with tenant_session(ctx.tenant_id) as s:
        # Ask Oracle: the plan's open decisions.
        c = Context()
        await plan._decisions(s, c)
        titles = " ".join(e["title"] for e in c.entries.values())
        text = c.text()
        assert f"D-{kept_open['number']}" in titles
        assert f"D-{gone_open['number']}" not in titles
        assert (
            f"Left out, no longer standing: D-{gone_open['number']} Cut bulk export "
            "(about a roadmap now in Trash)." in text
        )

        # PRD and roadmap drafts: the decided decisions naming a subject.
        found = await meetings.decided_in(s, [{"kind": "document", "id": str(doc_id)}])
        assert found == {}

        # Briefs: the decisions made this period.
        approver = ctx.users["approver"].id
        now = datetime.now(UTC)
        bctx = blocks.BlockCtx(approver, now - timedelta(days=1), now + timedelta(days=1), now)
        made = await blocks.decisions_made(s, bctx)
        assert [r.get("decision_id") for r in made if r.get("decision_id")] == []
        assert [r["text"] for r in made if r.get("kind") == "left_out"] == [
            f"Left out, no longer standing: D-{gone['number']} Cut saved filters "
            "(about a roadmap now in Trash)."
        ]
        needs = await blocks.needs_decision(s, bctx)
        assert all(r.get("decision_id") != gone_open["id"] for r in needs)
        assert any(r.get("kind") == "left_out" for r in needs)


def _left_out_line(d: dict, title: str) -> str:
    return f"Left out, no longer standing: D-{d['number']} {title} (about a roadmap now in Trash)."


async def test_roadmap_read_says_which_decisions_were_left_out(client):
    w = await world()
    doc_id = await _roadmap(w.ctx)
    item = {"kind": "roadmap_item", "id": w.ids["edit_title-a"], "ref": "edit_title-a"}
    kept = await propose(client, w.ctx, title="Keep the weekly digest", subjects=[item])
    gone = await propose(client, w.ctx, title="Cut bulk export",
                         subjects=[item, *_about(doc_id)])  # fmt: skip
    for d in (kept, gone):
        await decide(client, w.ctx, d["number"])

    async def read() -> dict:
        r = await client.get("/v1/simple/roadmap", headers=w.ctx.as_("decider"))
        assert r.status_code == 200, r.text
        return r.json()

    view = await read()
    [it] = [i for i in view["items"] if i["key"] == "edit_title-a"]
    assert {x["number"] for x in it["decided_in"]} == {kept["number"], gone["number"]}
    assert view["left_out"] is None
    await _trash(client, w.ctx)
    view = await read()
    [it] = [i for i in view["items"] if i["key"] == "edit_title-a"]
    assert [x["number"] for x in it["decided_in"]] == [kept["number"]]
    line = _left_out_line(gone, "Cut bulk export")
    assert view["left_out"] == {"kind": "left_out", "title": line, "decision_ids": [gone["id"]]}


async def test_roadmap_read_names_a_reversed_decision_as_left_out(client):
    # Train AK review: the draft banner's left-out line names a reversed decision too; the
    # read must carry it (decided_in reads lapsed decisions, standing.split leaves them out).
    w = await world()
    item = {"kind": "roadmap_item", "id": w.ids["edit_title-a"], "ref": "edit_title-a"}
    kept = await propose(client, w.ctx, title="Keep the weekly digest", subjects=[item])
    gone = await propose(client, w.ctx, title="Cut bulk export", subjects=[item])
    for d in (kept, gone):
        await decide(client, w.ctx, d["number"])
    r = await client.post(
        f"/v1/decisions/{gone['number']}/reviews",
        json={"verdict": "reversed", "note": "Bulk export is back in"},
        headers=w.ctx.as_("approver"),
    )
    assert r.status_code == 200, r.text
    r = await client.get("/v1/simple/roadmap", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    view = r.json()
    [it] = [i for i in view["items"] if i["key"] == "edit_title-a"]
    assert [x["number"] for x in it["decided_in"]] == [kept["number"]]
    line = f"Left out, no longer standing: D-{gone['number']} Cut bulk export (reversed)."
    assert view["left_out"] == {"kind": "left_out", "title": line, "decision_ids": [gone["id"]]}


async def test_one_pager_read_says_which_decisions_were_left_out(client):
    from tests import test_simple_one_pager_api as op

    ctx = await op.world(client)
    view = await op.get(client, ctx)
    line_id = next(x["id"] for b in view["blocks"] for x in b["lines"])
    doc_id = await _roadmap(ctx)
    on_line = {"kind": "section", "id": view["document"]["id"], "ref": f"line:{line_id}"}
    kept = await propose(client, ctx, title="Keep the weekly digest", subjects=[on_line])
    gone = await propose(client, ctx, title="Cut saved filters",
                         subjects=[on_line, *_about(doc_id)])  # fmt: skip
    for d in (kept, gone):
        await decide(client, ctx, d["number"])
    view = await op.get(client, ctx)
    assert {x["number"] for x in op.line(view, line_id)["decisions"]} == {
        kept["number"], gone["number"]}  # fmt: skip
    assert view["left_out"] is None
    await _trash(client, ctx)
    view = await op.get(client, ctx)
    assert [x["number"] for x in op.line(view, line_id)["decisions"]] == [kept["number"]]
    line = _left_out_line(gone, "Cut saved filters")
    assert view["left_out"] == {"kind": "left_out", "title": line, "decision_ids": [gone["id"]]}


async def test_review_due_keeps_a_decision_about_trash(client, ctx):
    doc_id = await _roadmap(ctx)
    gone = await propose(client, ctx, title="Cut saved filters", subjects=_about(doc_id))
    await decide(client, ctx, gone["number"])
    await _trash(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        d = await s.scalar(select(Decision).where(Decision.id == uuid.UUID(gone["id"])))
        d.review_at = datetime.now(UTC).date()
        await s.commit()
        now = datetime.now(UTC)
        bctx = blocks.BlockCtx(ctx.users["approver"].id, now - timedelta(days=1),
                               now + timedelta(days=1), now)  # fmt: skip
        due = await blocks.decisions_due(s, bctx)
    assert [(r["decision_id"], r["text"]) for r in due] == [
        (gone["id"], f"D-{gone['number']} Cut saved filters (made about a roadmap now in Trash)")
    ]


async def test_split_leaves_out_lapsed_decisions(client, ctx):
    from oracle.decisions import standing

    standing_one = await propose(client, ctx, title="Keep the weekly digest")
    lapsed = []
    for status in ("reversed", "withdrawn", "superseded"):
        lapsed.append((await propose(client, ctx, title=f"An example {status} call"), status))
    async with tenant_session(ctx.tenant_id) as s:
        ids = [uuid.UUID(d["id"]) for d, _ in lapsed]
        for d in await s.scalars(select(Decision).where(Decision.id.in_(ids))):
            d.status = next(st for x, st in lapsed if x["id"] == str(d.id))
            d.chosen_option, d.rationale = "caps-first", "Example"
            d.decided_at, d.review_at = datetime.now(UTC), datetime.now(UTC).date()
        await s.commit()
        rows = list(await s.scalars(select(Decision).order_by(Decision.number)))
        kept, left = await standing.split(s, rows)
    assert [d.number for d in kept] == [standing_one["number"]]
    assert [x.why for x in left] == ["reversed", "withdrawn", "replaced by a later decision"]


async def test_company_decisions_marks_a_decision_about_a_trashed_roadmap(client, ctx):
    doc_id = await _roadmap(ctx)
    named = await propose(client, ctx, title="Cut bulk export", subjects=_about(doc_id))
    in_meeting = await propose(client, ctx, title="Cut saved filters")
    other = await propose(client, ctx, title="Keep the weekly digest")
    async with tenant_session(ctx.tenant_id) as s:
        now = datetime.now(UTC)
        owner = ctx.users["owner"].id
        session = SimpleSession(kind="meeting", started_by=owner, started_at=now)
        s.add(session)
        await s.flush()
        m = SimpleMeeting(title="Example roadmap review", prd_document_id=doc_id,
                          origin="roadmap", session_id=session.id, presenter_id=owner,
                          started_at=now)  # fmt: skip
        s.add(m)
        await s.flush()
        s.add(SimpleMeetingDecision(meeting_id=m.id, decision_id=uuid.UUID(in_meeting["id"]),
                                    at=now))  # fmt: skip
        await s.commit()

    async def mark(d: dict) -> str | None:
        r = await client.get(f"/v1/decisions/{d['number']}", headers=ctx.as_("viewer"))
        assert r.status_code == 200, r.text
        return r.json()["trash_note"]

    assert await mark(named) is None and await mark(in_meeting) is None
    await _trash(client, ctx)
    assert await mark(named) == ROADMAP_GONE
    assert await mark(in_meeting) == ROADMAP_GONE
    assert await mark(other) is None
    r = await client.get("/v1/decisions", headers=ctx.as_("viewer"))
    assert r.status_code == 200, r.text
    rows = r.json()
    listed = rows["items"] if isinstance(rows, dict) else rows
    marks = {x["number"]: x["trash_note"] for x in listed}
    assert marks == {named["number"]: ROADMAP_GONE, in_meeting["number"]: ROADMAP_GONE,
                     other["number"]: None}  # fmt: skip


async def test_reversing_a_decision_notes_the_open_drafts_that_cited_it(client, clock):
    w = await world()
    assert (await edit_title(client, w, "decider")).status_code == 201
    item = {"kind": "roadmap_item", "id": w.ids["edit_title-a"], "ref": "edit_title-a"}
    d = await propose(client, w.ctx, title="Cut bulk export", subjects=[item])
    await decide(client, w.ctx, d["number"])
    assert (await the_draft(client, w))["decision_notes"] == []

    # Reversed a minute before Pacific midnight (Mon Nov 2, 11:59 PM PST), read a minute
    # after it: the note keeps the reversal's own day, month first, in the company's zone.
    clock["now"] = datetime(2026, 11, 3, 7, 59, tzinfo=UTC)
    r = await client.post(
        f"/v1/decisions/{d['number']}/reviews",
        json={"verdict": "reversed", "note": "Bulk export is back in"},
        headers=w.ctx.as_("approver"),
    )
    assert r.status_code == 200, r.text
    clock["now"] = datetime(2026, 11, 3, 8, 1, tzinfo=UTC)
    assert (await the_draft(client, w))["decision_notes"] == [
        f"D-{d['number']} Cut bulk export was reversed on Nov 2: Bulk export is back in"
    ]
