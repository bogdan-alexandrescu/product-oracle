"""qa-docs-33 "Merge into Discuss": whole-draft feedback goes through the version's Discuss.

The review panel no longer has "Comment on the whole draft". During a review (the version
is not approved), an open Discuss thread on the version with a first message is also the
whole-draft review feedback that comment was: a ``general`` item, raised on the version by
the starter, its summary the first message. Every count that read the old comment reads it
(the feedback list, the Inbox, the review-comments job). Outside a review, or private, or
about one section, a discussion stays a discussion.
"""

import uuid

from sqlalchemy import select

from oracle.docs.models import Document
from oracle.review.models import FeedbackItem
from oracle.review.schemas import GENERAL_FEEDBACK_MAX
from oracle.tenancy import tenant_session
from tests.test_general_feedback import SLUG, two_versions, user_id
from tests.test_runs import as_user

REMARK = "The goals don't match the problem statement."


async def doc_id(tenant_id: uuid.UUID) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        return await s.scalar(select(Document.id).where(Document.slug == SLUG))


def discuss(document_id: uuid.UUID, n: int, message: str | None = REMARK, **extra) -> dict:
    return {
        "subject_kind": "document",
        "subject": {"document_id": str(document_id), "version": n},
        **({"message": {"body": message}} if message else {}),
        **extra,
    }


async def items(tenant_id: uuid.UUID) -> list[FeedbackItem]:
    async with tenant_session(tenant_id) as s:
        return list((await s.scalars(select(FeedbackItem))).all())


async def test_a_discuss_thread_during_a_review_is_whole_draft_feedback(client):
    tenant_id, auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter", "reviewer@example.com")
    approver = await as_user(tenant_id, "approver")
    document_id = await doc_id(tenant_id)

    resp = await client.post("/v1/discussions", json=discuss(document_id, 2), headers=reviewer)
    assert resp.status_code == 201, resp.text

    [item] = await items(tenant_id)
    assert (item.kind, item.section_key, item.raised_on_version) == ("general", None, 2)
    assert item.summary == REMARK and item.status == "open"
    assert item.author_id == await user_id(tenant_id, "reviewer@example.com")

    listed = (await client.get(f"/v1/documents/{SLUG}/feedback", headers=approver)).json()
    assert [(f["kind"], f["summary"]) for f in listed] == [("general", REMARK)]
    inbox = (await client.get("/v1/inbox", headers=approver)).json()
    [row] = [i for i in inbox["items"] if i["id"] == str(item.id)]
    assert row["kind"] == "general" and row["state"] == "new"
    [doc] = inbox["feedback"]
    assert doc["open_count"] == 1

    # Oracle's review-comments job picks it up, as it did the old comment.
    jobs = (await client.get(f"/v1/documents/{SLUG}/llm-jobs", headers=auth)).json()
    assert [(j["status"], j["version_number"]) for j in jobs if j["kind"] == "review_comments"] == [
        ("queued", 2)
    ]

    # Replies in the thread are the discussion's, not more feedback.
    d = resp.json()["id"]
    more = {"body": "And the metrics too."}
    assert (
        await client.post(f"/v1/discussions/{d}/messages", json=more, headers=reviewer)
    ).status_code == 201
    assert len(await items(tenant_id)) == 1


async def test_a_discussion_stays_a_discussion_outside_a_review(client):
    tenant_id, auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    document_id = await doc_id(tenant_id)

    # No first message: nothing said to count.
    body = discuss(document_id, 2, message=None)
    assert (await client.post("/v1/discussions", json=body, headers=reviewer)).status_code == 201
    # Private: only the people picked read it, so it is not the review's.
    body = discuss(document_id, 2, visibility="private")
    assert (await client.post("/v1/discussions", json=body, headers=reviewer)).status_code == 201
    # About one section: the section's own Discuss.
    body = {
        "subject_kind": "section",
        "subject": {"document_id": str(document_id), "version": 2, "section_key": "problem"},
        "message": {"body": REMARK},
    }
    resp = await client.post("/v1/discussions", json=body, headers=reviewer)
    assert resp.status_code == 201, resp.text
    assert await items(tenant_id) == []

    # An approved version is not in review.
    resp = await client.post(f"/v1/documents/{SLUG}/versions/2/approve", headers=auth)
    assert resp.status_code == 200, resp.text
    body = discuss(document_id, 2)
    assert (await client.post("/v1/discussions", json=body, headers=reviewer)).status_code == 201
    assert await items(tenant_id) == []


# --- fix3-discuss review: the item follows its thread --------------------------------------


