"""Simple S10 (#723, D26): the review's fixes to visual proposals (oracle.simple.visuals).
Against Postgres; the invented PRD and roadmap of tests/test_simple_visuals_api.py, the
``simple_visual`` job with a fake ``ask``.

Test cards (protects / fails_when / no_claim):

- test_proposal_visual_follows_who_sees_the_proposal: protects=a proposal's visual is read
  (and commented on) by whoever the change engine shows the proposal to: a required
  reviewer of the document and a participant of its session, not only its author, who
  decides it and owners; a viewer still gets 404; fails_when=a reviewer or a session's
  participant who sees the proposal is told "No such visual"; no_claim=the change
  engine's rule itself (test_simple_changes_api).
- test_documentless_visual_of_another_lane_is_closed: protects=a suggestion's or a chat
  card's visual requested with no document is read by its requester and the company's
  owners only, never by any reader who has the id; with its document, by the document's
  readers; fails_when=a viewer reads a document-less suggestion visual; no_claim=S7/S9's
  own screens.
- test_request_refuses_subjects_simple_cannot_look_up: protects=``/request`` draws only
  subjects Simple can look up (a change, a roadmap feature or draft item): a suggestion,
  a chat card or a one-pager line is drawn with its proposal, so asking for any uuid is
  422 and stores nothing, and the empty read offers no "Ask"; fails_when=an owner creates
  an orphan visual for a made-up id; no_claim=the hook other lanes call.
- test_change_survives_a_failed_visual: protects=a change already saved is answered 201
  when queueing its visual fails for any reason (a database error); fails_when=the route
  answers 500 for a saved change; no_claim=the job worker.
- test_direct_outcome_edit_queues_no_visual: protects=Oracle drafts a visual WITH a
  proposal: a commenter's outcome change queues the job, an owner's applied outcome edit
  or confirmation does not (the feature's own visual is asked for); fails_when=every
  applied outcome edit queues a model job; no_claim=one-pager bets (drawn in the draft).
"""

import uuid

import pytest
from sqlalchemy import select

from oracle import company_time
from oracle.auth.models import User
from oracle.review.models import DocumentReviewPolicy
from oracle.simple import visuals
from oracle.simple.models import SimpleChange, SimpleSession, SimpleVisual
from oracle.tenancy import tenant_session
from tests.test_simple_one_pager_api import edit, get, world
from tests.test_simple_roadmap_api import NOW
from tests.test_simple_visuals_api import CHANGES, URL, jobs, roadmap_world, run_visual_jobs


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(company_time, "now", lambda: NOW)


async def test_proposal_visual_follows_who_sees_the_proposal(client):
    ctx = await world(client)
    async with tenant_session(ctx.tenant_id) as s:
        peer = User(email="peer@example.com", name="Pat Peer", password_hash="x",
                    role="commenter")  # fmt: skip
        s.add(peer)
        await s.commit()
        ctx.users["peer"] = peer
    view = await get(client, ctx, "commenter")
    r = await edit(client, ctx, "commenter", view, "bets-1", "A setup checklist with invites")
    assert r.status_code == 201 and r.json()["change"]["status"] == "proposed", r.text
    cid = uuid.UUID(r.json()["change"]["id"])
    await run_visual_jobs(ctx)
    async with tenant_session(ctx.tenant_id) as s:
        # The approver is a required reviewer of the PRD; the peer started the meeting the
        # proposal was made in.
        policy = await s.scalar(
            select(DocumentReviewPolicy).where(
                DocumentReviewPolicy.document_id == uuid.UUID(view["document"]["id"])
            )
        )
        policy.mandatory_reviewer_ids = [ctx.users["approver"].id]
        meeting = SimpleSession(kind="meeting", started_by=ctx.users["peer"].id, started_at=NOW)
        s.add(meeting)
        await s.flush()
        (await s.get(SimpleChange, cid)).session_id = meeting.id
        await s.commit()
    path = f"{URL}/change/{cid}"
    for who in ("approver", "peer"):
        got = await client.get(path, headers=ctx.as_(who))
        assert got.status_code == 200, (who, got.text)
        assert got.json()["flow"]["version"] == 1 and got.json()["can_comment"] is True
        r = await client.post(f"{path}/comments", json={"body": f"{who}: show the skip path"},
                              headers=ctx.as_(who))  # fmt: skip
        assert r.status_code == 201, (who, r.text)
    assert (await client.get(path, headers=ctx.as_("viewer"))).status_code == 404


