"""Simple S10 (#723, D26): "Ask Oracle to draw it" on a one-pager bet line
(``/v1/simple/visuals/one_pager_line/{subject}`` with the PRD's ``document_id``), and the
bet visuals the ``one_pager`` job queues. Against Postgres, on the one-pager tests'
invented PRD; the jobs run with fakes, never a live model.

Test cards (protects / fails_when / no_claim):

- test_line_ask_published_by_role: protects=a published bet line with no drawing offers
  the ask (``can_revise``) to the company's owners and the PRD's decider only; their
  request queues one ``simple_visual`` job with the line's words, the panel reads
  ``pending`` until the job draws version 1; a commenter's or approver's request is 403, a
  viewer's 403, a subject that is no bet of the PRD 404, a request with no PRD 422;
  fails_when=a role is offered or granted an ask its rule does not give, the job is not
  queued, or a line of another page is drawn; no_claim=the web's button (the spec).
- test_line_ask_working_draft: protects=a bet reworded by the decider into the working
  draft keeps its subject (the line's own id, never its words: qa-simple-prd-1, "Carry
  the flow over"); who sees the draft asks with the draft's words as the brief, once;
  fails_when=the edit gives the bet a new subject, or the ask is queued twice;
  no_claim=publishing (S3b's tests).
- test_editing_a_bet_keeps_its_flow: protects=a bet with a drawn flow, reworded into the
  working draft, still shows that flow (its versions and comments) to who sees the draft
  and to who reads the published page, and after the draft is published; no new drawing
  is queued; fails_when=the edit or the publish detaches the flow ("No flow yet");
  no_claim=the web (simple-bet-flow-carry.spec.ts).
- test_line_ask_track_owner_without_decider: protects=with no decider, the track owner
  of the PRD (an approver) asks; a plain approver does not; fails_when=the fallback is
  missed or given to everyone; no_claim=the roadmap's own rule (S3a's tests).
- test_one_pager_job_queues_bet_visuals_only_when_built: protects=the one_pager job's
  answer rejected as ``built: false`` (it misses a block's lines) queues no bet visual;
  a good answer queues one per bet, each with its line's words and the PRD;
  fails_when=a rejected answer queues visuals or a built page queues none;
  no_claim=the drawing (test_simple_visuals_api).
- test_words_keyed_flow_still_found: protects=a flow left keyed by a bet's words (one the
  migration did not move) is still read by who finds a bet with those words on the page;
  fails_when=such a flow becomes unreadable.
- test_migrated_draft_words_flow_stays_with_the_draft: protects=a flow drawn, before
  migration 0092_bet_flow_line_key, from the words an open working draft gave a bet
  (keyed by those words) is, after the migration, read by the decider who sees the draft
  and by no viewer of the published page, by the bet's line or by those words;
  fails_when=the migration moves it onto the bet's line, where who reads the published
  page reads a drawing made from words they may not see; no_claim=the migration's other
  moves (test_bet_flow_line_key_migration).
- test_one_pager_job_queues_no_bet_visuals_when_lines_in_use: protects=the one_pager
  job's good answer rejected as ``built: false`` because a working draft holds the page's
  lines queues no bet visual; fails_when=the rejected answer's bets are drawn;
  no_claim=the reworded line's own change visual.
"""

import uuid

import pytest
from sqlalchemy import delete, select

from oracle import company_time
from oracle.db import get_engine
from oracle.docs.models import Document
from oracle.jobs.models import LlmJob
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import ProductTrack
from oracle.simple import one_pager, visuals
from oracle.simple.models import SimpleVisual
from oracle.tenancy import tenant_session
from tests.test_simple_one_pager_api import edit, get, line, world
from tests.test_simple_roadmap_api import NOW
from tests.test_simple_visuals_api import ANSWER, jobs, run_visual_jobs

