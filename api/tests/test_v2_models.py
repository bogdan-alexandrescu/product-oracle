"""The v2 tables: constraints that protect invariants, optimistic concurrency, company
scoping, and the review-correctness columns."""

import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from oracle.baseline.models import Edge, Entity
from oracle.docs.models import Document, DocumentVersion
from oracle.review.models import SectionReview
from oracle.tenancy import TenantMismatchError, tenant_session
from oracle.v2 import models as m
from oracle.v2.concurrency import (
    StaleDataError,
    VersionConflict,
    expect_version,
    flush_or_conflict,
)
from tests.baseline_helpers import make_ctx
from tests.conftest import make_tenant
from tests.v2_helpers import seed_v2


async def _refused(tenant_id: uuid.UUID, row, constraint: str) -> None:
    async with tenant_session(tenant_id) as s:
        s.add(row)
        with pytest.raises(IntegrityError, match=constraint):
            await s.flush()


async def test_invariants_are_enforced_by_the_database(tenant_id):
    seeded = await seed_v2(tenant_id)
    doc, blocker = seeded.document_id, seeded.blocker_id
    # §6: a non-compliant option can never be the selected one.
    await _refused(
        tenant_id,
        m.BlockerOption(
            blocker_id=blocker, title="x", approach="distribution", status="selected",
            compliance="non_compliant",
        ),
        "ck_blocker_options_compliant",
    )  # fmt: skip
    # §5 statuses and categories only.
    await _refused(
        tenant_id,
        m.KnowledgeGap(document_id=doc, category="customer_user", statement="x",
                       importance="high", status="maybe"),
        "ck_knowledge_gaps_status",
    )  # fmt: skip
    await _refused(
        tenant_id,
        m.KnowledgeGap(document_id=doc, category="customer_user", statement="x",
                       importance="high", impact=["vibes"]),
        "ck_knowledge_gaps_impact",
    )  # fmt: skip
    # A gap belongs to an intake or a document.
    await _refused(
        tenant_id,
        m.KnowledgeGap(category="customer_user", statement="x", importance="high"),
        "ck_knowledge_gaps_subject",
    )
    # Module releases are semver.
    await _refused(
        tenant_id,
        m.ModuleVersion(
            module_id=seeded.ids["module_definitions"], version="v2", contract={},
            contract_hash="h",
        ),
        "ck_module_versions_semver",
    )  # fmt: skip
    # A section link points at something.
    await _refused(
        tenant_id,
        m.DocumentSectionLink(document_id=doc, section_key="goal-trace", kind="claims"),
        "ck_document_section_links_target",
    )
    # A dependency has exactly one downstream.
    await _refused(
        tenant_id,
        m.ArtifactDependency(
            artifact_version_id=seeded.ids["artifact_versions"],
            document_version_id=seeded.version_id,
            upstream_entity_id=seeded.requirement_id,
        ),
        "ck_artifact_dependencies_downstream",
    )
    await _refused(
        tenant_id,
        m.ArtifactDependency(
            artifact_version_id=seeded.ids["artifact_versions"], freshness="stale"
        ),
        "ck_artifact_dependencies_freshness",
    )
    # One composition per document; revision numbers are unique per composition.
    await _refused(tenant_id, m.DocumentComposition(document_id=doc), "uq_document_compositions")
    await _refused(
        tenant_id,
        m.CompositionRevision(composition_id=seeded.ids["document_compositions"], number=1),
        "uq_composition_revisions",
    )


async def test_optimistic_concurrency_refuses_a_lost_update(tenant_id):
    seeded = await seed_v2(tenant_id)
    gap_id = seeded.ids["knowledge_gaps"]
    async with tenant_session(tenant_id) as a, tenant_session(tenant_id) as b:
        gap_a = await a.get(m.KnowledgeGap, gap_id)
        gap_b = await b.get(m.KnowledgeGap, gap_id)
        assert gap_a.lock_version == gap_b.lock_version == 1
        expect_version(gap_a, 1)
        gap_a.status = "asked"
        await a.commit()
        assert gap_a.lock_version == 2
        # B loaded version 1 and lost the race: no silent last-write-wins.
        gap_b.status = "deferred"
        with pytest.raises(VersionConflict) as exc:
            await flush_or_conflict(b)
        assert exc.value.status_code == 409
        assert isinstance(exc.value.__cause__, StaleDataError)
    async with tenant_session(tenant_id) as s:
        gap = await s.get(m.KnowledgeGap, gap_id)
        assert (gap.status, gap.lock_version) == ("asked", 2)
        with pytest.raises(VersionConflict):
            expect_version(gap, 1)


