"""POST /v1/documents/{doc}/versions and the version reads, against Postgres."""

import uuid

from sqlalchemy import func, select

from oracle.auth.service import create_api_token
from oracle.baseline.models import Entity
from oracle.docs.models import Citation, Document, DocumentVersion, Section
from oracle.models import AuditEvent
from oracle.review.models import FeedbackItem, SectionReview
from oracle.tenancy import tenant_session
from tests.conftest import make_tenant
from tests.fixtures import (
    FEEDBACK_GUEST,
    FEEDBACK_SHIPPING,
    MARKDOWN,
    draft,
    import_draft,
    seed_auth,
    seed_oracle_refs,
)
from tests.test_parser import V1_KEYS

DOC = "/v1/documents/checkout-redesign"


async def _add_feedback(tenant_id: uuid.UUID, document_id: uuid.UUID) -> None:
    async with tenant_session(tenant_id) as s:
        s.add_all(
            [
                FeedbackItem(
                    id=FEEDBACK_SHIPPING,
                    document_id=document_id,
                    raised_on_version=1,
                    kind="section_review",
                    section_key="s-5-2",
                    summary="Shipping cost needs an address; how is it shown early?",
                ),
                FeedbackItem(
                    id=FEEDBACK_GUEST,
                    document_id=document_id,
                    raised_on_version=1,
                    kind="comment",
                    section_key="open-questions",
                    summary="Decide on guest checkout",
                ),
            ]
        )
        await s.commit()


async def _review(tenant_id, version_id, section_key, verdict) -> None:
    # One commit per verdict so created_at orders them.
    async with tenant_session(tenant_id) as s:
        s.add(SectionReview(version_id=version_id, section_key=section_key, verdict=verdict))
        await s.commit()


async def test_import_v1_persists_document_sections_and_citations(client):
    tenant_id, auth = await seed_auth()
    resp = await import_draft(client, auth, draft("prd_v1.md"))
    assert resp.status_code == 201, resp.text
    v = resp.json()
    assert v["number"] == 1
    assert v["warnings"] == []
    assert v["snapshot"] == "2026-10-16T14:00Z"
    assert v["imported_by"] is not None
    assert [s["section_key"] for s in v["sections"]] == V1_KEYS
    assert sorted(c["cite_key"] for c in v["citations"]) == ["c1", "c2", "c3", "c4"]
    c1 = next(c for c in v["citations"] if c["cite_key"] == "c1")
    assert c1["source"] == "slack"
    assert c1["excerpt"] == "Most users abandon at the shipping step"
    assert c1["retrieved_at"].startswith("2026-10-16T13:10:00")
    assert v["front_matter"]["template"] == "oracle-default"

    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document))
        assert (doc.slug, doc.title, doc.status) == (
            "checkout-redesign",
            "Checkout redesign PRD",
            "draft",
        )
        assert (doc.template, doc.template_version) == ("oracle-default", "1")
        assert await s.scalar(select(func.count()).select_from(Section)) == len(V1_KEYS)
        assert await s.scalar(select(func.count()).select_from(Citation)) == 4
        problem = await s.scalar(select(Section).where(Section.section_key == "problem"))
        assert problem.citation_keys == ["c2", "c3"]
        assert problem.level == 2 and problem.ordinal == 3
        # E1 queues the draft's roadmap in the same import, so the import's own event is read.
        event = await s.scalar(
            select(AuditEvent).where(AuditEvent.action == "document.version_imported")
        )
        assert event is not None and event.data["number"] == 1


async def test_a_draft_citing_the_oracle_baseline_imports(client):
    # source 'oracle': the citation's ref is free text naming the baseline item, kept as is.
    tenant_id, auth = await seed_auth()
    await seed_oracle_refs(tenant_id)
    resp = await import_draft(client, auth, draft("prd_oracle_citations.md"), doc="example-prd")
    assert resp.status_code == 201, resp.text
    by_key = {c["cite_key"]: c for c in resp.json()["citations"]}
    assert {k: c["source"] for k, c in by_key.items()} == {
        "o-g1": "oracle",
        "o-d-ship": "oracle",
        "c1": "slack",
    }
    assert by_key["o-g1"]["ref"] == "baseline goal g1 (activation), locked"
    async with tenant_session(tenant_id) as s:
        stored = sorted(await s.scalars(select(Citation.source)))
    assert stored == ["oracle", "oracle", "slack"]