URL = "/v1/simple/visuals/one_pager_line"


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def panel(client, ctx, who, sid, doc_id) -> dict:
    r = await client.get(f"{URL}/{sid}", params={"document_id": doc_id}, headers=ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def ask(client, ctx, who, sid, doc_id):
    return await client.post(f"{URL}/{sid}/request", json={"document_id": doc_id},
                             headers=ctx.as_(who))  # fmt: skip


async def test_line_ask_published_by_role(client):
    ctx = await world(client)
    view = await get(client, ctx, "viewer")
    doc_id = view["document"]["id"]
    bet = line(view, "bets-2")
    sid = bet["flow_subject"]
    assert bet["flow"] is None
    for who, can in (("viewer", False), ("commenter", False), ("approver", False),
                     ("decider", True), ("owner", True)):  # fmt: skip
        out = await panel(client, ctx, who, sid, doc_id)
        assert out["flow"] is None and out["pending"] is False
        assert out["can_revise"] is can, who
    # Without the PRD, the line cannot be looked up: nothing is offered.
    r = await client.get(f"{URL}/{sid}", headers=ctx.as_("owner"))
    assert r.status_code == 200 and r.json()["can_revise"] is False
    for who in ("viewer", "commenter", "approver"):
        assert (await ask(client, ctx, who, sid, doc_id)).status_code == 403, who
    assert (await ask(client, ctx, "decider", uuid.uuid4(), doc_id)).status_code == 404
    r = await client.post(f"{URL}/{sid}/request", json={}, headers=ctx.as_("decider"))
    assert r.status_code == 422, r.text
    assert await jobs(ctx) == []

    r = await ask(client, ctx, "decider", sid, doc_id)
    assert r.status_code == 202, r.text
    assert r.json()["pending"] is True and r.json()["flow"] is None
    queued = await jobs(ctx)
    assert len(queued) == 1
    async with tenant_session(ctx.tenant_id) as s:
        v = await s.get(SimpleVisual, queued[0].visual_id)
        assert v.brief == bet["text"] and str(v.document_id) == doc_id
    # Twice is once.
    assert (await ask(client, ctx, "owner", sid, doc_id)).status_code == 202
    assert len(await jobs(ctx)) == 1
    assert (await panel(client, ctx, "viewer", sid, doc_id))["pending"] is True
    await run_visual_jobs(ctx)
    out = await panel(client, ctx, "viewer", sid, doc_id)
    assert out["pending"] is False and out["flow"]["version"] == 1
    assert line(await get(client, ctx, "viewer"), "bets-2")["flow"]["title"] == ANSWER["title"]


async def test_line_ask_working_draft(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    doc_id = view["document"]["id"]
    r = await edit(client, ctx, "decider", view, "bets-1", "A checklist that invites a teammate")
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    mine = line(await get(client, ctx, "decider"), "bets-1")
    assert mine["text"] == "A checklist that invites a teammate"
    sid = mine["flow_subject"]
    # The bet's subject is its line, not its words: the edit keeps it.
    assert sid == str(visuals.line_subject(uuid.UUID(doc_id), "bets-1"))
    assert sid != str(visuals.words_subject(uuid.UUID(doc_id), mine["text"]))
    published = line(await get(client, ctx, "viewer"), "bets-1")
    assert published["flow_subject"] == sid
    assert (await panel(client, ctx, "decider", sid, doc_id))["can_revise"] is True
    assert (await panel(client, ctx, "viewer", sid, doc_id))["can_revise"] is False
    before = len(await jobs(ctx))
    r = await ask(client, ctx, "decider", sid, doc_id)
    assert r.status_code == 202 and r.json()["pending"] is True, r.text
    assert len(await jobs(ctx)) == before + 1
    async with tenant_session(ctx.tenant_id) as s:
        v = await s.scalar(select(SimpleVisual).where(SimpleVisual.subject_id == uuid.UUID(sid)))
        # Drawn from the published words: who reads only the published page reads it too.
        assert v.brief == published["text"]
    # Twice is once.
    assert (await ask(client, ctx, "owner", sid, doc_id)).status_code == 202
    assert len(await jobs(ctx)) == before + 1


async def test_draft_words_never_reach_who_reads_the_published_page(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    doc_id = view["document"]["id"]
    words = "A checklist that invites a teammate"
    r = await edit(client, ctx, "decider", view, "bets-1", words)
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    sid = line(await get(client, ctx, "decider"), "bets-1")["flow_subject"]
    assert (await ask(client, ctx, "decider", sid, doc_id)).status_code == 202
    await run_visual_jobs(ctx)
    out = await panel(client, ctx, "viewer", sid, doc_id)
    assert out["flow"] is not None
    assert words.lower() not in str(out).lower()
    async with tenant_session(ctx.tenant_id) as s:
        payloads = [j.input for j in await s.scalars(select(LlmJob).where(
            LlmJob.kind == "simple_visual"))]  # fmt: skip
    assert payloads and words.lower() not in str(payloads).lower()


async def test_editing_a_bet_keeps_its_flow(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    doc_id = view["document"]["id"]
    sid = line(view, "bets-1")["flow_subject"]
    assert (await ask(client, ctx, "decider", sid, doc_id)).status_code == 202
    await run_visual_jobs(ctx)
    r = await client.post(f"{URL}/{sid}/comments", json={"body": "Show the skip path"},
                          headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 201, r.text
    r = await edit(client, ctx, "decider", view, "bets-1", "A checklist that invites a teammate")
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    queued = len(await jobs(ctx))
    for who in ("decider", "viewer"):
        bet = line(await get(client, ctx, who), "bets-1")
        assert bet["flow_subject"] == sid, who
        assert bet["flow"] is not None and bet["flow"]["title"] == ANSWER["title"], who
        out = await panel(client, ctx, who, sid, doc_id)
        assert out["flow"]["version"] == 1 and len(out["versions"]) == 1, who
        assert [c["body"] for c in out["comments"]] == ["Show the skip path"], who
    assert line(await get(client, ctx, "decider"), "bets-1")["text"] == (
        "A checklist that invites a teammate"
    )
    # Published: the bet's new words keep the flow.
    draft_id = (await get(client, ctx, "decider"))["draft"]["id"]
    sub = await client.post(f"/v1/simple/drafts/{draft_id}/submit", headers=ctx.as_("decider"))
    assert sub.status_code == 200, sub.text
    ok = await client.post(f"/v1/simple/drafts/{draft_id}/approve", headers=ctx.as_("decider"))
    assert ok.status_code == 200, ok.text
    after = line(await get(client, ctx, "viewer"), "bets-1")
    assert after["text"] == "A checklist that invites a teammate"
    assert after["flow_subject"] == sid and after["flow"]["title"] == ANSWER["title"]
    assert (await panel(client, ctx, "viewer", sid, doc_id))["flow"]["version"] == 1
    # Carried over, never drawn again.
    assert len(await jobs(ctx)) == queued
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(SimpleVisual).where(
            SimpleVisual.subject_kind == "one_pager_line")))  # fmt: skip
        assert [v.subject_id for v in rows] == [uuid.UUID(sid)]


async def test_line_ask_track_owner_without_decider(client):
    ctx = await world(client)
    view = await get(client, ctx, "viewer")
    doc_id = view["document"]["id"]
    async with tenant_session(ctx.tenant_id) as s:
        await s.execute(delete(DocumentReviewPolicy))
        doc = await s.get(Document, uuid.UUID(doc_id))
        s.add(ProductTrack(prd_document_id=doc.id, title="Setup", owner_id=ctx.users["decider"].id))
        await s.commit()
    sid = line(view, "bets-3")["flow_subject"]
    assert (await panel(client, ctx, "approver", sid, doc_id))["can_revise"] is False
    assert (await ask(client, ctx, "approver", sid, doc_id)).status_code == 403
    assert (await panel(client, ctx, "decider", sid, doc_id))["can_revise"] is True
    assert (await ask(client, ctx, "decider", sid, doc_id)).status_code == 202


GOOD = {"blocks": [
    {"key": "problem", "lines": [{"text": "Admins stall.", "source_keys": ["problem"]}]},
    {"key": "bets", "lines": [{"text": t, "source_keys": ["build"]}
                              for t in ("Checklist", "Invites", "Sample")]},
    {"key": "outcomes", "lines": [
        {"text": "Invites up", "source_keys": ["outcomes"],
         "metric": {"name": "Invited", "from": "48%", "to": "65%"}},
        {"text": "Setup", "source_keys": ["outcomes"],
         "metric": {"name": "Setup", "from": "30%", "to": "50%"}}]},
    {"key": "not_doing", "lines": [{"text": "No SSO", "source_keys": ["not-doing"]}]},
    {"key": "risks", "lines": [{"text": "Calendar", "source_keys": ["risks"]}]},
]}  # fmt: skip


async def test_one_pager_job_queues_bet_visuals_only_when_built(client):
    ctx = await world(client)
    await get(client, ctx, "owner")  # a writer's read queues the one_pager job
    good = GOOD
    missing = {"blocks": [b for b in good["blocks"] if b["key"] != "bets"]}
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        assert job is not None

        async def rejected(kind, payload):
            return missing

        assert (await one_pager.run_job(s, job, rejected))["built"] is False
        await s.commit()
    assert await jobs(ctx) == []
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))

        async def built(kind, payload):
            return good

        assert (await one_pager.run_job(s, job, built))["built"] is True
        await s.commit()
    queued = await jobs(ctx)
    assert len(queued) == 3
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(SimpleVisual)))
        assert sorted(v.brief for v in rows) == ["Checklist", "Invites", "Sample"]
        assert {v.subject_kind for v in rows} == {"one_pager_line"}
        doc = await s.scalar(select(Document).where(Document.slug == "guided-setup"))
        assert {v.document_id for v in rows} == {doc.id}
        subjects = {v.subject_id for v in rows}
    page = await get(client, ctx, "owner")
    assert subjects == {uuid.UUID(line(page, f"bets-{i}")["flow_subject"]) for i in (1, 2, 3)}


