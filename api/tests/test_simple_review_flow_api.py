"""Simple one-pager review flow (build-review): Send for approval with added reviewers, and
the changes list readers see. Against Postgres; the PRD world of
tests.test_simple_one_pager_api (an invented PRD approved as version 1, a decider), with the
approver as the PRD's required reviewer.

Test cards (protects / fails_when / no_claim):

- test_submit_with_an_added_reviewer: protects=POST /v1/simple/drafts/{id}/submit with
  ``{"reviewer_ids": [...]}`` waits on the PRD's required reviewer and then the added one
  (the response, the one-pager's draft and the added one's Inbox say so); the version is not
  published until the added reviewer approves too, and their approval takes them out of
  ``waiting_on``; fails_when=the added reviewer is dropped, not asked, or the version
  publishes without them; no_claim=the web's picker.
- test_submit_refuses_people_who_are_not_members: protects=an id that is no active member
  (unknown, removed) is 422 with a plain message and submits nothing; no body still submits;
  fails_when=a stranger is waited on or the old call breaks; no_claim=role rules beyond it.
- test_readers_see_the_changes_in_review: protects=a viewer who does not see the submitted
  draft reads each hidden line change and proposal (before, after, who, whom it waits on),
  one per counted change; the owner, who sees the draft, reads none; fails_when=the list is
  missing, leaks for the owner, or disagrees with ``changes_in_review``; no_claim=roadmap
  item changes (no line).
"""

import uuid

from sqlalchemy import select

from oracle import company_time
from oracle.auth.models import User
from oracle.docs.models import DocumentVersion
from oracle.review.models import DocumentReviewPolicy
from oracle.tenancy import tenant_session
from tests.baseline_helpers import Ctx
from tests.test_simple_one_pager_api import clock as clock  # noqa: F401
from tests.test_simple_one_pager_api import edit, get, line
from tests.test_simple_one_pager_api import world as prd_world

DRAFTS = "/v1/simple/drafts"
NAMES = {
    "owner": "Olive Owner",
    "approver": "Abe Approver",
    "commenter": "Cora Commenter",
    "viewer": "Vic Viewer",
}


async def world(client) -> Ctx:
    ctx = await prd_world(client)
    async with tenant_session(ctx.tenant_id) as s:
        for role, name in NAMES.items():
            (await s.get(User, ctx.users[role].id)).name = name
        p = await s.scalar(select(DocumentReviewPolicy))
        p.mandatory_reviewer_ids = [ctx.users["approver"].id]
        await s.commit()
    return ctx


def uid(ctx: Ctx, who: str) -> str:
    return str(ctx.users[who].id)


async def owner_edits(client, ctx: Ctx, *edits: tuple[str, str]) -> str:
    for line_id, text in edits:
        view = await get(client, ctx, "owner")
        r = await edit(client, ctx, "owner", view, line_id, text)
        assert r.status_code == 201, r.text
    return (await get(client, ctx, "owner"))["draft"]["id"]


async def submit(client, ctx: Ctx, draft_id: str, **kw):
    return await client.post(f"{DRAFTS}/{draft_id}/submit", headers=ctx.as_("owner"), **kw)


async def approve(client, ctx: Ctx, draft_id: str, who: str) -> dict:
    r = await client.post(f"{DRAFTS}/{draft_id}/approve", headers=ctx.as_(who))
    assert r.status_code == 200, (who, r.text)
    return r.json()


async def test_submit_with_an_added_reviewer(client):
    ctx = await world(client)
    draft_id = await owner_edits(client, ctx, ("bets-2", "Invite suggestions from shared contacts"))
    r = await submit(client, ctx, draft_id, json={"reviewer_ids": [uid(ctx, "commenter")]})
    assert r.status_code == 200, r.text
    assert r.json()["waiting_on"] == [uid(ctx, "approver"), uid(ctx, "commenter")]
    page = await get(client, ctx, "owner")
    assert [p["name"] for p in page["draft"]["waiting_on"]] == ["Abe Approver", "Cora Commenter"]
    # The added reviewer is asked like the required one: an Inbox request, and Approve.
    inbox = await client.get("/v1/inbox", headers=ctx.as_("commenter"))
    assert [x["draft_id"] for x in inbox.json()["simple_approvals"]] == [draft_id]
    # The required reviewer and the decider approve: still waiting on the added one.
    assert (await approve(client, ctx, draft_id, "approver"))["waiting_on"] == [
        uid(ctx, "commenter")
    ]
    out = await approve(client, ctx, draft_id, "decider")
    assert out["status"] == "submitted" and out["waiting_on"] == [uid(ctx, "commenter")]
    assert (await get(client, ctx, "viewer"))["version"] == 1
    # The added reviewer's approval takes them out of waiting_on and publishes it.
    out = await approve(client, ctx, draft_id, "commenter")
    assert out["status"] == "approved" and out["waiting_on"] == []
    after = await get(client, ctx, "viewer")
    assert after["version"] == 2
    assert line(after, "bets-2")["text"] == "Invite suggestions from shared contacts"


