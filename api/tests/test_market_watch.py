# ruff: noqa: F811 - the fixtures are imported
"""H7 Competitive digest: weekly checks of watched pages, robots.txt, the text diff and
failures, on Oracle's own fetcher with a fake transport (made-up alternatives on
``.example`` hosts; no request leaves the test).

Each test's card: protects=<the observable>; fails_when=<the wrong result it rejects>;
no_claim=<what green does not prove>.
"""

from datetime import timedelta

from sqlalchemy import func, select

from oracle.market import diff, robots
from oracle.market.models import CompetitorChange, CompetitorPage, CompetitorPageSnapshot
from oracle.market.watch import check_due
from oracle.tenancy import tenant_session
from tests.market_helpers import add_competitor, html, watch_page, web  # noqa: F401
from tests.ritual_helpers import START, at, ctx  # noqa: F401

PRICING = "https://competitor-a.example/pricing"


async def _tick(tenant_id) -> int:
    async with tenant_session(tenant_id) as db:
        n = await check_due(db)
        await db.commit()
        return n


async def _count(tenant_id, model, **where) -> int:
    async with tenant_session(tenant_id) as db:
        q = select(func.count()).select_from(model)
        for k, v in where.items():
            q = q.where(getattr(model, k) == v)
        return int(await db.scalar(q))


async def _page(tenant_id, page_id) -> CompetitorPage:
    async with tenant_session(tenant_id) as db:
        return await db.get(CompetitorPage, page_id)


def test_normalise_and_diff_count_lines():
    """protects=the text is normalised (whitespace collapsed, empty lines dropped) and the
    diff counts added and removed lines, rating 3 or fewer minor; fails_when=whitespace
    alone makes a change or the counts are off; no_claim=difflib's alignment choices."""
    assert diff.normalise("  Team   plan \n\n\n $10 \r\n") == "Team plan\n$10"
    d = diff.line_diff("a\nb\nc", "a\nB\nc\nd")
    assert (d.added, d.removed) == (2, 1) and d.rating == "minor"
    assert {"op": "-", "text": "b"} in d.lines and {"op": "+", "text": "d"} in d.lines
    big = diff.line_diff("", "\n".join(str(i) for i in range(300)))
    assert big.added == 300 and len(big.lines) == diff.MAX_LINES and big.rating == "notable"


def test_robots_rules():
    """protects=robots.txt: the ProductOracleBot group wins over *, the longest rule wins,
    Allow on a tie; fails_when=a disallowed path is read or an allowed one refused;
    no_claim=every RFC 9309 corner."""
    rules = robots.parse("User-agent: *\nDisallow: /pricing\n")
    assert not rules.allows("/pricing") and not rules.allows("/pricing/teams")
    assert rules.allows("/changelog")
    own = robots.parse(
        "User-agent: *\nDisallow: /\n\nUser-agent: ProductOracleBot\nAllow: /\nDisallow: /p*$\n"
    )
    assert own.allows("/docs") and not own.allows("/plans")
    assert robots.parse("").allows("/anything")


async def test_weekly_check_stores_snapshots_and_one_change(client, ctx, at, web):
    """protects=criterion 1: a page is read at once when watched, then when its 7 days
    have passed; a changed body stores one page change with the right added and removed
    counts; an unchanged body stores a snapshot and no change; ten more ticks within the
    week read nothing; fails_when=a read is skipped, repeated within the week, or the
    change is missing, doubled or miscounted; no_claim=real sites' HTML."""
    web.page(PRICING, html("Starter $10", "Team $50", "Enterprise: call us"))
    cid = (await add_competitor(client, ctx)).json()["id"]
    resp = await watch_page(client, ctx, cid, PRICING)
    assert resp.status_code == 201, resp.text
    page_id = resp.json()["id"]
    assert resp.json()["last_checked_at"] is not None
    assert web.hits(PRICING) == 1

    at(START + timedelta(days=7))
    web.page(PRICING, html("Starter $12", "Team $50", "Enterprise: call us", "Free trial"))
    assert await _tick(ctx.tenant_id) == 1
    assert web.hits(PRICING) == 2
    async with tenant_session(ctx.tenant_id) as db:
        (change,) = await db.scalars(select(CompetitorChange))
        assert change.origin == "page" and str(change.page_id) == page_id
        assert (change.added_lines, change.removed_lines) == (2, 1)
        assert change.rating == "minor" and change.rated_by == "rule"
        assert {"op": "+", "text": "Free trial"} in change.diff

    for minutes in range(10):
        at(START + timedelta(days=7, minutes=minutes + 1))
        assert await _tick(ctx.tenant_id) == 0
    assert web.hits(PRICING) == 2

    at(START + timedelta(days=14, minutes=5))
    assert await _tick(ctx.tenant_id) == 1
    assert await _count(ctx.tenant_id, CompetitorPageSnapshot) == 3
    assert await _count(ctx.tenant_id, CompetitorChange) == 1