async def test_an_oracle_citation_naming_no_baseline_item_is_refused(client):
    # Every citation counts in the quality criteria: an oracle ref must name a baseline
    # item this company has ("baseline <kind> <key>"), else the citation is invalid.
    tenant_id, auth = await seed_auth()
    await seed_oracle_refs(tenant_id)
    text = draft("prd_oracle_citations.md").replace(
        "baseline goal g1 (activation)", "baseline goal g9 (activation)"
    )
    resp = await import_draft(client, auth, text, doc="example-prd")
    assert resp.status_code == 422, resp.text
    (problem,) = resp.json()["errors"]
    assert problem["code"] == "invalid_citation" and problem["cite_key"] == "o-g1"
    assert problem["message"] == (
        "citation #1 (o-g1) is invalid: ref names no baseline item of this company"
    )
    # Not a baseline ref at all, and another company's item: refused alike.
    other = await make_tenant("Other Co")
    async with tenant_session(other) as s:
        s.add(Entity(type="risk", key="only-there", title="R", status="confirmed", origin="user"))
        await s.commit()
    for ref in ("the activation goal", "baseline goal", "baseline risk only-there"):
        named = "baseline goal g1 (activation), locked"
        text = draft("prd_oracle_citations.md").replace(named, ref)
        resp = await import_draft(client, auth, text, doc="example-prd")
        assert resp.status_code == 422, resp.text
        assert [p["cite_key"] for p in resp.json()["errors"]] == ["o-g1"]
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Document)) == 0


async def test_reads_list_and_markdown(client):
    _, auth = await seed_auth()
    text = draft("prd_v1.md")
    created = (await import_draft(client, auth, text)).json()

    docs = (await client.get("/v1/documents", headers=auth)).json()
    assert [(d["slug"], d["latest_version"]) for d in docs] == [("checkout-redesign", 1)]

    by_slug = (await client.get(DOC, headers=auth)).json()
    by_id = (await client.get(f"/v1/documents/{created['document_id']}", headers=auth)).json()
    assert by_slug == by_id
    assert [v["number"] for v in by_slug["versions"]] == [1]

    versions = (await client.get(f"{DOC}/versions", headers=auth)).json()
    assert [v["id"] for v in versions] == [created["id"]]

    read = (await client.get(f"{DOC}/versions/1", headers=auth)).json()
    assert read == created

    md = await client.get(f"{DOC}/versions/1/markdown", headers=auth)
    assert md.status_code == 200
    assert md.headers["content-type"].startswith("text/markdown")
    assert md.text == text

    for path in (f"{DOC}/versions/2", f"{DOC}/versions/2/markdown", "/v1/documents/nope"):
        assert (await client.get(path, headers=auth)).status_code == 404


async def test_missing_ids_and_unknown_citations_are_422_naming_each(client):
    tenant_id, auth = await seed_auth()
    bad = (
        draft("prd_v1.md")
        .replace("## 3. Users {#users}", "## 3. Users")
        .replace("### 5.1 Payment step {#s-5-1}", "### 5.1 Payment step")
        .replace("[c:c2]", "[c:c9]")
        .replace("[c:c4]", "[c:nowhere]")
    )
    resp = await import_draft(client, auth, bad)
    assert resp.status_code == 422
    body = resp.json()
    assert body["detail"].startswith("draft rejected")
    errors = {(e["code"], e.get("cite_key"), e.get("section_key")) for e in body["errors"]}
    assert (
        errors
        == {
            ("missing_section_id", None, None),
            ("unknown_citation", "c9", "problem"),
            ("unknown_citation", "nowhere", "s-5-2"),
        }
        and len(body["errors"]) == 4
    )
    messages = " ".join(e["message"] for e in body["errors"])
    assert "3. Users" in messages and "5.1 Payment step" in messages

    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Document)) == 0


async def test_reimport_same_content_returns_existing_version(client):
    tenant_id, auth = await seed_auth()
    first = await import_draft(client, auth, draft("prd_v1.md"))
    again = await import_draft(client, auth, draft("prd_v1.md").replace("\n", "\r\n"))
    assert first.status_code == 201
    assert again.status_code == 200
    assert again.json() == first.json()
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(DocumentVersion)) == 1