async def test_added_reviewer_approves_first(client):
    ctx = await world(client)
    draft_id = await owner_edits(client, ctx, ("bets-2", "Invite suggestions from shared contacts"))
    r = await submit(client, ctx, draft_id, json={"reviewer_ids": [uid(ctx, "commenter")]})
    assert r.status_code == 200, r.text
    out = await approve(client, ctx, draft_id, "commenter")
    assert out["status"] == "submitted" and out["waiting_on"] == [uid(ctx, "approver")]
    page = await get(client, ctx, "owner")
    assert [p["name"] for p in page["draft"]["waiting_on"]] == ["Abe Approver"]


async def test_submit_refuses_people_who_are_not_members(client):
    ctx = await world(client)
    draft_id = await owner_edits(client, ctx, ("bets-2", "Invite suggestions from shared contacts"))
    async with tenant_session(ctx.tenant_id) as s:
        gone = User(email="gone@example.com", name="Gus Gone", password_hash="x",
                    role="approver", disabled_at=company_time.now())  # fmt: skip
        s.add(gone)
        await s.commit()
    for bad in (str(uuid.uuid4()), str(gone.id)):
        r = await submit(client, ctx, draft_id, json={"reviewer_ids": [bad]})
        assert r.status_code == 422, r.text
        assert "member" in r.json()["detail"]
    assert (await get(client, ctx, "owner"))["draft"]["status"] == "working"
    # No body still submits, as before.
    r = await submit(client, ctx, draft_id)
    assert r.status_code == 200, r.text
    assert r.json()["waiting_on"] == [uid(ctx, "approver")]


async def test_required_reviewer_named_again_is_not_doubled(client):
    ctx = await world(client)
    draft_id = await owner_edits(client, ctx, ("bets-2", "Invite suggestions from shared contacts"))
    ids = [uid(ctx, "approver"), uid(ctx, "commenter"), uid(ctx, "commenter")]
    r = await submit(client, ctx, draft_id, json={"reviewer_ids": ids})
    assert r.status_code == 200, r.text
    assert r.json()["waiting_on"] == [uid(ctx, "approver"), uid(ctx, "commenter")]


async def test_readers_see_the_changes_in_review(client):
    ctx = await world(client)
    published = await get(client, ctx, "viewer")
    old2, old3 = line(published, "bets-2")["text"], line(published, "bets-3")["text"]
    old_risk = line(published, "risks-1")["text"]
    draft_id = await owner_edits(
        client, ctx,
        ("bets-2", "Invite suggestions from shared contacts"),
        ("bets-3", "A sample project made on the first day"),
    )  # fmt: skip
    r = await edit(client, ctx, "commenter", await get(client, ctx, "commenter"), "risks-1",
                   "Calendar access may worry admins")  # fmt: skip
    assert r.status_code == 201 and r.json()["change"]["status"] == "proposed", r.text
    assert (await submit(client, ctx, draft_id)).status_code == 200
    view = await get(client, ctx, "viewer")
    assert view["draft"] is None and view["changes_in_review"] == 3
    rows = sorted(view["in_review"], key=lambda x: x["line_id"])
    assert len(rows) == view["changes_in_review"]
    approver = [{"id": uid(ctx, "approver"), "name": "Abe Approver"}]
    assert rows == [
        {"line_id": "bets-2", "kind": "change", "before": old2,
         "after": "Invite suggestions from shared contacts", "by_name": "Olive Owner",
         "waiting_on": approver},
        {"line_id": "bets-3", "kind": "change", "before": old3,
         "after": "A sample project made on the first day", "by_name": "Olive Owner",
         "waiting_on": approver},
        {"line_id": "risks-1", "kind": "proposal", "before": old_risk,
         "after": "Calendar access may worry admins", "by_name": "Cora Commenter",
         "waiting_on": [{"id": uid(ctx, "decider"), "name": "Dee Cider"}]},
    ]  # fmt: skip
    # The commenter sees their own proposal as a note: only the draft's changes are listed.
    mine = await get(client, ctx, "commenter")
    assert sorted(x["line_id"] for x in mine["in_review"]) == ["bets-2", "bets-3"]
    assert len(mine["in_review"]) == mine["changes_in_review"] == 2
    # The owner sees the draft itself: nothing listed.
    own = await get(client, ctx, "owner")
    assert own["draft"] is not None and own["in_review"] == []
    async with tenant_session(ctx.tenant_id) as s:
        v2 = await s.scalar(select(DocumentVersion).where(DocumentVersion.number == 2))
        assert v2 is not None and v2.approved_at is None


async def test_working_draft_changes_wait_on_nobody(client):
    ctx = await world(client)
    await owner_edits(client, ctx, ("bets-2", "Invite suggestions from shared contacts"))
    view = await get(client, ctx, "viewer")
    [row] = view["in_review"]
    assert row["kind"] == "change" and row["waiting_on"] == [] and row["by_name"] == "Olive Owner"


async def test_working_draft_names_who_approves(client):
    """Send for approval… names who approves before sending: the PRD's required reviewers on
    the owner's working draft; nothing once it is sent (waiting_on says it then)."""
    ctx = await world(client)
    draft_id = await owner_edits(client, ctx, ("bets-2", "Invite suggestions from shared contacts"))
    page = await get(client, ctx, "owner")
    assert [p["name"] for p in page["draft"]["reviewers"]] == ["Abe Approver"]
    assert (await submit(client, ctx, draft_id)).status_code == 200
    assert (await get(client, ctx, "owner"))["draft"]["reviewers"] == []
