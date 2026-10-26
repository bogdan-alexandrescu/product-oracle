"""Simple S3b (#723): working drafts, the review hand-off, meeting approval, visibility and
resume (``/v1/simple/drafts``, oracle.simple.drafts). Against Postgres.

Each test seeds S3a's world (tests.test_simple_changes_api: one roadmap, approved version
1, a decider) and acts over REST as a person would; ``approve_in_meeting`` is S8's
service call, made here in the company's session. People: the four roles plus
``decider`` and a second approver ``reviewer2``; the review policy names the decider and,
where a test says so, required reviewers.

Test cards (protects / fails_when / no_claim):

- test_published_version_unchanged_while_a_draft_exists: protects=the decider's applied
  change and an accepted proposal land in the roadmap's working draft (the change names
  it), the published item rows never change, the decider reads the draft on the Simple
  roadmap while a viewer reads the published version; fails_when=a change writes the
  approved version's rows or the draft is lost to its people; no_claim=PRD sections (S5).
- test_visibility_per_role (role x document role): protects=the draft and its changes are
  visible to company owners, the decider, required reviewers, the document's owner (its
  track's owner) and the session's people; everyone else reads the published version and
  ``changes_in_review`` (the count only) on the Simple roadmap and the document API, and
  no change in GET /v1/simple/changes; fails_when=a detail leaks or a member who may see
  the draft gets the published version; no_claim=Studio's version list after submit.
- test_submit_goes_through_the_review_policy: protects=only someone who may change the
  roadmap submits; submit imports the next version holding the draft (unapproved, so
  readers keep the published one); while it is in review new direct changes and undo are
  409; the decider's approval waits for the required reviewer, who gets an Inbox request
  and whose approval publishes it; then everyone reads the new version and the banner
  count is 0; fails_when=a version publishes without its required approvals, or a
  submitted draft keeps changing; no_claim=readiness checks of PRDs.
- test_approve_in_meeting_present_and_absent: protects=approve_in_meeting records the
  decider's and the present required reviewer's approvals, holds the version while an
  absent required reviewer has not approved, gives only the absent one an Inbox request,
  and publishes when they approve; fails_when=it publishes early, asks the present
  reviewer, or never publishes; no_claim=the meeting screen and minutes (S8).
- test_undo_inside_a_draft_change_by_change: protects=undo inside a working draft reverses
  one change at a time, back to the published values, without touching the published
  rows; fails_when=an undo reverts more than its change or writes the published rows;
  no_claim=S3a's undo rules (its tests).
- test_resume_rules: protects=an idle-closed session's draft stays a working draft, listed
  by GET /v1/simple/drafts; its old changes no longer undo; only its author or the
  decider resumes it (others 403), into a session whose changes join the same draft;
  fails_when=closing drops the draft, someone else resumes it, or a resumed change opens a
  second draft; no_claim=meeting sessions' resume (S8).
"""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select

from oracle.auth.models import User
from oracle.docs.models import DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.roadmap.models import RoadmapItem
from oracle.simple import changes as simple_changes
from oracle.simple import drafts
from oracle.simple.models import SimpleSession
from oracle.tenancy import tenant_session
from tests.test_simple_changes_api import CHANGES, SESSIONS, World, make_people, seeded_title
from tests.test_simple_changes_api import clock as clock  # noqa: F401
from tests.test_simple_roadmap_api import NOW

DRAFTS = "/v1/simple/drafts"
ROADMAP = "/v1/simple/roadmap"
OPS = ["edit_title", "move_dates"]
TITLE = seeded_title("edit_title-a")


async def world(*, reviewers: tuple[str, ...] = (), track_owner: str | None = None) -> World:
    ctx = await make_people()
    async with tenant_session(ctx.tenant_id) as s:
        user = User(email="reviewer2@example.com", name="Rae Viewer", password_hash="x",
                    role="approver")  # fmt: skip
        s.add(user)
        await s.commit()
        ctx.users["reviewer2"] = user
    w = await World(ctx).build(decider=True, track_owner=track_owner, ops=OPS)
    if reviewers:
        async with tenant_session(ctx.tenant_id) as s:
            p = await s.scalar(select(DocumentReviewPolicy))
            p.mandatory_reviewer_ids = [ctx.users[r].id for r in reviewers]
            await s.commit()
    return w


async def published(w: World, key: str) -> RoadmapItem:
    async with tenant_session(w.ctx.tenant_id) as s:
        return await s.get(RoadmapItem, w.ids[key])


