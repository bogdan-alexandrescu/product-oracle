"""Staleness (§7, §11.5): a change upstream marks downstream outputs potentially_stale,
with the causing change; approved outputs are never rewritten; review and reconcile are
recorded human actions. Downstream artifacts are stubs here (wave 2 builds real ones)."""

import uuid

from sqlalchemy import select

import oracle.main  # noqa: F401  (registers the lanes' change handlers)
from oracle import changes
from oracle.docs import service as docs_service
from oracle.docs.models import DocumentVersion
from oracle.models import AuditEvent
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx
from tests.trace_helpers import (
    DOC,
    PRD_V2,
    artifact_version,
    depend,
    dependency,
    import_md,
    link_section,
    prd_v1,
    section_hash,
    seed_chain,
    stub_artifact,
    version_row,
)

ACTIONS = "/v1/trace/staleness/actions"


def test_the_trace_handler_is_registered_for_every_upstream_subject():
    reg = {r.name: r for r in changes.handlers()}
    assert "trace.mark_stale" in reg
    subjects = reg["trace.mark_stale"].subjects
    for subject in (
        "document_section",
        "document_version",
        "requirement",
        "decision",
        "source_permission",
        "blocker_status",
        "composition_revision",
        "entity",
    ):
        assert subjects is None or subject in subjects


async def test_a_changed_section_marks_its_stub_artifact_stale_and_never_rewrites_it(client):
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    changed = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip
    unchanged = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id, section_key="metrics"
    )
    before = await artifact_version(ctx.tenant_id, spec)

    resp = await import_md(client, ctx.as_("approver"), PRD_V2)
    assert resp.status_code == 201, resp.text
    v2 = await version_row(ctx.tenant_id, 2)

    stale = await dependency(ctx.tenant_id, changed)
    assert stale.freshness == "potentially_stale"
    assert stale.stale_since is not None
    assert (await dependency(ctx.tenant_id, unchanged)).freshness == "fresh"
    async with tenant_session(ctx.tenant_id) as s:
        cause = await s.get(m.ChangeEvent, stale.caused_by_change_id)
        assert cause.subject_kind == "document_version"
        assert cause.subject_id == v2.id
        assert "trace.mark_stale" in cause.handled_by
        assert str(changed) in cause.data["trace"]["dependency_ids"]
        assert str(unchanged) not in cause.data["trace"]["dependency_ids"]
        marked = (
            await s.scalars(
                select(m.ArtifactReviewEvent).where(m.ArtifactReviewEvent.version_id == spec)
            )
        ).all()
        assert [e.kind for e in marked] == ["marked_stale"]
        assert "requirements" in marked[0].body
        output = await s.scalar(select(m.ArtifactOutput).where(m.ArtifactOutput.version_id == spec))
        assert output.content == "engineering_spec body"

    after = await artifact_version(ctx.tenant_id, spec)
    assert after.freshness == "potentially_stale"
    # Never rewritten: status, approval, content and provenance are as they were.
    for f in ("status", "approved_by", "approved_at", "content_hash", "summary", "provenance"):
        assert getattr(after, f) == getattr(before, f), f
    assert after.status == "approved"


async def test_an_import_of_the_same_content_marks_nothing(client):
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    dep = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip
    resp = await import_md(
        client, ctx.as_("approver"), (await version_row(ctx.tenant_id, 1)).markdown
    )
    assert resp.status_code == 200
    assert (await dependency(ctx.tenant_id, dep)).freshness == "fresh"


