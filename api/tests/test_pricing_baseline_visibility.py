"""H9 Pricing input, security fixes for #541: a decided pricing decision's baseline entity
is hidden with its decision (owners and approvers only, oracle.docs.visibility), and a
pricing memo created by an import is owners-and-approvers-only like one made from the
template. Against Postgres.

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid

import pytest
from sqlalchemy import select

from oracle.docs import visibility
from oracle.docs.models import Document
from oracle.swarm import FakeRuntime, set_runtime
from tests.baseline_helpers import make_ctx
from tests.blocker_helpers import make_entity
from tests.decision_helpers import clock  # noqa: F401
from tests.pricing_helpers import QUESTION, approved_memo, memo_md
from tests.test_mcp import api_token, mcp_client, run_token, text_of
from tests.update_helpers import import_md

# A flow whose run reads with its creator's role (its output is approvers-only); a draft
# of a company-wide document reads as a member (#541 part 5).
CREATOR_VIEW = "pricing_memo"

RATIONALE = "Teams ask for one price; a third of losses were on price."
WORD = "per-seat"  # in the pricing memo only


@pytest.fixture
async def ctx():
    return await make_ctx()


@pytest.fixture(autouse=True)
def runtime():
    """The local runtime: run tokens from any address."""
    set_runtime(FakeRuntime())
    yield
    set_runtime(None)


async def _decided(client, ctx) -> str:
    """A decided pricing decision; returns its baseline entity's id."""
    slug = await approved_memo(client, ctx)
    owner = ctx.as_("owner")
    d = (await client.post(f"/v1/pricing-memos/{slug}/decide", headers=owner)).json()
    resp = await client.post(
        f"/v1/decisions/{d['number']}/decide",
        json={
            "option_key": "flat-team",
            "rationale": RATIONALE,
            "reversibility": "reversible",
            "expected_outcome": "More teams of 10 to 50 pick the Team plan.",
        },
        headers=owner,
    )
    assert resp.status_code == 200, resp.text
    resp = await client.get("/v1/baseline/entities?type=decision", headers=owner)
    (entity,) = [e for e in resp.json() if e["key"] == f"d-{d['number']}"]
    return entity["id"]


def _leaks(body: str, entity_id: str) -> bool:
    return entity_id in body or QUESTION in body or RATIONALE in body


@pytest.mark.parametrize(("who", "sees"), [("owner", True), ("approver", True),
                                          ("commenter", False), ("viewer", False)])  # fmt: skip
async def test_the_decision_entity_follows_its_decision(client, ctx, who, sees):
    """protects=a decided pricing decision's baseline entity is in an owner's and an
    approver's entity list, graph, entity read and revisions, and absent from a commenter's
    and a viewer's (the read a 404, no revisions, no edge to it); a company-wide entity
    stays in every list; fails_when=a viewer or commenter reads the pricing question, the
    rationale or the chosen option through the baseline; no_claim=the web (the API is what
    it shows)."""
    goal = await make_entity(ctx, "goal", "team-plan-revenue")
    entity_id = await _decided(client, ctx)
    resp = await client.post(
        "/v1/baseline/edges",
        json={"src_id": entity_id, "dst_id": str(goal), "type": "affects"},
        headers=ctx.as_("owner"),
    )
    assert resp.status_code == 201, resp.text
    me = ctx.as_(who)
    listed = await client.get("/v1/baseline/entities", headers=me)
    graph = await client.get("/v1/baseline/graph", headers=me)
    edges = await client.get("/v1/baseline/edges", headers=me)
    one = await client.get(f"/v1/baseline/entities/{entity_id}", headers=me)
    revisions = await client.get(f"/v1/baseline/entities/{entity_id}/revisions", headers=me)
    goal_read = await client.get(f"/v1/baseline/entities/{goal}", headers=me)
    for resp in (listed, graph, edges, revisions, goal_read):
        assert resp.status_code == 200, resp.text
    assert str(goal) in listed.text and str(goal) in graph.text
    if sees:
        assert any(e["id"] == entity_id for e in listed.json())
        assert any(e["id"] == entity_id for e in graph.json()["entities"])
        assert any(e["src_id"] == entity_id for e in graph.json()["edges"])
        assert one.status_code == 200 and one.json()["attrs"]["chosen_option"] == "flat-team"
        assert revisions.json()
    else:
        for resp in (listed, graph, edges, goal_read):
            assert not _leaks(resp.text, entity_id), resp.url
        assert one.status_code == 404
        assert revisions.json() == []


