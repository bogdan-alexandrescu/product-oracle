"""The Company tab of coverage (A2, owner 2026-10-21 "Coverage"): owners see, per active
member and source kind, how many sources, live items, the fresh share and the last sync,
and nothing else: no source name, id, item or "not read" entry crosses.

Each test states its card: protects / fails_when / no_claim. Synthetic placeholders only.
"""

from datetime import UTC, datetime

import pytest

from oracle.auth.models import User
from oracle.sources import coverage
from oracle.sources.schemas import CompanyCoverage
from oracle.tenancy import tenant_session
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

COMPANY = "/v1/sources/coverage/company"
SYNC_A = datetime(2026, 10, 15, 8, tzinfo=UTC)
SYNC_B = datetime(2026, 10, 17, 8, tzinfo=UTC)


@pytest.fixture
async def ctx():
    return await make_ctx()


async def _company(client, ctx, who="owner") -> dict:
    resp = await client.get(COMPANY, headers=ctx.as_(who))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _disable(ctx, who: str) -> None:
    async with tenant_session(ctx.tenant_id) as s:
        (await s.get(User, ctx.users[who].id)).disabled_at = NOW
        await s.commit()


async def test_owners_see_counts_per_member_and_kind(client, ctx):
    """protects=per member and kind: summed sources, items, freshness, fresh share and the
    newest sync; members with none listed first; disabled members left out;
    fails_when=a member or kind is missing, a sum is wrong, or a disabled member shows;
    no_claim=the UI's ordering and chips (Playwright)."""
    a = await add_source(ctx, "owner", last_synced_at=SYNC_A)
    b = await add_source(ctx, "owner", last_synced_at=SYNC_B)
    for age in (5, 10, 40):
        await add_item(ctx, a, occurred_at=days_ago(age))
    await add_item(ctx, b, occurred_at=days_ago(70))
    await add_item(ctx, b, occurred_at=days_ago(1), deleted=True)
    drive = await add_source(ctx, "approver", kind="google_docs")
    await add_item(ctx, drive, kind="doc", occurred_at=days_ago(400))
    # The viewer is disabled: never listed, nor their source counted.
    gone = await add_source(ctx, "viewer", kind="github")
    await add_item(ctx, gone, kind="readme", occurred_at=days_ago(1))
    await _disable(ctx, "viewer")

    body = await _company(client, ctx)
    assert (body["members_total"], body["members_with_sources"]) == (3, 2)
    emails = [m["member"]["email"] for m in body["members"]]
    # No source first, then the lowest fresh share.
    assert emails == ["commenter@example.com", "approver@example.com", "owner@example.com"]
    by = {m["member"]["email"]: m for m in body["members"]}
    assert by["commenter@example.com"]["kinds"] == []
    assert by["commenter@example.com"]["member"]["role"] == "commenter"
    assert by["owner@example.com"]["member"]["name"] is None
    assert by["owner@example.com"]["kinds"] == [
        {
            "kind": "slack",
            "sources": 2,
            "items": 4,
            "fresh_share": 0.5,
            "freshness": {"fresh": 2, "aging": 1, "stale": 1},
            "last_synced_at": SYNC_B.isoformat().replace("+00:00", "Z"),
        }
    ]
    [docs] = by["approver@example.com"]["kinds"]
    assert docs["kind"] == "google_docs"
    assert (docs["sources"], docs["items"], docs["fresh_share"]) == (1, 1, 0.0)
    assert docs["freshness"] == {"fresh": 0, "aging": 0, "stale": 1}
    assert docs["last_synced_at"] is None


@pytest.mark.parametrize("role", ["approver", "commenter", "viewer"])
async def test_only_owners_see_company_coverage(client, ctx, role):
    """protects=the Company tab is the owners' alone;
    fails_when=an approver, commenter or viewer gets counts;
    no_claim=their own coverage (they read it on Mine)."""
    resp = await client.get(COMPANY, headers=ctx.as_(role))
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Company coverage is for owners"


