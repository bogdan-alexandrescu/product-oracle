"""D13: a "General" feedback item on the whole draft (POST .../versions/{n}/feedback).

A whole-draft remark is a first-class feedback item: kind ``general``, no section, raised
on the version it was left on, by its author. Oracle's review-comments job picks it up, the
feedback list and the Inbox show it, and the feedback-loop prompt prints it as
``[general]``.
"""

import uuid

from sqlalchemy import select

from oracle.auth.models import User
from oracle.docs.models import Document
from oracle.models import AuditEvent
from oracle.review.models import FeedbackItem
from oracle.tenancy import tenant_session
from tests.fixtures import draft, import_draft, seed_auth
from tests.test_runs import as_user, runtime, started  # noqa: F401

SLUG = "checkout-redesign"
REMARK = "The goals section doesn't match the problem statement."


def url(n: int) -> str:
    return f"/v1/documents/{SLUG}/versions/{n}/feedback"


async def two_versions(client) -> tuple[uuid.UUID, dict[str, str]]:
    tenant_id, auth = await seed_auth()
    assert (await import_draft(client, auth, draft("prd_v1.md"))).status_code == 201
    v2 = draft("prd_v1.md").replace("draft for review", "second draft")
    assert (await import_draft(client, auth, v2)).status_code == 201
    return tenant_id, auth


async def user_id(tenant_id: uuid.UUID, email: str) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(User.id).where(User.email == email))


async def test_a_commenter_leaves_a_general_item_on_the_draft(client):
    tenant_id, auth = await two_versions(client)
    commenter = await as_user(tenant_id, "commenter", "reviewer@example.com")

    resp = await client.post(url(2), json={"body": REMARK}, headers=commenter)

    assert resp.status_code == 201, resp.text
    item = resp.json()
    assert item["kind"] == "general"
    assert item["section_key"] is None
    assert item["comment_id"] is None and item["section_review_id"] is None
    assert item["summary"] == REMARK
    assert item["status"] == "open" and item["state"] == "open"
    assert item["raised_on_version"] == 2
    assert item["author_id"] == str(await user_id(tenant_id, "reviewer@example.com"))
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        assert doc.status == "in_review"
        [event] = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "feedback.create"))
        ).all()
        assert event.target_id == uuid.UUID(item["id"])
        assert event.data["kind"] == "general"
        assert event.data["raised_on_version"] == 2

    # Severity is optional, with the change-request values.
    resp = await client.post(
        url(2), json={"body": "Add a rollout section.", "severity": "major"}, headers=commenter
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["severity"] == "major"


async def test_roles_and_validation(client):
    tenant_id, auth = await two_versions(client)
    viewer = await as_user(tenant_id, "viewer")
    commenter = await as_user(tenant_id, "commenter")

    assert (await client.post(url(2), json={"body": REMARK}, headers=viewer)).status_code == 403
    for body in ("", "x" * 4001):
        resp = await client.post(url(2), json={"body": body}, headers=commenter)
        assert resp.status_code == 422, (len(body), resp.text)
    resp = await client.post(url(2), json={"body": "x" * 4000}, headers=commenter)
    assert resp.status_code == 201
    assert (await client.post(url(2), json={}, headers=commenter)).status_code == 422
    resp = await client.post(url(2), json={"body": REMARK, "severity": "huge"}, headers=commenter)
    assert resp.status_code == 422
    assert (await client.post(url(9), json={"body": REMARK}, headers=commenter)).status_code == 404
    resp = await client.post(
        "/v1/documents/missing/versions/1/feedback", json={"body": REMARK}, headers=commenter
    )
    assert resp.status_code == 404
    async with tenant_session(tenant_id) as s:
        assert len((await s.scalars(select(FeedbackItem))).all()) == 1


async def test_the_review_comments_job_is_queued_for_it(client):
    tenant_id, auth = await two_versions(client)
    before = (await client.get(f"/v1/documents/{SLUG}/llm-jobs", headers=auth)).json()
    assert [j for j in before if j["kind"] == "review_comments"] == []

    assert (await client.post(url(2), json={"body": REMARK}, headers=auth)).status_code == 201

    jobs = (await client.get(f"/v1/documents/{SLUG}/llm-jobs", headers=auth)).json()
    assert [(j["kind"], j["status"], j["version_number"]) for j in jobs] == [
        ("review_comments", "queued", 2)
    ]


async def test_the_feedback_list_and_the_inbox_show_it(client):
    tenant_id, auth = await two_versions(client)
    commenter = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    created = (await client.post(url(2), json={"body": REMARK}, headers=commenter)).json()

    listed = (await client.get(f"/v1/documents/{SLUG}/feedback", headers=commenter)).json()
    assert [(f["id"], f["kind"], f["section_key"]) for f in listed] == [
        (created["id"], "general", None)
    ]
    on_v2 = (
        await client.get(f"/v1/documents/{SLUG}/feedback?version=2", headers=commenter)
    ).json()
    assert [f["id"] for f in on_v2] == [created["id"]]

    inbox = (await client.get("/v1/inbox", headers=approver)).json()
    [row] = [i for i in inbox["items"] if i["id"] == created["id"]]
    assert row["kind"] == "general" and row["section_key"] is None
    assert row["state"] == "new"
    assert inbox["counts"]["new"] == 1
    [doc] = inbox["feedback"]
    assert doc["counts"]["other"] == 1 and doc["open_count"] == 1


async def test_the_feedback_loop_prompt_prints_it_as_general(client, runtime):  # noqa: F811
    tenant_id, auth = await two_versions(client)
    created = (await client.post(url(2), json={"body": REMARK}, headers=auth)).json()

    await started(client, auth, flow="feedback_loop", document=SLUG)

    prompt = runtime.submitted[0].steps[-1].prompt
    assert f"- {created['id']} [general]: {REMARK}" in prompt


async def test_comment_and_verdict_items_carry_their_author_too(client):
    tenant_id, auth = await two_versions(client)
    approver = await as_user(tenant_id, "approver", "lead@example.com")
    lead = str(await user_id(tenant_id, "lead@example.com"))
    resp = await client.post(
        f"/v1/documents/{SLUG}/versions/2/comments",
        json={"section_key": "title", "anchor": {"exact": "Owner: product."}, "body": "Who?"},
        headers=approver,
    )
    assert resp.status_code == 201, resp.text
    resp = await client.put(
        f"/v1/documents/{SLUG}/versions/2/sections/problem/review",
        json={"verdict": "changes_requested", "note": "Size the problem."},
        headers=approver,
    )
    assert resp.status_code == 200, resp.text

    listed = (await client.get(f"/v1/documents/{SLUG}/feedback", headers=auth)).json()
    assert sorted((f["kind"], f["author_id"]) for f in listed) == [
        ("comment", lead),
        ("section_review", lead),
    ]