@pytest.mark.parametrize(("who", "sees"), [("approver", True), ("commenter", False),
                                          ("viewer", False)])  # fmt: skip
async def test_over_mcp_read_baseline_follows_the_decision(client, ctx, who, sees):
    """protects=over MCP with read:baseline, an API token of the role and a run token of a
    run that role started read the decision entity in get_baseline only for an approver;
    fails_when=a run token or a token of a commenter or viewer reads it; no_claim=other
    MCP tools (they call the same routes)."""
    entity_id = await _decided(client, ctx)
    tokens = [
        await api_token(ctx.tenant_id, who),
        await run_token(ctx.tenant_id, ["read:baseline"], ctx.users[who].id, flow=CREATOR_VIEW),
    ]
    for raw in tokens:
        async with mcp_client(raw) as c:
            got = await c.call_tool("get_baseline", {})
        assert not got.is_error, text_of(got)
        assert (entity_id in text_of(got)) is sees, who
        if not sees:
            assert not _leaks(text_of(got), entity_id)


async def test_a_run_token_reads_the_entity_only_for_an_approver_or_owner_creator(client, ctx):
    """protects=over MCP, a run token's read of the decision entity and its revisions
    follow the run's creator: read for an owner's run, 404 and no revisions for a
    commenter's; fails_when=a commenter's run reads it; no_claim=writes."""
    entity_id = await _decided(client, ctx)
    for who, sees in (("owner", True), ("commenter", False)):
        uid = ctx.users[who].id
        raw = await run_token(ctx.tenant_id, ["read:baseline"], uid, flow=CREATOR_VIEW)
        async with mcp_client(raw) as c:
            one = await c.call_tool("get_entity", {"entity_id": entity_id})
            revisions = await c.call_tool("list_entity_revisions", {"entity_id": entity_id})
        assert not revisions.is_error, text_of(revisions)
        if sees:
            assert not one.is_error and RATIONALE in text_of(one), who
            assert RATIONALE in text_of(revisions), who
        else:
            assert one.is_error and "HTTP 404" in text_of(one), who
            assert not _leaks(text_of(revisions), entity_id), who


# --------------------------------------------------------------------- imported memos


async def _doc_id(ctx, slug: str) -> uuid.UUID:
    from oracle.tenancy import tenant_session

    async with tenant_session(ctx.tenant_id) as s:
        return await s.scalar(select(Document.id).where(Document.slug == slug))


def test_the_default_visibility_comes_from_the_kind():
    """protects=one rule for a new document's visibility: an update and a pricing memo are
    owners and approvers only, any other kind company-wide; fails_when=a creation path
    picks its own; no_claim=the owner's switch to company (H8)."""
    assert visibility.default_for("pricing") == visibility.APPROVERS
    assert visibility.default_for("update") == visibility.APPROVERS
    for kind in ("prd", "roadmap", "spec", "vision", "strategy"):
        assert visibility.default_for(kind) == visibility.COMPANY


@pytest.mark.parametrize("who", ["commenter", "viewer"])
async def test_an_imported_pricing_memo_is_for_approvers_only(client, ctx, who):
    """protects=a pricing memo created by importing its Markdown (no template start) is
    approvers-only: absent from a commenter's and a viewer's documents, search and MCP,
    and listed for an owner; fails_when=it falls back to company-wide; no_claim=the
    template path (test_pricing_visibility)."""
    slug = "team-plan-pricing-import"
    resp = await import_md(client, ctx.as_("approver"), slug, memo_md(slug))
    assert resp.status_code == 201, resp.text
    doc_id = await _doc_id(ctx, slug)
    owner = await client.get(f"/v1/documents/{slug}", headers=ctx.as_("owner"))
    assert owner.status_code == 200 and owner.json()["visibility"] == visibility.APPROVERS
    me = ctx.as_(who)
    assert (await client.get(f"/v1/documents/{slug}", headers=me)).status_code == 404
    listed = await client.get("/v1/documents", headers=me)
    assert listed.status_code == 200 and slug not in listed.text
    assert str(doc_id) not in listed.text
    hits = (await client.get("/v1/search", params={"q": WORD}, headers=me)).json()["hits"]
    assert not any(slug in str(h) or str(doc_id) in str(h) for h in hits)
    async with mcp_client(await api_token(ctx.tenant_id, who)) as c:
        got = await c.call_tool("get_document", {"doc": slug})
    assert got.is_error and "HTTP 404" in text_of(got)