async def roadmap(client, w: World, who: str) -> dict:
    r = await client.get(ROADMAP, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


def title_in(view: dict, key: str) -> str:
    return next(i["title"] for i in view["items"] if i["key"] == key)


async def slug(w: World) -> str:
    async with tenant_session(w.ctx.tenant_id) as s:
        from oracle.docs.models import Document

        return (await s.get(Document, uuid.UUID(w.roadmap_id))).slug


async def edit_title(client, w: World, who: str, title: str = "Ledger v2", **over):
    return await w.post(client, who, "edit_title",
                        after={"title": title}, **over)  # fmt: skip


async def the_draft(client, w: World, who: str = "decider") -> dict:
    r = await client.get(DRAFTS, headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    [d] = r.json()
    return d


async def inbox(client, w: World, who: str) -> dict:
    r = await client.get("/v1/inbox", headers=w.ctx.as_(who))
    assert r.status_code == 200, r.text
    return r.json()


async def test_published_version_unchanged_while_a_draft_exists(client):
    w = await world()
    r = await edit_title(client, w, "decider")
    assert r.status_code == 201, r.text
    change = r.json()["change"]
    assert change["status"] == "applied" and len(change["draft_ids"]) == 1
    assert (await published(w, "edit_title-a")).title == TITLE
    assert title_in(await roadmap(client, w, "decider"), "edit_title-a") == "Ledger v2"
    seen = await roadmap(client, w, "viewer")
    assert title_in(seen, "edit_title-a") == TITLE
    # A proposal accepted by the decider joins the same working draft.
    prop = (await w.post(client, "commenter", "move_dates")).json()["change"]
    acc = await client.post(f"{CHANGES}/{prop['id']}/accept", headers=w.ctx.as_("decider"))
    assert acc.status_code == 200, acc.text
    assert acc.json()["change"]["draft_ids"] == change["draft_ids"]
    a = await published(w, "move_dates-a")
    assert a.start_date.isoformat() == "2026-10-01"
    d = await the_draft(client, w)
    assert d["id"] == change["draft_ids"][0] and d["status"] == "working"
    assert d["changes"] == 2 and d["document"]["id"] == w.roadmap_id
    assert d["can_submit"] and d["can_resume"]


@pytest.mark.parametrize(
    "who,track_owner,sees",
    [
        ("owner", None, True),
        ("decider", None, True),
        ("approver", None, True),  # a required reviewer
        ("reviewer2", None, False),
        ("commenter", None, False),
        ("viewer", None, False),
        ("commenter", "commenter", True),  # the roadmap's owner (its track's)
    ],
)
async def test_visibility_per_role(client, who, track_owner, sees):
    w = await world(reviewers=("approver",), track_owner=track_owner)
    assert (await edit_title(client, w, "decider")).status_code == 201
    view = await roadmap(client, w, who)
    assert title_in(view, "edit_title-a") == ("Ledger v2" if sees else TITLE)
    assert view["changes_in_review"] == (0 if sees else 1)
    assert [d["status"] for d in view["drafts"]] == (["working"] if sees else [])
    doc = await client.get(f"/v1/documents/{await slug(w)}", headers=w.ctx.as_(who))
    assert doc.status_code == 200 and doc.json()["changes_in_review"] == 1
    listed = await client.get(CHANGES, headers=w.ctx.as_(who))
    assert len(listed.json()) == (1 if sees else 0)
    drafts_ = (await client.get(DRAFTS, headers=w.ctx.as_(who))).json()
    assert len(drafts_) == (1 if sees else 0)


async def test_submit_goes_through_the_review_policy(client):
    w = await world(reviewers=("approver",))
    change = (await edit_title(client, w, "decider")).json()["change"]
    d = await the_draft(client, w)
    # A commenter does not see the draft (404); the required reviewer sees it, but does
    # not change the roadmap (403).
    for who, code in (("commenter", 404), ("approver", 403)):
        r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_(who))
        assert r.status_code == code, (who, r.text)
    r = await client.post(f"{DRAFTS}/{d['id']}/submit", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["status"] == "submitted" and out["version"] == 2
    assert out["waiting_on"] == [str(w.ctx.users["approver"].id)]
    async with tenant_session(w.ctx.tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        assert v2.approved_at is None
        titles = {
            r.item_key: r.title
            for r in await s.scalars(
                select(RoadmapItem).where(RoadmapItem.roadmap_version_id == v2.id)
            )
        }
        assert titles["edit_title-a"] == "Ledger v2" and len(titles) == 6
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") == TITLE
    # In review: no more direct changes, no undo.
    r = await w.post(client, "decider", "move_dates")
    assert r.status_code == 409, r.text
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=w.ctx.as_("decider"))
    assert r.status_code == 409, r.text
    # The reviewer is asked in the Inbox.
    rows = (await inbox(client, w, "approver"))["simple_approvals"]
    assert [x["draft_id"] for x in rows] == [d["id"]]
    assert (await inbox(client, w, "commenter"))["simple_approvals"] == []
    # The decider's approval waits for the required reviewer.
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "submitted" and r.json()["decider_approved"]
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") == TITLE
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("commenter"))
    assert r.status_code == 404
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("approver"))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved" and r.json()["waiting_on"] == []
    view = await roadmap(client, w, "viewer")
    assert title_in(view, "edit_title-a") == "Ledger v2" and view["changes_in_review"] == 0
    assert (await inbox(client, w, "approver"))["simple_approvals"] == []