async def test_reordered_bets_keep_their_flows(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")  # a writer's read queues the one_pager job
    doc_id = view["document"]["id"]
    texts = [line(view, f"bets-{i}")["text"] for i in (1, 2, 3)]
    sid = line(view, "bets-2")["flow_subject"]
    assert (await ask(client, ctx, "decider", sid, doc_id)).status_code == 202
    await run_visual_jobs(ctx)
    # Oracle's answer puts the bets in another order: the second bet is now the third.
    answer = {"blocks": [
        {"key": "bets", "lines": [{"text": t, "source_keys": ["build"]}
                                  for t in (texts[2], texts[0], texts[1])]}
        if b["key"] == "bets" else b for b in GOOD["blocks"]
    ]}  # fmt: skip
    async with tenant_session(ctx.tenant_id) as s:
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))

        async def built(kind, payload):
            return answer

        assert (await one_pager.run_job(s, job, built))["built"] is True
        await s.commit()
    for who in ("decider", "viewer"):
        page = await get(client, ctx, who)
        moved = line(page, "bets-3")
        assert moved["text"] == texts[1], who
        assert moved["flow_subject"] == sid and moved["flow"] is not None, who
        assert line(page, "bets-2")["flow_subject"] != sid, who
        assert line(page, "bets-1")["flow_subject"] != sid, who
    async with tenant_session(ctx.tenant_id) as s:
        rows = list(await s.scalars(select(SimpleVisual)))
    # The moved bet is not drawn again; the two others are asked for once each.
    assert sorted(v.brief for v in rows) == sorted(texts)
    assert len({v.subject_id for v in rows}) == 3