async def test_every_editable_table_is_versioned():
    editable = [
        cls
        for cls in vars(m).values()
        if isinstance(cls, type) and hasattr(cls, "__table__") and "lock_version" in cls.__table__.c
    ]
    assert len(editable) == 7
    for cls in editable:
        assert cls.__mapper__.version_id_col is cls.__table__.c.lock_version, cls


async def test_rows_are_company_scoped(tenant_id):
    seeded = await seed_v2(tenant_id)
    other = await make_tenant("Other Co")
    async with tenant_session(other) as s:
        for name, row_id in seeded.ids.items():
            model = next(
                c for c in vars(m).values()
                if isinstance(c, type) and getattr(c, "__tablename__", None) == name
            )  # fmt: skip
            assert await s.get(model, row_id) is None, name
        # And cannot attach rows to the other company.
        s.add(m.ChangeEvent(tenant_id=tenant_id, subject_kind="decision", cause="x", actor="x"))
        with pytest.raises(TenantMismatchError):
            await s.flush()


async def test_deleting_a_document_cascades_its_v2_rows(tenant_id):
    seeded = await seed_v2(tenant_id)
    async with tenant_session(tenant_id) as s:
        await s.delete(await s.get(Document, seeded.document_id))
        await s.commit()
        for model in (
            m.DocumentComposition, m.CompositionRevision, m.DocumentSectionLink,
            m.EvaluationReport, m.EvaluationFinding, m.ArtifactRequest, m.ArtifactVersion,
            m.ArtifactOutput, m.AssumptionDecision,
        ):  # fmt: skip
            assert await s.scalar(select(func.count()).select_from(model)) == 0, model
        # The intake outlives its document; the change log keeps the event.
        intake = await s.get(m.ProductIntake, seeded.ids["product_intakes"])
        assert intake.document_id is None
        change = await s.get(m.ChangeEvent, seeded.ids["change_events"])
        assert change.document_id is None


async def test_the_baseline_graph_carries_the_trace_types(client):
    """§7: outcome, acceptance criteria, assumptions and risks live in the one graph."""
    ctx = await make_ctx()
    h = ctx.as_("owner")
    ids = {}
    for type_, key in [
        ("requirement", "saved-addresses"),
        ("outcome", "faster-repeat-checkout"),
        ("acceptance_criterion", "address-prefilled"),
        ("assumption", "buyers-reuse-addresses"),
        ("risk", "stale-address-data"),
    ]:
        resp = await client.post(
            "/v1/baseline/entities", json={"type": type_, "key": key, "title": key}, headers=h
        )
        assert resp.status_code == 201, resp.text
        ids[type_] = resp.json()["entity"]["id"]
    for src, dst, type_ in [
        ("requirement", "outcome", "derived_from"),
        ("acceptance_criterion", "requirement", "verifies"),
        ("assumption", "requirement", "affects"),
        ("requirement", "risk", "mitigates"),
    ]:
        resp = await client.post(
            "/v1/baseline/edges",
            json={"src_id": ids[src], "dst_id": ids[dst], "type": type_},
            headers=h,
        )
        assert resp.status_code == 201, resp.text
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.scalar(select(func.count()).select_from(Edge)) == 4
        assert await s.scalar(select(func.count()).select_from(Entity)) == 5


async def test_verdicts_record_the_section_hash_and_approval_the_approver(client):
    ctx = await make_ctx()
    seeded = await seed_v2(ctx.tenant_id)
    h = ctx.as_("approver")
    base = "/v1/documents/checkout-redesign/versions/1"
    resp = await client.put(
        f"{base}/sections/goal-trace/review", json={"verdict": "approved"}, headers=h
    )
    assert resp.status_code == 200, resp.text
    assert (await client.post(f"{base}/approve", headers=h)).status_code == 200
    async with tenant_session(ctx.tenant_id) as s:
        review = await s.scalar(select(SectionReview))
        # The review revision: the section's revision and its section link.
        from oracle.review.state import review_revisions

        bound = await review_revisions(
            s, seeded.document_id, seeded.version_id, {"goal-trace": seeded.section_hash}
        )
        assert review.section_hash == bound["goal-trace"] != seeded.section_hash
        version = await s.get(DocumentVersion, seeded.version_id)
        assert version.approved_by == ctx.users["approver"].id
        assert version.base_number is None
