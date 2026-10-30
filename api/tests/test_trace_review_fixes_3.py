"""Review fixes for the trace lane, round 3 (PR #30): deleting a source or removing
evidence keeps a section link that names another target (its traceability to an entity
survives, and a later change to that entity still reaches the section); only a link left
with no target is deleted, and that one is kept on the change. Synthetic placeholders
only."""

import uuid

import pytest
from sqlalchemy import select

import oracle.main  # noqa: F401  (registers the lanes' change handlers)
from oracle.auth.service import create_api_token
from oracle.sources import service as sources_service
from oracle.sources.models import Source, SourceItem
from oracle.tenancy import tenant_session
from oracle.v2 import models as m
from tests.baseline_helpers import make_ctx, make_item
from tests.test_mcp import mcp_client
from tests.trace_helpers import (
    depend,
    dependency,
    link_section,
    prd_v1,
    seed_chain,
    stub_artifact,
)

B = "/v1/baseline"


async def _changes(tenant_id: uuid.UUID, cause: str) -> list[m.ChangeEvent]:
    async with tenant_session(tenant_id) as s:
        rows = await s.scalars(
            select(m.ChangeEvent).where(m.ChangeEvent.cause == cause)
            .order_by(m.ChangeEvent.created_at)
        )  # fmt: skip
        return list(rows.all())


async def _link(tenant_id: uuid.UUID, link_id: uuid.UUID) -> m.DocumentSectionLink | None:
    async with tenant_session(tenant_id) as s:
        return await s.get(m.DocumentSectionLink, link_id)


def _snapshotted(change: m.ChangeEvent) -> set[str]:
    return {lk["id"] for lk in change.data["trace"]["links"]}


async def _source_of(tenant_id: uuid.UUID, item_id: uuid.UUID) -> uuid.UUID:
    async with tenant_session(tenant_id) as s:
        return (await s.get(SourceItem, item_id)).source_id


async def _delete_source(client, ctx, source_id: uuid.UUID, via: str) -> None:
    if via == "rest":
        resp = await client.delete(f"/v1/sources/{source_id}", headers=ctx.as_("owner"))
        assert resp.status_code == 204, resp.text
        return
    async with tenant_session(ctx.tenant_id) as s:
        _, raw = await create_api_token(s, "agent", user_id=ctx.users["owner"].id)
        await s.commit()
    async with mcp_client(raw) as c:
        result = await c.call_tool("delete_source", {"source_id": str(source_id)})
    assert not result.is_error, result


async def _remove_evidence(client, ctx, evidence_id: uuid.UUID, via: str) -> None:
    if via == "rest":
        resp = await client.delete(f"{B}/evidence/{evidence_id}", headers=ctx.as_("approver"))
        assert resp.status_code == 204, resp.text
        return
    async with mcp_client(ctx.token) as c:
        result = await c.call_tool("remove_evidence", {"evidence_id": str(evidence_id)})
    assert not result.is_error, result


async def _assert_section_follows(client, ctx, v1, feature: uuid.UUID, section: str) -> None:
    """A dependency on ``section`` made now goes stale when the feature changes: the
    section still links it."""
    _, av = await stub_artifact(ctx.tenant_id, v1.document_id, v1.id, kind="wireframe")
    dep_id = await depend(
        ctx.tenant_id, artifact_version_id=av, upstream_version_id=v1.id, section_key=section
    )
    resp = await client.patch(
        f"{B}/entities/{feature}", json={"title": "Saved delivery addresses"},
        headers=ctx.as_("approver"),
    )  # fmt: skip
    assert resp.status_code == 200, resp.text
    dep = await dependency(ctx.tenant_id, dep_id)
    assert dep.freshness == "potentially_stale"
    async with tenant_session(ctx.tenant_id) as s:
        change = await s.get(m.ChangeEvent, dep.caused_by_change_id)
    assert change.subject_id == feature
    marked = {x["id"]: x for x in change.data["trace"]["marked"]}
    assert any(
        # qa-plan-10: the feature by its title, never its baseline key.
        section in r
        and ("links Saved delivery addresses" in r or "links Saved addresses" in r)
        and "saved-addresses" not in r
        for r in marked[str(dep_id)]["reasons"]
    )