async def test_words_keyed_flow_still_found(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    doc_id = uuid.UUID(view["document"]["id"])
    bet = line(view, "bets-2")
    old = visuals.words_subject(doc_id, bet["text"])
    async with tenant_session(ctx.tenant_id) as s:
        await visuals.request_visual(s, None, "one_pager_line", old, bet["text"],
                                     document_id=doc_id)  # fmt: skip
        await s.commit()
    await run_visual_jobs(ctx)
    out = await panel(client, ctx, "viewer", old, str(doc_id))
    assert out["flow"]["version"] == 1


def _upgrade_0092(conn) -> None:
    """Migration 0092's upgrade on the test database (already at head), through Alembic's
    op on this connection."""
    import importlib.util

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    from tests.conftest import API_DIR

    path = API_DIR / "migrations" / "versions" / "0092_bet_flow_line_key.py"
    spec = importlib.util.spec_from_file_location("migration_0092", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with Operations.context(MigrationContext.configure(conn)):
        module.upgrade()


async def test_migrated_draft_words_flow_stays_with_the_draft(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    doc_id = uuid.UUID(view["document"]["id"])
    said = "A checklist that invites a teammate"
    r = await edit(client, ctx, "decider", view, "bets-1", said)
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    # Before 0092 who saw the draft asked by the draft's words: a flow drawn from them.
    old = visuals.words_subject(doc_id, said)
    async with tenant_session(ctx.tenant_id) as s:
        await visuals.request_visual(s, None, "one_pager_line", old, said,
                                     document_id=doc_id)  # fmt: skip
        await s.commit()
    await run_visual_jobs(ctx)
    async with get_engine().begin() as conn:
        await conn.run_sync(_upgrade_0092)
    bet = visuals.line_subject(doc_id, "bets-1")
    for sid in (bet, old):
        out = await panel(client, ctx, "viewer", sid, str(doc_id))
        assert out["flow"] is None, sid
        assert said.lower() not in str(out).lower()
    assert line(await get(client, ctx, "viewer"), "bets-1")["flow"] is None
    mine = line(await get(client, ctx, "decider"), "bets-1")
    assert mine["text"] == said
    # Who sees the draft reads the flow drawn from its words on the bet itself.
    assert mine["flow_subject"] == str(old)
    assert mine["flow"] is not None and mine["flow"]["subject_id"] == str(old)
    assert (await panel(client, ctx, "decider", old, str(doc_id)))["flow"]["version"] == 1


async def test_the_line_flow_wins_over_a_draft_words_flow(client):
    """Card: protects=a bet with a flow of its own (keyed by its line) shows that flow to
    everyone, a decider who sees the draft too, over one drawn from the draft's unpublished
    words; who does not see the draft never gets the draft words' flow; fails_when=the
    decider's bet shows the draft words' flow though the line has its own, or a viewer's
    shows it at all; no_claim=the drawing itself."""
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    doc_id = uuid.UUID(view["document"]["id"])
    said = "A checklist that invites a teammate"
    r = await edit(client, ctx, "decider", view, "bets-1", said)
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    old = visuals.words_subject(doc_id, said)
    bet = visuals.line_subject(doc_id, "bets-1")
    async with tenant_session(ctx.tenant_id) as s:
        await visuals.request_visual(s, None, "one_pager_line", old, said,
                                     document_id=doc_id)  # fmt: skip
        await s.commit()
    assert (await ask(client, ctx, "decider", str(bet), str(doc_id))).status_code == 202
    await run_visual_jobs(ctx)
    for who in ("decider", "owner", "viewer"):
        mine = line(await get(client, ctx, who), "bets-1")
        assert mine["flow_subject"] == str(bet), who
        assert mine["flow"] is not None and mine["flow"]["subject_id"] == str(bet), who
    # The draft words' flow: only who sees the draft reads it.
    assert (await panel(client, ctx, "viewer", old, str(doc_id)))["flow"] is None
    assert (await panel(client, ctx, "decider", old, str(doc_id)))["flow"]["version"] == 1


async def test_one_pager_job_queues_no_bet_visuals_when_lines_in_use(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")  # a writer's read queues the one_pager job
    r = await edit(client, ctx, "decider", view, "bets-1", "A checklist that invites a teammate")
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    async with tenant_session(ctx.tenant_id) as s:
        before = {v.id for v in await s.scalars(select(SimpleVisual))}
        job = await s.scalar(select(LlmJob).where(LlmJob.kind == "one_pager"))
        assert job is not None

        async def built(kind, payload):
            return GOOD

        out = await one_pager.run_job(s, job, built)
        assert out["built"] is False and "working draft" in out["reason"], out
        await s.commit()
    async with tenant_session(ctx.tenant_id) as s:
        rows = [v for v in await s.scalars(select(SimpleVisual)) if v.id not in before]
    assert rows == []