async def test_reads_are_capped_per_tick_and_per_host(client, ctx, at, web):
    """protects=at most 10 reads per company per tick and one read per host per minute;
    fails_when=a tick reads 11 pages, or one host twice in a minute; no_claim=the order
    pages are read in beyond oldest first."""
    a = (await add_competitor(client, ctx)).json()["id"]
    b = (await add_competitor(client, ctx, name="Competitor B")).json()["id"]
    for i in range(6):
        for cid, host in ((a, "competitor-a.example"), (b, f"b{i}.example")):
            url = f"https://{host}/p{i}"
            web.page(url, html(f"page {i}"))
            assert (await watch_page(client, ctx, cid, url, label="docs")).status_code == 201
    at(START + timedelta(days=7))
    web.requests.clear()
    assert await _tick(ctx.tenant_id) == 7  # one competitor-a.example page, six b<i> hosts
    hosts = [u.split("/")[2] for u in web.requests if not u.endswith("/robots.txt")]
    assert hosts.count("competitor-a.example") == 1
    for i in range(1, 6):
        at(START + timedelta(days=7, minutes=i + 1))
        assert await _tick(ctx.tenant_id) == 1


async def test_robots_disallow_blocks_and_check_now_is_409(client, ctx, at, web):
    """protects=criterion 2: robots.txt with User-agent: * and Disallow: /pricing sets the
    page blocked and no request for it leaves; Check now on it is 409; a page on an
    allowed path is read; fails_when=the disallowed page is fetched or Check now reads it;
    no_claim=robots.txt caching across processes."""
    web.page("https://competitor-a.example/robots.txt",
             "User-agent: *\nDisallow: /pricing\n", kind="text/plain")  # fmt: skip
    web.page(PRICING, html("Team $50"))
    web.page("https://competitor-a.example/changelog", html("v2 shipped"))
    cid = (await add_competitor(client, ctx)).json()["id"]
    blocked = await watch_page(client, ctx, cid, PRICING)
    assert blocked.status_code == 201
    assert blocked.json()["status"] == "blocked"
    assert blocked.json()["last_error"] == robots.BLOCKED
    allowed = await watch_page(client, ctx, cid, "https://competitor-a.example/changelog",
                               label="changelog")  # fmt: skip
    assert allowed.json()["status"] == "active"
    resp = await client.post(f"/v1/competitor-pages/{blocked.json()['id']}/check",
                             headers=ctx.as_("approver"))  # fmt: skip
    assert resp.status_code == 409 and resp.json()["detail"] == robots.BLOCKED
    assert web.hits(PRICING) == 0
    assert web.hits("https://competitor-a.example/changelog") == 1


async def test_private_address_and_sign_in_end_in_error(client, ctx, at, web):
    """protects=criterion 3: a page whose host resolves to a private address, or that
    answers 403 (a sign-in), ends error at once with the fetcher's message; a page that
    times out three weeks running ends error and its alternative shows "Not read for 3
    weeks"; fails_when=a private address is requested, or a failing page stays active;
    no_claim=DNS rebinding (public_links' own tests)."""
    web.addresses["intranet.example"] = "10.0.0.7"
    web.page("https://competitor-b.example/pricing", "Sign in", status=403)
    cid = (await add_competitor(client, ctx)).json()["id"]
    private = await watch_page(client, ctx, cid, "https://intranet.example/pricing")
    assert private.json()["status"] == "error"
    assert "private, local or internal network address" in private.json()["last_error"]
    assert not any("intranet.example" in u for u in web.requests)
    walled = await watch_page(client, ctx, cid, "https://competitor-b.example/pricing")
    assert walled.json()["status"] == "error"
    assert "asks for a sign-in" in walled.json()["last_error"]

    web.slow.add("slow.example")
    slow = (await watch_page(client, ctx, cid, "https://slow.example/pricing")).json()
    assert slow["status"] == "active" and slow["attempts"] == 1
    for week in (1, 2):
        at(START + timedelta(days=7 * week, minutes=week))
        await _tick(ctx.tenant_id)
    page = await _page(ctx.tenant_id, slow["id"])
    assert page.status == "error" and page.attempts == 3
    assert page.last_error == "The page took too long to respond."
    got = (await client.get("/v1/competitors", headers=ctx.as_("viewer"))).json()
    assert got[0]["watch_problem"] == "Not read for 3 weeks"
