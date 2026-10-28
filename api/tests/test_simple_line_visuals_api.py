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
  draft is asked for by its draft words (its own subject), by who sees the draft; a
  viewer, who reads the published version, finds no such bet (404) and is offered no
  ask; fails_when=a draft line cannot be asked for, or a draft's words leak to a viewer;
  no_claim=publishing (S3b's tests).
- test_line_ask_track_owner_without_decider: protects=with no decider, the track owner
  of the PRD (an approver) asks; a plain approver does not; fails_when=the fallback is
  missed or given to everyone; no_claim=the roadmap's own rule (S3a's tests).
- test_one_pager_job_queues_bet_visuals_only_when_built: protects=the one_pager job's
  answer rejected as ``built: false`` (it misses a block's lines) queues no bet visual;
  a good answer queues one per bet, each with its line's words and the PRD;
  fails_when=a rejected answer queues visuals or a built page queues none;
  no_claim=the drawing (test_simple_visuals_api).
- test_draft_line_visual_hidden_from_who_reads_the_published_page: protects=a visual
  drawn for a working draft's bet (its subject is the draft's words) is read only by who
  sees that bet on the page: a viewer of the PRD who has the subject id reads "nothing
  drawn" (with or without the PRD), its version 404, a comment 404; the published bet's
  visual stays readable to the viewer; fails_when=the PRD's readers alone are enough to
  read a draft bet's drawing; no_claim=publishing (S3b's tests).
- test_one_pager_job_queues_no_bet_visuals_when_lines_in_use: protects=the one_pager
  job's good answer rejected as ``built: false`` because a working draft holds the page's
  lines queues no bet visual; fails_when=the rejected answer's bets are drawn;
  no_claim=the reworded line's own change visual.
"""

import uuid

import pytest
from sqlalchemy import delete, select

from oracle import company_time
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
    assert sid == str(visuals.line_subject(uuid.UUID(doc_id), mine["text"]))
    published = line(await get(client, ctx, "viewer"), "bets-1")
    assert published["flow_subject"] != sid
    assert (await panel(client, ctx, "decider", sid, doc_id))["can_revise"] is True
    assert (await panel(client, ctx, "viewer", sid, doc_id))["can_revise"] is False
    before = len(await jobs(ctx))
    r = await ask(client, ctx, "decider", sid, doc_id)
    assert r.status_code == 202 and r.json()["pending"] is True, r.text
    assert len(await jobs(ctx)) == before + 1
    # The published version's line is asked for too (its own subject).
    r = await ask(client, ctx, "decider", published["flow_subject"], doc_id)
    assert r.status_code == 202, r.text
    assert len(await jobs(ctx)) == before + 2


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
        assert {v.subject_id for v in rows} == {
            visuals.line_subject(doc.id, t) for t in ("Checklist", "Invites", "Sample")
        }


async def test_draft_line_visual_hidden_from_who_reads_the_published_page(client):
    ctx = await world(client)
    view = await get(client, ctx, "decider")
    doc_id = view["document"]["id"]
    r = await edit(client, ctx, "decider", view, "bets-1", "A checklist that invites a teammate")
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    sid = line(await get(client, ctx, "decider"), "bets-1")["flow_subject"]
    published = line(await get(client, ctx, "viewer"), "bets-1")["flow_subject"]
    assert (await ask(client, ctx, "decider", sid, doc_id)).status_code == 202
    assert (await ask(client, ctx, "decider", published, doc_id)).status_code == 202
    await run_visual_jobs(ctx)
    assert (await panel(client, ctx, "decider", sid, doc_id))["flow"]["version"] == 1
    # The viewer reads the published page: the draft bet's drawing is not there for them.
    out = await panel(client, ctx, "viewer", sid, doc_id)
    assert out["flow"] is None and out["versions"] == [] and out.get("brief") is None
    r = await client.get(f"{URL}/{sid}", headers=ctx.as_("viewer"))
    assert r.status_code == 200 and r.json()["flow"] is None, r.text
    r = await client.get(f"{URL}/{sid}/versions/1", headers=ctx.as_("viewer"))
    assert r.status_code == 404, r.text
    r = await client.post(f"{URL}/{sid}/comments", json={"body": "Looks right"},
                          headers=ctx.as_("commenter"))  # fmt: skip
    assert r.status_code == 404, r.text
    # The published bet's drawing is the viewer's to read.
    assert (await panel(client, ctx, "viewer", published, doc_id))["flow"]["version"] == 1


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