# --- MAJOR: a link that names an entity survives its source's deletion ------------------------


@pytest.mark.parametrize("via", ["rest", "mcp"])
async def test_a_link_naming_an_entity_survives_its_sources_deletion(client, via):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    item_id = await make_item(ctx, "owner")
    both = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", entity_id=chain["feature"],
        source_item_id=item_id, kind="implements",
    )  # fmt: skip
    item_only = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", source_item_id=item_id, kind="evidences"
    )

    await _delete_source(client, ctx, await _source_of(ctx.tenant_id, item_id), via)

    kept = await _link(ctx.tenant_id, both)
    assert kept is not None
    assert kept.entity_id == chain["feature"] and kept.source_item_id is None
    assert await _link(ctx.tenant_id, item_only) is None
    (change,) = await _changes(ctx.tenant_id, "source_deleted")
    # Only what was deleted is kept on the change; the surviving link is still in the table.
    assert _snapshotted(change) == {str(item_only)}
    await _assert_section_follows(client, ctx, v1, chain["feature"], "sources")


async def test_a_link_naming_evidence_keeps_it_when_the_source_goes(client):
    """Evidence outlives its source item (its excerpt was copied): a link naming both
    keeps the evidence."""
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    item_id = await make_item(ctx, "owner")
    resp = await client.post(
        f"{B}/entities/{chain['feature']}/evidence",
        json={"source_item_id": str(item_id)},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    evidence_id = uuid.UUID(resp.json()["id"])
    link = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", evidence_id=evidence_id,
        source_item_id=item_id, kind="evidences",
    )  # fmt: skip

    await _delete_source(client, ctx, await _source_of(ctx.tenant_id, item_id), "rest")

    kept = await _link(ctx.tenant_id, link)
    assert kept is not None
    assert kept.evidence_id == evidence_id and kept.source_item_id is None
    (change,) = await _changes(ctx.tenant_id, "source_deleted")
    assert _snapshotted(change) == set()


async def test_an_item_only_link_is_deleted_with_its_source(client):
    """Called directly (no request rollback to hide it): no IntegrityError from the
    link's target check, and the link is gone."""
    ctx = await make_ctx()
    v1 = await prd_v1(client, ctx)
    item_id = await make_item(ctx, "owner")
    link = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", source_item_id=item_id, kind="mentions"
    )
    async with tenant_session(ctx.tenant_id) as s:
        source = await s.get(Source, await _source_of(ctx.tenant_id, item_id))
        await sources_service.delete_source(s, source, actor="test")
    assert await _link(ctx.tenant_id, link) is None
    async with tenant_session(ctx.tenant_id) as s:
        assert await s.get(SourceItem, item_id) is None


# --- the same for removed evidence --------------------------------------------------------------


@pytest.mark.parametrize("via", ["rest", "mcp"])
async def test_a_link_naming_an_entity_survives_its_evidences_removal(client, via):
    ctx = await make_ctx()
    chain = await seed_chain(ctx.tenant_id)
    v1 = await prd_v1(client, ctx)
    resp = await client.post(
        f"{B}/entities/{chain['feature']}/evidence",
        json={"ref": "checkout-notes.md", "excerpt": "Buyers retype their address"},
        headers=ctx.as_("approver"),
    )
    assert resp.status_code == 201, resp.text
    evidence_id = uuid.UUID(resp.json()["id"])
    both = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", entity_id=chain["feature"],
        evidence_id=evidence_id, kind="implements",
    )  # fmt: skip
    evidence_only = await link_section(
        ctx.tenant_id, v1.document_id, v1.id, "sources", evidence_id=evidence_id,
        kind="evidences",
    )  # fmt: skip

    await _remove_evidence(client, ctx, evidence_id, via)

    kept = await _link(ctx.tenant_id, both)
    assert kept is not None
    assert kept.entity_id == chain["feature"] and kept.evidence_id is None
    assert await _link(ctx.tenant_id, evidence_only) is None
    (change,) = await _changes(ctx.tenant_id, "evidence_deleted")
    assert _snapshotted(change) == {str(evidence_only)}
    await _assert_section_follows(client, ctx, v1, chain["feature"], "sources")
