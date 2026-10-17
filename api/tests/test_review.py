"""Lane 2: comments, verdicts, feedback items, feedback package, resolution report, approve.

Documents and versions are inserted directly (no dependency on Lane 1's importer).
"""

import hashlib
import uuid
from dataclasses import dataclass

import pytest
from sqlalchemy import select

from oracle.auth.service import create_api_token
from oracle.docs.models import Document, DocumentVersion, Section
from oracle.models import AuditEvent
from oracle.review.models import Comment, FeedbackItem, SectionReview
from oracle.review.schemas import Resolution
from oracle.review.service import (
    UnknownFeedbackItemsError,
    apply_resolutions,
    locked_section_keys,
)
from oracle.seed import seed
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant

SECTIONS = {
    "title": "Checkout redesign PRD",
    "goal-trace": "Serves G1 (activation). Most users abandon at the shipping step.",
    "s-5-2": "Ship to saved addresses first. Ranked by installs.",
}


@dataclass
class Ctx:
    tenant_id: uuid.UUID
    headers: dict[str, str]
    document_id: uuid.UUID
    slug: str = "checkout-redesign"

    def v(self, n: int, path: str = "") -> str:
        return f"/v1/documents/{self.slug}/versions/{n}{path}"


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


async def add_version(tenant_id: uuid.UUID, document_id: uuid.UUID, n: int) -> uuid.UUID:
    markdown = f"---\ndocument: checkout-redesign\n---\n# v{n}\n" + "\n".join(
        f"## {k} {{#{k}}}\n{body}" for k, body in SECTIONS.items()
    )
    async with tenant_session(tenant_id) as s:
        version = DocumentVersion(
            document_id=document_id, number=n, markdown=markdown, content_hash=_hash(markdown)
        )
        s.add(version)
        await s.flush()
        for i, (key, body) in enumerate(SECTIONS.items()):
            s.add(
                Section(
                    version_id=version.id,
                    section_key=key,
                    ordinal=i,
                    level=1 if i == 0 else 2,
                    heading=key,
                    body_md=body,
                    body_text=body,
                    content_hash=_hash(body),
                )
            )
        await s.commit()
        return version.id


@pytest.fixture
async def ctx() -> Ctx:
    r = await seed(token_name="test")
    async with tenant_session(r.tenant_id) as s:
        doc = Document(slug="checkout-redesign", title="Checkout redesign PRD")
        s.add(doc)
        await s.commit()
    await add_version(r.tenant_id, doc.id, 1)
    return Ctx(r.tenant_id, {"Authorization": f"Bearer {r.token}"}, doc.id)


ANCHOR = {"exact": "shipping step", "prefix": "abandon at the ", "suffix": "."}