async def test_a_run_is_refused_and_an_owners_read_only_client_reads(client, ctx):
    """protects=runs never see the company's counts; an owner's read-only MCP client does;
    fails_when=a run token reads counts, or the owner's oracle:read client is refused;
    no_claim=MCP tool listing."""
    resp = await client.get(COMPANY, headers=await run_headers(ctx, "owner"))
    assert resp.status_code == 403
    assert resp.json()["detail"] == "Coverage is for people"

    resp = await client.get(COMPANY, headers=await read_only_mcp(ctx, "owner"))
    assert resp.status_code == 200, resp.text
    # A read-only client of a non-owner is still refused.
    resp = await client.get(COMPANY, headers=await read_only_mcp(ctx, "approver"))
    assert resp.status_code == 403


def _keys(schema: dict, defs: dict, prefix: str = "") -> set[str]:
    out = set()
    for name, prop in schema.get("properties", {}).items():
        path = f"{prefix}{name}"
        out.add(path)
        ref = prop.get("$ref") or prop.get("items", {}).get("$ref")
        for alt in prop.get("anyOf", []):
            ref = ref or alt.get("$ref")
        if ref:
            out |= _keys(defs[ref.rsplit("/", 1)[-1]], defs, f"{path}.")
    return out


async def test_no_name_id_or_item_crosses(client, ctx):
    """protects=counts only: no source name, id, external id, item title or not-read entry;
    fails_when=any of those strings is in the response, or the schema grows a field;
    no_claim=what the owner's own Mine tab shows."""
    src = await add_source(
        ctx, "approver", name="Secret channel",
        unavailable=[{"external_id": "XSECRET1", "reason": "No access", "name": "Secret file",
                      "status": "unavailable"}],
    )  # fmt: skip
    await add_item(ctx, src, occurred_at=days_ago(1), title="Secret plan")

    resp = await client.get(COMPANY, headers=ctx.as_("owner"))
    text = resp.text
    for secret in ("Secret channel", "Secret plan", "Secret file", "XSECRET1", str(src)):
        assert secret not in text

    schema = CompanyCoverage.model_json_schema()
    assert _keys(schema, schema["$defs"]) == {
        "as_of", "members_total", "members_with_sources", "members",
        "members.member", "members.member.id", "members.member.email", "members.member.name",
        "members.member.role",
        "members.kinds", "members.kinds.kind", "members.kinds.sources", "members.kinds.items",
        "members.kinds.fresh_share", "members.kinds.freshness", "members.kinds.freshness.fresh",
        "members.kinds.freshness.aging", "members.kinds.freshness.stale",
        "members.kinds.last_synced_at",
    }  # fmt: skip


@pytest.mark.parametrize(("members", "sources"), [(2, 1), (12, 40)])
async def test_company_coverage_runs_four_statements(ctx, members, sources):
    """protects=4 statements whatever the number of members and sources;
    fails_when=a query runs per member or per source;
    no_claim=wall time (measured by hand, recorded in the PR)."""
    async with tenant_session(ctx.tenant_id) as s:
        for i in range(members - len(ctx.users)):
            s.add(User(email=f"member{i}@example.com", password_hash="x", role="viewer"))
        await s.commit()
    for i in range(sources):
        who = list(ctx.users)[i % len(ctx.users)]
        src = await add_source(ctx, who, name=f"Source {i:02}")
        await add_item(ctx, src, occurred_at=days_ago(i))
    async with tenant_session(ctx.tenant_id) as s:
        with count_statements() as seen:
            out = await coverage.company_coverage(s)
    assert out.members_total == max(members, len(ctx.users))
    assert len(seen) == 4, seen


async def test_another_companys_members_and_sources_never_appear(client, ctx):
    """protects=company coverage is scoped to the caller's company;
    fails_when=another company's member or counts show;
    no_claim=the tenancy layer itself (test_tenancy)."""
    other = await make_ctx("Other Co")
    src = await add_source(other, "owner", name="Other chat")
    await add_item(other, src, occurred_at=days_ago(1))

    body = await _company(client, ctx)
    ids = {m["member"]["id"] for m in body["members"]}
    assert ids == {str(u.id) for u in ctx.users.values()}
    assert body["members_with_sources"] == 0
    assert all(m["kinds"] == [] for m in body["members"])