async def test_a_changed_requirement_marks_entity_and_section_dependencies(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["requirement"]
    )
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    _, tests_ = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="acceptance_tests")
    _, wire = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="wireframe")
    on_section = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip
    # Acceptance criteria verify the requirement: they are downstream of it.
    on_ac = await depend(ctx.tenant_id, artifact_version_id=tests_, entity_id=chain["ac"])
    unrelated = await depend(
        ctx.tenant_id, artifact_version_id=wire, upstream_version_id=v1.id, section_key="risks"
    )

    resp = await client.patch(
        f"/v1/baseline/entities/{chain['requirement']}",
        json={"title": "Save up to ten addresses", "origin": "user"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text

    for dep_id in (on_section, on_ac):
        dep = await dependency(ctx.tenant_id, dep_id)
        assert dep.freshness == "potentially_stale", dep_id
    assert (await dependency(ctx.tenant_id, unrelated)).freshness == "fresh"
    dep = await dependency(ctx.tenant_id, on_section)
    async with tenant_session(ctx.tenant_id) as s:
        cause = await s.get(m.ChangeEvent, dep.caused_by_change_id)
    assert cause.subject_kind == "requirement"
    assert cause.subject_id == chain["requirement"]
    assert cause.actor == f"user:{ctx.users['approver'].id}"


async def test_an_agent_write_to_a_locked_requirement_is_a_proposal_and_marks_nothing(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    dep = await depend(ctx.tenant_id, artifact_version_id=spec, entity_id=chain["requirement"])
    resp = await client.patch(
        f"/v1/baseline/entities/{chain['requirement']}",
        json={"title": "Agent rewrite", "origin": "agent"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 202, resp.text
    assert (await dependency(ctx.tenant_id, dep)).freshness == "fresh"


async def test_decision_blocker_status_and_composition_changes_mark_downstream(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "requirements", entity_id=chain["requirement"]
    )
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    _, proto = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="prototype")
    on_req = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip
    on_risks = await depend(
        ctx.tenant_id, artifact_version_id=proto, upstream_version_id=v1.id, section_key="risks"
    )

    async def record(kind, **kw):
        async with tenant_session(ctx.tenant_id) as s:
            event = await changes.record_change(s, kind, actor="system", **kw)
            await s.commit()
            return event

    async def reset(*deps):
        async with tenant_session(ctx.tenant_id) as s:
            for d in deps:
                (await s.get(m.ArtifactDependency, d)).freshness = "fresh"
            await s.commit()

    # A decision that affects the requirement.
    event = await record("decision", cause="decision_changed", subject_id=chain["decision"])
    assert (await dependency(ctx.tenant_id, on_req)).caused_by_change_id == event.id
    assert (await dependency(ctx.tenant_id, on_risks)).freshness == "fresh"
    await reset(on_req)

    # The blocker that blocks the requirement changes status.
    event = await record(
        "blocker_status", cause="blocker_resolved", subject_id=chain["blocker"],
        data={"from": "open", "to": "resolved"},
    )  # fmt: skip
    assert (await dependency(ctx.tenant_id, on_req)).caused_by_change_id == event.id
    await reset(on_req)

    # A composition revision that changes the module rendering "risks".
    async with tenant_session(ctx.tenant_id) as s:
        comp = m.DocumentComposition(document_id=v1.document_id, current_revision=2)
        s.add(comp)
        await s.flush()
        mod = {
            "key": "risks.privacy",
            "version": "1.0.0",
            "policy": "required",
            "included": True,
            "reason": "policy",
            "order": 1,
            "section_ids": ["risks"],
        }
        first = m.CompositionRevision(
            composition_id=comp.id, number=1, status="superseded", modules=[mod], inputs={}
        )
        second = m.CompositionRevision(
            composition_id=comp.id, number=2, status="confirmed", parent_number=1,
            modules=[{**mod, "version": "1.1.0"}], inputs={},
        )  # fmt: skip
        s.add_all([first, second])
        await s.commit()
    event = await record(
        "composition_revision", cause="composition_confirmed", subject_id=second.id,
        document_id=v1.document_id,
    )  # fmt: skip
    assert (await dependency(ctx.tenant_id, on_risks)).caused_by_change_id == event.id
    assert (await dependency(ctx.tenant_id, on_req)).freshness == "fresh"


async def test_a_source_permission_change_marks_sections_whose_evidence_came_from_it(client):
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    async with tenant_session(ctx.tenant_id) as s:
        source = Source(owner_user_id=ctx.users["owner"].id, kind="upload", name="interviews")
        s.add(source)
        await s.flush()
        item = SourceItem(source_id=source.id, external_id="i1", kind="file", title="Notes")
        s.add(item)
        await s.commit()
    await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "metrics", source_item_id=item.id, kind="evidences"
    )
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    dep = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id, section_key="metrics"
    )
    async with tenant_session(ctx.tenant_id) as s:
        event = await changes.record_change(
            s, "source_permission", cause="source_revoked", actor="system", subject_id=source.id
        )
        await s.commit()
    got = await dependency(ctx.tenant_id, dep)
    assert got.freshness == "potentially_stale"
    assert got.caused_by_change_id == event.id


async def test_review_and_reconcile_are_recorded_human_actions(client):
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    dep = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip
    await import_md(client, ctx.as_("approver"), PRD_V2)
    v2 = await version_row(ctx.tenant_id, 2)
    body = {"action": "review", "artifact_version_id": str(spec)}

    # Commenters and viewers may not decide; approvers may.
    for who in ("viewer", "commenter"):
        assert (await client.post(ACTIONS, json=body, headers=ctx.as_(who))).status_code == 403
    resp = await client.post(ACTIONS, json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["freshness"] == "under_review"
    assert (await dependency(ctx.tenant_id, dep)).freshness == "under_review"

    # Reconciling needs a reason.
    missing = {"action": "reconcile", "artifact_version_id": str(spec)}
    assert (
        await client.post(ACTIONS, json=missing, headers=ctx.as_("approver"))
    ).status_code == 422
    resp = await client.post(
        ACTIONS, json={**missing, "reason": "The ten-address limit does not change the spec"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["freshness"] == "reconciled"
    got = await dependency(ctx.tenant_id, dep)
    assert got.freshness == "reconciled"
    assert got.reconciled_by == ctx.users["approver"].id
    # Re-anchored on the version it was confirmed against.
    assert got.upstream_version_id == v2.id
    assert got.upstream_section_hash == await section_hash(ctx.tenant_id, v2.id, "requirements")
    av = await artifact_version(ctx.tenant_id, spec)
    assert av.freshness == "reconciled" and av.status == "approved"

    async with tenant_session(ctx.tenant_id) as s:
        actions = (
            await s.scalars(
                select(AuditEvent.action)
                .where(AuditEvent.action.like("trace.staleness.%"))
                .order_by(AuditEvent.created_at)
            )
        ).all()
        kinds = (
            await s.scalars(
                select(m.ArtifactReviewEvent.kind)
                .where(m.ArtifactReviewEvent.version_id == spec)
                .order_by(m.ArtifactReviewEvent.created_at)
            )
        ).all()
    assert actions == ["trace.staleness.review", "trace.staleness.reconcile"]
    assert kinds == ["marked_stale", "comment", "reconciled"]

    # Nothing left to reconcile: 409.
    again = await client.post(
        ACTIONS, json={**missing, "reason": "again"}, headers=ctx.as_("approver")
    )
    assert again.status_code == 409

    # A later change makes it potentially stale again.
    v3 = PRD_V2.replace("name them", "label them")
    assert (await import_md(client, ctx.as_("approver"), v3)).status_code == 201
    assert (await dependency(ctx.tenant_id, dep)).freshness == "potentially_stale"


async def test_staleness_actions_are_company_scoped(client):
    a = await make_ctx("Company A")
    b = await make_ctx("Company B")
    v1 = await prd_v1(client, b)
    _, theirs = await stub_artifact(b.tenant_id, v1.document_id, v1.id)
    await depend(b.tenant_id, artifact_version_id=theirs, upstream_version_id=v1.id)
    for body in (
        {"action": "review", "artifact_version_id": str(theirs)},
        {"action": "review", "document_version_id": str(v1.id)},
        {"action": "review", "artifact_version_id": str(uuid.uuid4())},
    ):
        resp = await client.post(ACTIONS, json=body, headers=a.as_("owner"))
        assert resp.status_code == 404, body
    listed = (await client.get("/v1/trace/staleness", headers=a.as_("owner"))).json()
    assert listed == []


async def test_a_roadmap_built_from_the_prd_goes_stale_when_a_linked_section_changes(client):
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    roadmap_md = f"""---
document: saved-addresses-roadmap
title: Saved addresses roadmap
kind: roadmap
---

# Saved addresses roadmap {{#title}}

## Now {{#now}}

### Saved addresses {{#item-saved}}

From [the requirements](/documents/{DOC}/v/1#requirements).

### Faster checkout {{#item-metrics}}

From [the metrics](/documents/{DOC}/v/1#metrics).
"""
    async with tenant_session(ctx.tenant_id) as s:
        from oracle.auth.deps import Principal

        principal = Principal(
            tenant_id=ctx.tenant_id, kind="user", role="approver",
            user_id=ctx.users["approver"].id,
        )  # fmt: skip
        result = await docs_service.import_draft(
            s, "saved-addresses-roadmap", roadmap_md, principal, kind="roadmap",
            source_version_id=v1.id,
        )  # fmt: skip
    roadmap_version = result.version.id
    async with tenant_session(ctx.tenant_id) as s:
        deps = (
            await s.scalars(
                select(m.ArtifactDependency).where(
                    m.ArtifactDependency.document_version_id == roadmap_version
                )
            )
        ).all()
        markdown_before = (await s.get(DocumentVersion, roadmap_version)).markdown
    assert sorted(d.upstream_section_key for d in deps) == ["metrics", "requirements"]
    assert all(d.freshness == "fresh" for d in deps)

    assert (await import_md(client, ctx.as_("approver"), PRD_V2)).status_code == 201
    async with tenant_session(ctx.tenant_id) as s:
        deps = {
            d.upstream_section_key: d.freshness
            for d in (
                await s.scalars(
                    select(m.ArtifactDependency).where(
                        m.ArtifactDependency.document_version_id == roadmap_version
                    )
                )
            ).all()
        }
        assert (await s.get(DocumentVersion, roadmap_version)).markdown == markdown_before
    assert deps == {"requirements": "potentially_stale", "metrics": "fresh"}

    listed = (await client.get("/v1/trace/staleness", headers=ctx.as_("viewer"))).json()
    assert [d["document_version_id"] for d in listed] == [str(roadmap_version)]
    assert listed[0]["category"] == "roadmap"
    assert listed[0]["freshness"] == "potentially_stale"


async def test_dependencies_can_be_registered_for_a_stub_artifact(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    body = {
        "artifact_version_id": str(spec),
        "upstream": [
            {"version_id": str(v1.id), "section_key": "requirements"},
            {"entity_id": str(chain["requirement"])},
        ],
    }
    assert (
        await client.post("/v1/trace/dependencies", json=body, headers=ctx.as_("commenter"))
    ).status_code == 403
    resp = await client.post("/v1/trace/dependencies", json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 201, resp.text
    rows = resp.json()
    assert len(rows) == 2
    section = next(r for r in rows if r["upstream_section_key"] == "requirements")
    assert section["upstream_section_hash"] == await section_hash(
        ctx.tenant_id, v1.id, "requirements"
    )
    assert all(r["freshness"] == "fresh" for r in rows)
    # Idempotent: the same anchors again create nothing new.
    again = await client.post("/v1/trace/dependencies", json=body, headers=ctx.as_("approver"))
    assert sorted(r["id"] for r in again.json()) == sorted(r["id"] for r in rows)
    bad = {**body, "upstream": [{"version_id": str(v1.id), "section_key": "no-such"}]}
    resp = await client.post("/v1/trace/dependencies", json=bad, headers=ctx.as_("approver"))
    assert resp.status_code == 422


async def test_links_carry_forward_and_still_reach_a_reconciled_dependency(client):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    for key in ("requirements", "summary"):
        await link_section(
            ctx.tenant_id, v1.document_id, v1.id, key, entity_id=chain["requirement"]
        )
    _, spec = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id)
    dep = await depend(
        ctx.tenant_id, artifact_version_id=spec, upstream_version_id=v1.id,
        section_key="requirements",
    )  # fmt: skip
    assert (await import_md(client, ctx.as_("approver"), PRD_V2)).status_code == 201
    v2 = await version_row(ctx.tenant_id, 2)
    async with tenant_session(ctx.tenant_id) as s:
        carried = (
            await s.scalars(
                select(m.DocumentSectionLink.section_key).where(
                    m.DocumentSectionLink.version_id == v2.id
                )
            )
        ).all()
    # Unchanged sections keep their links; the changed one is linked again by a person.
    assert carried == ["summary"]

    resp = await client.post(
        ACTIONS,
        json={"action": "reconcile", "artifact_version_id": str(spec), "reason": "Still holds"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200, resp.text
    assert (await dependency(ctx.tenant_id, dep)).upstream_version_id == v2.id

    # The v1 link still ties the re-anchored dependency to the requirement.
    resp = await client.patch(
        f"/v1/baseline/entities/{chain['requirement']}",
        json={"title": "Save up to ten addresses", "origin": "user"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 200
    assert (await dependency(ctx.tenant_id, dep)).freshness == "potentially_stale"