async def test_v2_applies_resolutions_and_warns_on_changed_locked_section(client):
    tenant_id, auth = await seed_auth()
    v1 = (await import_draft(client, auth, draft("prd_v1.md"))).json()
    await _add_feedback(tenant_id, uuid.UUID(v1["document_id"]))
    # goal-trace approved (changes in v2), problem approved (unchanged in v2),
    # s-5-2 approved then changes requested (latest wins: not locked).
    await _review(tenant_id, uuid.UUID(v1["id"]), "goal-trace", "approved")
    await _review(tenant_id, uuid.UUID(v1["id"]), "problem", "approved")
    await _review(tenant_id, uuid.UUID(v1["id"]), "s-5-2", "approved")
    await _review(tenant_id, uuid.UUID(v1["id"]), "s-5-2", "changes_requested")

    resp = await import_draft(client, auth, draft("prd_v2.md"))
    assert resp.status_code == 201, resp.text
    v2 = resp.json()
    assert v2["number"] == 2
    assert [(w["code"], w["section_keys"]) for w in v2["warnings"]] == [
        ("locked_section_changed", ["goal-trace"])
    ]
    assert "rollout" in [s["section_key"] for s in v2["sections"]]

    async with tenant_session(tenant_id) as s:
        items = {i.id: i for i in await s.scalars(select(FeedbackItem))}
    assert items[FEEDBACK_SHIPPING].status == "addressed"
    assert items[FEEDBACK_SHIPPING].addressed_in_version == 2
    assert items[FEEDBACK_SHIPPING].resolution_note.startswith("Shipping estimate")
    assert items[FEEDBACK_GUEST].status == "declined"
    assert items[FEEDBACK_GUEST].addressed_in_version == 2

    # The warning is stored on the version and the v1 verdicts show up on v1.
    listed = (await client.get(f"{DOC}/versions", headers=auth)).json()
    assert listed[1]["warnings"][0]["section_keys"] == ["goal-trace"]
    v1_read = (await client.get(f"{DOC}/versions/1", headers=auth)).json()
    verdicts = {s["section_key"]: (s["verdict"] or {}).get("verdict") for s in v1_read["sections"]}
    assert verdicts["goal-trace"] == "approved"
    assert verdicts["s-5-2"] == "changes_requested"
    assert verdicts["users"] is None


async def test_removed_locked_section_is_reported(client):
    tenant_id, auth = await seed_auth()
    v1 = (await import_draft(client, auth, draft("prd_v1.md"))).json()
    await _review(tenant_id, uuid.UUID(v1["id"]), "open-questions", "approved")
    await _add_feedback(tenant_id, uuid.UUID(v1["document_id"]))
    v2 = (await import_draft(client, auth, draft("prd_v2.md"))).json()
    assert v2["warnings"][0]["section_keys"] == ["open-questions"]


async def test_unknown_resolution_ids_reject_the_import(client):
    tenant_id, auth = await seed_auth()
    await import_draft(client, auth, draft("prd_v1.md"))
    resp = await import_draft(client, auth, draft("prd_v2.md"))  # no feedback items exist
    assert resp.status_code == 422
    errors = resp.json()["errors"]
    assert [e["code"] for e in errors] == ["unknown_feedback_item"] * 2
    assert str(FEEDBACK_SHIPPING) in errors[0]["message"]
    assert str(FEEDBACK_GUEST) in errors[1]["message"]
    async with tenant_session(tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(DocumentVersion)) == 1


async def test_front_matter_document_must_match_target(client):
    _, auth = await seed_auth()
    resp = await import_draft(client, auth, draft("prd_v1.md"), doc="other-doc")
    assert resp.status_code == 422
    assert resp.json()["errors"][0]["code"] == "document_mismatch"

    created = (await import_draft(client, auth, draft("prd_v1.md"))).json()
    # Importing by document id works and dedupes the same way.
    again = await import_draft(client, auth, draft("prd_v1.md"), doc=created["document_id"])
    assert again.status_code == 200
    missing = await import_draft(client, auth, draft("prd_v1.md"), doc=str(uuid.uuid4()))
    assert missing.status_code == 404


async def test_import_into_approved_document_reopens_review(client):
    tenant_id, auth = await seed_auth()
    await import_draft(client, auth, draft("prd_v1.md"))
    async with tenant_session(tenant_id) as s:
        doc = await s.scalar(select(Document))
        doc.status = "approved"
        await s.commit()
    await _add_feedback(tenant_id, doc.id)
    await import_draft(client, auth, draft("prd_v2.md"))
    async with tenant_session(tenant_id) as s:
        assert (await s.scalar(select(Document))).status == "in_review"


async def test_documents_are_tenant_isolated(client):
    _, auth = await seed_auth()
    await import_draft(client, auth, draft("prd_v1.md"))
    other_tenant = await make_tenant("Other Co")
    async with tenant_session(other_tenant) as s:
        _, raw = await create_api_token(s, "other")
        await s.commit()
    other_auth = {"Authorization": f"Bearer {raw}"}
    assert (await client.get(DOC, headers=other_auth)).status_code == 404
    assert (await client.get("/v1/documents", headers=other_auth)).json() == []
    # Same slug in another tenant is a separate document.
    resp = await import_draft(client, other_auth, draft("prd_v1.md"))
    assert resp.status_code == 201 and resp.json()["number"] == 1


async def test_non_utf8_body_is_rejected(client):
    _, auth = await seed_auth()
    resp = await client.post(
        f"{DOC}/versions", content=b"\xff\xfe---", headers={**auth, **MARKDOWN}
    )
    assert resp.status_code == 422
    assert resp.json()["errors"][0]["code"] == "invalid_encoding"