async def test_approve_in_meeting_present_and_absent(client):
    w = await world(reviewers=("approver", "reviewer2"))
    meeting = await client.post(SESSIONS, json={"kind": "meeting"}, headers=w.ctx.as_("decider"))
    sid = meeting.json()["id"]
    r = await edit_title(client, w, "decider", session_id=sid)
    assert r.status_code == 201, r.text
    d = await the_draft(client, w)
    assert (await client.post(f"{DRAFTS}/{d['id']}/submit",
                              headers=w.ctx.as_("decider"))).status_code == 200  # fmt: skip
    async with tenant_session(w.ctx.tenant_id) as s:
        session = await s.get(SimpleSession, uuid.UUID(sid))
        [out] = await drafts.approve_in_meeting(
            s, session, w.ctx.users["decider"].id, [w.ctx.users["approver"].id]
        )
        await s.commit()
    assert out.status == "submitted"
    assert out.waiting_on == [w.ctx.users["reviewer2"].id]
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") == TITLE
    assert (await inbox(client, w, "approver"))["simple_approvals"] == []
    [row] = (await inbox(client, w, "reviewer2"))["simple_approvals"]
    assert row["draft_id"] == d["id"] and row["decider_approved"]
    r = await client.post(f"{DRAFTS}/{d['id']}/approve", headers=w.ctx.as_("reviewer2"))
    assert r.status_code == 200 and r.json()["status"] == "approved", r.text
    assert title_in(await roadmap(client, w, "viewer"), "edit_title-a") == "Ledger v2"


async def test_undo_inside_a_draft_change_by_change(client):
    w = await world()
    first = (await edit_title(client, w, "decider")).json()["change"]
    second = (
        await edit_title(client, w, "decider", "Ledger v3", before={"title": "Ledger v2"})
    ).json()["change"]
    assert first["draft_ids"] == second["draft_ids"]
    r = await client.post(f"{CHANGES}/{second['id']}/undo", headers=w.ctx.as_("decider"))
    assert r.status_code == 201, r.text
    assert title_in(await roadmap(client, w, "decider"), "edit_title-a") == "Ledger v2"
    r = await client.post(f"{CHANGES}/{first['id']}/undo", headers=w.ctx.as_("decider"))
    assert r.status_code == 201, r.text
    assert title_in(await roadmap(client, w, "decider"), "edit_title-a") == TITLE
    assert (await published(w, "edit_title-a")).title == TITLE


async def test_resume_rules(client, clock):
    w = await world()
    change = (await edit_title(client, w, "decider")).json()["change"]
    clock["now"] = NOW + timedelta(minutes=31)
    async with tenant_session(w.ctx.tenant_id) as s:
        assert await simple_changes.close_idle(s) == 1
        await s.commit()
    d = await the_draft(client, w)
    assert d["status"] == "working" and d["changes"] == 1
    r = await client.post(f"{CHANGES}/{change['id']}/undo", headers=w.ctx.as_("decider"))
    assert r.status_code == 409
    for who, code in (("commenter", 404), ("approver", 404), ("owner", 403)):
        r = await client.post(f"{DRAFTS}/{d['id']}/resume", headers=w.ctx.as_(who))
        assert r.status_code == code, (who, r.text)
    r = await client.post(f"{DRAFTS}/{d['id']}/resume", headers=w.ctx.as_("decider"))
    assert r.status_code == 200, r.text
    session = r.json()["session"]
    assert session["id"] != change["session_id"] and session["closed_at"] is None
    nxt = await edit_title(client, w, "decider", "Ledger v3", before={"title": "Ledger v2"},
                           session_id=session["id"])  # fmt: skip
    assert nxt.status_code == 201, nxt.text
    assert nxt.json()["change"]["draft_ids"] == change["draft_ids"]
    assert (await the_draft(client, w))["changes"] == 2
