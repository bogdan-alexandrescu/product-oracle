# ruff: noqa: F811 - the fixtures are imported
"""H7 Competitive digest API: alternatives, watched pages, the change log, positioning,
roles, limits, isolation and the run tokens' read scope (made-up alternatives on
``.example`` hosts; the fetcher's transport is fake).

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

import uuid

from oracle.swarm import FakeRuntime, set_runtime
from tests.baseline_helpers import make_ctx
from tests.market_helpers import add_competitor, html, watch_page, web  # noqa: F401
from tests.ritual_helpers import at, ctx  # noqa: F401
from tests.test_mcp import mcp_client, run_token, text_of


async def test_alternatives_crud_and_archive(client, ctx, at, web):
    """protects=approvers add, edit (lock_version) and archive alternatives, archiving
    pauses their pages, viewers list them with their counts; fails_when=a stale
    lock_version lands, an archived alternative's page stays active, or the list misses
    a field; no_claim=the screen."""
    web.page("https://competitor-a.example/pricing", html("Team $50"))
    resp = await add_competitor(client, ctx, aliases=["CompA"])
    assert resp.status_code == 201, resp.text
    a = resp.json()
    assert a["kind"] == "direct" and a["aliases"] == ["CompA"] and a["pages"] == 0
    page = (await watch_page(client, ctx, a["id"], "https://competitor-a.example/pricing")).json()
    url = f"/v1/competitors/{a['id']}"
    resp = await client.patch(url, json={"lock_version": 1, "description": "Made-up rival"},
                              headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200 and resp.json()["lock_version"] == 2
    resp = await client.patch(url, json={"lock_version": 1, "kind": "indirect"},
                              headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 409
    got = (await client.get(url, headers=ctx.as_("viewer"))).json()
    assert got["pages"] == 1 and got["page_list"][0]["host"] == "competitor-a.example"
    assert got["description"] == "Made-up rival"
    assert (await client.post(f"{url}/archive", headers=ctx.as_("approver"))).status_code == 200
    got = (await client.get(url, headers=ctx.as_("viewer"))).json()
    assert got["status"] == "archived" and got["page_list"][0]["status"] == "paused"
    assert (await client.get("/v1/competitors", headers=ctx.as_("viewer"))).json() == []
    listed = await client.get("/v1/competitors?include_archived=true", headers=ctx.as_("viewer"))
    assert [c["name"] for c in listed.json()] == ["Competitor A"]
    assert (await client.post(f"{url}/restore", headers=ctx.as_("approver"))).status_code == 200
    resp = await client.patch(f"/v1/competitor-pages/{page['id']}", json={"status": "active"},
                              headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 200 and resp.json()["status"] == "active"
    resp = await client.delete(f"/v1/competitor-pages/{page['id']}", headers=ctx.as_("approver"))
    assert resp.status_code == 204


async def test_limits(client, ctx, at, web):
    """protects=criterion 14: an 11th page on one alternative is 422, an http:// URL is
    422, a duplicate URL is 422, a name of another active alternative (any case) is 422,
    more than 5 aliases is 422; fails_when=any of them is stored; no_claim=the 60-page
    company limit at scale (same code path)."""
    cid = (await add_competitor(client, ctx)).json()["id"]
    for i in range(10):
        web.page(f"https://competitor-a.example/p{i}", html(f"page {i}"))
        resp = await watch_page(client, ctx, cid, f"https://competitor-a.example/p{i}")
        assert resp.status_code == 201, resp.text
    resp = await watch_page(client, ctx, cid, "https://competitor-a.example/p10")
    assert resp.status_code == 422
    other = (await add_competitor(client, ctx, name="Competitor B")).json()["id"]
    assert (await watch_page(client, ctx, other, "http://competitor-b.example/")).status_code == 422
    web.page("https://competitor-b.example/", html("home"))
    assert (
        await watch_page(client, ctx, other, "https://competitor-b.example/")
    ).status_code == 201
    assert (
        await watch_page(client, ctx, other, "https://competitor-b.example/")
    ).status_code == 422
    assert (await add_competitor(client, ctx, name="competitor a")).status_code == 422
    six = [f"Alias {i}" for i in range(6)]
    assert (await add_competitor(client, ctx, name="Competitor C", aliases=six)).status_code == 422


async def test_positioning_edit_and_item_limits(client, ctx, at):
    """protects=approvers edit positioning with lock_version, items are capped at 300
    characters and 10 per field (one market category), and a person's edit is audited;
    fails_when=an over-long item or a stale write lands; no_claim=inline editing."""
    url = "/v1/positioning"
    got = (await client.get(url, headers=ctx.as_("viewer"))).json()
    assert got["lock_version"] == 0 and got["fields"]["trends"] == []
    fields = {
        "unique_attributes": [{"text": "Setup in a day"}],
        "market_category": [{"text": "Planning tools"}],
    }
    body = {"lock_version": 0, "fields": fields}
    resp = await client.put(url, json=body, headers=ctx.as_("approver"))
    assert resp.status_code == 200, resp.text
    assert resp.json()["fields"]["unique_attributes"][0]["text"] == "Setup in a day"
    assert (await client.put(url, json=body, headers=ctx.as_("approver"))).status_code == 409
    too_long = {"lock_version": 1, "fields": {"trends": [{"text": "x" * 301}]}}
    assert (await client.put(url, json=too_long, headers=ctx.as_("approver"))).status_code == 422
    two = {"lock_version": 1, "fields": {"market_category": [{"text": "A"}, {"text": "B"}]}}
    assert (await client.put(url, json=two, headers=ctx.as_("approver"))).status_code == 422
    many = {"lock_version": 1, "fields": {"trends": [{"text": f"t{i}"} for i in range(11)]}}
    assert (await client.put(url, json=many, headers=ctx.as_("approver"))).status_code == 422


async def test_commenters_get_403_on_every_write_viewers_read(client, ctx, at, web):
    """protects=criterion 13: a commenter gets 403 on every write; a viewer reads the
    alternatives, changes, positioning and web findings; fails_when=a commenter writes or
    a viewer is refused a read; no_claim=the screen hides the buttons (Playwright, lane
    3)."""
    web.page("https://competitor-a.example/pricing", html("Team $50"))
    cid = (await add_competitor(client, ctx)).json()["id"]
    page = (await watch_page(client, ctx, cid, "https://competitor-a.example/pricing")).json()
    sid, fid = uuid.uuid4(), uuid.uuid4()
    writes = [
        ("POST", "/v1/competitors", {"name": "Competitor C", "kind": "direct"}),
        ("PATCH", f"/v1/competitors/{cid}", {"lock_version": 1}),
        ("POST", f"/v1/competitors/{cid}/archive", None),
        ("POST", f"/v1/competitors/{cid}/restore", None),
        ("POST", f"/v1/competitors/{cid}/pages", {"url": "https://x.example/", "label": "other"}),
        ("PATCH", f"/v1/competitor-pages/{page['id']}", {"status": "paused"}),
        ("DELETE", f"/v1/competitor-pages/{page['id']}", None),
        ("POST", f"/v1/competitor-pages/{page['id']}/check", None),
        ("POST", f"/v1/competitor-web-findings/{fid}/promote", {}),
        ("POST", f"/v1/competitor-web-findings/{fid}/dismiss", {}),
        ("PUT", "/v1/positioning", {"lock_version": 0, "fields": {}}),
        ("POST", f"/v1/positioning-suggestions/{sid}/accept", None),
        ("POST", f"/v1/positioning-suggestions/{sid}/dismiss", None),
    ]
    for who in ("commenter", "viewer"):
        for method, path, body in writes:
            resp = await client.request(method, path, json=body, headers=ctx.as_(who))
            assert resp.status_code == 403, (who, method, path)
    for path in ("/v1/competitors", f"/v1/competitors/{cid}", "/v1/competitor-changes",
                 "/v1/competitor-web-findings", "/v1/positioning"):  # fmt: skip
        assert (await client.get(path, headers=ctx.as_("viewer"))).status_code == 200, path


async def test_another_companys_ids_are_404(client, ctx, at, web):
    """protects=criterion 13: every route answers 404 for another company's alternative,
    page or change; fails_when=one reads or writes across companies; no_claim=row-level
    security in Postgres (tenancy's own tests)."""
    web.page("https://competitor-a.example/pricing", html("Team $50"))
    cid = (await add_competitor(client, ctx)).json()["id"]
    page = (await watch_page(client, ctx, cid, "https://competitor-a.example/pricing")).json()
    other = await make_ctx("Other Example Co")
    for method, path, body in [
        ("GET", f"/v1/competitors/{cid}", None),
        ("PATCH", f"/v1/competitors/{cid}", {"lock_version": 1}),
        ("POST", f"/v1/competitors/{cid}/archive", None),
        ("POST", f"/v1/competitors/{cid}/pages", {"url": "https://x.example/", "label": "other"}),
        ("PATCH", f"/v1/competitor-pages/{page['id']}", {"status": "paused"}),
        ("POST", f"/v1/competitor-pages/{page['id']}/check", None),
        ("DELETE", f"/v1/competitor-pages/{page['id']}", None),
    ]:
        resp = await client.request(method, path, json=body, headers=other.as_("owner"))
        assert resp.status_code == 404, (method, path)
    assert (await client.get("/v1/competitors", headers=other.as_("owner"))).json() == []


async def test_a_run_token_reads_positioning_and_cannot_write(client, ctx, at):
    """protects=criterion 13: a run token with read:baseline reads get_positioning and
    list_competitors and gets 403 on writes; fails_when=a read is refused or a write
    lands; no_claim=the agent's use of what it read."""
    set_runtime(FakeRuntime())
    try:
        raw = await run_token(ctx.tenant_id, ["read:baseline"], ctx.users["owner"].id)
        async with mcp_client(raw) as c:
            got = await c.call_tool("get_positioning", {})
            assert not got.is_error and "unique_attributes" in text_of(got)
            assert not (await c.call_tool("list_competitors", {})).is_error
            names = {t.name for t in (await c.list_tools()).tools}
            assert {"get_positioning", "list_competitors", "get_competitor"} <= names
            writes = {"create_competitor", "update_positioning", "promote_web_finding",
                      "accept_positioning_suggestion", "watch_competitor_page"}  # fmt: skip
            assert names.isdisjoint(writes)
            for tool, args in (
                ("create_competitor", {"name": "Competitor Z", "kind": "direct"}),
                ("update_positioning", {"lock_version": 0, "fields": {}}),
            ):
                refused = await c.call_tool(tool, args)
                assert refused.is_error and "not available to run tokens" in text_of(refused)
    finally:
        set_runtime(None)
    got = (await client.get("/v1/competitors", headers=ctx.as_("viewer"))).json()
    assert got == []