async def test_documentless_visual_of_another_lane_is_closed(client):
    ctx = await world(client)
    rm, _ = await roadmap_world(ctx)
    loose, mine, placed = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    async with tenant_session(ctx.tenant_id) as s:
        await visuals.request_visual(s, None, "suggestion", loose, "A sample project")
        await visuals.request_visual(s, None, "chat_card", mine, "A guided tour")
        await visuals.request_visual(s, None, "chat_card", placed, "A tour", document_id=rm.id)
        # A person asked for this one (their lane's hook with them as the principal).
        (await visuals._visual(s, "chat_card", mine)).requested_by = ctx.users["commenter"].id
        await s.commit()
    await run_visual_jobs(ctx)
    for who, kind, sid, status in [
        ("viewer", "suggestion", loose, 404),
        ("commenter", "suggestion", loose, 404),
        ("owner", "suggestion", loose, 200),
        ("commenter", "chat_card", mine, 200),
        ("viewer", "chat_card", mine, 404),
        ("viewer", "chat_card", placed, 200),
    ]:
        got = await client.get(f"{URL}/{kind}/{sid}", headers=ctx.as_(who))
        assert got.status_code == status, (who, kind, got.text)
        got = await client.get(f"{URL}/{kind}/{sid}/versions/1", headers=ctx.as_(who))
        assert got.status_code == status, (who, kind, got.text)


async def test_request_refuses_subjects_simple_cannot_look_up(client):
    ctx = await world(client)
    for kind in ("suggestion", "chat_card", "one_pager_line"):
        sid = uuid.uuid4()
        r = await client.post(f"{URL}/{kind}/{sid}/request", json={"brief": "Anything"},
                              headers=ctx.as_("owner"))  # fmt: skip
        assert r.status_code == 422, (kind, r.text)
        got = await client.get(f"{URL}/{kind}/{sid}", headers=ctx.as_("owner"))
        assert got.status_code == 200 and got.json()["can_revise"] is False, (kind, got.text)
    async with tenant_session(ctx.tenant_id) as s:
        assert not list(await s.scalars(select(SimpleVisual)))
    assert await jobs(ctx) == []


async def test_change_survives_a_failed_visual(client, monkeypatch):
    ctx = await world(client)
    _, item = await roadmap_world(ctx)

    async def broken(db, principal, change):
        raise RuntimeError("the database went away")

    monkeypatch.setattr(visuals, "on_change", broken)
    body = {"op": "edit_outcome", "target": {"item_id": str(item.id)},
            "before": {"outcome": "Admins finish setup"},
            "after": {"outcome": "Admins invite a teammate on day one"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("commenter"))
    assert r.status_code == 201, r.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(SimpleChange, uuid.UUID(r.json()["change"]["id"])) is not None


async def test_direct_outcome_edit_queues_no_visual(client):
    ctx = await world(client)
    _, item = await roadmap_world(ctx)
    body = {"op": "edit_outcome", "target": {"item_id": str(item.id)},
            "before": {"outcome": "Admins finish setup"},
            "after": {"outcome": "Admins invite a teammate on day one"}}  # fmt: skip
    r = await client.post(CHANGES, json=body, headers=ctx.as_("owner"))
    assert r.status_code == 201 and r.json()["change"]["status"] == "applied", r.text
    assert await jobs(ctx) == []
    # The owner's edit is in the working draft; a commenter proposes over the published one.
    body["after"] = {"outcome": "Admins invite two teammates"}
    r = await client.post(CHANGES, json=body, headers=ctx.as_("commenter"))
    assert r.status_code == 201 and r.json()["change"]["status"] == "proposed", r.text
    assert len(await jobs(ctx)) == 1
