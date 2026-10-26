"""What run tokens read (S6): ``/v1/source-items/{id}`` over MCP under read:sources, and
the evidence inspector's confidence frozen at the run's pin, as the baseline detail
reads it (owner, 2026-10-20). Synthetic placeholders only."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from oracle.mcp.scopes import required_scope
from tests.baseline_helpers import cite, entity, make_ctx, make_item
from tests.test_evidence_freshness import _rescore, _run_pinned_at
from tests.test_mcp import local_runtime, mcp_client, run_token, text_of  # noqa: F401
from tests.trace_helpers import DOC, link_section, prd_v1


@pytest.fixture
async def ctx():
    return await make_ctx()


def test_source_items_need_read_sources():
    assert required_scope("GET", "/v1/source-items/{item_id}") == "read:sources"


async def test_a_run_token_reads_its_creators_source_item_over_mcp(client, ctx):
    item = await make_item(ctx, "owner", title="#placeholder thread")
    token = await run_token(ctx.tenant_id, ["read:sources"], ctx.users["owner"].id)
    async with mcp_client(token) as c:
        got = await c.call_tool("get_source_item", {"item_id": str(item)})
        assert not got.is_error, text_of(got)
        assert got.structured_content["id"] == str(item)
    # Without read:sources it stays refused.
    token = await run_token(ctx.tenant_id, ["read:baseline"], ctx.users["owner"].id)
    async with mcp_client(token) as c:
        refused = await c.call_tool("get_source_item", {"item_id": str(item)})
        assert refused.is_error and "read:sources" in text_of(refused)


async def _inspected(client, headers) -> dict[str, dict]:
    """Link targets of the inspector, by target type."""
    resp = await client.get(f"/v1/documents/{DOC}/versions/1/evidence", headers=headers)
    assert resp.status_code == 200, resp.text
    links = [lk for sec in resp.json()["sections"] for lk in sec["links"]]
    return {lk["target"]["type"]: lk["target"] for lk in links}


async def test_the_inspector_shows_a_run_confidence_as_of_its_pin(client, ctx):
    feat = await entity(client, ctx, type="feature", key="guided-setup")
    updated = datetime.now(UTC) - timedelta(days=10)
    item = await make_item(ctx, "owner", updated=updated)
    ev = await cite(client, ctx, feat, who="owner", source_item_id=str(item))
    version = await prd_v1(client, ctx)
    feat_id, ev_id = uuid.UUID(feat["id"]), uuid.UUID(ev["id"])
    await link_section(ctx.tenant_id, version.document_id, version.id, "summary", entity_id=feat_id)
    await link_section(
        ctx.tenant_id, version.document_id, version.id, "requirements", evidence_id=ev_id
    )
    run = await _run_pinned_at(ctx, "owner", datetime.now(UTC))
    # The source ages two months: people's live score drops, the run's does not.
    await _rescore(ctx, feat["id"], datetime.now(UTC) + timedelta(days=60))

    detail = (await client.get(f"/v1/baseline/entities/{feat_id}", headers=run)).json()
    live = (await client.get(f"/v1/baseline/entities/{feat_id}", headers=ctx.as_("owner"))).json()
    assert detail["evidence"][0]["confidence"] > live["evidence"][0]["confidence"]

    as_run = await _inspected(client, run)
    assert as_run["evidence"]["confidence"] == detail["evidence"][0]["confidence"]
    assert as_run["entity"]["confidence"] == detail["confidence"]
    as_person = await _inspected(client, ctx.as_("owner"))
    assert as_person["evidence"]["confidence"] == live["evidence"][0]["confidence"]
    assert as_person["entity"]["confidence"] == live["confidence"]
