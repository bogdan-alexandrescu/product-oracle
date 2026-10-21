"""Coverage of a person's own sources (A2): what Oracle read from each source, what it
left out and why, how fresh it is, and where it is used.

Each test states its card: protects / fails_when / no_claim. Synthetic placeholders only.
"""

import hashlib
import uuid
from datetime import timedelta

import pytest

from oracle.baseline.models import Entity, Evidence
from oracle.docs.models import Citation, Document, DocumentVersion
from oracle.sources import coverage
from oracle.sources.items import CONFIDENCE_SETTING
from oracle.tenancy import tenant_session
from oracle.tenant_settings import TenantSetting
from oracle.v2.models import DocumentSectionLink
from tests.baseline_helpers import make_ctx
from tests.coverage_helpers import (
    NOW,
    add_item,
    add_source,
    count_statements,
    days_ago,
    read_only_mcp,
    run_headers,
)

LIST = "/v1/sources/coverage"


def detail(source_id) -> str:
    return f"/v1/sources/{source_id}/coverage"


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _get(client, ctx, path, who="owner", **params):
    resp = await client.get(path, headers=ctx.as_(who), params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _one(body: dict, source_id) -> dict:
    [row] = [s for s in body["sources"] if s["source_id"] == str(source_id)]
    return row


async def _set_half_life(ctx, table: dict) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        s.add(TenantSetting(key=CONFIDENCE_SETTING, value={"half_life_days": table}))
        await s.commit()


# --- AC 1: own sources only ----------------------------------------------------------


async def test_a_member_sees_their_own_sources_and_never_anothers(client, ctx):
    """protects=coverage is private to the source's owner;
    fails_when=another member's source is listed, or its detail answers;
    no_claim=what the Company tab shows owners (test_source_coverage_company)."""
    mine = [await add_source(ctx, "owner", name=n) for n in ("Alpha chat", "Beta chat")]
    theirs = await add_source(ctx, "approver", name="Their chat")
    await add_item(ctx, theirs, occurred_at=days_ago(1))

    body = await _get(client, ctx, LIST)
    assert {s["source_id"] for s in body["sources"]} == {str(i) for i in mine}
    assert [s["name"] for s in body["sources"]] == ["Alpha chat", "Beta chat"]
    assert body["as_of"]

    resp = await client.get(detail(theirs), headers=ctx.as_("owner"))
    assert resp.status_code == 404
    # Their own view still has it.
    assert _one(await _get(client, ctx, LIST, "approver"), theirs)["items"] == 1


# --- AC 2: live and removed ----------------------------------------------------------


async def test_live_and_removed_items_are_counted_apart(client, ctx):
    """protects=items counts live rows, removed counts soft-deleted ones;
    fails_when=a narrowed-away item is counted as held, or not at all;
    no_claim=why an item was removed (narrowing or upstream)."""
    src = await add_source(ctx, "owner")
    for _ in range(5):
        await add_item(ctx, src, occurred_at=days_ago(2))
    for _ in range(2):
        await add_item(ctx, src, occurred_at=days_ago(2), deleted=True)

    row = _one(await _get(client, ctx, LIST), src)
    assert (row["items"], row["removed"]) == (5, 2)
    got = await _get(client, ctx, detail(src))
    assert (got["items"], got["removed"]) == (5, 2)
    assert got["by_kind"] == [
        {"kind": "message", "items": 5, "newest_at": got["newest_at"], "half_life_days": 30}
    ]


# --- AC 3: not read -------------------------------------------------------------------


async def test_not_read_counts_by_status_and_lists_every_entry(client, ctx):
    """protects=what was left out and why, per status (a missing status is unavailable);
    fails_when=an entry without status is dropped, or a status is miscounted;
    no_claim=the connectors' wording of reasons."""
    entries = [
        {"external_id": "D1", "reason": "Skipped: owned outside example.com", "name": "Doc one",
         "status": "skipped"},
        {"external_id": "D2", "reason": "Skipped: in a shared drive outside the company",
         "name": "Doc two", "status": "skipped"},
        {"external_id": "C9", "reason": "No access: removed, or no longer shared",
         "status": "unavailable"},
        {"external_id": "C8", "reason": "No access: archived"},
    ]  # fmt: skip
    src = await add_source(ctx, "owner", kind="google_docs", unavailable=entries)

    row = _one(await _get(client, ctx, LIST), src)
    assert row["not_read"] == {"skipped": 2, "unavailable": 2, "flagged": 0, "limited": 0}

    got = await _get(client, ctx, detail(src))
    assert got["not_read_items"] == [
        {"external_id": "D1", "name": "Doc one", "status": "skipped",
         "reason": "Skipped: owned outside example.com"},
        {"external_id": "D2", "name": "Doc two", "status": "skipped",
         "reason": "Skipped: in a shared drive outside the company"},
        {"external_id": "C9", "name": None, "status": "unavailable",
         "reason": "No access: removed, or no longer shared"},
        {"external_id": "C8", "name": None, "status": "unavailable",
         "reason": "No access: archived"},
    ]  # fmt: skip


# --- AC 4: freshness ------------------------------------------------------------------


async def test_freshness_buckets_follow_the_kinds_half_life(client, ctx):
    """protects=fresh (<= 1 half-life), aging (<= 2), stale (older) per kind;
    fails_when=a bucket uses the wrong half-life or boundary;
    no_claim=the UI ring."""
    src = await add_source(ctx, "owner")
    for age in (10, 40, 70):
        await add_item(ctx, src, occurred_at=days_ago(age))

    row = _one(await _get(client, ctx, LIST), src)
    assert row["freshness"] == {"fresh": 1, "aging": 1, "stale": 1}
    assert row["newest_at"][:10] == days_ago(10).isoformat()[:10]
    assert row["oldest_at"][:10] == days_ago(70).isoformat()[:10]


async def test_freshness_follows_the_companys_half_life_override(client, ctx):
    """protects=the company's confidence_weights apply to coverage as to scores;
    fails_when=a bucket ignores the company's override;
    no_claim=the override's validation (tenant settings tests)."""
    src = await add_source(ctx, "owner")
    for age in (10, 40, 70):
        await add_item(ctx, src, occurred_at=days_ago(age))
    await _set_half_life(ctx, {"slack": 60})

    row = _one(await _get(client, ctx, LIST), src)
    assert row["freshness"] == {"fresh": 2, "aging": 1, "stale": 0}
    got = await _get(client, ctx, detail(src))
    assert got["by_kind"][0]["half_life_days"] == 60


async def test_an_items_time_is_its_latest_stamp_then_its_fetch(client, ctx):
    """protects=the item's time is greatest(updated, occurred), else the version's fetch,
    as confidence.Factors.latest_at; no time at all counts as stale;
    fails_when=an old occurred_at hides a recent update, or a fetch-only item is stale;
    no_claim=a run's frozen freshness (S6)."""
    src = await add_source(ctx, "owner")
    # Occurred long ago, changed upstream lately: fresh.
    await add_item(ctx, src, occurred_at=days_ago(300), updated_at=days_ago(5))
    # No stamps, fetched lately: fresh by its version.
    await add_item(ctx, src, fetched_at=days_ago(3))
    # No stamps and no version: stale.
    await add_item(ctx, src, version=False)

    row = _one(await _get(client, ctx, LIST), src)
    assert row["freshness"] == {"fresh": 2, "aging": 0, "stale": 1}
    assert row["items"] == 3


async def test_the_half_life_of_a_source_and_item_kind_pair_wins(client, ctx):
    """protects=the most specific half-life key (github:issue 60 over github 180);
    fails_when=items of one source are bucketed with one half-life for every kind;
    no_claim=kinds Oracle has no default for (they take 90 days)."""
    src = await add_source(ctx, "owner", kind="github")
    await add_item(ctx, src, kind="issue", occurred_at=days_ago(100))
    await add_item(ctx, src, kind="readme", occurred_at=days_ago(100))

    got = await _get(client, ctx, detail(src))
    assert got["freshness"] == {"fresh": 1, "aging": 1, "stale": 0}
    assert {k["kind"]: k["half_life_days"] for k in got["by_kind"]} == {
        "issue": 60,
        "readme": 180,
    }


# --- AC 5 and 6: usage ------------------------------------------------------------------


async def _entity(s, key: str) -> Entity:
    e = Entity(type="feature", key=key, title=key.replace("-", " ").capitalize(), origin="user")
    s.add(e)
    await s.flush()
    return e


async def _document(s, slug: str, versions: int) -> tuple[Document, list[DocumentVersion]]:
    doc = Document(slug=slug, title=slug.replace("-", " ").title(), kind="prd")
    s.add(doc)
    await s.flush()
    out = []
    for n in range(1, versions + 1):
        md = f"# {slug} v{n}"
        digest = hashlib.sha1(md.encode()).hexdigest()
        v = DocumentVersion(document_id=doc.id, number=n, markdown=md, content_hash=digest)
        s.add(v)
        out.append(v)
    await s.flush()
    return doc, out


async def test_usage_counts_evidence_citations_and_section_links(client, ctx):
    """protects=where a source's items are used, from the three tables that point at them;
    fails_when=a use is missed, a document counted twice, or the order is not newest first;
    no_claim=the links the UI builds from them."""
    src = await add_source(ctx, "owner")
    a = await add_item(ctx, src, occurred_at=days_ago(1), title="Pricing thread")
    b = await add_item(ctx, src, occurred_at=days_ago(1), title="Setup thread")
    async with tenant_session(ctx.tenant_id) as s:
        ent = await _entity(s, "usage-billing")
        x, (x1, x2) = await _document(s, "billing-prd", 2)
        y, (y1,) = await _document(s, "setup-prd", 1)
        at = lambda h: NOW - timedelta(hours=h)  # noqa: E731
        s.add_all(
            [
                Evidence(entity_id=ent.id, source_item_id=a, created_at=at(6)),
                Evidence(entity_id=ent.id, source_item_id=b, created_at=at(5)),
                Citation(version_id=x1.id, cite_key="c1", source="slack", ref="r", item_id=a,
                         created_at=at(4)),
                Citation(version_id=x2.id, cite_key="c1", source="slack", ref="r", item_id=a,
                         created_at=at(3)),
                Citation(version_id=x2.id, cite_key="c2", source="slack", ref="r", item_id=b,
                         created_at=at(2)),
                DocumentSectionLink(document_id=y.id, version_id=y1.id, section_key="pricing",
                                    kind="evidences", source_item_id=a, created_at=at(1)),
            ]
        )  # fmt: skip
        await s.commit()
        ent_id, x_slug, y_slug = str(ent.id), x.slug, y.slug

    row = _one(await _get(client, ctx, LIST), src)
    assert row["used"] == {"evidence": 2, "citations": 3, "section_links": 1, "documents": 2}

    got = await _get(client, ctx, detail(src))
    assert got["used_in_total"] == 6
    used = got["used_in"]
    assert [u["kind"] for u in used] == [
        "section_link", "citation", "citation", "citation", "evidence", "evidence",
    ]  # fmt: skip
    assert [u["at"] for u in used] == sorted((u["at"] for u in used), reverse=True)
    link, newest_cite = used[0], used[1]
    assert link["document"] == {"slug": y_slug, "title": "Setup Prd", "kind": "prd"}
    assert (link["version"], link["section_key"]) == (1, "pricing")
    assert link["item"]["title"] == "Pricing thread"
    assert newest_cite["document"]["slug"] == x_slug
    assert (newest_cite["version"], newest_cite["cite_key"]) == (2, "c2")
    assert newest_cite["item"]["title"] == "Setup thread"
    assert used[-1]["entity"] == {
        "id": ent_id, "type": "feature", "key": "usage-billing", "title": "Usage billing",
        "status": "proposed",
    }  # fmt: skip


async def test_used_in_pages_fifty_at_a_time(client, ctx):
    """protects=the used-in list pages (limit 1-100, default 50) with its total;
    fails_when=a page overflows, the total is the page's length, or limit 101 passes;
    no_claim=speed at scale (measured by hand)."""
    src = await add_source(ctx, "owner")
    item = await add_item(ctx, src, occurred_at=days_ago(1))
    async with tenant_session(ctx.tenant_id) as s:
        ent = await _entity(s, "busy")
        s.add_all(
            [
                Evidence(entity_id=ent.id, source_item_id=item, created_at=at)
                for at in (NOW - timedelta(minutes=i) for i in range(60))
            ]
        )
        await s.commit()

    first = await _get(client, ctx, detail(src))
    assert (len(first["used_in"]), first["used_in_total"]) == (50, 60)
    rest = await _get(client, ctx, detail(src), offset=50)
    assert (len(rest["used_in"]), rest["used_in_total"]) == (10, 60)
    resp = await client.get(detail(src), headers=ctx.as_("owner"), params={"limit": 101})
    assert resp.status_code == 422


# --- AC 7: who may call ---------------------------------------------------------------


async def test_a_run_is_refused_and_a_read_only_client_reads(client, ctx):
    """protects=coverage is for people: a run never sees it, a person's MCP client does;
    fails_when=a run token reads a person's coverage, or a read-only client is refused;
    no_claim=the MCP tool listing itself."""
    src = await add_source(ctx, "owner")
    run = await run_headers(ctx, "owner")
    for path in (LIST, detail(src)):
        resp = await client.get(path, headers=run)
        assert resp.status_code == 403, resp.text
        assert resp.json()["detail"] == "Coverage is for people"

    mcp = await read_only_mcp(ctx, "owner")
    for path in (LIST, detail(src)):
        resp = await client.get(path, headers=mcp)
        assert resp.status_code == 200, resp.text


# --- AC 8: a fixed number of statements ----------------------------------------------------


@pytest.mark.parametrize("n", [1, 12])
async def test_the_list_runs_four_statements_whatever_the_number_of_sources(ctx, n):
    """protects=the list is 4 statements, not one per source;
    fails_when=a query runs per source (N+1);
    no_claim=wall time (measured by hand, recorded in the PR)."""
    for i in range(n):
        src = await add_source(ctx, "owner", name=f"Source {i:02}")
        await add_item(ctx, src, occurred_at=days_ago(i))
    async with tenant_session(ctx.tenant_id) as s:
        with count_statements() as seen:
            out = await coverage.list_coverage(s, ctx.users["owner"].id)
    assert len(out.sources) == n
    assert len(seen) == 4, seen


# --- AC 9: route order ------------------------------------------------------------------


async def test_the_coverage_route_is_not_taken_for_a_source_id(client, ctx):
    """protects=/sources/coverage is its own route, declared before /sources/{source_id};
    fails_when=it answers 422 for a bad UUID;
    no_claim=the other /sources routes."""
    resp = await client.get(LIST, headers=ctx.as_("viewer"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["sources"] == []
    resp = await client.get(f"{LIST}/company", headers=ctx.as_("owner"))
    assert resp.status_code == 200, resp.text


async def test_an_unknown_source_is_a_404(client, ctx):
    """protects=a source id nobody owns is a 404, like every /sources route;
    fails_when=it answers 200 or 500;
    no_claim=sources of another company (isolation tests)."""
    resp = await client.get(detail(uuid.uuid4()), headers=ctx.as_("owner"))
    assert resp.status_code == 404