async def started(client, headers, document_id, n=2, **extra) -> dict:
    resp = await client.post(
        "/v1/discussions", json=discuss(document_id, n, **extra), headers=headers
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def first_message(client, headers, d: str) -> str:
    resp = await client.get(f"/v1/discussions/{d}/messages", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    rows = body["items"] if isinstance(body, dict) else body
    return next(m["id"] for m in rows if m["author_kind"] == "person")


async def test_editing_the_first_message_updates_the_item(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    d = (await started(client, reviewer, await doc_id(tenant_id)))["id"]
    mid = await first_message(client, reviewer, d)

    edited = {"body": "The goals don't match the problem, and the metrics are missing."}
    resp = await client.patch(f"/v1/discussions/{d}/messages/{mid}", json=edited, headers=reviewer)
    assert resp.status_code == 200, resp.text

    [item] = await items(tenant_id)
    assert item.summary == edited["body"] and item.status == "open"


async def test_deleting_the_first_message_withdraws_the_item(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    d = (await started(client, reviewer, await doc_id(tenant_id)))["id"]
    mid = await first_message(client, reviewer, d)

    resp = await client.delete(f"/v1/discussions/{d}/messages/{mid}", headers=reviewer)
    assert resp.status_code == 204, resp.text

    assert await items(tenant_id) == []
    listed = (await client.get(f"/v1/documents/{SLUG}/feedback", headers=approver)).json()
    assert listed == []
    inbox = (await client.get("/v1/inbox", headers=approver)).json()
    assert [i for i in inbox["items"] if i["kind"] == "general"] == []


async def test_making_the_thread_private_withdraws_the_item(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    out = await started(client, reviewer, await doc_id(tenant_id))

    patch = {"visibility": "private", "lock_version": out["lock_version"]}
    resp = await client.patch(f"/v1/discussions/{out['id']}", json=patch, headers=reviewer)
    assert resp.status_code == 200, resp.text

    assert await items(tenant_id) == []


async def test_the_item_leads_to_its_thread_and_resolving_it_closes_the_thread(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    d = (await started(client, reviewer, await doc_id(tenant_id)))["id"]

    [listed] = (await client.get(f"/v1/documents/{SLUG}/feedback", headers=approver)).json()
    assert listed["discussion_id"] == d

    resolve = {"status": "addressed", "resolution_note": "Goals rewritten."}
    resp = await client.patch(f"/v1/feedback/{listed['id']}", json=resolve, headers=approver)
    assert resp.status_code == 200, resp.text

    thread = (await client.get(f"/v1/discussions/{d}", headers=reviewer)).json()
    assert thread["status"] == "closed"


async def test_a_first_message_too_long_for_whole_draft_feedback_is_refused(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    body = discuss(await doc_id(tenant_id), 2, message="x" * (GENERAL_FEEDBACK_MAX + 1))

    resp = await client.post("/v1/discussions", json=body, headers=reviewer)

    assert resp.status_code == 422, resp.text
    assert "4,000" in resp.text
    assert await items(tenant_id) == []
    listed = (await client.get("/v1/discussions", headers=reviewer)).json()
    rows = listed["items"] if isinstance(listed, dict) else listed
    assert rows == []


async def test_a_discussion_on_a_draft_does_not_start_its_review(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        assert doc.status == "draft"

    await started(client, reviewer, doc.id)

    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document).where(Document.slug == SLUG))
        assert doc.status == "draft"
    assert len(await items(tenant_id)) == 1


async def test_a_mentioned_approver_hears_of_the_remark_once(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver", "approver@example.com")
    approver_id = await user_id(tenant_id, "approver@example.com")
    d = (await started(client, reviewer, await doc_id(tenant_id), participants=[str(approver_id)]))[
        "id"
    ]

    inbox = (await client.get("/v1/inbox", headers=approver)).json()
    assert [i["kind"] for i in inbox["items"]] == ["general"]
    assert [r for r in inbox["discussions"] if r["discussion_id"] == d] == []


async def oracle_suggests(tenant_id: uuid.UUID, kind: str) -> str:
    from oracle.jobs.models import LlmSuggestion

    [item] = await items(tenant_id)
    async with tenant_session(tenant_id) as s:
        row = LlmSuggestion(
            document_id=item.document_id,
            feedback_item_id=item.id,
            version_number=2,
            classification="other",
            kind=kind,
            rationale="Nothing in the draft to change.",
        )
        s.add(row)
        await s.commit()
        return str(row.id)


async def test_a_decision_on_oracles_suggestion_that_closes_the_item_closes_the_thread(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    d = (await started(client, reviewer, await doc_id(tenant_id)))["id"]
    sid = await oracle_suggests(tenant_id, "none")

    resp = await client.post(f"/v1/suggestions/{sid}/accept", json={}, headers=approver)
    assert resp.status_code == 200, resp.text

    [item] = await items(tenant_id)
    assert item.status == "addressed"
    thread = (await client.get(f"/v1/discussions/{d}", headers=reviewer)).json()
    assert thread["status"] == "closed"


async def test_declining_the_item_with_oracles_suggestion_closes_the_thread(client):
    tenant_id, _auth = await two_versions(client)
    reviewer = await as_user(tenant_id, "commenter")
    approver = await as_user(tenant_id, "approver")
    d = (await started(client, reviewer, await doc_id(tenant_id)))["id"]
    sid = await oracle_suggests(tenant_id, "none")

    body = {"reason": "Out of scope.", "decline": True}
    resp = await client.post(f"/v1/suggestions/{sid}/dismiss", json=body, headers=approver)
    assert resp.status_code == 200, resp.text

    thread = (await client.get(f"/v1/discussions/{d}", headers=reviewer)).json()
    assert thread["status"] == "closed"
