"""CR-06 publish gate and immutable publish (build prompt §9, §16.11 gate half, §16.17).

The publish transaction refuses missing required sections, stale mandatory approvals,
a critical hard readiness check (a critical unresolved blocker) and invalidated source
permissions; an advisory result never blocks (T2). A publication pins the approved
version, template and composition, the last approval and decider, the evidence
snapshot and the appendix, and later edits and source updates never change it."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError

from oracle import changes, readiness
from oracle.readiness import CheckOutcome
from oracle.review.models import DocumentPublication
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.v2.models import CompositionRevision, DocumentComposition, DocumentSectionLink
from tests.review_v2_helpers import (
    DOC,
    DRAFT,
    approve_all,
    edit,
    person,
    replace,
    setup,
    states,
    verdict,
)


@pytest.fixture(autouse=True)
def _only_test_checks():
    with readiness.isolated_checks():
        yield


def outcome(status: str, **kw):
    async def check(ctx):
        assert ctx.purpose == "publish"
        return CheckOutcome(status=status, rationale=f"dummy {status}", **kw)

    return check


async def approved(client, ctx, n: int = 1) -> None:
    assert (await client.post(ctx.v(n, "/approve"), headers=ctx.auth)).status_code == 200


async def check(client, ctx, n: int = 1) -> dict:
    resp = await client.get(ctx.v(n, "/publish-check"), headers=ctx.auth)
    assert resp.status_code == 200, resp.text
    return resp.json()


def codes(body: dict) -> list[str]:
    return [b["code"] for b in body["blockers"]]


async def test_an_unapproved_version_cannot_be_published(client):
    ctx = await setup(client)
    body = await check(client, ctx)
    assert body["can_publish"] is False and codes(body) == ["version_not_approved"]
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 409
    assert resp.json()["check"]["blockers"][0]["code"] == "version_not_approved"
    async with tenant_session(ctx.tenant_id) as s:
        assert (await s.scalars(select(DocumentPublication))).all() == []


async def test_missing_required_sections_block(client):
    templated = replace(
        DRAFT,
        "title: Team calendar PRD\n",
        'title: Team calendar PRD\ntemplate: oracle-default\ntemplate_version: "1"\n',
    )
    ctx = await setup(client, templated)
    await approved(client, ctx)
    body = await check(client, ctx)
    # oracle-default v1 requires title, goal-trace, problem, solution and metrics.
    assert body["required_sections"] == ["title", "goal-trace", "problem", "solution", "metrics"]
    [missing] = [b for b in body["blockers"] if b["code"] == "missing_required_section"]
    assert missing["section_keys"] == ["metrics"]
    # Required sections need an approval of their current revision.
    [unapproved] = [b for b in body["blockers"] if b["code"] == "missing_approval"]
    assert unapproved["section_keys"] == ["title", "goal-trace", "problem", "solution"]


async def test_stale_mandatory_approvals_block_and_current_ones_pass(client):
    ctx = await setup(client)
    resp = await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"required_section_keys": ["problem", "solution"]},
        headers=ctx.auth,
    )
    assert resp.status_code == 200
    for key in ("problem", "solution"):
        assert (await verdict(client, ctx.auth, 1, key)).status_code == 200
    s1 = await states(client, ctx.auth, 1)
    assert s1["problem"]["approval_required"] and not s1["risks"]["approval_required"]
    resp = await edit(client, ctx.auth, "problem", 1, s1["problem"]["revision"], "Edited.")
    assert resp.status_code == 201
    await approved(client, ctx, 2)
    body = await check(client, ctx, 2)
    assert codes(body) == ["stale_approval"]
    assert body["blockers"][0]["section_keys"] == ["problem"]
    # The decider approves the current revision: nothing blocks.
    assert (await verdict(client, ctx.auth, 2, "problem")).status_code == 200
    body = await check(client, ctx, 2)
    assert body["can_publish"] is True, body["blockers"]


async def test_a_critical_hard_check_blocks_and_an_advisory_one_never_does(client):
    """§16.11 (gate half): a critical unresolved blocker prevents publication; an
    ordinary advisory quality result alone does not silently block (T2)."""
    ctx = await setup(client)
    await approved(client, ctx)
    readiness.register_check("problem_clarity", outcome("critical"))  # advisory
    body = await check(client, ctx)
    assert body["can_publish"] is True
    assert [w["code"] for w in body["warnings"]] == ["readiness_warning"]
    assert [r["key"] for r in body["readiness"]] == ["problem_clarity"]

    readiness.register_check(
        "critical_blockers", outcome("critical", section_keys=["risks"]), hard=True
    )
    body = await check(client, ctx)
    assert codes(body) == ["readiness_critical"]
    assert body["blockers"][0]["check_key"] == "critical_blockers"
    assert body["blockers"][0]["section_keys"] == ["risks"]
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 409
    # Accepted risk / feasibility-only path: the blockers lane's check passes.
    readiness.register_check("critical_blockers", outcome("pass"), hard=True)
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 201, resp.text


async def _linked_item(ctx) -> tuple:
    owner = await person(ctx.tenant_id, "owner", "source-owner")
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=owner.user_id, kind="upload", name="Survey uploads")
        s.add(source)
        await s.flush()
        item = SourceItem(source_id=source.id, external_id="survey.md", kind="file")
        s.add(item)
        await s.flush()
        from oracle.docs.models import Document, DocumentVersion

        document = await s.scalar(select(Document).where(Document.slug == DOC))
        version = await s.scalar(
            select(DocumentVersion).where(DocumentVersion.document_id == document.id)
        )
        s.add(
            DocumentSectionLink(
                document_id=document.id,
                version_id=version.id,
                section_key="problem",
                kind="evidences",
                source_item_id=item.id,
            )
        )
        await s.commit()
        return source.id, item.id


async def test_invalidated_source_permissions_block(client):
    ctx = await setup(client)
    await approved(client, ctx)
    source_id, item_id = await _linked_item(ctx)
    assert (await check(client, ctx))["can_publish"] is True

    # A permission change recorded by another lane through oracle.changes.
    async with tenant_session(ctx.tenant_id) as s:
        await changes.record_change(
            s, "source_permission", cause="revoked", actor=None, subject_id=source_id
        )
        await s.commit()
    body = await check(client, ctx)
    assert codes(body) == ["source_permission_revoked"]
    assert body["blockers"][0]["section_keys"] == ["problem"]
    assert str(item_id) in body["blockers"][0]["ids"]

    async with tenant_session(ctx.tenant_id) as s:
        await changes.record_change(
            s, "source_permission", cause="restored", actor=None, subject_id=source_id
        )
        await s.commit()
    assert (await check(client, ctx))["can_publish"] is True

    # A deleted source item is revoked too.
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        item.deleted_at = item.created_at
        await s.commit()
    assert codes(await check(client, ctx)) == ["source_permission_revoked"]


async def test_publish_pins_everything_and_never_changes(client):
    """§16.17: publishing pins the approved revision, composition and evidence
    snapshot; later source updates or draft changes do not mutate it."""
    ctx = await setup(client)
    decider = await person(ctx.tenant_id, "approver", "decider")
    await client.put(
        f"/v1/documents/{DOC}/review-policy",
        json={"decider_id": str(decider.user_id), "section_approval": "all_sections"},
        headers=ctx.auth,
    )
    # The link is part of what the section approvals bind to (a link added after them
    # would leave them stale).
    _, item_id = await _linked_item(ctx)
    await approve_all(client, decider.headers, 1)
    assert (await client.post(ctx.v(1, "/approve"), headers=decider.headers)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.docs.models import Document

        document = await s.scalar(select(Document).where(Document.slug == DOC))
        composition = DocumentComposition(document_id=document.id, current_revision=1)
        s.add(composition)
        await s.flush()
        s.add(
            CompositionRevision(
                composition_id=composition.id,
                number=1,
                status="confirmed",
                modules=[
                    {
                        "key": "core.problem",
                        "version": "1.0.0",
                        "policy": "required",
                        "included": True,
                        "reason": "core",
                        "order": 1,
                        "section_ids": ["problem"],
                    }
                ],
            )
        )
        await s.commit()

    pre = await check(client, ctx)
    assert pre["can_publish"] is True, pre["blockers"]
    resp = await client.post(
        ctx.v(1, "/publish"), json={"content_hash": pre["content_hash"]}, headers=ctx.auth
    )
    assert resp.status_code == 201, resp.text
    pub = resp.json()
    assert pub["number"] == 1 and pub["version_number"] == 1
    manifest = pub["manifest"]
    assert manifest["approval"]["approved_by"] == str(decider.user_id)
    assert manifest["approval"]["decider_id"] == str(decider.user_id)
    assert manifest["composition"]["revision"] == 1
    assert manifest["composition"]["modules"][0]["section_ids"] == ["problem"]
    assert manifest["template"] is None
    assert [c["cite_key"] for c in manifest["evidence"]["citations"]] == ["c1"]
    assert manifest["evidence"]["citations"][0]["section_keys"] == ["goal-trace"]
    assert [link["source_item_id"] for link in manifest["evidence"]["section_links"]] == [
        str(item_id)
    ]
    assert manifest["appendix"]["section_keys"] == ["sources"]
    assert "Calendar survey" in manifest["appendix"]["markdown"]
    assert {s["status"] for s in manifest["sections"]} == {"approved"}
    assert all(s["approval"]["reviewer_id"] == str(decider.user_id) for s in manifest["sections"])

    html = (await client.get(f"/v1/documents/{DOC}/publications/1/export", headers=ctx.auth)).text
    md = (
        await client.get(f"/v1/documents/{DOC}/publications/1/export?format=md", headers=ctx.auth)
    ).text
    assert "Teams miss shared deadlines." in html
    assert md.startswith("---\n") and "Product Oracle publication 1" in md

    # Later: the draft changes, the source item changes and is revoked.
    s1 = await states(client, ctx.auth, 1)
    resp = await edit(client, ctx.auth, "problem", 1, s1["problem"]["revision"], "Rewritten.")
    assert resp.status_code == 201
    async with tenant_session(ctx.tenant_id) as s:
        item = await s.get(SourceItem, item_id)
        item.title = "Renamed survey"
        item.deleted_at = item.created_at
        await s.commit()

    again = (await client.get(f"/v1/documents/{DOC}/publications/1", headers=ctx.auth)).json()
    assert again == pub
    assert (
        await client.get(f"/v1/documents/{DOC}/publications/1/export", headers=ctx.auth)
    ).text == html
    listed = (await client.get(f"/v1/documents/{DOC}/publications", headers=ctx.auth)).json()
    assert [(p["number"], p["manifest_hash"]) for p in listed] == [(1, pub["manifest_hash"])]

    # The database refuses any update of a publication.
    async with tenant_session(ctx.tenant_id) as s:
        with pytest.raises(DBAPIError, match="immutable"):
            await s.execute(text("UPDATE document_publications SET markdown = 'x'"))
        await s.rollback()

    # Publishing the same version twice is refused.
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 409
    assert "already_published" in [b["code"] for b in resp.json()["check"]["blockers"]]


async def test_publish_refuses_a_content_hash_it_was_not_checked_with(client):
    ctx = await setup(client)
    await approved(client, ctx)
    resp = await client.post(ctx.v(1, "/publish"), json={"content_hash": "x"}, headers=ctx.auth)
    assert resp.status_code == 409 and "check again" in resp.json()["detail"]


async def test_brief_layers_are_pinned_when_the_version_has_them(client):
    briefed = replace(
        DRAFT, "title: Team calendar PRD\n", "title: Team calendar PRD\nbrief: [title, problem]\n"
    )
    ctx = await setup(client, briefed)
    await approved(client, ctx)
    resp = await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)
    assert resp.status_code == 201, resp.text
    assert resp.json()["has_brief"] is True
    brief = await client.get(
        f"/v1/documents/{DOC}/publications/1/export?layer=brief", headers=ctx.auth
    )
    assert brief.status_code == 200 and "Teams miss shared deadlines." in brief.text
    deck = await client.get(
        f"/v1/documents/{DOC}/publications/1/export?layer=deck", headers=ctx.auth
    )
    assert deck.status_code == 200
    bad = await client.get(
        f"/v1/documents/{DOC}/publications/1/export?layer=brief&format=md", headers=ctx.auth
    )
    assert bad.status_code == 422


async def test_warnings_never_block(client):
    ctx = await setup(client)
    await client.post(
        ctx.v(1, "/comments"),
        json={
            "section_key": "risks",
            "anchor": {"exact": "lag"},
            "body": "Name the lag",
            "severity": "major",
        },
        headers=ctx.auth,
    )
    await approved(client, ctx)
    body = await check(client, ctx)
    assert body["can_publish"] is True
    # A critical change request does block (T2; test_review_v2_security_2).
    assert "open_change_request" in [w["code"] for w in body["warnings"]]
    assert (await client.post(ctx.v(1, "/publish"), json={}, headers=ctx.auth)).status_code == 201


async def test_review_invariants_are_a_hard_readiness_check(client):
    """For the readiness dashboard: the review lane registers its invariants as a hard
    check; the publish check computes them itself."""
    from oracle.review import publish as review_publish

    readiness.register_check(
        review_publish.REVIEW_CHECK_KEY, review_publish._review_check, hard=True
    )
    ctx = await setup(client)
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.docs.models import Document

        document = await s.scalar(select(Document).where(Document.slug == DOC))
        report = await readiness.evaluate(readiness.ReadinessContext(s, document.id))
    [result] = report.results
    assert result.hard and result.status == "critical"
    body = await check(client, ctx)
    # Not counted twice in the publish check.
    assert [r["key"] for r in body["readiness"]] == []
    assert codes(body) == ["version_not_approved"]