async def comment(client, ctx: Ctx, n: int = 1, key: str = "goal-trace", body: str = "Cite it"):
    resp = await client.post(
        ctx.v(n, "/comments"),
        json={"section_key": key, "anchor": ANCHOR, "body": body},
        headers=ctx.headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def verdict(client, ctx: Ctx, key: str, v: str, note: str | None = None, n: int = 1):
    resp = await client.put(
        ctx.v(n, f"/sections/{key}/review"), json={"verdict": v, "note": note}, headers=ctx.headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def feedback(client, ctx: Ctx, **params) -> list[dict]:
    resp = await client.get(
        f"/v1/documents/{ctx.slug}/feedback", params=params, headers=ctx.headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def actions(ctx: Ctx) -> list[str]:
    async with tenant_session(ctx.tenant_id) as s:
        return list(
            (await s.scalars(select(AuditEvent.action).order_by(AuditEvent.created_at))).all()
        )


# --- Comments ----------------------------------------------------------------------------


async def test_comment_anchor_round_trips(client, ctx):
    created = await comment(client, ctx)
    assert created["anchor"] == ANCHOR
    assert created["section_key"] == "goal-trace"
    assert created["parent_id"] is None and created["resolved_at"] is None
    assert created["feedback_item_id"]

    listed = (await client.get(ctx.v(1, "/comments"), headers=ctx.headers)).json()
    assert len(listed) == 1
    assert listed[0]["anchor"] == ANCHOR
    assert listed[0]["id"] == created["id"]
    assert listed[0]["feedback_item_id"] == created["feedback_item_id"]

    # Also reachable by document id instead of slug.
    by_id = await client.get(
        f"/v1/documents/{ctx.document_id}/versions/1/comments", headers=ctx.headers
    )
    assert by_id.json()[0]["anchor"] == ANCHOR

    items = await feedback(client, ctx)
    assert [i["id"] for i in items] == [created["feedback_item_id"]]
    item = items[0]
    assert item["kind"] == "comment" and item["status"] == "open"
    assert item["anchor"] == ANCHOR and item["summary"] == "Cite it"
    assert item["raised_on_version"] == 1 and item["section_key"] == "goal-trace"
    assert await actions(ctx) == ["comment.create", "feedback.create"]


async def test_comment_validation(client, ctx):
    bad_section = await client.post(
        ctx.v(1, "/comments"),
        json={"section_key": "nope", "anchor": ANCHOR, "body": "x"},
        headers=ctx.headers,
    )
    assert bad_section.status_code == 422
    no_exact = await client.post(
        ctx.v(1, "/comments"),
        json={"section_key": "goal-trace", "anchor": {"exact": ""}, "body": "x"},
        headers=ctx.headers,
    )
    assert no_exact.status_code == 422
    missing_version = await client.post(
        ctx.v(9, "/comments"),
        json={"section_key": "goal-trace", "anchor": ANCHOR, "body": "x"},
        headers=ctx.headers,
    )
    assert missing_version.status_code == 404
    missing_doc = await client.get("/v1/documents/nope/versions/1/comments", headers=ctx.headers)
    assert missing_doc.status_code == 404


async def test_replies_and_resolve(client, ctx):
    top = await comment(client, ctx)
    reply = await client.post(
        f"/v1/comments/{top['id']}/replies", json={"body": "Added c1"}, headers=ctx.headers
    )
    assert reply.status_code == 201
    reply = reply.json()
    assert reply["parent_id"] == top["id"] and reply["anchor"] is None
    assert reply["section_key"] == "goal-trace"

    # A reply to a reply joins the same thread.
    nested = await client.post(
        f"/v1/comments/{reply['id']}/replies", json={"body": "Thanks"}, headers=ctx.headers
    )
    assert nested.json()["parent_id"] == top["id"]

    listed = (await client.get(ctx.v(1, "/comments"), headers=ctx.headers)).json()
    assert len(listed) == 1
    assert [r["body"] for r in listed[0]["replies"]] == ["Added c1", "Thanks"]

    # Replies do not open feedback items.
    assert len(await feedback(client, ctx)) == 1

    resolved = await client.patch(
        f"/v1/comments/{top['id']}", json={"resolved": True}, headers=ctx.headers
    )
    assert resolved.status_code == 200
    assert resolved.json()["resolved_at"] is not None
    assert len(resolved.json()["replies"]) == 2
    listed = (await client.get(ctx.v(1, "/comments"), headers=ctx.headers)).json()
    assert listed[0]["resolved_at"] is not None

    reopened = await client.patch(
        f"/v1/comments/{top['id']}", json={"resolved": False}, headers=ctx.headers
    )
    assert reopened.json()["resolved_at"] is None

    edited = await client.patch(
        f"/v1/comments/{top['id']}", json={"body": "Cite the thread"}, headers=ctx.headers
    )
    assert edited.json()["body"] == "Cite the thread"
    assert (await feedback(client, ctx))[0]["summary"] == "Cite the thread"

    reply_resolve = await client.patch(
        f"/v1/comments/{reply['id']}", json={"resolved": True}, headers=ctx.headers
    )
    assert reply_resolve.status_code == 422
    missing = await client.post(
        f"/v1/comments/{uuid.uuid4()}/replies", json={"body": "x"}, headers=ctx.headers
    )
    assert missing.status_code == 404

    assert await actions(ctx) == [
        "comment.create",
        "feedback.create",
        "comment.reply",
        "comment.reply",
        "comment.update",
        "comment.update",
        "comment.update",
    ]


# --- Verdicts ----------------------------------------------------------------------------


async def test_verdicts_create_and_supersede_feedback_items(client, ctx):
    approved = await verdict(client, ctx, "title", "approved")
    assert approved["feedback_item_id"] is None
    assert await feedback(client, ctx) == []

    first = await verdict(client, ctx, "s-5-2", "changes_requested", "Rank by installs")
    assert first["verdict"] == "changes_requested" and first["feedback_item_id"]
    items = await feedback(client, ctx)
    assert len(items) == 1
    assert items[0]["kind"] == "section_review" and items[0]["verdict"] == "changes_requested"
    assert items[0]["summary"] == "Changes requested: Rank by installs"
    assert items[0]["section_review_id"] == first["id"]

    second = await verdict(client, ctx, "s-5-2", "rejected", "Wrong approach")
    by_id = {i["id"]: i for i in await feedback(client, ctx)}
    assert by_id[first["feedback_item_id"]]["status"] == "superseded"
    assert by_id[second["feedback_item_id"]]["status"] == "open"
    assert by_id[second["feedback_item_id"]]["verdict"] == "rejected"

    # Approving the section supersedes the open item and opens none.
    third = await verdict(client, ctx, "s-5-2", "approved")
    assert third["feedback_item_id"] is None
    assert {i["status"] for i in await feedback(client, ctx)} == {"superseded"}

    # History is kept; the latest verdict wins.
    async with tenant_session(ctx.tenant_id) as s:
        history = (
            await s.scalars(
                select(SectionReview.verdict)
                .where(SectionReview.section_key == "s-5-2")
                .order_by(SectionReview.created_at)
            )
        ).all()
        assert history == ["changes_requested", "rejected", "approved"]
        v1 = await s.scalar(select(DocumentVersion.id).where(DocumentVersion.number == 1))
        assert await locked_section_keys(s, v1) == {"title", "s-5-2"}
        doc = await s.get(Document, ctx.document_id)
        assert doc.status == "in_review"

    # Comment items are not touched by verdicts.
    c = await comment(client, ctx, key="s-5-2")
    await verdict(client, ctx, "s-5-2", "rejected")
    by_id = {i["id"]: i for i in await feedback(client, ctx)}
    assert by_id[c["feedback_item_id"]]["status"] == "open"

    acts = await actions(ctx)
    assert acts.count("section_review.create") == 5
    assert acts.count("feedback.supersede") == 2
    assert acts.count("feedback.create") == 4  # 3 verdict items + 1 comment item


async def test_verdict_validation(client, ctx):
    bad = await client.put(
        ctx.v(1, "/sections/goal-trace/review"), json={"verdict": "meh"}, headers=ctx.headers
    )
    assert bad.status_code == 422
    unknown = await client.put(
        ctx.v(1, "/sections/nope/review"), json={"verdict": "approved"}, headers=ctx.headers
    )
    assert unknown.status_code == 422


async def test_later_version_verdict_supersedes_earlier_version_item(client, ctx):
    old = await verdict(client, ctx, "goal-trace", "rejected", "No")
    await add_version(ctx.tenant_id, ctx.document_id, 2)
    await verdict(client, ctx, "goal-trace", "approved", n=2)
    items = {i["id"]: i for i in await feedback(client, ctx)}
    assert items[old["feedback_item_id"]]["status"] == "superseded"


# --- Feedback list / patch ---------------------------------------------------------------


async def test_feedback_filters_by_status_and_version(client, ctx):
    c1 = await comment(client, ctx, body="v1 comment")
    r1 = await verdict(client, ctx, "s-5-2", "changes_requested", "fix")
    await add_version(ctx.tenant_id, ctx.document_id, 2)
    c2 = await comment(client, ctx, n=2, body="v2 comment")

    resp = await client.patch(
        f"/v1/feedback/{c1['feedback_item_id']}",
        json={"status": "addressed", "resolution_note": "done", "addressed_in_version": 2},
        headers=ctx.headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "addressed" and body["addressed_in_version"] == 2
    assert body["resolution_note"] == "done"

    def ids(items):
        return {i["id"] for i in items}

    assert ids(await feedback(client, ctx)) == {
        c1["feedback_item_id"],
        r1["feedback_item_id"],
        c2["feedback_item_id"],
    }
    assert ids(await feedback(client, ctx, version=1)) == {
        c1["feedback_item_id"],
        r1["feedback_item_id"],
    }
    assert ids(await feedback(client, ctx, version=2)) == {c2["feedback_item_id"]}
    assert ids(await feedback(client, ctx, status="open")) == {
        r1["feedback_item_id"],
        c2["feedback_item_id"],
    }
    assert ids(await feedback(client, ctx, status="addressed")) == {c1["feedback_item_id"]}
    assert ids(await feedback(client, ctx, status="open", version=2)) == {c2["feedback_item_id"]}
    assert await feedback(client, ctx, status="declined") == []
    bad = await client.get(
        f"/v1/documents/{ctx.slug}/feedback", params={"status": "nah"}, headers=ctx.headers
    )
    assert bad.status_code == 422


async def test_patch_feedback(client, ctx):
    c = await comment(client, ctx)
    url = f"/v1/feedback/{c['feedback_item_id']}"
    declined = await client.patch(
        url, json={"status": "declined", "addressed_in_version": 1}, headers=ctx.headers
    )
    assert declined.json()["status"] == "declined"
    # Only the given fields change.
    noted = await client.patch(url, json={"resolution_note": "out of scope"}, headers=ctx.headers)
    assert noted.json()["status"] == "declined"
    assert noted.json()["resolution_note"] == "out of scope"
    reopened = await client.patch(url, json={"status": "open"}, headers=ctx.headers)
    assert reopened.json()["status"] == "open"
    assert reopened.json()["addressed_in_version"] is None

    bad_version = await client.patch(url, json={"addressed_in_version": 7}, headers=ctx.headers)
    assert bad_version.status_code == 422
    missing = await client.patch(
        f"/v1/feedback/{uuid.uuid4()}", json={"status": "open"}, headers=ctx.headers
    )
    assert missing.status_code == 404
    assert (await actions(ctx)).count("feedback.update") == 3


# --- Feedback package / resolution report ------------------------------------------------


async def test_feedback_package(client, ctx):
    c = await comment(client, ctx)
    r = await verdict(client, ctx, "s-5-2", "rejected", "Redo")
    await verdict(client, ctx, "title", "approved")
    await verdict(client, ctx, "goal-trace", "approved")
    await verdict(client, ctx, "goal-trace", "changes_requested")  # latest wins: not locked
    closed = await comment(client, ctx, body="closed")
    await client.patch(
        f"/v1/feedback/{closed['feedback_item_id']}",
        json={"status": "declined"},
        headers=ctx.headers,
    )

    resp = await client.get(ctx.v(1, "/feedback-package"), headers=ctx.headers)
    assert resp.status_code == 200
    pkg = resp.json()
    assert pkg["document_id"] == str(ctx.document_id)
    assert pkg["slug"] == ctx.slug and pkg["title"] == "Checkout redesign PRD"
    assert pkg["version"] == 1
    assert pkg["markdown"].startswith("---\ndocument: checkout-redesign")
    assert "{#goal-trace}" in pkg["markdown"]
    assert pkg["locked_section_keys"] == ["title"]
    open_ids = {i["id"] for i in pkg["open_items"]}
    assert c["feedback_item_id"] in open_ids and r["feedback_item_id"] in open_ids
    assert closed["feedback_item_id"] not in open_ids
    assert {i["status"] for i in pkg["open_items"]} == {"open"}
    assert len(pkg["open_items"]) == 3  # comment, s-5-2 rejection, goal-trace changes
    anchored = next(i for i in pkg["open_items"] if i["id"] == c["feedback_item_id"])
    assert anchored["anchor"] == ANCHOR

    missing = await client.get(ctx.v(5, "/feedback-package"), headers=ctx.headers)
    assert missing.status_code == 404


async def test_resolution_report_lists_earlier_items_with_outcome(client, ctx):
    c = await comment(client, ctx)
    r = await verdict(client, ctx, "s-5-2", "changes_requested", "Rank by installs")
    sup = await verdict(client, ctx, "goal-trace", "rejected")
    await verdict(client, ctx, "goal-trace", "changes_requested", "smaller")
    v2 = await add_version(ctx.tenant_id, ctx.document_id, 2)

    # Lane 1 calls apply_resolutions on import of v2.
    async with tenant_session(ctx.tenant_id) as s:
        updated = await apply_resolutions(
            s,
            ctx.document_id,
            v2,
            [
                Resolution(feedback_id=c["feedback_item_id"], status="addressed", note="cited"),
                Resolution(feedback_id=r["feedback_item_id"], status="declined", note="no data"),
            ],
        )
        assert {i.id for i in updated} == {
            uuid.UUID(c["feedback_item_id"]),
            uuid.UUID(r["feedback_item_id"]),
        }
        await s.commit()
    later = await comment(client, ctx, n=2, body="raised on v2")

    resp = await client.get(ctx.v(2, "/resolution-report"), headers=ctx.headers)
    assert resp.status_code == 200
    report = resp.json()
    assert report["version"] == 2
    items = {i["id"]: i for i in report["items"]}
    assert later["feedback_item_id"] not in items  # raised on v2, not earlier
    assert len(items) == 4
    assert items[c["feedback_item_id"]]["status"] == "addressed"
    assert items[c["feedback_item_id"]]["addressed_in_version"] == 2
    assert items[c["feedback_item_id"]]["resolution_note"] == "cited"
    assert items[r["feedback_item_id"]]["status"] == "declined"
    assert items[sup["feedback_item_id"]]["status"] == "superseded"
    assert report["counts"] == {"open": 1, "addressed": 1, "declined": 1, "superseded": 1}

    v1_report = (await client.get(ctx.v(1, "/resolution-report"), headers=ctx.headers)).json()
    assert v1_report["items"] == []
    assert v1_report["counts"] == {"open": 0, "addressed": 0, "declined": 0, "superseded": 0}

    async with tenant_session(ctx.tenant_id) as s:
        events = (
            await s.scalars(select(AuditEvent).where(AuditEvent.action == "feedback.resolve"))
        ).all()
        assert len(events) == 2 and {e.actor for e in events} == {"system"}


async def test_apply_resolutions_rejects_unknown_ids_without_changes(ctx):
    async with tenant_session(ctx.tenant_id) as s:
        v1 = await s.scalar(select(DocumentVersion.id))
        comment_row = Comment(version_id=v1, section_key="goal-trace", body="x")
        s.add(comment_row)
        await s.flush()
        item = FeedbackItem(
            document_id=ctx.document_id,
            raised_on_version=1,
            kind="comment",
            comment_id=comment_row.id,
            summary="x",
        )
        s.add(item)
        # An item on another document counts as unknown too.
        other = Document(slug="other", title="Other")
        s.add(other)
        await s.flush()
        foreign = FeedbackItem(
            document_id=other.id, raised_on_version=1, kind="general", summary="y"
        )
        s.add(foreign)
        await s.commit()
        unknown = uuid.uuid4()
        with pytest.raises(UnknownFeedbackItemsError) as exc:
            await apply_resolutions(
                s,
                ctx.document_id,
                v1,
                [
                    Resolution(feedback_id=item.id, status="addressed"),
                    Resolution(feedback_id=unknown, status="addressed"),
                    Resolution(feedback_id=foreign.id, status="declined"),
                ],
            )
        assert exc.value.feedback_ids == [unknown, foreign.id]
        await s.refresh(item)
        assert item.status == "open" and item.addressed_in_version is None
        assert await apply_resolutions(s, ctx.document_id, v1, []) == []


# --- Approve -----------------------------------------------------------------------------


async def test_approve_sets_document_status(client, ctx):
    await add_version(ctx.tenant_id, ctx.document_id, 2)
    resp = await client.post(ctx.v(2, "/approve"), headers=ctx.headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["document_id"] == str(ctx.document_id)
    assert body["document_status"] == "approved"
    assert body["version"]["number"] == 2 and body["version"]["approved_at"]

    async with tenant_session(ctx.tenant_id) as s:
        doc = await s.get(Document, ctx.document_id)
        assert doc.status == "approved"
        versions = {
            v.number: v.approved_at for v in (await s.scalars(select(DocumentVersion))).all()
        }
        assert versions[1] is None and versions[2] is not None

    # Idempotent: approved_at is kept.
    again = (await client.post(ctx.v(2, "/approve"), headers=ctx.headers)).json()
    assert again["version"]["approved_at"] == body["version"]["approved_at"]
    assert (await actions(ctx)).count("version.approve") == 2
    assert (await client.post(ctx.v(3, "/approve"), headers=ctx.headers)).status_code == 404


async def test_other_tenant_cannot_see_review_data(client, ctx):
    c = await comment(client, ctx)
    async with tenant_session(await make_tenant("Other Co")) as s:
        _, raw = await create_api_token(s, "other")
        await s.commit()
    h = {"Authorization": f"Bearer {raw}"}
    assert (await client.get(ctx.v(1, "/comments"), headers=h)).status_code == 404
    reply = await client.post(f"/v1/comments/{c['id']}/replies", json={"body": "x"}, headers=h)
    assert reply.status_code == 404
    patch = await client.patch(
        f"/v1/feedback/{c['feedback_item_id']}", json={"status": "declined"}, headers=h
    )
    assert patch.status_code == 404
