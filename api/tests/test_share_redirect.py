"""O5 share links: ``/s/{token}`` redirects to the API's public share page (owner
decision 2026-10-26).

``GET /s/{token}`` answers 307 to ``/v1/public/shares/{token}``, keeping the query
string, with ``Cache-Control: no-store`` and ``Referrer-Policy: no-referrer``; the token
is not looked up; a token outside the share-token alphabet is 404 without a redirect;
the route is in neither OpenAPI nor MCP; it counts against the per-address limit of the
public routes. Invented data only.
"""

import pytest

from oracle.shares import public as share_public
from oracle.shares import service as share_service

TOKEN = "Ab3_-xY9" * 5 + "zQ1"


@pytest.fixture(autouse=True)
def clean_limits():
    share_public.reset_limits()
    yield
    share_public.reset_limits()


async def test_s_token_redirects_to_the_public_share_page(client):
    """protects=the address a creator copies (/s/<token>) reaches the API's public page;
    fails_when=/s/<token> is 404 or redirects elsewhere; no_claim=what the page shows."""
    resp = await client.get(f"/s/{TOKEN}")
    assert resp.status_code == 307
    assert resp.headers["location"] == f"/v1/public/shares/{TOKEN}"


async def test_a_real_token_redirects_the_same_and_an_unknown_one_reaches_the_page(client):
    """protects=the token is not looked up: a minted token and an unknown one redirect
    alike, and the unknown one gets the public page's passcode form; fails_when=the
    redirect tells known tokens from unknown ones; no_claim=the passcode flow."""
    real, _ = share_service.new_token()
    resp = await client.get(f"/s/{real}")
    assert resp.status_code == 307
    assert resp.headers["location"] == f"/v1/public/shares/{real}"
    followed = await client.get(f"/s/{TOKEN}", follow_redirects=True)
    assert str(followed.url).endswith(f"/v1/public/shares/{TOKEN}")
    assert followed.status_code == 401
    assert "Enter the passcode" in followed.text


async def test_the_query_string_is_kept(client):
    """protects=a query on the copied address survives the redirect; fails_when=the
    query is dropped or re-encoded; no_claim=what the page does with it."""
    resp = await client.get(f"/s/{TOKEN}?utm_source=mail&x=a%20b&x=2")
    assert resp.status_code == 307
    assert resp.headers["location"] == f"/v1/public/shares/{TOKEN}?utm_source=mail&x=a%20b&x=2"


async def test_the_redirect_is_never_cached_and_sends_no_referrer(client):
    """protects=a revoked link is not served from a cache and the token does not leak
    in a Referer; fails_when=Cache-Control or Referrer-Policy is missing or weaker;
    no_claim=the public page's own headers."""
    resp = await client.get(f"/s/{TOKEN}")
    assert resp.status_code == 307
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["referrer-policy"] == "no-referrer"


@pytest.mark.parametrize(
    "bad",
    ["a.b", "abc%21def", "abc%20def", "abc~def", "%C3%A9t%C3%A9", "abc%2Edef", "x" * 129],
)
async def test_a_malformed_token_is_404_without_a_redirect(client, bad):
    """protects=only the share-token alphabet (A-Z a-z 0-9 _ -) is ever redirected;
    fails_when=a malformed token gets a 307 or a Location; no_claim=the length of a
    minted token (any length up to the public routes' TOKEN_MAX is redirected)."""
    resp = await client.get(f"/s/{bad}")
    assert resp.status_code == 404
    assert "location" not in resp.headers
    assert resp.headers["cache-control"] == "no-store"
    assert resp.headers["referrer-policy"] == "no-referrer"


async def test_the_redirect_shares_the_per_address_limit_of_the_public_routes(client):
    """protects=/s/ cannot be used to go around the per-address limit, and counts toward
    it; fails_when=/s/ answers past CLIENT_PER_MINUTE or does not count against the
    public routes; no_claim=the per-link limits."""
    for _ in range(share_public.CLIENT_PER_MINUTE):
        assert (await client.get(f"/s/{TOKEN}")).status_code == 307
    resp = await client.get(f"/s/{TOKEN}")
    assert resp.status_code == 429
    assert int(resp.headers["retry-after"]) > 0
    assert "location" not in resp.headers
    # The same window as the public routes: the page itself is refused now too.
    assert (await client.get(f"/v1/public/shares/{TOKEN}")).status_code == 429


async def test_the_public_routes_count_toward_the_redirects_limit(client):
    """protects=one window per address across /s/ and /v1/public/shares/; fails_when=
    the redirect keeps its own window; no_claim=the window's length."""
    for _ in range(share_public.CLIENT_PER_MINUTE):
        await client.get(f"/v1/public/shares/{TOKEN}/status")
    assert (await client.get(f"/s/{TOKEN}")).status_code == 429


def test_the_redirect_is_in_neither_openapi_nor_mcp():
    """protects=/s/ is a browser address, not an API operation or an MCP tool;
    fails_when=it shows up in the schema or as a tool; no_claim=the other public
    routes' exclusion (tests.test_share_links)."""
    from oracle.main import app
    from oracle.mcp import tools

    schema = app.openapi()
    assert not [p for p in schema["paths"] if p == "/s" or p.startswith("/s/")]
    ops = tools.operations_from_openapi(schema)
    assert not [t for t in ops if t.path.startswith("/s/")]
    assert any(r.path == "/s/{token}" for r in app.routes if hasattr(r, "path"))
